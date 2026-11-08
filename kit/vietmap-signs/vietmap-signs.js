'use strict';
/**
 * vietmap-signs - the root helper of the VietMap signs app (apps/vietmap_signs): the speed-limit sign
 * VietMap Live shows on the phone, drawn on the instrument cluster's map and on the HUD.
 *
 * The phone app (android/vmsign) reads the number in VietMap Live's speed bubble and sends it over the
 * car's Wi-Fi, a small JSON datagram on UDP 8471 at each change and once a second:
 *     {"t":"vms","v":1,"seq":12,"limit":60}          limit 0: no sign
 * This answers each one to its sender: {"t":"vms-ack","v":1,"seq":12,"car":"0.1.0","shown":["map"],"why":""}.
 * The unit's firewall (table ip filter, input) drops what it does not accept, so while this runs one
 * rule per interface (wlan_bridge, the car's own Wi-Fi; wlan0, a phone hotspot the car is on) accepts
 * the port, tagged "vietmap-signs", checked every 30 s and removed at a stop and at the Store's removal.
 * Only senders on those interfaces' own subnets are listened to.
 *
 * The sign is an image layer of cluster-render (robertnisipeanu/idrive-apps, the renderer Waze on
 * cluster draws through), class overlay, over the map in the cluster's map area (target map) and over
 * the HUD's map (target hud). It is shown only while Waze on cluster shows its map there
 * (/run/waze-on-cluster/status.json), so it never asks the cluster for a slot of its own; it goes 5 s
 * after the phone's last datagram, and while BMW's own sign shows, if the app says so (the app writes
 * BMW's displayed speed limit to its data/bmw_sign.json while it runs).
 *
 * The app's choices are its own settings file (data/settings.json, written by the kit). The state goes
 * to /run/vietmap-signs/status.json (0644), which the app shows.
 *
 *   node vietmap-signs.js run          the service (vietmap-signs.service)
 *   node vietmap-signs.js deactivate   the firewall rules removed, for the Store's removal
 *   node vietmap-signs.js status       print the status file
 *   node vietmap-signs.js sign 60 128  write the sign as a PNG-less RGBA dump (sign-60.rgba), to look at
 *
 * Node 8 (the head unit's), no dependencies. MIT, as the rest of this repository; the digits are
 * Inter Bold (OFL-Inter.txt).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const dgram = require('dgram');
const zlib = require('zlib');

const VERSION = '0.1.1';
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CFG = {
    oap: env('VMS_OAP', '/var/opt/public/oap'),
    run: env('VMS_RUN', '/run/vietmap-signs'),
    port: Number(env('VMS_PORT', 8471)),
    ifaces: env('VMS_IFACES', 'wlan_bridge,wlan0').split(',').map((s) => s.trim()).filter(Boolean),
    nft: env('VMS_NFT', 'nft'),
    wocRun: env('VMS_WOC_RUN', '/run/waze-on-cluster'),
    crClient: env('VMS_CR_CLIENT', '/var/opt/cluster-render/current/cluster_render_client.js'),
    crSocket: env('VMS_CR_SOCKET', ''),
    pollMs: Number(env('VMS_POLL_MS', 500)),
    phoneStaleMs: Number(env('VMS_PHONE_STALE_MS', 5000)),
    bmwStaleMs: Number(env('VMS_BMW_STALE_MS', 4000)),
    wocStaleMs: Number(env('VMS_WOC_STALE_MS', 30000)),
    ruleMs: Number(env('VMS_RULE_MS', 30000)),
    loopback: env('VMS_LOOPBACK', '') === '1',     // tests: senders on 127.0.0.1 too
};
const APP = /^vietmap_signs\d*$/;          // the app's id (the Store may install it as vietmap_signs2)
const NFT_COMMENT = 'vietmap-signs';
const STATUS_FILE = () => path.join(CFG.run, 'status.json');

// cluster-render's targets on iDrive 7 (its PROTOCOL.md hello): the map area and the HUD
const MAP_W = 1088, MAP_H = 480, HUD_W = 800, HUD_H = 480;
const SIZES = { small: { map: 96, hud: 64 }, medium: { map: 128, hud: 80 }, large: { map: 160, hud: 100 } };
// the map area fades out towards its edges (the KOMBI's vignette): the sign stays inside it
const MAP_EDGE_X = 200, MAP_TOP = 36;

function log(msg) { process.stdout.write(new Date().toISOString() + ' ' + msg + '\n'); }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function readJson(p) { const t = readText(p); try { return t === null ? null : JSON.parse(t); } catch (e) { return null; } }
function mtime(p) { try { return fs.statSync(p).mtime.getTime(); } catch (e) { return 0; } }
function writeAtomic(p, text, mode) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, text, { mode: mode || 0o644 });
    fs.renameSync(tmp, p);
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ---------------- the sign ---------------- */

let DIGITS = null;
function digits() {
    if (DIGITS) return DIGITS;
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'digits.json'), 'utf8'));
    Object.keys(d.glyphs).forEach((k) => {
        const g = d.glyphs[k];
        g.mask = zlib.inflateSync(Buffer.from(g.data, 'base64'));
        g.h = d.height;
        if (g.mask.length !== g.w * g.h) throw new Error('digits.json: digit ' + k + ' has the wrong size');
    });
    DIGITS = d;
    return d;
}

function sample(g, u, v) {
    // bilinear, zero outside the mask
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const at = (x, y) => (x < 0 || y < 0 || x >= g.w || y >= g.h ? 0 : g.mask[y * g.w + x]);
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

/**
 * The speed-limit sign (Vietnam's P.127 look: a red ring on white, black digits, a thin white rim
 * outside the red so it reads on a dark map) as S x S RGBA, straight alpha.
 */
function drawSign(limit, S) {
    const px = Buffer.alloc(S * S * 4);
    const c = S / 2, R = S / 2 - 0.5;
    const rim = Math.max(1.5, S * 0.035), ring = S * 0.12;
    const rRed = R - rim, rIn = rRed - ring;
    const RED = [215, 25, 32], WHITE = [255, 255, 255], INK = [17, 17, 17];
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const dx = x + 0.5 - c, dy = y + 0.5 - c, d = Math.sqrt(dx * dx + dy * dy);
            const a = clamp01(R - d + 0.5);
            if (a <= 0) continue;
            const red = clamp01(rRed - d + 0.5) * (1 - clamp01(rIn - d + 0.5));
            const o = (y * S + x) * 4;
            for (let i = 0; i < 3; i++) px[o + i] = Math.round(WHITE[i] * (1 - red) + RED[i] * red);
            px[o + 3] = Math.round(a * 255);
        }
    }
    const text = String(limit);
    const D = digits();
    const gs = text.split('').map((ch) => D.glyphs[ch]).filter(Boolean);
    if (!gs.length) return px;
    // the ink from the first digit's left edge to the last one's right, in font pixels
    let pen = 0;
    const placed = gs.map((g) => { const p = { g, x: pen + g.left }; pen += g.adv; return p; });
    const inkL = placed[0].x, inkR = placed[placed.length - 1].x + placed[placed.length - 1].g.w;
    const inkW = inkR - inkL, H = D.height;
    const cond = gs.length >= 3 ? 0.82 : 0.92;            // narrower digits, as on the signs
    const k = Math.min((S * 0.44) / H, (2 * rIn * 0.80) / (inkW * cond));
    const sx = k * cond, sy = k;
    const ox = c - (inkW * sx) / 2 - inkL * sx, oy = c - (H * sy) / 2;
    const SUB = [0.25, 0.75];
    placed.forEach((p) => {
        const x0 = Math.max(0, Math.floor(ox + p.x * sx)), x1 = Math.min(S, Math.ceil(ox + (p.x + p.g.w) * sx));
        const y0 = Math.max(0, Math.floor(oy)), y1 = Math.min(S, Math.ceil(oy + H * sy));
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                let cov = 0;
                SUB.forEach((qy) => SUB.forEach((qx) => {
                    cov += sample(p.g, (x + qx - ox) / sx - p.x - 0.5, (y + qy - oy) / sy - 0.5);
                }));
                const t = cov / (4 * 255);
                if (t <= 0) continue;
                const o = (y * S + x) * 4;
                for (let i = 0; i < 3; i++) px[o + i] = Math.round(px[o + i] * (1 - t) + INK[i] * t);
            }
        }
    });
    return px;
}

const signCache = new Map();
function sign(limit, S) {
    const key = limit + '@' + S;
    if (!signCache.has(key)) {
        if (signCache.size > 40) signCache.clear();
        signCache.set(key, drawSign(limit, S));
    }
    return signCache.get(key);
}

/* ---------------- the app: where it is and what it asks for ---------------- */

let appCache = null, appScanAt = 0;
/** { id, root, spec } of the installed app, or null. Looked for again every 10 s while missing. */
function findApp(now) {
    if (appCache && fs.existsSync(appCache.spec)) return appCache;
    if (appCache === null && appScanAt && now - appScanAt < 10000 && now >= appScanAt) return null;
    appScanAt = now;
    appCache = null;
    let dirs = [];
    try { dirs = fs.readdirSync(CFG.oap).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (const d of dirs) {
        for (const rel of ['source/javascript/kit/app-spec.json', 'javascript/kit/app-spec.json']) {
            const spec = path.join(CFG.oap, d, rel);
            const s = readJson(spec);
            if (s && typeof s.id === 'string' && APP.test(s.id)) {
                appCache = { id: s.id, root: path.join(CFG.oap, d), spec };
                return appCache;
            }
        }
    }
    return null;
}

const DEFAULTS = { mode: 'on', show: 'both', side: 'right', size: 'medium', bmw: 'hide' };
/** The app's settings in effect: its defaults (app-spec.json) under what it saved (data/settings.json). */
function desired(now) {
    const app = findApp(now);
    const values = Object.assign({}, DEFAULTS);
    if (app) {
        const spec = readJson(app.spec) || {};
        (spec.settings || []).forEach((s) => { if (s.key in DEFAULTS) values[s.key] = s.default; });
        const saved = readJson(path.join(app.root, 'data', 'settings.json')) || {};
        Object.keys(DEFAULTS).forEach((k) => { if (saved[k] !== undefined) values[k] = saved[k]; });
    }
    return {
        app: app ? app.id : null,
        on: values.mode !== 'off',
        show: ['both', 'cluster', 'hud'].indexOf(values.show) >= 0 ? values.show : 'both',
        side: values.side === 'left' ? 'left' : 'right',
        size: SIZES[values.size] ? values.size : 'medium',
        bmw: values.bmw === 'show' ? 'show' : 'hide',
    };
}

/** BMW's own displayed speed limit, as the app last wrote it (only while the app runs). */
function bmwSign(now) {
    const app = findApp(now);
    if (!app) return null;
    const f = path.join(app.root, 'data', 'bmw_sign.json');
    const b = readJson(f);
    if (!b) return null;
    const at = Date.parse(b.at) || mtime(f);
    return { limit: b.limit, valid: !!b.valid, at, fresh: now - at < CFG.bmwStaleMs && now >= at - 5000 };
}

/* ---------------- Waze on cluster: is its map on the cluster, on the HUD ---------------- */

function wocStatus(now) {
    const f = path.join(CFG.wocRun, 'status.json');
    const s = readJson(f);
    if (!s) return { known: false, map: false, hud: false };
    const fresh = now - mtime(f) < CFG.wocStaleMs;
    // Waze on cluster's HUD box (its map_feed.cpp quad()): hud_width_pct of the HUD's width (at most
    // 85 %), the 1088x480 picture's shape, or 0: the fitted 453x200; centred, then moved by hud_x/hud_y
    // pixels and held inside the HUD's 800x480
    const pct = Math.min(Number(s.hud_width_pct) || 0, 85);
    let bw = 453, bh = 200;
    if (pct > 0) {
        bw = Math.floor(HUD_W * pct / 100);
        bh = Math.floor((bw * 480 + 544) / 1088);
        if (bh > HUD_H) { bh = HUD_H; bw = Math.floor((bh * 1088 + 240) / 480); }
    }
    const ox = isFinite(Number(s.hud_x)) ? Number(s.hud_x) : 0, oy = isFinite(Number(s.hud_y)) ? Number(s.hud_y) : 0;
    const bx = Math.max(0, Math.min(HUD_W - bw, Math.floor((HUD_W - bw) / 2) + ox));
    const by = Math.max(0, Math.min(HUD_H - bh, Math.floor((HUD_H - bh) / 2) + oy));
    return {
        known: true, fresh, state: s.state || null, reason: s.reason || null,
        map: fresh && s.state === 'showing' && s.target !== 'hud' && Number(s.cluster) !== 0,
        hud: fresh && Number(s.hud) === 1 && s.hud_state === 'showing',
        guideHold: Number(s.hide_bmw_guidance) === 0 ? 0 : 1,
        hudBox: { x: bx, y: by, w: bw, h: bh },
    };
}

/** Where the sign goes on each target. */
function geometry(d, woc) {
    const s = SIZES[d.size];
    const map = { size: s.map, y: MAP_TOP, x: d.side === 'left' ? MAP_EDGE_X : MAP_W - MAP_EDGE_X - s.map };
    const b = (woc && woc.hudBox) || { x: 173, y: 140, w: 453, h: 200 };
    const hud = { size: s.hud, y: b.y + 8, x: d.side === 'left' ? b.x + 8 : b.x + b.w - s.hud - 8 };
    hud.x = Math.max(0, Math.min(HUD_W - s.hud, hud.x));
    hud.y = Math.max(0, Math.min(HUD_H - s.hud, hud.y));
    return { map, hud };
}

/* ---------------- the firewall ---------------- */

const fw = { rules: [], checkedAt: 0, error: null, present: null };
function nft(args) {
    const r = cp.spawnSync(CFG.nft, args, { timeout: 10000, encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error('nft ' + args.join(' ') + ': ' + String((r.error && r.error.message) || r.stderr || ('exit ' + r.status)).trim().slice(0, 200));
    return r.stdout || '';
}
/** Our tagged rules: [{ iface, handle }], or null without the unit's chain. */
function ourRules() {
    let out;
    try { out = nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']); } catch (e) { return null; }
    return out.split('\n').filter((l) => l.indexOf('comment "' + NFT_COMMENT + '"') >= 0).map((l) => {
        const h = /# handle (\d+)\s*$/.exec(l), i = /iifname "([^"]+)"/.exec(l), p = /dport (\d+)/.exec(l);
        return h ? { handle: h[1], iface: i ? i[1] : null, port: p ? Number(p[1]) : null } : null;
    }).filter(Boolean);
}
function removeRules() {
    const rs = ourRules() || [];
    rs.forEach((r) => { try { nft(['delete', 'rule', 'ip', 'filter', 'input', 'handle', r.handle]); } catch (e) { log(e.message); } });
    return rs.length;
}
/** One accept per interface on our port at the top of the input chain; put back when a ruleset load took it. */
function ensureRules(now) {
    fw.checkedAt = now;
    try {
        const rs = ourRules();
        fw.present = rs !== null;
        if (rs === null) { fw.rules = []; fw.error = null; return; }      // no unit firewall here
        const ok = rs.length === CFG.ifaces.length && CFG.ifaces.every((i) => rs.some((r) => r.iface === i && r.port === CFG.port));
        if (!ok) {
            if (rs.length) removeRules();
            CFG.ifaces.forEach((i) => nft(['insert', 'rule', 'ip', 'filter', 'input', 'iifname', '"' + i + '"', 'udp', 'dport', String(CFG.port),
                'accept', 'comment', '"' + NFT_COMMENT + '"']));
            log('firewall: udp ' + CFG.port + ' accepted on ' + CFG.ifaces.join(', '));
        }
        fw.rules = CFG.ifaces.slice();
        fw.error = null;
    } catch (e) {
        fw.error = e.message;
        log('firewall: ' + e.message);
    }
}

/* ---------------- the phone ---------------- */

const phone = { from: null, at: 0, seq: null, limit: null, test: false, ver: null, packets: 0, ignored: 0, bad: 0 };

function ipv4ToInt(a) { return a.split('.').reduce((n, x) => ((n << 8) >>> 0) + (Number(x) & 255), 0) >>> 0; }
/** Is the sender on one of our interfaces' own subnets? */
function allowedSender(addr) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return false;
    if (CFG.loopback && /^127\./.test(addr)) return true;
    const nets = os.networkInterfaces();
    const a = ipv4ToInt(addr);
    return CFG.ifaces.some((name) => (nets[name] || []).some((n) => {
        if (n.family !== 'IPv4' && n.family !== 4) return false;
        const m = ipv4ToInt(n.netmask || '255.255.255.255');
        return ((a & m) >>> 0) === ((ipv4ToInt(n.address) & m) >>> 0);
    }));
}

/** A datagram: the state it changes, or null when it is not ours. */
function parsePacket(buf) {
    if (!buf || buf.length > 2048) return null;
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
    if (!m || m.t !== 'vms') return null;
    const limit = Number(m.limit);
    if (!(Number.isInteger(limit) && limit >= 0 && limit <= 199)) return null;
    return { seq: Number.isFinite(Number(m.seq)) ? Number(m.seq) : null, limit: limit || null, test: !!m.test, ver: typeof m.app === 'string' ? m.app.slice(0, 40) : null };
}

/* ---------------- drawing through cluster-render ---------------- */

const renderer = { installed: false, connected: false, backend: null, error: null, layers: {}, targets: {} };
let cr = null;
const layers = {};       // target -> { ref, size, x, y, limit, visible, guide }

function startRenderer() {
    if (cr) return true;
    if (!fs.existsSync(CFG.crClient)) { renderer.installed = false; renderer.error = 'cluster-render is not installed'; return false; }
    let ClusterRender;
    try { ClusterRender = require(CFG.crClient).ClusterRender; } catch (e) { renderer.error = 'cluster-render client: ' + e.message; return false; }
    renderer.installed = true;
    renderer.error = null;
    cr = new ClusterRender('vietmap-signs', CFG.crSocket || undefined);
    cr.on('ready', () => { renderer.connected = true; renderer.backend = cr.backend || null; log('cluster-render: connected (' + cr.backend + ', ' + cr.targets + ')'); });
    cr.on('disconnected', () => { renderer.connected = false; log('cluster-render: disconnected'); });
    cr.on('layer', (ref, state, reason) => {
        Object.keys(layers).forEach((t) => { if (layers[t].ref === ref) renderer.layers[t] = { state, reason: reason || null }; });
    });
    cr.on('target', (name, state, holder, reason) => { renderer.targets[name] = { state, holder: holder || null, reason: reason || null }; });
    cr.on('refused', (op, ref, reason) => { renderer.error = 'cluster-render refused ' + op + ': ' + reason; log(renderer.error); });
    cr.connect();
    return true;
}

/** want: { limit, map: { visible, x, y, size, guide }, hud: {...} } */
function applyLayers(want) {
    if (!cr) return;
    ['map', 'hud'].forEach((t) => {
        const w = want[t];
        let L = layers[t];
        if (!w.visible || !want.limit) {
            if (L && L.visible) { cr.set(L.ref, { visible: false }); L.visible = false; }
            return;
        }
        if (!L || L.size !== w.size) {
            if (L) cr.drop(L.ref);
            const ref = cr.image({ target: t, klass: 'overlay', z: 10, x: w.x, y: w.y, w: w.size, h: w.size, iw: w.size, ih: w.size,
                visible: false, fps: 4, guide_hold: w.guide, contend: false });
            if (!ref) { renderer.error = 'cluster-render client refused the ' + t + ' layer'; return; }
            L = layers[t] = { ref, size: w.size, x: w.x, y: w.y, limit: null, visible: false, guide: w.guide };
            renderer.layers[t] = { state: 'made', reason: null };
        }
        if (L.limit !== want.limit) { cr.pixels(L.ref, null, sign(want.limit, w.size)); L.limit = want.limit; }
        if (L.x !== w.x || L.y !== w.y) { cr.set(L.ref, { x: w.x, y: w.y }); L.x = w.x; L.y = w.y; }
        if (L.guide !== w.guide) { cr.set(L.ref, { guide_hold: w.guide }); L.guide = w.guide; }
        if (!L.visible) { cr.set(L.ref, { visible: true }); L.visible = true; }
    });
}

/* ---------------- one look ---------------- */

let last = { shown: [], why: '', limit: null };
let lastWrite = 0, lastKey = '';

function decide(now) {
    const d = desired(now);
    const woc = wocStatus(now);
    const fresh = phone.at && now - phone.at < CFG.phoneStaleMs;
    const limit = fresh ? phone.limit : null;
    const bmw = bmwSign(now);
    const bmwShows = !!(bmw && bmw.fresh && bmw.valid && bmw.limit > 0);
    const suppress = d.bmw === 'hide' && bmwShows;
    const g = geometry(d, woc);
    const wantMap = d.on && d.show !== 'hud', wantHud = d.on && d.show !== 'cluster';
    const showOk = renderer.installed !== false && !!limit && !suppress;
    const map = Object.assign({ visible: showOk && wantMap && woc.map, guide: woc.guideHold === 0 ? 0 : 1 }, g.map);
    const hud = Object.assign({ visible: showOk && wantHud && woc.hud, guide: woc.guideHold === 0 ? 0 : 1 }, g.hud);
    let why = '';
    if (!d.on) why = 'off in the app';
    else if (!phone.at) why = 'no phone yet';
    else if (!fresh) why = 'the phone stopped sending';
    else if (!limit) why = 'no sign in VietMap';
    else if (suppress) why = 'BMW shows its own sign';
    else if (!renderer.installed) why = 'cluster-render is not installed';
    else if (!woc.known) why = 'Waze on cluster is not installed';
    else if (!(wantMap && woc.map) && !(wantHud && woc.hud)) why = 'Waze on cluster shows no map there';
    return { d, woc, bmw: bmw ? { limit: bmw.limit, valid: bmw.valid, fresh: bmw.fresh, suppress } : null, limit, map, hud, why };
}

function tick() {
    const now = Date.now();
    if (now - fw.checkedAt >= CFG.ruleMs) ensureRules(now);
    if (!cr) startRenderer();
    const s = decide(now);
    applyLayers({ limit: s.limit, map: s.map, hud: s.hud });
    last = { shown: ['map', 'hud'].filter((t) => s[t].visible), why: s.why, limit: s.limit };
    const key = JSON.stringify([last, s.bmw, renderer, fw.error, s.d, s.woc.map, s.woc.hud, phone.from, phone.bad, phone.ignored]);
    if (key !== lastKey || now - lastWrite > 2000) { writeStatus(s, now); lastKey = key; lastWrite = now; }
    return s;
}

function writeStatus(s, now) {
    const st = {
        tool: VERSION, at: new Date(now).toISOString(), app: s.d.app, settings: s.d, port: CFG.port,
        phone: { from: phone.from, at: phone.at ? new Date(phone.at).toISOString() : null, ago_ms: phone.at ? now - phone.at : null,
            seq: phone.seq, limit: phone.limit, test: phone.test, app: phone.ver, packets: phone.packets, ignored: phone.ignored, bad: phone.bad },
        limit: s.limit, shown: last.shown, why: s.why, bmw: s.bmw,
        waze: { known: s.woc.known, fresh: s.woc.fresh, state: s.woc.state || null, map: s.woc.map, hud: s.woc.hud },
        renderer: { installed: renderer.installed, connected: renderer.connected, backend: renderer.backend, error: renderer.error,
            layers: renderer.layers, targets: renderer.targets },
        firewall: { present: fw.present, rules: fw.rules, error: fw.error },
    };
    try { writeAtomic(STATUS_FILE(), JSON.stringify(st, null, 1) + '\n', 0o644); } catch (e) { log('status: ' + e.message); }
}

/* ---------------- commands ---------------- */

let sock = null;
function listen(onPacket) {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => { log('udp: ' + e.message); });
    sock.on('message', (buf, rinfo) => {
        if (!allowedSender(rinfo.address)) { phone.ignored++; return; }
        const p = parsePacket(buf);
        if (!p) { phone.bad++; return; }
        const now = Date.now();
        if (phone.from !== rinfo.address) log('phone: ' + rinfo.address + ':' + rinfo.port + (p.ver ? ' (' + p.ver + ')' : ''));
        if (phone.limit !== p.limit) log('sign: ' + (p.limit || 'none') + (p.test ? ' (test)' : ''));
        const ver = p.ver || (phone.from === rinfo.address ? phone.ver : null);
        Object.assign(phone, { from: rinfo.address, at: now, seq: p.seq, limit: p.limit, test: p.test, ver });
        phone.packets++;
        if (onPacket) onPacket();
        const ack = Buffer.from(JSON.stringify({ t: 'vms-ack', v: 1, seq: p.seq, car: VERSION, shown: last.shown, why: last.why }));
        sock.send(ack, rinfo.port, rinfo.address, () => {});
    });
    sock.bind(CFG.port, '0.0.0.0');
    return sock;
}

function run() {
    try { fs.mkdirSync(CFG.run, 0o755); } catch (e) { /* there */ }
    log('vietmap-signs ' + VERSION + ' started, udp ' + CFG.port + ' on ' + CFG.ifaces.join(', '));
    let timer = null;
    const loop = () => {
        try { tick(); } catch (e) { log('tick: ' + (e && e.stack || e)); }
        timer = setTimeout(loop, CFG.pollMs);
    };
    // a datagram shows (or hides) the sign at once, not at the next look
    listen(() => { try { tick(); } catch (e) { log('tick: ' + e); } });
    const quit = (sig) => {
        log('stopping (' + sig + ')');
        clearTimeout(timer);
        try { if (cr) cr.close(); } catch (e) { /* gone */ }
        try { removeRules(); } catch (e) { /* gone */ }
        try { sock.close(); } catch (e) { /* gone */ }
        setTimeout(() => process.exit(0), 200);
    };
    process.on('SIGTERM', () => quit('SIGTERM'));
    process.on('SIGINT', () => quit('SIGINT'));
    loop();
}

/** The Store's removal: no rule of ours left. Succeeds when there is nothing to undo. */
function deactivate() {
    let n = 0;
    try { n = removeRules(); } catch (e) { /* no firewall */ }
    process.stdout.write(JSON.stringify({ status: n ? 'firewall rules removed (' + n + ')' : 'nothing to undo' }) + '\n');
}

if (require.main === module) {
    const cmd = process.argv[2] || 'run';
    if (cmd === 'run') run();
    else if (cmd === 'deactivate') deactivate();
    else if (cmd === 'status') process.stdout.write((readText(STATUS_FILE()) || '{}\n'));
    else if (cmd === 'sign') {
        const n = Number(process.argv[3] || 60), S = Number(process.argv[4] || 128);
        fs.writeFileSync('sign-' + n + '.rgba', drawSign(n, S));
        process.stdout.write('sign-' + n + '.rgba: ' + S + 'x' + S + ' RGBA\n');
    } else { process.stderr.write('usage: node vietmap-signs.js run|deactivate|status|sign <limit> <size>\n'); process.exit(2); }
}

module.exports = {
    VERSION, CFG, SIZES, drawSign, desired, findApp, wocStatus, geometry, decide, tick, parsePacket, allowedSender,
    ensureRules, removeRules, ourRules, listen, phone, renderer, layers, _last: () => last,
    _reset: () => { appCache = null; appScanAt = 0; },
};
