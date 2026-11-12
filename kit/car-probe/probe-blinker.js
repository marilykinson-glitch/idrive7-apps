'use strict';
// car-probe: where the car says which turn signal is on. Lists the catalog's fields, events and
// broadcasts named for a turn indicator / blinker, subscribes (as root, reading only) to the first 16
// that notify, and prints every change for LISTEN_MS: flick the turn signal left, right, then the
// hazard lights while it listens. Node 8.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const CATALOG = process.env.CP_CATALOG || '/etc/oap/someip/someip-interfaces.json';
const SOMEIP = process.env.CP_SOMEIP || '/usr/lib/someip.node';
const GEN = process.env.CP_GEN || path.join(__dirname, 'gen.js');
const LISTEN_MS = Number(process.env.CP_LISTEN_MS) || 45000;
const NAME = /turn.?indicat|direction.?indicat|blink|flasher|hazard.?warn|fahrtrichtung/i;
const t0 = Date.now();
const at = () => '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };

let db;
try { db = JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch (e) { console.log('no catalog: ' + e.message); process.exit(0); }
const found = [];
Object.keys(db.interfaces || {}).forEach((iface) => {
    const i = db.interfaces[iface];
    Object.keys(i.fields || {}).forEach((f) => {
        if (!NAME.test(f)) return;
        const d = i.fields[f] || {};
        const get = d.getter && d.getter.id, evt = d.notifier && d.notifier.id;
        found.push({ iface, member: f, kind: 'field', flags: (get ? 'r' : '') + (evt ? 's' : '') });
    });
    ['events', 'broadcasts'].forEach((k) => Object.keys(i[k] || {}).forEach((m) => {
        if (NAME.test(m)) found.push({ iface, member: m, kind: k, flags: 's' });
    }));
});
console.log(found.length + ' named for a turn signal:');
found.slice(0, 60).forEach((x) => console.log('  ' + x.iface.replace('de.bmw.', '') + ' ' + x.kind.replace(/s$/, '') + ' ' + x.member + ' [' + x.flags + ']'));

const listen = found.filter((x) => /s/.test(x.flags)).slice(0, 16);
let someip = null;
try { someip = require(SOMEIP); } catch (e) { console.log('someip binding: ' + cut(e.message, 200)); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'car-probe-b-'));
const held = [];
const tick = () => new Promise((r) => setImmediate(r));
const within = (p, ms, what) => Promise.race([p, new Promise((r, j) => setTimeout(() => j(new Error(what + ': no answer in ' + ms + ' ms')), ms))]);

async function one(x, n) {
    const tag = x.iface.split('.').pop() + '.' + x.member;
    const dir = path.join(tmp, String(n));
    fs.mkdirSync(dir);
    const entry = { instances: '1' };
    if (x.kind === 'field') { entry.attributes = {}; entry.attributes[x.member] = 's'; } else entry.broadcasts = [x.member];
    const proxies = {};
    proxies[x.iface] = entry;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ proxies, services: {} }));
    let cfg;
    try {
        cp.execFileSync(process.execPath, [GEN, CATALOG, path.join(dir, 'manifest.json'), '0', path.join(dir, 'out')], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
        cfg = JSON.parse(fs.readFileSync(path.join(dir, 'out', x.iface.replace(/\./g, '_') + '.json'), 'utf8'));
    } catch (e) {
        const text = String(e.stderr || '') + String(e.stdout || '') || e.message;
        console.log(tag + ': generator: ' + cut(text.split('\n').filter((l) => /Error/.test(l) && l.length < 500)[0] || text.slice(-200), 300));
        return;
    }
    try {
        await tick();
        const p = await within(someip.buildProxy(cfg, '1').then((px) => px.init().then(() => px)), 4000, 'proxy');
        held.push(p);
        await tick();
        try { p.subscribeToAvailability((a) => console.log(tag + ': availability ' + !!a + ' ' + at())); } catch (e) { /* older binding */ }
        let last = '', n2 = 0;
        await tick();
        await within(Promise.resolve(p.subscribe({ name: x.member, onReceive: (v) => {
            const s = JSON.stringify(v === undefined ? null : v);
            n2++;
            if (s !== last && n2 < 400) { last = s; console.log(tag + ' #' + n2 + ' ' + at() + ': ' + cut(s, 400)); }
        } })), 3000, 'subscribe');
        console.log(tag + ': subscribed ' + at());
    } catch (e) { console.log(tag + ': ' + cut(e && e.message || e, 200)); }
}

(async () => {
    for (let i = 0; i < listen.length; i++) await one(listen[i], i);
    console.log('listening ' + Math.round(LISTEN_MS / 1000) + ' s: turn signal left, right, hazard lights now');
    setTimeout(() => {
        try { cp.execFileSync('rm', ['-rf', tmp]); } catch (e) { /* a temp folder */ }
        console.log('blinker probe end ' + at());
        process.exit(0);
    }, LISTEN_MS);
})();
