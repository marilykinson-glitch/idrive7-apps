'use strict';
/**
 * probe.js - looks for the speed limit BMW's own map knows (the one the cluster shows with no sign in the
 * camera's sight), which nothing here reads yet. Started by the helper while the app's setting "probe" is
 * on; read only: it subscribes to and reads fields and broadcasts, calls no method, writes nothing to the car.
 *
 * It searches the unit's SOME/IP catalogue for every interface and member whose name speaks of a speed
 * limit, a traffic sign, the electronic horizon, road attributes or map matching, writes what it found
 * (probe.log, in RAM), opens each instance of each as root (a value line names its instance) and writes every different value that comes, at most one line
 * per member every 2 s. The log goes to the Store's log with the tool vietmap-signs-log; the member whose
 * value follows the road's limit while driving is the one to use.
 *
 *   node probe.js run <log file> <tmp folder>
 *
 * Node 8, no dependencies.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const CATALOG = process.env.VMS_CATALOG || '/etc/oap/someip/someip-interfaces.json';
const SOMEIP = process.env.VMS_SOMEIP || '/usr/lib/someip.node';
const GEN = process.env.VMS_GEN || path.join(__dirname, 'gen.js');
const MAX_LOG = 400 * 1024;

const NAME = /speed.?limit|limit.?speed|traffic.?sign|road.?sign|sign.?recogn|speed.?info|legal.?speed|max(imum)?.?speed|e.?horizon|horizon|adas|road.?attr|road.?class|road.?type|map.?match|current.?(road|street|segment)|no.?passing|overtak|speed.?warn|speed.?camera/i;
const WIDE = /navigation|\.map|sign|limit|horizon|adas|kombi|cluster|assist|environment|position/i;
const MAX_IFACES = 30, MAX_FIELDS = 14, MAX_BROADCASTS = 8;

/** What to open: [{ name, fields, broadcasts, why }], the interfaces named for it first; and the wider list of names. */
function candidates(db) {
    const all = (db && db.interfaces) || {};
    const out = [];
    Object.keys(all).sort().forEach((name) => {
        const i = all[name] || {};
        const fields = Object.keys(i.fields || i.attributes || {}), broadcasts = Object.keys(i.broadcasts || i.events || {});
        const byName = NAME.test(name.replace(/^.*\./, '')) || NAME.test(name);
        const f = byName ? fields : fields.filter((x) => NAME.test(x));
        const b = byName ? broadcasts : broadcasts.filter((x) => NAME.test(x));
        if (!f.length && !b.length) return;
        out.push({ name, fields: f.slice(0, MAX_FIELDS), broadcasts: b.slice(0, MAX_BROADCASTS), why: byName ? 'name' : 'member',
            more: Math.max(0, f.length - MAX_FIELDS) + Math.max(0, b.length - MAX_BROADCASTS), methods: Object.keys(i.methods || {}).filter((x) => NAME.test(x)).slice(0, 10) });
    });
    // those named for a speed limit or a sign first, then the rest
    const rank = (c) => (/speed.?limit|traffic.?sign|sign/i.test(c.name + ' ' + c.fields.join(' ') + ' ' + c.broadcasts.join(' ')) ? 0 : 1);
    out.sort((a, b) => rank(a) - rank(b));
    return { open: out.slice(0, MAX_IFACES), left: out.slice(MAX_IFACES).map((c) => c.name), wide: Object.keys(all).filter((n) => WIDE.test(n)).sort() };
}

const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const within = (p, ms, what) => Promise.race([p, new Promise((r, j) => setTimeout(() => j(new Error(what + ': no answer in ' + ms + ' ms')), ms))]);

function run(logFile, tmp, o) {
    o = o || {};
    let size = 0;
    try { size = fs.statSync(logFile).size; } catch (e) { /* new */ }
    const say = (obj) => {
        const line = new Date().toISOString() + ' ' + JSON.stringify(obj) + '\n';
        try {
            if (size + line.length > MAX_LOG) { try { fs.renameSync(logFile, logFile + '.1'); } catch (e) { /* none */ } size = 0; }
            fs.appendFileSync(logFile, line);
            size += line.length;
        } catch (e) { /* the next one */ }
    };
    let db;
    try { db = JSON.parse(fs.readFileSync(o.catalog || CATALOG, 'utf8')); } catch (e) { say({ ev: 'note', text: 'no catalogue: ' + cut(e.message, 160) }); return Promise.resolve(0); }
    const c = candidates(db);
    db = null;
    say({ ev: 'start', open: c.open.length, left: c.left, wide: c.wide.length });
    for (let i = 0; i < c.wide.length; i += 25) say({ ev: 'names', names: c.wide.slice(i, i + 25) });
    c.open.forEach((x) => say({ ev: 'found', iface: x.name, why: x.why, fields: x.fields, broadcasts: x.broadcasts, methods: x.methods, more: x.more }));
    let someip;
    try { someip = o.someip || require(SOMEIP); } catch (e) { say({ ev: 'note', text: 'no someip binding: ' + cut(e.message, 160) }); return Promise.resolve(0); }
    try { cp.execFileSync('rm', ['-rf', tmp]); } catch (e) { /* none */ }
    try { fs.mkdirSync(tmp); } catch (e) { /* there */ }
    const held = [];
    const last = {}, lastAt = {}, pending = {};
    // each instance of a service is a source of its own: never one value line for two of them
    const got = (iface, name, kind, inst) => (v) => {
        const key = iface + '|' + inst + '|' + name, s = cut(JSON.stringify(v === undefined ? null : v), 1500), now = Date.now();
        if (s === last[key]) return;
        last[key] = s;
        const write = () => { lastAt[key] = Date.now(); pending[key] = null; say({ ev: 'value', iface, inst: String(inst), name, kind, value: last[key] }); };
        // at most one line per member every 2 s: the newest when the time is up
        if (now - (lastAt[key] || 0) >= 2000) write();
        else if (!pending[key]) pending[key] = setTimeout(write, 2000 - (now - lastAt[key]));
    };
    let up = 0, n = 0;
    // what the generator said went wrong: its Error line (its output starts with a page of its own source)
    const genError = (e) => {
        const text = String(e.stderr || '') + '\n' + String(e.stdout || '');
        const lines = text.split('\n').filter((l) => /Error|not found|unknown|undefined|cannot/i.test(l) && l.length < 300);
        return cut(lines.slice(-3).join(' | ') || text.slice(-300) || e.message, 400);
    };
    const one = (x, single) => {
        const dir = path.join(tmp, String(n++));
        let cfg;
        try {
            fs.mkdirSync(dir);
            const entry = { instances: '*' };
            if (x.fields.length) { entry.attributes = {}; x.fields.forEach((f) => { entry.attributes[f] = 'rs'; }); }
            if (x.broadcasts.length) entry.broadcasts = x.broadcasts;
            const proxies = {};
            proxies[x.name] = entry;
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ proxies, services: {} }));
            cp.execFileSync(process.execPath, [o.gen || GEN, o.catalog || CATALOG, path.join(dir, 'manifest.json'), '0', path.join(dir, 'out')], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
            cfg = JSON.parse(fs.readFileSync(path.join(dir, 'out', x.name.replace(/\./g, '_') + '.json'), 'utf8'));
        } catch (e) {
            say({ ev: 'proxy', iface: x.name, ok: false, members: x.fields.concat(x.broadcasts), note: 'description: ' + genError(e) });
            // one member the generator cannot describe spoils the lot: each alone then
            const parts = x.fields.map((f) => ({ name: x.name, fields: [f], broadcasts: [] })).concat(x.broadcasts.map((b) => ({ name: x.name, fields: [], broadcasts: [b] })));
            if (single || parts.length < 2) return Promise.resolve();
            let each = Promise.resolve();
            parts.forEach((p) => { each = each.then(() => one(p, true)); });
            return each;
        }
        const allInsts = Object.keys(cfg.instances || { 1: 1 }), insts = allInsts.slice(0, 6);
        if (allInsts.length > 1) say({ ev: 'instances', iface: x.name, all: allInsts, opened: insts });
        let chain = Promise.resolve();
        insts.forEach((inst) => {
            chain = chain.then(() => within(someip.buildProxy(cfg, String(inst)).then((p) => p.init().then(() => p)), 6000, 'proxy')).then((p) => {
                held.push(p);
                up++;
                say(Object.assign({ ev: 'proxy', iface: x.name, inst, ok: true }, single ? { members: x.fields.concat(x.broadcasts) } : {}));
                try { p.subscribeToAvailability((a) => say({ ev: 'available', iface: x.name, inst, up: !!a })); } catch (e) { /* older binding */ }
                x.fields.concat(x.broadcasts).forEach((name, k) => {
                    const kind = k < x.fields.length ? 'field' : 'broadcast', on = got(x.name, name, kind, inst);
                    try { Promise.resolve(p.subscribe({ name, onReceive: on })).catch((e) => say({ ev: 'note', text: x.name + '.' + name + ' subscribe (instance ' + inst + '): ' + cut(e && e.message || e, 160) })); } catch (e) { say({ ev: 'note', text: x.name + '.' + name + ' subscribe (instance ' + inst + '): ' + cut(e.message, 160) }); }
                    if (kind === 'field') {
                        const get = () => { try { Promise.resolve(p.getValue(name, 3000)).then(on).catch(() => {}); } catch (e) { /* no getter */ } };
                        setTimeout(get, 800 + k * 50);
                        setInterval(get, 10000);
                    }
                });
            }, (e) => { say({ ev: 'proxy', iface: x.name, inst, ok: false, note: cut(e && e.message || e, 200) }); });
        });
        return chain;
    };
    let all = Promise.resolve();
    c.open.forEach((x) => { all = all.then(() => one(x)); });
    return all.then(() => { say({ ev: 'ready', opened: up }); try { cp.execFileSync('rm', ['-rf', tmp]); } catch (e) { /* a temp folder */ } return up; });
}

if (require.main === module && process.argv[2] === 'run') {
    const log = process.argv[3], tmp = process.argv[4];
    const note = (t) => { try { fs.appendFileSync(log, new Date().toISOString() + ' ' + JSON.stringify({ ev: 'note', text: t }) + '\n'); } catch (e) { /* gone */ } };
    process.on('uncaughtException', (e) => { note('error: ' + cut(e && e.stack || e, 300)); process.exit(1); });
    process.on('unhandledRejection', (e) => note('rejected: ' + cut(e && e.message || e, 200)));
    process.on('SIGTERM', () => process.exit(0));
    run(log, tmp).then((up) => { if (!up) setTimeout(() => process.exit(0), 200); });
}

module.exports = { candidates, run, NAME };
