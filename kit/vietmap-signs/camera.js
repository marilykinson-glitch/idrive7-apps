'use strict';
/**
 * camera.js - the speed-limit sign BMW's front camera reads (de.bmw.environmentalmodel.
 * SignRecognitionFrontCamera, event TrafficSignRecognitionFrontCamera), and the car's speed
 * (de.bmw.infotainment.vehicle.Vehicle2, statusCarSpeed2), straight from the unit's SOME/IP binding.
 * Apps are not given the camera; this runs in the root helper. Subscriptions only: nothing is
 * written to the car.
 *
 * The camera says which signs it sees, one event a few seconds apart while it sees any:
 *   { eventDataQualifier: 'EVENT_DATA_AVAILABLE', trafficSignRecognition: { numberSigns: 2, speedLimitUnit: 'KM_H' },
 *     trafficSign: [ { type: 'SPEED_LIMIT', value: 60, firstSupplementalType: 'SS_TRUCK', ... }, { type: 'SPEED_LIMIT', value: 80 } ] }
 * not the limit in force. pick() makes that a limit for a car: speed limits only, none under a plate
 * for another vehicle class or a condition (truck, trailer, rain, a time, a distance ...); of those
 * left, the value most of them carry, the higher on a tie. A new limit holds until another, an
 * end-of-limit sign, or holdKm driven (the car's speed, integrated), else holdMin without a speed.
 * A different limit is taken at once when it is the only one in its event; next to another one, once a
 * second event within 8 s agrees.
 *
 * The interface descriptions come from BMW's own generator (gen.js, which loads it from the unit's
 * firmware) against the unit's catalog, made once into <run>/someip/. Node 8.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const TARGETS = {
    camera: { iface: 'de.bmw.environmentalmodel.SignRecognitionFrontCamera', broadcasts: ['TrafficSignRecognitionFrontCamera'] },
    speed: { iface: 'de.bmw.infotainment.vehicle.Vehicle2', attributes: { statusCarSpeed2: 's' } },
};
// a plate that says the sign is for another vehicle, or only sometimes / further on
const NOT_FOR_US = /TRUCK|TRAILER|BUS|LORRY|HGV|WEIGHT|TONN|TRACTOR|HAZARD|DANGEROUS|RAIN|SNOW|FOG|WET|ICE|TIME|DISTANCE|EXIT|SCHOOL|WORK|NIGHT|DAY|ARROW/;
const PLAIN = /^(SIGNAL_UNFILLED|NO_ADDITIONAL_RESTRICTION|GENERIC_SUPPLEMENTAL|NONE|NO_SUPPLEMENTAL.*)?$/;
const SPEED = /SPEED_LIMIT/, NOT_A_LIMIT = /END|CANCEL|MINIMUM|RECOMMEND|ADVIS|ZONE_END/;
const END = /(END|CANCEL|DERESTRICT)/, ENDS_WHAT = /(SPEED|LIMIT|ALL_RESTRICTION|RESTRICTIONS)/;

/** What one camera event says for a car: { limit (0: none), end, values (all speed limits seen), single }; null: nothing. */
function pick(v) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.trafficSign)) return null;
    if (v.eventDataQualifier && v.eventDataQualifier !== 'EVENT_DATA_AVAILABLE') return null;
    const r = v.trafficSignRecognition || {};
    if (r.speedLimitUnit && r.speedLimitUnit !== 'KM_H') return null;
    const n = Number.isFinite(r.numberSigns) ? r.numberSigns : v.trafficSign.length;
    const signs = v.trafficSign.slice(0, n);
    const count = {}, values = [];
    let end = false;
    signs.forEach((g) => {
        const type = String(g && g.type || '');
        if (END.test(type) && ENDS_WHAT.test(type)) { end = true; return; }
        if (!SPEED.test(type) || NOT_A_LIMIT.test(type)) return;
        const value = Number(g.value);
        if (!(value >= 5 && value <= 150 && value % 5 === 0)) return;
        values.push(value);
        const plates = [g.firstSupplementalType, g.secondSupplementalType, g.additionalInfo].map((x) => String(x || ''));
        if (plates.some((x) => !PLAIN.test(x) && NOT_FOR_US.test(x))) return;
        count[value] = (count[value] || 0) + 1;
    });
    const kept = Object.keys(count).map(Number);
    if (!kept.length) return values.length || end ? { limit: 0, end, values, single: false } : null;
    kept.sort((a, b) => count[b] - count[a] || b - a);
    return { limit: kept[0], end: false, values, single: kept.length === 1 };
}

/** The sign held: what events and the distance driven make of it. */
function createState(opts) {
    opts = opts || {};
    return {
        holdKm: opts.holdKm || 3, holdMin: opts.holdMin || 15, confirmMs: opts.confirmMs || 8000,
        limit: 0, at: 0, km: 0, candidate: 0, candidateAt: 0, events: 0, signs: '', lastEventAt: 0,
        speed: null, speedAt: 0, up: { camera: null, speed: null }, error: null, ready: false,
    };
}

function onEvent(st, v, now, log) {
    st.events++;
    st.lastEventAt = now;
    const p = pick(v);
    if (!p) return st.limit;
    st.signs = p.values.join(',') + (p.end ? ' end' : '');
    if (p.limit) {
        const take = !st.limit || p.limit === st.limit || p.single
            || (st.candidate === p.limit && now - st.candidateAt < st.confirmMs);
        if (take) {
            if (p.limit !== st.limit && log) log('camera: sign ' + p.limit + ' (saw ' + p.values.join(', ') + ')');
            st.limit = p.limit; st.at = now; st.km = 0; st.candidate = 0;
        } else { st.candidate = p.limit; st.candidateAt = now; }
    } else if (p.end && st.limit) {
        if (log) log('camera: end of ' + st.limit);
        st.limit = 0; st.at = now; st.km = 0; st.candidate = 0;
    }
    return st.limit;
}

function onSpeed(st, v, now) {
    const raw = v && v.speedVehicleCentreOfGravity;
    if (!Number.isFinite(raw) || raw === 65535) return;
    const kmh = raw * 0.015625;
    if (st.speed !== null && now - st.speedAt < 2000 && now > st.speedAt) st.km += (st.speed + kmh) / 2 * (now - st.speedAt) / 3600000;
    st.speed = Math.round(kmh * 10) / 10;
    st.speedAt = now;
}

/** The limit in force now, 0 for none; drops it once driven past or held too long. */
function current(st, now, log) {
    if (!st.limit) return 0;
    const driven = st.km >= st.holdKm;
    const stale = (st.speed === null || now - st.speedAt > 5000) && now - st.at > st.holdMin * 60000;
    if (driven || stale) {
        if (log) log('camera: ' + st.limit + ' dropped (' + (driven ? st.km.toFixed(1) + ' km driven' : 'held ' + st.holdMin + ' min') + ')');
        st.limit = 0; st.km = 0;
    }
    return st.limit;
}

/** The car's speed in km/h from here, null when older than 2 s. */
function speed(st, now) { return st.speed !== null && now - st.speedAt < 2000 ? st.speed : null; }

/* ---------------- the binding ---------------- */

let chain = Promise.resolve();
function nativeTick(fn) {        // the binding is called one call at a time, each from its own tick (see kit/runtime/signals.js)
    const run = () => new Promise((resolve, reject) => setImmediate(() => { try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); } }));
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
}

function generate(o, key) {
    const t = TARGETS[key];
    const dir = path.join(o.run, 'someip', key);
    const out = path.join(dir, t.iface.replace(/\./g, '_') + '.json');
    return new Promise((resolve, reject) => {
        try { return resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch (e) { /* made below */ }
        [o.run, path.join(o.run, 'someip')].forEach((d) => { try { fs.mkdirSync(d); } catch (e) { /* there */ } });
        try { fs.mkdirSync(dir); } catch (e) { /* there */ }
        const entry = { instances: '1' };
        if (t.attributes) entry.attributes = t.attributes;
        if (t.broadcasts) entry.broadcasts = t.broadcasts;
        const proxies = {};
        proxies[t.iface] = entry;
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ proxies, services: {} }));
        cp.execFile(process.execPath, [o.gen, o.catalog, path.join(dir, 'manifest.json'), '0', path.join(dir, 'gen')], { timeout: 30000 }, (err, so, se) => {
            if (err) {
                const line = String(se || so || err.message).split('\n').filter((l) => /Error/.test(l) && l.length < 400)[0];
                return reject(new Error('generator: ' + (line || err.message)));
            }
            try {
                const text = fs.readFileSync(path.join(dir, 'gen', path.basename(out)), 'utf8');
                fs.writeFileSync(out, text);
                resolve(JSON.parse(text));
            } catch (e) { reject(new Error('generator made nothing: ' + e.message)); }
        });
    });
}

/**
 * Subscribes to the camera and the speed; tries again a minute after anything fails.
 * o: { run, catalog, gen, someip (the binding's path, or the module itself for tests), log }.
 */
function start(st, o) {
    const log = o.log || (() => {});
    const held = [], done = {};         // the proxies, kept: one nothing refers to is collected with its subscriptions
    let binding = null;
    const attempt = () => {
        if (!binding) {
            try { binding = typeof o.someip === 'string' ? require(o.someip) : o.someip; } catch (e) { st.error = 'no SOME/IP binding: ' + e.message; return; }
        }
        const one = (key, member, handler) => (done[key] ? Promise.resolve() : generate(o, key)
            .then((cfg) => nativeTick(() => binding.buildProxy(cfg, '1').then((p) => p.init().then(() => p))))
            .then((p) => {
                held.push(p);
                return nativeTick(() => {
                    try { p.subscribeToAvailability((a) => { if (st.up[key] !== !!a) log(key + ': ' + (a ? 'available' : 'not available')); st.up[key] = !!a; }); } catch (e) { /* older binding */ }
                }).then(() => nativeTick(() => p.subscribe({ name: member, onReceive: (v) => { try { handler(v, Date.now()); } catch (e) { log(key + ': ' + e.message); } } })))
                    .then(() => { done[key] = true; });
            }));
        Promise.all([
            one('camera', 'TrafficSignRecognitionFrontCamera', (v, now) => onEvent(st, v, now, log)),
            one('speed', 'statusCarSpeed2', (v, now) => onSpeed(st, v, now)),
        ]).then(() => { st.ready = true; st.error = null; log('camera: listening'); })
            .catch((e) => { st.error = String(e && e.message || e).slice(0, 200); log('camera: ' + st.error + ' (again in 60 s)'); setTimeout(attempt, 60000); });
    };
    attempt();
    return held;
}

module.exports = { pick, createState, onEvent, onSpeed, current, speed, start, TARGETS };
