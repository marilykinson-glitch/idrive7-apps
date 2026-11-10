'use strict';
// car-probe: as root, ask the car for BMW's speed limit where the app cannot: for each place it may be,
// BMW's own generator (gen.js, from the unit's firmware) makes the interface description, then the
// unit's SOME/IP binding is asked for the provider's availability, the field's value (getter) and
// what a subscription sends in the next seconds. Read only: no setter, no method is called. Node 8.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const CATALOG = process.env.CP_CATALOG || '/etc/oap/someip/someip-interfaces.json';
const SOMEIP = process.env.CP_SOMEIP || '/usr/lib/someip.node';
const GEN = process.env.CP_GEN || path.join(__dirname, 'gen.js');
const RUN_MS = Number(process.env.CP_RUN_MS) || 9000;
const N = 'de.bmw.infotainment.navigation.';
const TARGETS = [
    { iface: N + 'ADAS', attributes: { speedLimitProfileNavGraph2: 'r' } },
    { iface: N + 'ADAS', attributes: { navGraphExtendedSpeed: 'r' } },
    { iface: N + 'ADAS', attributes: { trafficSignNavGraph2: 'r' } },
    { iface: 'de.bmw.infotainment.fasus.FASuS', attributes: { statusNextSpeedLimitRecognition: 'rs' } },
    { iface: 'de.bmw.dass.driverassistanceapplications.TrafficSignDisplayControl', attributes: { displaySpeedLimitAndNoPassingRestriction: 's' } },
    { iface: N + 'externalize.adasng.CCP', broadcasts: ['effectiveSpeedLimit', 'speedLimitUnit', 'variableSpeedLimitSign'] },
    { iface: 'de.bmw.environmentalmodel.SignRecognitionFrontCamera', broadcasts: ['TrafficSignRecognitionFrontCamera'] },
];
const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const say = (s) => console.log(s);
const t0 = Date.now();
const at = () => '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';

// the catalog's own word on the fields asked for (getter / notifier ids)
try {
    const db = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    TARGETS.forEach((t) => Object.keys(t.attributes || {}).forEach((f) => {
        const fd = ((db.interfaces[t.iface] || {}).fields || {})[f];
        const own = {};
        Object.keys(fd || {}).forEach((k) => { if (k !== 'dataRef') own[k] = fd[k]; });
        say('catalog ' + t.iface.split('.').pop() + '.' + f + ': ' + (fd ? cut(JSON.stringify(own), 300) : 'not there'));
    }));
} catch (e) { say('catalog: ' + e.message); }

let someip = null;
try { someip = require(SOMEIP); } catch (e) { say('someip binding: ' + cut(e.message, 200)); }

let tmp;
try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'car-probe-')); } catch (e) { tmp = fs.mkdtempSync('/run/car-probe-'); }

function generate(t, i) {
    const dir = path.join(tmp, String(i));
    fs.mkdirSync(dir);
    const entry = { instances: '1' };
    if (t.attributes) entry.attributes = t.attributes;
    if (t.broadcasts) entry.broadcasts = t.broadcasts;
    const proxies = {};
    proxies[t.iface] = entry;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ proxies, services: {} }));
    try {
        cp.execFileSync(process.execPath, [GEN, CATALOG, path.join(dir, 'manifest.json'), '0', path.join(dir, 'out')], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    } catch (e) {
        const text = String(e.stderr || '') + String(e.stdout || '');
        const line = text.split('\n').filter((l) => /Error/.test(l) && l.length < 600)[0];
        return { error: cut(line || text.slice(-300) || e.message, 400) };
    }
    try { return { cfg: JSON.parse(fs.readFileSync(path.join(dir, 'out', t.iface.replace(/\./g, '_') + '.json'), 'utf8')) }; } catch (e) { return { error: 'no description made: ' + e.message }; }
}

const tick = () => new Promise((r) => setImmediate(r));
const within = (p, ms, what) => Promise.race([p, new Promise((r, j) => setTimeout(() => j(new Error(what + ': no answer in ' + ms + ' ms')), ms))]);

async function probe(t, i) {
    const members = Object.keys(t.attributes || {}).concat(t.broadcasts || []);
    const tag = t.iface.split('.').pop() + '.' + members.join('+');
    const g = generate(t, i);
    if (g.error) { say(tag + ': generator: ' + g.error); return; }
    const cfg = g.cfg;
    const part = {};
    members.forEach((m) => { const d = (cfg.fields || {})[m] || (cfg.events || {})[m]; if (d) { part[m] = {}; Object.keys(d).forEach((k) => { if (k !== 'schema') part[m][k] = d[k]; }); } });
    say(tag + ': description ok, serviceId ' + cfg.serviceId + ', instances ' + JSON.stringify(cfg.instances) + ', ' + cut(JSON.stringify(part), 300));
    if (!someip) return;
    for (const inst of Object.keys(cfg.instances || { 1: 1 })) {
        const who = tag + '@' + inst;
        let p;
        try {
            await tick();
            p = await within(someip.buildProxy(cfg, String(inst)).then((px) => px.init().then(() => px)), 4000, 'proxy');
        } catch (e) { say(who + ': proxy: ' + cut(e && e.message || e, 200)); continue; }
        say(who + ': proxy up ' + at() + (p.isAvailable ? ', available now: ' + p.isAvailable() : ''));
        try { await tick(); p.subscribeToAvailability((a) => say(who + ': availability ' + !!a + ' ' + at())); } catch (e) { say(who + ': subscribeToAvailability: ' + cut(e.message, 120)); }
        for (const m of members) {
            const flags = (t.attributes || {})[m] || 's';
            let seen = 0;
            if (/s/.test(flags)) {
                try {
                    await tick();
                    await within(Promise.resolve(p.subscribe({ name: m, onReceive: (v) => { if (seen++ < 3) say(who + ' ' + m + ' sent ' + at() + ': ' + cut(JSON.stringify(v), 700)); } })), 3000, 'subscribe');
                    say(who + ' ' + m + ': subscribed');
                } catch (e) { say(who + ' ' + m + ': subscribe: ' + cut(e && e.message || e, 200)); }
            }
            if (/r/.test(flags)) {
                const read = (n) => p.getValue(m, 3000)
                    .then((v) => say(who + ' ' + m + ' read ' + n + ' ' + at() + ': ' + cut(JSON.stringify(v), 900)))
                    .catch((e) => say(who + ' ' + m + ' read ' + n + ' ' + at() + ': failed: ' + cut(e && e.message || e, 200)));
                setTimeout(() => read(1), 500);
                setTimeout(() => read(2), 5000);
            }
        }
    }
}

(async () => {
    for (let i = 0; i < TARGETS.length; i++) {
        try { await probe(TARGETS[i], i); } catch (e) { say('probe ' + i + ': ' + cut(e && e.stack || e, 300)); }
    }
    setTimeout(() => {
        try { cp.execFileSync('rm', ['-rf', tmp]); } catch (e) { /* a temp folder */ }
        say('read probe end ' + at());
        process.exit(0);
    }, someip ? RUN_MS : 0);
})();
