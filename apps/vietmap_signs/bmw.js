'use strict';
/**
 * bmw.js - BMW's own speed limit, the one the cluster shows (the car's map, or its camera), from the
 * SOME/IP places it may come from, all tried at once; what each gives is shown on the screen, and the
 * best is written to data/bmw_sign.json once a second for the helper (kit/vietmap-signs).
 *
 *   TSD    de.bmw.dass.driverassistanceapplications.TrafficSignDisplayControl,
 *          field displaySpeedLimitAndNoPassingRestriction: what the cluster draws
 *   Map    de.bmw.infotainment.navigation.externalize.adasng.CCP, event effectiveSpeedLimit: the head
 *          unit's own map at the car's place
 *   FASuS  de.bmw.infotainment.fasus.FASuS, field statusNextSpeedLimitRecognition
 *
 * Instances: what app.json "_instances" names (the generated config holds that one); see car-probe 0.2.0
 * for the catalog's names. Kit-free parsing (limitOf) for the tests.
 */
const fs = require('fs');
const path = require('path');

const SOURCES = [
    { key: 'tsd', name: 'TSD', iface: 'de.bmw.dass.driverassistanceapplications.TrafficSignDisplayControl', kind: 'field',
        member: 'displaySpeedLimitAndNoPassingRestriction' },
    { key: 'map', name: 'Map', iface: 'de.bmw.infotainment.navigation.externalize.adasng.CCP', kind: 'event', member: 'effectiveSpeedLimit' },
    { key: 'fasus', name: 'FASuS', iface: 'de.bmw.infotainment.fasus.FASuS', kind: 'field', member: 'statusNextSpeedLimitRecognition' },
];

const HIDDEN = /NO_?DISPLAY|NONE|^OFF|INVALID|NOT_|INACTIVE|UNKNOWN|NO_SIGN|UNLIMITED|NO_LIMIT/i;

/**
 * A speed limit in whatever a source sends: TSD's struct (displaySpeedLimit, invalidFlag,
 * displaySymbolStyle), a bare number, or a struct or enum with the number in a member named for a
 * speed or limit (or an enum value like SPEED_60). { limit (or null), valid, raw }.
 */
function limitOf(v) {
    const raw = v === undefined ? null : v;
    const num = (x) => {
        if (typeof x === 'number' && isFinite(x)) return x;
        if (typeof x === 'string' && !HIDDEN.test(x)) { const m = /(?:^|[^0-9])([0-9]{1,3})(?:[^0-9]|$)/.exec(x); return m ? Number(m[1]) : null; }
        return null;
    };
    const ok = (n) => n !== null && n >= 5 && n <= 150;
    if (v === null || v === undefined) return { limit: null, valid: false, raw };
    if (typeof v !== 'object') { const n = num(v); return { limit: ok(n) ? n : null, valid: ok(n), raw }; }
    const invalid = v.invalidFlag === true || Number(v.invalidFlag) === 1;
    const style = v.displaySymbolStyle;
    if (invalid || (typeof style === 'string' && HIDDEN.test(style)) || style === 0) return { limit: null, valid: false, raw };
    const keys = Object.keys(v);
    const pick = ['displaySpeedLimit'].concat(keys.filter((k) => /speed|limit/i.test(k) && !/unit|distance|length|counter|warning|supplement|offset|probab/i.test(k)));
    for (const k of pick) {
        if (!(k in v)) continue;
        const n = num(v[k]);
        if (ok(n)) return { limit: n, valid: true, raw };
    }
    return { limit: null, valid: false, raw };
}

/** Start every source; returns { best(), view() }. ctx: the kit's (signals, log, dataDir). */
function start(ctx) {
    const { log } = ctx;
    const state = {};
    SOURCES.forEach((s) => { state[s.key] = { name: s.name, connected: false, available: false, error: null, value: null, at: 0, raw: '', seenAvail: null }; });
    const setAvail = (st, s, a) => {
        a = !!a;
        if (st.seenAvail === a) return;
        st.seenAvail = a;
        st.available = a;
        log.info('BMW ' + s.name + ': ' + (a ? 'available (provider up)' : 'not available (provider down)'));
    };
    const got = (s) => (v) => {
        const st = state[s.key];
        st.value = limitOf(v);
        st.at = Date.now();
        setAvail(st, s, true); // a value only ever arrives once the provider is really there
        const raw = JSON.stringify(v === undefined ? null : v);
        if (raw !== st.raw) { st.raw = raw; log.info('BMW ' + s.name + ': ' + raw.slice(0, 300) + ' -> ' + (st.value.valid ? st.value.limit : 'none')); }
    };
    SOURCES.forEach((s) => {
        const st = state[s.key];
        if (s.kind === 'field') {
            ctx.signals.watch(s.iface, '1', { [s.member]: got(s) }, log)
                .then((sub) => {
                    st.sub = sub;
                    st.connected = true;
                    if (sub.error) { st.error = String(sub.error).slice(0, 120); log.warn('BMW ' + s.name + ': ' + sub.error); }
                    else log.info('BMW ' + s.name + ': proxy up, subscribed (' + s.iface + ')');
                    // watch()'s own availability is live on this same object - poll it in, since there is no callback out
                    setInterval(() => setAvail(st, s, sub.available), 1000);
                })
                .catch((e) => { st.error = String(e).slice(0, 120); log.warn('BMW ' + s.name + ': ' + e); });
        } else {
            Promise.resolve()
                .then(() => ctx.signals.proxy(s.iface, '1'))
                .then((p) => {
                    st.proxy = p;
                    st.connected = true;
                    log.info('BMW ' + s.name + ': proxy up (' + s.iface + ')');
                    // availability first, subscribe to the event second - the same order watch() uses for
                    // fields (and the only order the binding was ever seen to call back availability on)
                    return ctx.signals.onAvailable(p, (a) => setAvail(st, s, a))
                        .then(() => ctx.signals.on(p, s.member, got(s), log))
                        .then(() => log.info('BMW ' + s.name + ': subscribed to ' + s.member))
                        .catch((e) => { st.error = String(e).slice(0, 120); log.warn('BMW ' + s.name + ' subscribe: ' + e); });
                })
                .catch((e) => { st.error = String(e).slice(0, 120); log.warn('BMW ' + s.name + ': ' + e); });
        }
    });
    const live = (st) => st.available;
    /** The first source with a valid limit; or, of those that answer, that there is none. */
    const best = () => {
        for (const s of SOURCES) {
            const st = state[s.key];
            if (live(st) && st.value && st.value.valid) return { available: true, valid: true, limit: st.value.limit, source: s.name };
        }
        const any = SOURCES.some((s) => live(state[s.key]));
        return { available: any, valid: false, limit: null, source: null };
    };
    /**
     * One short line per source for the screen: "connecting" (no proxy yet), "error ..." (proxy or
     * subscribe failed), "no signal" (proxy/subscribe fine, but the car's provider is not up),
     * "waiting" (provider up, no value sent yet), or the number (or "none").
     */
    const view = () => SOURCES.map((s) => {
        const st = state[s.key];
        if (st.error) return s.name + ': error ' + st.error.replace(/^Error:\s*/, '').slice(0, 40);
        if (!st.connected) return s.name + ': connecting';
        if (!st.available) return s.name + ': no signal';
        if (!st.value) return s.name + ': waiting';
        return s.name + ': ' + (st.value.valid ? st.value.limit : 'none');
    }).join('  ·  ');
    // for the helper, once a second while anything answers
    const file = path.join(ctx.dataDir, 'bmw_sign.json');
    setInterval(() => {
        const b = best();
        if (!b.available) return;
        try {
            fs.writeFileSync(file + '.tmp', JSON.stringify({ at: new Date().toISOString(), limit: b.limit, valid: b.valid, source: b.source }));
            fs.renameSync(file + '.tmp', file);
        } catch (e) { /* the next second */ }
    }, 1000);
    return { best, view, state };
}

module.exports = { start, limitOf, SOURCES };
