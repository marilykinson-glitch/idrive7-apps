'use strict';
// car-probe: listens for 25 minutes, as root, to what the car sends about speed limits while it drives
// (the front camera's sign event, FASuS, TSD, CCP) and writes each new word to a log that the next
// install of car-probe prints. Subscriptions only: nothing is written to the car. Node 8.
//   node probe-listen.js        listen (started by probe.sh, detached)
//   node probe-listen.js stop   stop a running one (component.json deactivate)
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const DIR = process.env.CP_DIR || (fs.existsSync('/var/opt/public') ? '/var/opt/public' : os.tmpdir());
const LOG = path.join(DIR, 'car-probe-listen.log'), PID = path.join(DIR, 'car-probe-listen.pid');
const CATALOG = process.env.CP_CATALOG || '/etc/oap/someip/someip-interfaces.json';
const SOMEIP = process.env.CP_SOMEIP || '/usr/lib/someip.node';
const GEN = process.env.CP_GEN || path.join(__dirname, 'gen.js');
const RUN_MS = Number(process.env.CP_RUN_MS) || 25 * 60000;
const MAX_LINES = 800;

if (process.argv[2] === 'stop') {
    try { process.kill(Number(fs.readFileSync(PID, 'utf8')), 'SIGTERM'); } catch (e) { /* none running */ }
    try { fs.unlinkSync(PID); } catch (e) { /* none */ }
    process.exit(0);
}

const TARGETS = [
    // the camera's signs, each in a few words (type, value, form, side, supplements); a new line when they change
    { iface: 'de.bmw.environmentalmodel.SignRecognitionFrontCamera', broadcasts: ['TrafficSignRecognitionFrontCamera'], brief: (v) => {
        if (!v || !Array.isArray(v.trafficSign)) return JSON.stringify(v);
        const r = v.trafficSignRecognition || {};
        return v.eventDataQualifier + ' ' + r.numberSigns + ' signs ' + r.speedLimitUnit + ': ' + v.trafficSign.slice(0, r.numberSigns === undefined ? 8 : r.numberSigns).map((g) => {
            const p = g.position || {};
            const sup = [g.firstSupplementalType, g.secondSupplementalType, g.additionalInfo].filter((x) => x && !/UNFILLED|NO_ADDITIONAL/.test(x));
            return g.type + '=' + g.value + ' ' + g.trafficSignForm + (p.left ? ' L' : '') + (p.right ? ' R' : '') + (p.overhead ? ' top' : '') + (g.variable ? ' variable' : '') + (sup.length ? ' [' + sup.join(',') + ']' : '');
        }).join(' | ');
    } },
    { iface: 'de.bmw.infotainment.fasus.FASuS', attributes: { statusNextSpeedLimitRecognition: 's', statusRoadSignConfigStatus: 's' } },
    { iface: 'de.bmw.dass.driverassistanceapplications.TrafficSignDisplayControl', attributes: { displaySpeedLimitAndNoPassingRestriction: 's' } },
    { iface: 'de.bmw.infotainment.navigation.externalize.adasng.CCP', broadcasts: ['effectiveSpeedLimit', 'variableSpeedLimitSign'] },
    { iface: 'de.bmw.infotainment.vehicle.Vehicle2', attributes: { statusCarSpeed2: 's' }, every: 30000, brief: (v) => (v && v.speedVehicleCentreOfGravity !== undefined ? Math.round(v.speedVehicleCentreOfGravity * 0.015625) + ' km/h' : JSON.stringify(v)) },
];
const KEEP = [], HEARD = {};
let lines = 0;
const say = (s) => {
    if (lines++ > MAX_LINES) return;
    try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + String(s).slice(0, 900) + '\n'); } catch (e) { /* full disk */ }
};
const end = (why) => { say('listen end: ' + why); try { fs.unlinkSync(PID); } catch (e) { /* gone */ } process.exit(0); };

fs.writeFileSync(LOG, '');
fs.writeFileSync(PID, String(process.pid));
process.on('SIGTERM', () => end('stopped'));
say('listen begin ' + new Date().toISOString() + ', ' + Math.round(RUN_MS / 60000) + ' min');
setTimeout(() => end('time'), RUN_MS);
// every 3 minutes: how many words each has sent so far, so a silence is told from a deaf listener
setInterval(() => say('heard so far: ' + (Object.keys(HEARD).map((k) => k.split('.').pop() + ' ' + HEARD[k]).join(', ') || 'nothing')), Number(process.env.CP_BEAT_MS) || 180000);

let someip;
try { someip = require(SOMEIP); } catch (e) { end('someip binding: ' + e.message); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'car-probe-l-'));

function generate(t, i) {
    const dir = path.join(tmp, String(i));
    fs.mkdirSync(dir);
    const entry = { instances: '1' };
    if (t.attributes) entry.attributes = t.attributes;
    if (t.broadcasts) entry.broadcasts = t.broadcasts;
    const proxies = {};
    proxies[t.iface] = entry;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ proxies, services: {} }));
    cp.execFileSync(process.execPath, [GEN, CATALOG, path.join(dir, 'manifest.json'), '0', path.join(dir, 'out')], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    return JSON.parse(fs.readFileSync(path.join(dir, 'out', t.iface.replace(/\./g, '_') + '.json'), 'utf8'));
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
    for (let i = 0; i < TARGETS.length; i++) {
        const t = TARGETS[i], tag = t.iface.split('.').pop();
        try {
            const cfg = generate(t, i);
            await tick();
            const p = await someip.buildProxy(cfg, '1').then((px) => px.init().then(() => px));
            KEEP.push(p);       // held for good: a proxy nothing refers to is collected, and its subscriptions with it
            await tick();
            try { p.subscribeToAvailability((a) => say(tag + ': availability ' + !!a)); } catch (e) { /* older binding */ }
            for (const m of Object.keys(t.attributes || {}).concat(t.broadcasts || [])) {
                let last = '', at = 0, n = 0;
                await tick();
                await p.subscribe({ name: m, onReceive: (v) => {
                    const s = (t.brief || JSON.stringify)(v === undefined ? null : v), now = Date.now();
                    n++;
                    HEARD[tag + '.' + m] = n;
                    // each new word; a signal that keeps changing (the speed) at most every t.every
                    if (s === last || (t.every && now - at < t.every)) return;
                    last = s; at = now;
                    say(tag + '.' + m + ' #' + n + ': ' + s);
                } });
                say(tag + '.' + m + ': subscribed');
            }
        } catch (e) {
            const text = String(e && e.stderr || '') || String(e && e.message || e);
            say(tag + ': ' + (text.split('\n').filter((l) => /Error/.test(l) && l.length < 500)[0] || text.slice(0, 300)));
        }
    }
    try { cp.execFileSync('rm', ['-rf', tmp]); } catch (e) { /* a temp folder */ }
})();
