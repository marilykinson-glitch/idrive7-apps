'use strict';
/**
 * vietmap-signs - the root helper of the VietMap signs app (apps/vietmap_signs): the speed-limit sign
 * VietMap Live shows on the phone, drawn on the instrument cluster's map and on the HUD.
 *
 * The sign comes first from BMW's own front camera (camera.js: the signs it recognises, read as root
 * from the unit's SOME/IP binding; apps are not given them), then from the phone, then (off by default)
 * from a picture of the centre screen. Faster than the sign, it pulses in brightness.
 *
 * The phone app (android/vmsign) reads the number in VietMap Live's speed bubble and sends it over the
 * car's Wi-Fi, a small JSON datagram on UDP 8471 at each change and once a second:
 *     {"t":"vms","v":1,"seq":12,"limit":60,"code":"482915"}          limit 0: no sign
 * This answers each one to its sender: {"t":"vms-ack","v":1,"seq":12,"car":"0.6.0","paired":true,"shown":["map"],"why":""}.
 * The code is the pairing code: six digits made here once (kept in /var/opt/vietmap-signs/pair.json,
 * root only), shown by the app (it gets it in its own folder in /run, below) and typed into the phone
 * app once. A datagram without it is answered {"paired":false,"why":"wrong code"} and changes nothing;
 * a sender with 20 wrong codes in a minute is not listened to for a minute.
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
 * to /run/vietmap-signs/status.json (0644), which the app shows. What changes often goes through RAM,
 * not the app's data folder (flash): this makes /run/vietmap-signs/app (0770, the user and group the app runs as), where
 * the app writes preview.json (its Position page is open) and speed.json (the car's speed, only while the
 * status says this has none of its own: speed_own false), and where this puts pair.json (the code) and
 * takes pair-new (a new code wanted). Files there are read without following links, at most 4 KB.
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
const crypto = require('crypto');
const jpeg = require('./jpeg');
const signread = require('./signread');
const camera = require('./camera');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const dgram = require('dgram');
const zlib = require('zlib');

const VERSION = '0.6.2';
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CFG = {
    oap: env('VMS_OAP', '/var/opt/public/oap'),
    proc: env('VMS_PROC', '/proc'),
    run: env('VMS_RUN', '/run/vietmap-signs'),
    // what stays across restarts (the pairing code): next to the installed versions, written once
    state: env('VMS_STATE', '/var/opt/vietmap-signs'),
    pairing: env('VMS_PAIRING', '1') !== '0',
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
    // the centre screen's pictures (CarPlay: VietMap Live's widget with the sign)
    grabber: env('VMS_GRABBER', '/usr/bin/winston-grabber'),
    wayland: env('VMS_XDG_RUNTIME_DIR', '/run/wayland'),
    screenMs: Number(env('VMS_SCREEN_MS', 1000)),
    screenGeometry: env('VMS_SCREEN_GEOMETRY', '960x360'),
    screenStaleMs: Number(env('VMS_SCREEN_STALE_MS', 4000)),
    // BMW's front camera's signs (camera.js), read as root from the unit's SOME/IP binding
    camera: env('VMS_CAMERA', '1') !== '0',
    someip: env('VMS_SOMEIP', '/usr/lib/someip.node'),
    catalog: env('VMS_CATALOG', '/etc/oap/someip/someip-interfaces.json'),
    gen: env('VMS_GEN', path.join(__dirname, 'gen.js')),
    camHoldKm: Number(env('VMS_CAMERA_HOLD_KM', camera.DEFAULT_HOLD_KM)),
};
const APP = /^vietmap_signs\d*$/;          // the app's id (the Store may install it as vietmap_signs2)
const NFT_COMMENT = 'vietmap-signs';
const STATUS_FILE = () => path.join(CFG.run, 'status.json');

// cluster-render's targets on iDrive 7 (its PROTOCOL.md hello): the map area and the HUD
const MAP_W = 1088, MAP_H = 480, HUD_W = 800, HUD_H = 480;
const SIZES = { small: { map: 96, hud: 64 }, medium: { map: 128, hud: 80 }, large: { map: 160, hud: 100 } };
// what the HUD shows of its 800x480, with room to spare: Waze on cluster's widest map, 85 % (680x300),
// centred, is said to be the most not cut off at its edges, and a sign reaching x 740 was cut on the car
const HUD_SEEN = { x: 80, y: 90, w: 640, h: 300 };
// the map area fades out towards its edges (the KOMBI's vignette): the sign stays inside it
const MAP_EDGE_X = 200, MAP_TOP = 36;

function log(msg) { process.stdout.write(new Date().toISOString() + ' ' + msg + '\n'); }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function readJson(p) { const t = readText(p); try { return t === null ? null : JSON.parse(t); } catch (e) { return null; } }
function mtime(p) { try { return fs.statSync(p).mtime.getTime(); } catch (e) { return 0; } }
/** A small file in a folder someone else can write: never through a link, at most 4 KB; { text, mtime } or null. */
function readSmall(p) {
    let fd = -1;
    try {
        fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > 4096) return null;
        const b = Buffer.alloc(st.size);
        const n = st.size ? fs.readSync(fd, b, 0, st.size, 0) : 0;
        return { text: b.slice(0, n).toString('utf8'), mtime: st.mtime.getTime() };
    } catch (e) { return null; } finally { if (fd >= 0) try { fs.closeSync(fd); } catch (e) { /* closed */ } }
}
function readSmallJson(p) {
    const r = readSmall(p);
    if (!r) return null;
    try { const j = JSON.parse(r.text); return j && typeof j === 'object' ? { j, mtime: r.mtime } : null; } catch (e) { return null; }
}
function writeAtomic(p, text, mode) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, text, { mode: mode || 0o644 });
    fs.renameSync(tmp, p);
}
/** A file into a folder someone else owns (the app's): the temporary file made new (never through a
 *  link left there), given to uid, then renamed over the old one. */
function writeInto(p, text, mode, uid, gid) {
    const tmp = p + '.tmp';
    try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
        fs.writeSync(fd, text);
        if (uid !== null && uid !== undefined) fs.fchownSync(fd, uid, gid === null || gid === undefined ? -1 : gid);
    } finally { fs.closeSync(fd); }
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
function drawSign(limit, S, warn) {
    const px = Buffer.alloc(S * S * 4);
    const c = S / 2, R = S / 2 - 0.5;
    const rim = Math.max(1.5, S * 0.035), ring = S * 0.12;
    const rRed = R - rim, rIn = warn ? -1 : rRed - ring;     // the warning: red to the middle
    const RED = [215, 25, 32], WHITE = [255, 255, 255], INK = warn ? [255, 255, 255] : [17, 17, 17];
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
    const k = Math.min((S * 0.44) / H, (2 * (rRed - ring) * 0.80) / (inkW * cond));
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
function sign(limit, S, warn) {
    const key = limit + '@' + S + (warn ? '!' : '');
    if (!signCache.has(key)) {
        if (signCache.size > 40) signCache.clear();
        signCache.set(key, drawSign(limit, S, warn));
    }
    return signCache.get(key);
}

/* Keep the sign readable during the warning. Only layer opacity changes, on both displays. */
const BLINK = { frameMs: 50, cycleMs: 1000, minOpacity: 0.25 };
const flash = { timer: null, opacity: 1 };
function setSignOpacity(opacity) {
    if (flash.opacity === opacity) return;
    flash.opacity = opacity;
    Object.keys(layers).forEach((t) => {
        const L = layers[t];
        if (L.visible) cr.set(L.ref, { opacity });
    });
}
function flashing(on) {
    if (on && !flash.timer) {
        const started = process.hrtime();
        flash.timer = setInterval(() => {
            const elapsed = process.hrtime(started);
            const ms = elapsed[0] * 1000 + elapsed[1] / 1e6;
            const phase = (ms % BLINK.cycleMs) / BLINK.cycleMs;
            const brightness = (1 + Math.cos(2 * Math.PI * phase)) / 2;
            const opacity = BLINK.minOpacity + (1 - BLINK.minOpacity) * brightness;
            if (cr) setSignOpacity(Math.round(opacity * 100) / 100);
        }, BLINK.frameMs);
    } else if (!on && flash.timer) {
        clearInterval(flash.timer);
        flash.timer = null;
        if (cr) setSignOpacity(1);
    }
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

const DEFAULTS = { mode: 'on', show: 'both', side: 'right', hudSide: 'left', size: 'medium', bmw: 'hide', screen: 'on', warn: '5', camera: 'on', probe: 'off' };
const WARN = { off: null, '0': 0, '5': 5, '10': 10 };
const POS_KEYS = ['mapX', 'mapY', 'hudX', 'hudY'];
const PREVIEW_LIMIT = 60;
/** The app's settings in effect: its defaults (app-spec.json) under what it saved (data/settings.json). */
function desired(now) {
    const app = findApp(now);
    const values = Object.assign({}, DEFAULTS);
    if (app) {
        const spec = readJson(app.spec) || {};
        (spec.settings || []).forEach((s) => { if (s.key in DEFAULTS) values[s.key] = s.default; });
        const saved = readJson(path.join(app.root, 'data', 'settings.json')) || {};
        Object.keys(DEFAULTS).forEach((k) => { if (saved[k] !== undefined) values[k] = saved[k]; });
        // where the user put the sign on the app's Position page (its top-left, in the target's pixels)
        POS_KEYS.forEach((k) => { if (Number.isFinite(saved[k])) values[k] = Math.round(saved[k]); });
    }
    const pos = (x, y) => (Number.isFinite(values[x]) && Number.isFinite(values[y]) ? { x: values[x], y: values[y] } : null);
    return {
        app: app ? app.id : null,
        on: values.mode !== 'off',
        show: ['both', 'cluster', 'hud'].indexOf(values.show) >= 0 ? values.show : 'both',
        side: values.side === 'left' ? 'left' : 'right',
        hudSide: values.hudSide === 'right' ? 'right' : 'left',
        size: SIZES[values.size] ? values.size : 'medium',
        bmw: values.bmw === 'show' ? 'show' : 'hide',
        screen: values.screen !== 'off',
        camera: values.camera !== 'off',
        // look for BMW's map speed limit in the unit's interfaces and log what comes (probe.js)
        probe: values.probe === 'on',
        // warn above the sign by this much (km/h), or null: no warning
        warn: Object.prototype.hasOwnProperty.call(WARN, String(values.warn)) ? WARN[String(values.warn)] : 5,
        mapPos: pos('mapX', 'mapY'),
        hudPos: pos('hudX', 'hudY'),
    };
}

/* ---------------- the app's folder in RAM ---------------- */

const appRun = { dir: null, uid: null, gid: null, by: null, error: null, checkedAt: 0, procAt: 0, proc: null };
/**
 * The user and group the app's program runs as: a process whose command line or working folder is in
 * the app's folder (/proc). Its data folder's owner need not be that user (0.6.0 went by the data folder,
 * and the app could not read the folder made for it). null when the app is not running.
 */
function appProcess(app, now) {
    if (appRun.proc && now - appRun.procAt < 30000 && now >= appRun.procAt) return appRun.proc;
    appRun.procAt = now;
    let found = null;
    let pids = [];
    try { pids = fs.readdirSync(CFG.proc).filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid); } catch (e) { return null; }
    const inApp = (s) => !!s && (s === app.root || s.indexOf(app.root + '/') >= 0 || s.indexOf(app.root + '\0') >= 0);
    for (const pid of pids) {
        const base = path.join(CFG.proc, pid);
        let cmd = null, cwd = null;
        try { cmd = fs.readFileSync(path.join(base, 'cmdline'), 'latin1'); } catch (e) { continue; }
        try { cwd = fs.readlinkSync(path.join(base, 'cwd')); } catch (e) { /* not ours to see */ }
        if (!/node/.test(cmd) && !inApp(cwd)) continue;
        if (!inApp(cmd) && !inApp(cwd)) continue;
        const st = readText(path.join(base, 'status')) || '';
        const u = /^Uid:\s+(\d+)/m.exec(st), g = /^Gid:\s+(\d+)/m.exec(st);
        if (!u || !g || Number(u[1]) === 0) continue;
        found = { uid: Number(u[1]), gid: Number(g[1]), pid: Number(pid) };
        break;
    }
    appRun.proc = found;
    return found;
}

/**
 * /run/vietmap-signs/app, the app's own (0770, the user and group its program runs as; before it runs,
 * its data folder's): what the app writes often goes there, not to flash. Made again when missing
 * (the service's /run folder goes at each stop).
 */
function appRunDir(now) {
    const app = findApp(now);
    if (!app) return null;
    if (appRun.dir && now - appRun.checkedAt < 5000 && now >= appRun.checkedAt) return appRun.dir;
    appRun.checkedAt = now;
    const dir = path.join(CFG.run, 'app');
    try {
        const proc = appProcess(app, now);
        const data = fs.statSync(path.join(app.root, 'data'));
        const owner = proc ? { uid: proc.uid, gid: proc.gid } : { uid: data.uid, gid: data.gid };
        let st = null;
        try { st = fs.lstatSync(dir); } catch (e) { /* none yet */ }
        if (st && !st.isDirectory()) { fs.unlinkSync(dir); st = null; }
        if (!st) fs.mkdirSync(dir, 0o770);
        st = fs.lstatSync(dir);
        if (st.uid !== owner.uid || st.gid !== owner.gid) fs.chownSync(dir, owner.uid, owner.gid);
        if ((st.mode & 0o777) !== 0o770) fs.chmodSync(dir, 0o770);
        if (appRun.uid !== owner.uid || appRun.gid !== owner.gid) {
            log('app folder ' + dir + ': ' + owner.uid + ':' + owner.gid + (proc ? ' (the app\'s program, pid ' + proc.pid + ')' : ' (its data folder)'));
            pair.written = null;      // the code again, as the new owner's
        }
        appRun.dir = dir; appRun.uid = owner.uid; appRun.gid = owner.gid; appRun.by = proc ? 'process' : 'data'; appRun.error = null;
    } catch (e) {
        if (appRun.error !== e.message) log('app folder ' + dir + ': ' + e.message);
        appRun.dir = null; appRun.error = e.message;
    }
    return appRun.dir;
}

/** The newest fresh copy of one of the app's files: in its RAM folder, else (an older app) in data/. */
function appFile(now, name, maxAgeMs) {
    const app = findApp(now);
    if (!app) return null;
    let best = null;
    [appRun.dir ? path.join(appRun.dir, name) : null, path.join(app.root, 'data', name)].forEach((f) => {
        const r = f && readSmallJson(f);
        if (!r) return;
        const at = Date.parse(r.j.at) || r.mtime;
        if (now - at < maxAgeMs && now >= at - 5000 && (!best || at > best.at)) best = { j: r.j, at };
    });
    return best;
}

/** The car's speed from here (camera.js), or null. A car that stands still sends nothing new: a speed
 *  under 3 km/h holds for a minute (it could only hide a warning, never make one up). */
function ownSpeed(now) {
    const s = camera.speed(cam, now);
    if (s !== null) return s;
    return cam.speed !== null && cam.speed <= 3 && now - cam.speedAt < 60000 && now >= cam.speedAt ? cam.speed : null;
}

/** The car's speed (km/h): read here, else as the app writes it (speed.json, only while this has none); null when old. */
function carSpeed(now) {
    const own = ownSpeed(now);
    if (own !== null) return own;
    const s = appFile(now, 'speed.json', 2000);
    return s && Number.isFinite(s.j.kmh) && s.j.kmh >= 0 && s.j.kmh < 400 ? s.j.kmh : null;
}

/** The app's Position page is open (it writes preview.json every second): a sign to place. With a finger
 *  dragging it there, { t: 'map' | 'hud', x, y }: where it is now (saved in the settings when it comes up). */
function preview(now) {
    const p = appFile(now, 'preview.json', 4000);
    return !!p;
}
function previewDrag(now) {
    const p = appFile(now, 'preview.json', 1000);
    const d = p && p.j.drag;
    return d && (d.t === 'map' || d.t === 'hud') && Number.isFinite(d.x) && Number.isFinite(d.y) ? { t: d.t, x: Math.round(d.x), y: Math.round(d.y) } : null;
}

/* ---------------- the probe for BMW's map speed limit (probe.js), while the app asks for it ---------------- */

const probe = { child: null, startedAt: 0, exits: 0 };
function probeLog() { return path.join(CFG.run, 'probe.log'); }
function manageProbe(want, now) {
    if (want && !probe.child && (now - probe.startedAt > 60000 || now < probe.startedAt)) {
        probe.startedAt = now;
        try {
            const child = cp.spawn(process.execPath, [path.join(__dirname, 'probe.js'), 'run', probeLog(), path.join(CFG.run, 'probe-tmp')],
                { stdio: 'ignore', env: Object.assign({}, process.env, { VMS_CATALOG: CFG.catalog, VMS_GEN: CFG.gen, VMS_SOMEIP: typeof CFG.someip === 'string' ? CFG.someip : '' }) });
            probe.child = child;
            log('probe: started (pid ' + child.pid + '), log ' + probeLog());
            child.on('exit', (code) => { if (probe.child === child) probe.child = null; probe.exits++; log('probe: ended (' + code + ')'); });
            child.on('error', (e) => { if (probe.child === child) probe.child = null; log('probe: ' + e.message); });
        } catch (e) { log('probe: ' + e.message); }
    } else if (!want && probe.child) {
        try { probe.child.kill('SIGTERM'); } catch (e) { /* gone */ }
        probe.child = null;
        log('probe: stopped');
    }
}

/* ---------------- pairing: the phone sends the code the app shows ---------------- */

// wrong codes from one sender in a minute before it is not listened to for a minute (a phone with a wrong
// code sends every 5 s: 12 a minute; guessing 6 digits at 20 a minute takes weeks)
const STRIKES = 20;
const pair = { code: null, error: null, made: null, refused: 0, from: null, at: 0, strikes: {}, newAt: 0, written: null };
function pairFile() { return path.join(CFG.state, 'pair.json'); }
function newCode() {
    // six digits, never starting with 0 (typed on a phone, read on a screen)
    const n = crypto.randomBytes(4).readUInt32BE(0);
    return String(100000 + (n % 900000));
}
/** The pairing code: the one kept, else a new one saved (0600). */
function pairCode() {
    if (pair.code) return pair.code;
    const p = readJson(pairFile());
    if (p && /^\d{6}$/.test(String(p.code))) { pair.code = String(p.code); pair.made = p.made || null; return pair.code; }
    return setCode(newCode(), 'first start');
}
function setCode(code, why) {
    pair.code = code; pair.made = new Date().toISOString();
    try {
        try { fs.mkdirSync(CFG.state, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        writeAtomic(pairFile(), JSON.stringify({ code, made: pair.made }) + '\n', 0o600);
        pair.error = null;
    } catch (e) { pair.error = e.message; log('pairing code not saved: ' + e.message); }
    log('pairing code: new (' + why + ')');
    pair.written = null;
    return code;
}
/** The code into the app's RAM folder (pair.json, the app's user, 0600); a new one when the app asks (pair-new). */
function pairToApp(now) {
    const dir = appRun.dir;
    if (!dir || !CFG.pairing) return;
    // the ask: in RAM, or (the app could not write there) in its data folder
    const app = findApp(now);
    const asks = [path.join(dir, 'pair-new')].concat(app ? [path.join(app.root, 'data', 'pair-new')] : []);
    const ask = asks.filter((f) => readSmall(f));
    if (ask.length) {
        ask.forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* gone */ } });
        if (now - pair.newAt > 3000 || now < pair.newAt) { pair.newAt = now; setCode(newCode(), 'asked in the app'); }
    }
    const f = path.join(dir, 'pair.json');
    const want = JSON.stringify({ code: pairCode(), made: pair.made });
    if (pair.written === want && fs.existsSync(f)) return;
    try {
        writeInto(f, want + '\n', 0o640, appRun.uid, appRun.gid);
        pair.written = want;
    } catch (e) { log('pairing code to the app: ' + e.message); }
}
/** Is this datagram's code the one? A sender with STRIKES wrong ones in a minute is turned away for a minute. */
function paired(p, addr, now) {
    if (!CFG.pairing) return true;
    const s = pair.strikes[addr];
    if (s && s.n >= STRIKES && now - s.at < 60000) return false;
    const want = Buffer.from(pairCode()), got = Buffer.from(typeof p.code === 'string' ? p.code : '');
    const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
    if (ok) { delete pair.strikes[addr]; return true; }
    pair.strikes[addr] = s && now - s.at < 60000 ? { n: s.n + 1, at: s.at } : { n: 1, at: now };
    const keys = Object.keys(pair.strikes);
    if (keys.length > 64) delete pair.strikes[keys[0]];
    if (pair.from !== addr) log('phone ' + addr + ': wrong pairing code');
    pair.refused++; pair.from = addr; pair.at = now;
    return false;
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
    // the part of Waze on cluster's HUD map the HUD really shows (seen on the car: a sign at the box's
    // right edge, moved right, was cut off), the sign in its corner
    let x0 = Math.max(b.x, HUD_SEEN.x), y0 = Math.max(b.y, HUD_SEEN.y);
    let x1 = Math.min(b.x + b.w, HUD_SEEN.x + HUD_SEEN.w), y1 = Math.min(b.y + b.h, HUD_SEEN.y + HUD_SEEN.h);
    if (x1 - x0 < s.hud + 16 || y1 - y0 < s.hud + 16) {
        x0 = HUD_SEEN.x; y0 = HUD_SEEN.y; x1 = HUD_SEEN.x + HUD_SEEN.w; y1 = HUD_SEEN.y + HUD_SEEN.h;
    }
    const hud = { size: s.hud, y: y0 + 8, x: d.hudSide === 'right' ? x1 - s.hud - 8 : x0 + 8 };
    if (d.mapPos) { map.x = d.mapPos.x; map.y = d.mapPos.y; }
    if (d.hudPos) { hud.x = d.hudPos.x; hud.y = d.hudPos.y; }
    map.x = Math.max(0, Math.min(MAP_W - s.map, map.x));
    map.y = Math.max(0, Math.min(MAP_H - s.map, map.y));
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
    return { seq: Number.isFinite(Number(m.seq)) ? Number(m.seq) : null, limit: limit || null, test: !!m.test, ver: typeof m.app === 'string' ? m.app.slice(0, 40) : null,
        code: typeof m.code === 'string' ? m.code.slice(0, 16) : typeof m.code === 'number' ? String(m.code) : null };
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
            if (L && L.visible) { cr.set(L.ref, { visible: false, opacity: 1 }); L.visible = false; }
            return;
        }
        if (!L || L.size !== w.size) {
            if (L) cr.drop(L.ref);
            const ref = cr.image({ target: t, klass: 'overlay', z: 10, x: w.x, y: w.y, w: w.size, h: w.size, iw: w.size, ih: w.size,
                visible: false, fps: 4, guide_hold: w.guide, contend: false });
            if (!ref) { renderer.error = 'cluster-render client refused the ' + t + ' layer'; return; }
            L = layers[t] = { ref, size: w.size, x: w.x, y: w.y, limit: null, look: null, anim: 0, visible: false, guide: w.guide };
            renderer.layers[t] = { state: 'made', reason: null };
        }
        if (L.limit !== want.limit) { cr.pixels(L.ref, null, sign(want.limit, w.size)); L.limit = want.limit; }
        if (L.x !== w.x || L.y !== w.y) { cr.set(L.ref, { x: w.x, y: w.y }); L.x = w.x; L.y = w.y; }
        if (L.guide !== w.guide) { cr.set(L.ref, { guide_hold: w.guide }); L.guide = w.guide; }
        if (!L.visible) { cr.set(L.ref, { visible: true, opacity: flash.opacity }); L.visible = true; }
    });
    flashing(!!want.warn && (want.map.visible || want.hud.visible));
}

/* ---------------- one look ---------------- */

let last = { shown: [], why: '', limit: null };
const cam = camera.createState({ holdKm: CFG.camHoldKm });
let lastWrite = 0, lastKey = '';

/* ---------------- the centre screen: the sign in a picture of it ---------------- */

/**
 * Once a second while it could show (the cluster or the HUD has Waze on cluster's map) and the phone
 * says nothing, BMW's grabber writes one JPEG of the centre screen (CarPlay with VietMap Live's widget)
 * and the sign in it is read (signread.js). A number counts once two pictures in a row agree; the
 * sign goes after two without it, and 4 s after the last picture.
 */
const screen = { running: false, startedAt: 0, at: 0, limit: 0, candidate: 0, misses: 0, shots: 0, fails: 0,
    ms: null, decodeMs: null, rings: [], error: null, geometry: CFG.screenGeometry, child: null };

function screenFile() { return path.join(CFG.run, 'centre.jpg'); }

function grabArgs() {
    const a = ['--screen=center'];
    if (screen.geometry) a.push('--geometry=' + screen.geometry);
    return a.concat(['--num-frames=1', '-p', 'jpeg_msdk(num_frames=1),file', screenFile()]);
}

function shootScreen(now) {
    screen.running = true;
    screen.startedAt = now;
    try { fs.unlinkSync(screenFile()); } catch (e) { /* none */ }
    let child, done = false, tail = '';
    const finish = (code, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        screen.child = null;
        screen.running = false;
        const t = Date.now();
        screen.ms = t - now;
        let img = null;
        try {
            if (err) throw err;
            const buf = fs.readFileSync(screenFile());
            const t0 = Date.now();
            const r = signread.read(jpeg.decode(buf));
            screen.decodeMs = Date.now() - t0;
            screen.shots++;
            screen.fails = 0;
            screen.error = null;
            screen.rings = r.rings.slice(0, 3);
            screen.size = null;
            img = r;
        } catch (e) {
            screen.fails++;
            screen.error = String(e.message || e).slice(0, 160) + (code ? ' (exit ' + code + ')' : '') + (tail ? ': ' + tail.trim().split('\n').pop().slice(0, 120) : '');
            // a grabber that will not scale: the whole screen from the next one
            if (screen.fails >= 2 && screen.geometry) { log('screen: no picture at ' + screen.geometry + ', the screen\'s own size next'); screen.geometry = ''; }
        }
        if (img) {
            const n = img.limit;
            if (n && (n === screen.limit || n === screen.candidate)) {
                if (n !== screen.limit) log('screen: sign ' + n);
                screen.limit = n;
                screen.candidate = 0;
                screen.misses = 0;
                screen.at = t;
            } else if (n) {
                screen.candidate = n;
                if (screen.limit) screen.at = t;
            } else {
                screen.candidate = 0;
                screen.misses++;
                if (screen.misses >= 2) { if (screen.limit) log('screen: no sign'); screen.limit = 0; }
                screen.at = t;
            }
        }
        try { fs.unlinkSync(screenFile()); } catch (e) { /* none */ }
    };
    try {
        child = cp.spawn(CFG.grabber, grabArgs(), { env: Object.assign({}, process.env, { XDG_RUNTIME_DIR: CFG.wayland }), stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { finish(null, e); return; }
    screen.child = child;
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-400); });
    child.on('error', (e) => finish(null, e));
    child.on('exit', (code) => finish(code, code ? new Error('grabber failed') : null));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } finish(null, new Error('grabber took over 5 s')); }, 5000);
}

/** The centre screen's sign now (0: none or not read), and whether it is being read. */
function screenSign(now) {
    const fresh = screen.at && now - screen.at < CFG.screenStaleMs;
    return fresh ? screen.limit : 0;
}

function decide(now) {
    const d = desired(now);
    const dr = previewDrag(now);
    if (dr) d[dr.t === 'map' ? 'mapPos' : 'hudPos'] = { x: dr.x, y: dr.y };
    const woc = wocStatus(now);
    const fresh = phone.at && now - phone.at < CFG.phoneStaleMs;
    const placing = preview(now);
    // BMW's front camera's sign first, then the phone's (VietMap), then the centre screen's
    const camLimit = d.on && d.camera ? camera.current(cam, now, log) : 0;
    // the centre screen is read while neither the camera nor the phone has a sign and the sign could show
    const reading = d.on && d.screen && !camLimit && !fresh && !placing && (woc.map || woc.hud) && renderer.installed !== false
        && (fs.existsSync(CFG.grabber) || !path.isAbsolute(CFG.grabber));
    if (reading && !screen.running && now - screen.startedAt >= CFG.screenMs) shootScreen(now);
    const onScreen = reading ? screenSign(now) : 0;
    // while it is being placed, 60 without any
    const source = camLimit ? 'camera' : fresh && phone.limit ? 'phone' : onScreen ? 'screen' : placing ? 'preview' : null;
    const limit = camLimit || (fresh && phone.limit) || onScreen || (placing ? PREVIEW_LIMIT : null);
    const bmw = bmwSign(now);
    const bmwShows = !!(bmw && bmw.fresh && bmw.valid && bmw.limit > 0);
    const suppress = d.bmw === 'hide' && bmwShows;
    const g = geometry(d, woc);
    const wantMap = d.on && d.show !== 'hud', wantHud = d.on && d.show !== 'cluster';
    const showOk = renderer.installed !== false && !!limit && (!suppress || placing);
    const speed = carSpeed(now);
    const over = !!limit && !placing && d.warn !== null && speed !== null && speed > limit + d.warn;
    const map = Object.assign({ visible: showOk && wantMap && woc.map, guide: woc.guideHold === 0 ? 0 : 1 }, g.map);
    const hud = Object.assign({ visible: showOk && wantHud && woc.hud, guide: woc.guideHold === 0 ? 0 : 1 }, g.hud);
    let why = '';
    if (!d.on) why = 'off in the app';
    else if (placing && !limit) why = '';
    else if (placing) why = !renderer.installed ? 'cluster-render is not installed' : !woc.known ? 'Waze on cluster is not installed'
        : !(wantMap && woc.map) && !(wantHud && woc.hud) ? 'Waze on cluster shows no map there' : '';
    else if (reading && !limit) why = screen.error ? 'the centre screen cannot be read' : 'no sign on the centre screen';
    else if (!limit && !phone.at) why = 'no phone yet';
    else if (!limit && !fresh) why = 'the phone stopped sending';
    else if (!limit) why = 'no sign in VietMap';
    else if (suppress) why = 'BMW shows its own sign';
    else if (!renderer.installed) why = 'cluster-render is not installed';
    else if (!woc.known) why = 'Waze on cluster is not installed';
    else if (!(wantMap && woc.map) && !(wantHud && woc.hud)) why = 'Waze on cluster shows no map there';
    return { d, woc, placing, reading, speed, over, source, bmw: bmw ? { limit: bmw.limit, valid: bmw.valid, fresh: bmw.fresh, suppress } : null, limit, map, hud, why };
}

function tick() {
    const now = Date.now();
    if (now - fw.checkedAt >= CFG.ruleMs) ensureRules(now);
    if (!cr) startRenderer();
    appRunDir(now);
    pairToApp(now);
    const s = decide(now);
    if (CFG.camera) manageProbe(s.d.probe, now);
    applyLayers({ limit: s.limit, map: s.map, hud: s.hud, warn: s.over });
    last = { shown: ['map', 'hud'].filter((t) => s[t].visible), why: s.why, limit: s.limit };
    const key = JSON.stringify([last, s.bmw, renderer, fw.error, s.d, s.placing, s.reading, s.over, s.woc.map, s.woc.hud, phone.from, phone.bad, phone.ignored,
        screen.limit, screen.error, screen.shots, cam.limit, cam.signs, cam.ready, cam.error, cam.up, ownSpeed(now) !== null, pair.refused, appRun.dir, appRun.uid, pair.code]);
    if (key !== lastKey || now - lastWrite > 2000) { writeStatus(s, now); lastKey = key; lastWrite = now; }
    return s;
}

function writeStatus(s, now) {
    const st = {
        tool: VERSION, at: new Date(now).toISOString(), app: s.d.app, settings: s.d, port: CFG.port,
        phone: { from: phone.from, at: phone.at ? new Date(phone.at).toISOString() : null, ago_ms: phone.at ? now - phone.at : null,
            seq: phone.seq, limit: phone.limit, test: phone.test, app: phone.ver, packets: phone.packets, ignored: phone.ignored, bad: phone.bad },
        limit: s.limit, shown: last.shown, why: s.why, bmw: s.bmw,
        waze: { known: s.woc.known, fresh: s.woc.fresh, state: s.woc.state || null, map: s.woc.map, hud: s.woc.hud, hudBox: s.woc.hudBox || null },
        placing: s.placing,
        geometry: { map: { x: s.map.x, y: s.map.y, size: s.map.size, w: MAP_W, h: MAP_H, placed: !!s.d.mapPos },
            hud: { x: s.hud.x, y: s.hud.y, size: s.hud.size, w: HUD_W, h: HUD_H, placed: !!s.d.hudPos, seen: HUD_SEEN } },
        renderer: { installed: renderer.installed, connected: renderer.connected, backend: renderer.backend, error: renderer.error,
            layers: renderer.layers, targets: renderer.targets },
        firewall: { present: fw.present, rules: fw.rules, error: fw.error },
        source: s.source,
        speed: s.speed, over: s.over,
        // the app writes the car's speed only while this is false (this reads it itself otherwise)
        speed_own: ownSpeed(now) !== null,
        app_dir: appRun.dir, app_dir_error: appRun.error,
        // the code: also here, where the app surely reads it (the status is on the unit only, in RAM)
        pairing: { on: CFG.pairing, code: CFG.pairing ? pairCode() : null, refused: pair.refused, from: pair.from, ago_ms: pair.at ? now - pair.at : null, error: pair.error },
        probe: { on: s.d.probe, running: !!probe.child, bytes: (() => { try { return fs.statSync(probeLog()).size; } catch (e) { return 0; } })() },
        app_dir_owner: appRun.dir ? { uid: appRun.uid, gid: appRun.gid, by: appRun.by } : null,
        camera: { on: s.d.camera, ready: cam.ready, error: cam.error, up: cam.up, limit: cam.limit,
            at: cam.at ? new Date(cam.at).toISOString() : null, km: Math.round(cam.km * 10) / 10, seen: cam.signs,
            events: cam.events, last_event: cam.lastEventAt ? new Date(cam.lastEventAt).toISOString() : null },
        screen: { on: s.d.screen, reading: s.reading, limit: screen.limit, at: screen.at ? new Date(screen.at).toISOString() : null,
            shots: screen.shots, ms: screen.ms, decode_ms: screen.decodeMs, rings: screen.rings, error: screen.error,
            geometry: screen.geometry || 'full' },
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
        if (!paired(p, rinfo.address, now)) {
            // a phone that does not know the code: told so (it says so to its user), nothing changes
            const s = pair.strikes[rinfo.address];
            if (!s || s.n <= STRIKES) sock.send(Buffer.from(JSON.stringify({ t: 'vms-ack', v: 1, seq: p.seq, car: VERSION, paired: false, why: 'wrong code' })), rinfo.port, rinfo.address, () => {});
            if (onPacket) onPacket();
            return;
        }
        if (phone.from !== rinfo.address) log('phone: ' + rinfo.address + ':' + rinfo.port + (p.ver ? ' (' + p.ver + ')' : ''));
        if (phone.limit !== p.limit) log('sign: ' + (p.limit || 'none') + (p.test ? ' (test)' : ''));
        const ver = p.ver || (phone.from === rinfo.address ? phone.ver : null);
        Object.assign(phone, { from: rinfo.address, at: now, seq: p.seq, limit: p.limit, test: p.test, ver });
        phone.packets++;
        if (onPacket) onPacket();
        const ack = Buffer.from(JSON.stringify({ t: 'vms-ack', v: 1, seq: p.seq, car: VERSION, paired: true, shown: last.shown, why: last.why }));
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
    if (CFG.camera) camera.start(cam, { run: CFG.run, catalog: CFG.catalog, gen: CFG.gen, someip: CFG.someip, log });
    if (CFG.pairing) pairCode();
    const quit = (sig) => {
        log('stopping (' + sig + ')');
        clearTimeout(timer);
        flashing(false);
        manageProbe(false, Date.now());
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
    ensureRules, removeRules, ourRules, listen, phone, renderer, layers, _last: () => last, _cam: cam, BLINK,
    _reset: () => { appCache = null; appScanAt = 0; appRun.dir = null; appRun.checkedAt = 0; appRun.proc = null; appRun.procAt = 0; },
    appRunDir, carSpeed, preview, previewDrag, ownSpeed, pairCode, setCode, pair, appRun, readSmall, writeInto,
};
