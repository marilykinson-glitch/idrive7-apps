'use strict';
/**
 * vietmap-cluster - the root helper of the VietMap on cluster app (apps/vietmap_cluster).
 *
 * VietMap Live (like most Android Auto apps) draws no map of its own for the cluster, so this copies
 * the centre screen instead: BMW's own screen grabber (winston-grabber) captures the "center" screen,
 * encodes it as H.264/RTP and sends it to waze-on-cluster's local UDP port; waze-on-cluster (from
 * robertnisipeanu/idrive-apps, installed separately) decodes it and draws it in the cluster's map area
 * and on the HUD, as it does the phone's own cluster map.
 *
 * While the app's "VietMap on cluster" is on, /run/vietmap-cluster/woc.env holds
 *     WOC_SRC_CROP=-s avb_stream= -s src_crop=<the view's crop>
 * which this tool's drop-in for waze-on-cluster.service reads after waze-on-cluster's own crop file,
 * so waze-on-cluster runs without the phone's cluster stream and crops the copied screen; the service
 * is restarted when that changes. Off, at a stop of this tool, a removal (deactivate) and after every
 * boot (/run is in memory) the file is gone and waze-on-cluster runs exactly as installed. Nothing of
 * waze-on-cluster, CarPlay or Android Auto is patched or edited.
 *
 * The app's choices are its own settings file (data/settings.json, written by the kit), read every
 * 2 s. The state goes to /run/vietmap-cluster/status.json (0644), which the app shows.
 *
 *   node vietmap-cluster.js run          the service (vietmap-cluster.service)
 *   node vietmap-cluster.js deactivate   undo, for the Store's removal (no service running)
 *   node vietmap-cluster.js status       print the status file
 *
 * Node 8 (the head unit's), no dependencies. MIT, as the rest of this repository.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const VERSION = '0.1.0';
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CFG = {
    oap: env('VMC_OAP', '/var/opt/public/oap'),
    run: env('VMC_RUN', '/run/vietmap-cluster'),
    grabber: env('VMC_GRABBER', '/usr/bin/winston-grabber'),
    systemctl: env('VMC_SYSTEMCTL', 'systemctl'),
    wocDir: env('VMC_WOC_DIR', '/var/opt/waze-on-cluster'),
    wocRun: env('VMC_WOC_RUN', '/run/waze-on-cluster'),
    wocUnit: 'waze-on-cluster.service',
    pollMs: Number(env('VMC_POLL_MS', 2000)),
    wayland: env('VMC_XDG_RUNTIME_DIR', '/run/wayland'),
};
const APP = /^vietmap_cluster\d*$/;          // the app's id (the Store may install it as vietmap_cluster2)
const ENV_FILE = () => path.join(CFG.run, 'woc.env');
const STATUS_FILE = () => path.join(CFG.run, 'status.json');

/**
 * What the copy looks like: the centre screen (1920x720, Android Auto's bar 128 px on the left) is
 * captured at `geometry`, and the cluster's 1088x480 map area shows `crop` of it, 1:1. Fit: most of
 * the map, scaled down; the zooms: smaller parts around the map's centre, sharper and bigger.
 * Every number even (waze-on-cluster's src_crop).
 */
const VIEWS = {
    fit: { geometry: '1280x480', crop: '1280x480:136,0,1088,480', cbr: '2M' },
    zoom1: { geometry: '1600x600', crop: '1600x600:308,60,1088,480', cbr: '3M' },
    zoom2: { geometry: '1920x720', crop: '1920x720:480,120,1088,480', cbr: '4M' },
};
const FPS = 15;

function log(msg) { process.stdout.write(new Date().toISOString() + ' ' + msg + '\n'); }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function readJson(p) { const t = readText(p); try { return t === null ? null : JSON.parse(t); } catch (e) { return null; } }
function writeAtomic(p, text, mode) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, text, { mode: mode || 0o644 });
    fs.renameSync(tmp, p);
}

/* ---------------- the app: where it is and what it asks for ---------------- */

let appCache = null, appScanAt = 0;
/** { id, root } of the installed app, or null. Looked for again every 10 s while missing. */
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

/** The app's settings in effect: its defaults (app-spec.json) under what it saved (data/settings.json). */
function desired(now) {
    const app = findApp(now);
    if (!app) return { app: null, on: false, view: 'fit' };
    const spec = readJson(app.spec) || {};
    const values = {};
    (spec.settings || []).forEach((s) => { values[s.key] = s.default; });
    Object.assign(values, readJson(path.join(app.root, 'data', 'settings.json')) || {});
    return { app: app.id, on: values.mode === 'on', view: VIEWS[values.view] ? values.view : 'fit' };
}

/* ---------------- waze-on-cluster ---------------- */

function wocInstalled() { return fs.existsSync(path.join(CFG.wocDir, 'current')); }

/** waze-on-cluster's local UDP port (its conf, then its local conf), 20557 by default. */
function udpPort() {
    let port = 20557;
    [path.join(CFG.wocDir, 'current', 'waze-on-cluster.conf'), path.join(CFG.wocDir, 'waze-on-cluster.local.conf')].forEach((f) => {
        (readText(f) || '').split('\n').forEach((line) => {
            const m = /^\s*udp_port\s*=\s*(\d+)\s*(#.*)?$/.exec(line);
            if (m && Number(m[1]) > 0 && Number(m[1]) < 65536) port = Number(m[1]);
        });
    });
    return port;
}

function wocStatus() {
    const s = readJson(path.join(CFG.wocRun, 'status.json'));
    return s ? { state: s.state || null, reason: s.reason || null } : { state: null, reason: null };
}

function envLine(view) { return 'WOC_SRC_CROP=-s avb_stream= -s src_crop=' + VIEWS[view].crop + '\n'; }

let lastRestart = { at: null, ok: null, error: null };
function restartWoc(why) {
    log('restarting ' + CFG.wocUnit + ': ' + why);
    const r = cp.spawnSync(CFG.systemctl, ['restart', CFG.wocUnit], { timeout: 30000, encoding: 'utf8' });
    const ok = r.status === 0 && !r.error;
    lastRestart = { at: new Date().toISOString(), ok, error: ok ? null : String((r.error && r.error.message) || r.stderr || ('exit ' + r.status)).trim().slice(0, 200) };
    if (!ok) log('restart failed: ' + lastRestart.error);
    return ok;
}

/** The env file says what is wanted (view, or null to remove it); waze-on-cluster restarts when it changed. */
function applyEnv(view) {
    const want = view ? envLine(view) : null;
    const have = readText(ENV_FILE());
    if (have === want) return false;
    if (want) writeAtomic(ENV_FILE(), want, 0o644);
    else { try { fs.unlinkSync(ENV_FILE()); } catch (e) { /* gone */ } }
    if (wocInstalled()) restartWoc(view ? 'centre screen, view ' + view : 'back to the phone\'s cluster map');
    return true;
}

/* ---------------- the grabber ---------------- */

let grab = null;                  // { child, view, since, stopping }
let failures = 0, nextStart = 0, restarts = 0, lastExit = null;
const tail = [];

function grabArgs(view, port) {
    const v = VIEWS[view];
    return ['--screen=center', '--geometry=' + v.geometry, '--fps=' + FPS, '--num-frames=0',
        '--pipeline=h264_msdk(gop=' + FPS + ',gop_ref_dist=1,cbr=' + v.cbr + '), rtp, udp', 'udp://127.0.0.1:' + port];
}

function startGrab(view, now) {
    const args = grabArgs(view, udpPort());
    log('grabber: ' + CFG.grabber + ' ' + args.join(' '));
    let child;
    try {
        child = cp.spawn(CFG.grabber, args, { env: Object.assign({}, process.env, { XDG_RUNTIME_DIR: CFG.wayland }), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        lastExit = { at: new Date().toISOString(), error: e.message };
        failures++; nextStart = now + backoff();
        return;
    }
    const g = { child, view, since: now, stopping: false };
    grab = g;
    const keep = (d) => String(d).split('\n').forEach((l) => { if (l.trim()) { tail.push(l.trim().slice(0, 200)); if (tail.length > 8) tail.shift(); } });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => { keep('error: ' + e.message); });
    child.on('exit', (code, signal) => {
        if (grab === g) grab = null;
        const t = Date.now();
        lastExit = { at: new Date(t).toISOString(), code, signal, line: tail.length ? tail[tail.length - 1] : null };
        if (g.stopping) return;
        if (t - g.since > 60000) failures = 0;     // it ran a while: start again soon
        failures++; restarts++;
        nextStart = t + backoff();
        log('grabber ended (' + (signal || 'exit ' + code) + '); again in ' + Math.round((nextStart - t) / 1000) + ' s');
    });
}

function backoff() { return Math.min(60000, 3000 * Math.pow(2, Math.max(0, failures - 1))); }

function stopGrab() {
    const g = grab;
    if (!g) return;
    g.stopping = true;
    grab = null;
    try { g.child.kill('SIGTERM'); } catch (e) { /* gone */ }
    const t = setTimeout(() => { try { g.child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
    if (t.unref) t.unref();
    log('grabber stopped');
}

/* ---------------- one look ---------------- */

let lastWanted = null;
function tick() {
    const now = Date.now();
    const d = desired(now);
    const woc = wocInstalled();
    const grabberThere = fs.existsSync(CFG.grabber) || !path.isAbsolute(CFG.grabber);
    let error = null;
    const key = JSON.stringify(d);
    if (key !== lastWanted) { log('wanted: ' + (d.app ? (d.on ? 'on, view ' + d.view : 'off') : 'no app installed')); lastWanted = key; failures = 0; nextStart = 0; }
    if (d.on && !woc) error = 'Waze on cluster is not installed';
    else if (d.on && !grabberThere) error = 'winston-grabber not found';
    if (d.on && !error) {
        applyEnv(d.view);
        if (grab && grab.view !== d.view) stopGrab();
        if (!grab && now >= nextStart) startGrab(d.view, now);
        if (!grab && failures) error = 'screen grabber stopped' + (lastExit && lastExit.line ? ': ' + lastExit.line : '');
    } else {
        stopGrab();
        applyEnv(null);
    }
    writeStatus(d, error, now);
}

function writeStatus(d, error, now) {
    const s = {
        tool: VERSION, at: new Date(now).toISOString(), app: d.app, on: d.on, view: d.view,
        applied: readText(ENV_FILE()) !== null,
        waze: Object.assign({ installed: wocInstalled() }, wocStatus(), { restart: lastRestart }),
        grabber: { running: !!grab, pid: grab ? grab.child.pid : null, since: grab ? new Date(grab.since).toISOString() : null,
            restarts, lastExit, tail: tail.slice(-3) },
        error,
    };
    try { writeAtomic(STATUS_FILE(), JSON.stringify(s, null, 1) + '\n', 0o644); } catch (e) { log('status: ' + e.message); }
}

/* ---------------- commands ---------------- */

function systemStopping() {
    const r = cp.spawnSync(CFG.systemctl, ['is-system-running'], { timeout: 3000, encoding: 'utf8' });
    return /stopping/.test(String(r.stdout || ''));
}

function run() {
    try { fs.mkdirSync(CFG.run, 0o755); } catch (e) { /* there */ }
    log('vietmap-cluster ' + VERSION + ' started');
    let timer = null;
    const loop = () => {
        try { tick(); } catch (e) { log('tick: ' + (e && e.stack || e)); }
        timer = setTimeout(loop, CFG.pollMs);
    };
    const quit = (sig) => {
        log('stopping (' + sig + ')');
        clearTimeout(timer);
        stopGrab();
        // a stop of the service puts waze-on-cluster back as installed, but not while the head unit
        // shuts down (/run goes with it)
        if (readText(ENV_FILE()) !== null) {
            try { fs.unlinkSync(ENV_FILE()); } catch (e) { /* gone */ }
            if (!systemStopping() && wocInstalled()) restartWoc('vietmap-cluster stopped');
        }
        setTimeout(() => process.exit(0), 200);
    };
    process.on('SIGTERM', () => quit('SIGTERM'));
    process.on('SIGINT', () => quit('SIGINT'));
    loop();
}

/** The Store's removal: nothing of ours left in effect. Succeeds when there is nothing to undo. */
function deactivate() {
    const had = readText(ENV_FILE()) !== null;
    try { fs.unlinkSync(ENV_FILE()); } catch (e) { /* gone */ }
    if (had && wocInstalled()) restartWoc('vietmap-cluster removed');
    process.stdout.write(JSON.stringify({ status: had ? 'waze-on-cluster back to the phone\'s cluster map' : 'nothing to undo' }) + '\n');
}

if (require.main === module) {
    const cmd = process.argv[2] || 'run';
    if (cmd === 'run') run();
    else if (cmd === 'deactivate') deactivate();
    else if (cmd === 'status') process.stdout.write((readText(STATUS_FILE()) || '{}\n'));
    else { process.stderr.write('usage: node vietmap-cluster.js run|deactivate|status\n'); process.exit(2); }
}

module.exports = { VIEWS, CFG, grabArgs, envLine, desired, findApp, tick, udpPort, stopGrab, _state: () => ({ grab, failures, restarts }) };
