'use strict';
/**
 * VietMap signs - VietMap Live's speed-limit sign on the instrument cluster and the HUD.
 *
 * The VietMap signs phone app (android/vmsign) reads the number in VietMap Live's speed bubble and sends
 * it over the car's Wi-Fi to this app's helper, the root tool vietmap-signs (kit/vietmap-signs,
 * installed with this app), which draws the sign over Waze on cluster's map through cluster-render.
 * This app says what is wanted (its settings, saved by the kit in data/settings.json, which the helper
 * reads), shows what the helper reports (/run/vietmap-signs/status.json), and, while it runs, writes
 * BMW's own displayed speed limit (SOME/IP TrafficSignDisplayControl) to data/bmw_sign.json once a
 * second, so the helper can leave the cluster to BMW's sign while it shows one.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const UI = require('./ui');
const { readStatus, report, bmwFrom } = require('./status');

const BMW_IFACE = 'de.bmw.dass.driverassistanceapplications.TrafficSignDisplayControl';
const BMW_FIELD = 'displaySpeedLimitAndNoPassingRestriction';

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const shows = settings.item('show').options;
        const set = (k, v) => { if (settings.get(k) !== v) { settings.set(k, v); log.info(k + ': ' + v); } repaint(); };
        const acts = {
            on: () => set('mode', 'on'),
            off: () => set('mode', 'off'),
            show: () => {
                const keys = shows.map((o) => o[0]);
                set('show', keys[(keys.indexOf(settings.get('show')) + 1) % keys.length]);
            },
        };

        // --- BMW's own sign, for the helper ---
        let bmw = null, bmwSub = null, lastRaw = '';
        const bmwFile = path.join(ctx.dataDir, 'bmw_sign.json');
        const onBmw = (v) => {
            bmw = bmwFrom(v);
            const raw = JSON.stringify(bmw.raw);
            if (raw !== lastRaw) { lastRaw = raw; log.info('BMW sign: ' + raw + (bmw.valid ? ' -> ' + bmw.limit : ' -> none')); }
        };
        ctx.signals.watch(BMW_IFACE, '1', { [BMW_FIELD]: onBmw }, log)
            .then((sub) => { bmwSub = sub; if (sub.error) log.warn('BMW sign: ' + sub.error); })
            .catch((e) => log.warn('BMW sign: ' + e));
        setInterval(() => {
            if (!bmwSub || !bmwSub.available || !bmw) return;
            try {
                fs.writeFileSync(bmwFile + '.tmp', JSON.stringify({ at: new Date().toISOString(), limit: bmw.limit, valid: bmw.valid, raw: bmw.raw }));
                fs.renameSync(bmwFile + '.tmp', bmwFile);
            } catch (e) { /* the next second */ }
        }, 1000);

        const render = async () => {
            const want = { on: settings.get('mode') !== 'off', show: settings.get('show') };
            const b = bmwSub ? Object.assign({ available: !!bmwSub.available }, bmw || { valid: false }) : null;
            const r = report(readStatus(), want, b);
            const v = Object.assign({ on: want.on, show: want.show, shows }, r);
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), v, acts);
            await ui.image('MAIN_GFX', cv);
        };
        const loop = ctx.loop('MAIN', 4, render);
        const repaint = () => (loop && loop.kick ? loop.kick() : render());

        ['BTN_ON', 'BTN_OFF', 'BTN_SHOW'].forEach((b) => ctx.hideButton && ctx.hideButton(b));
        ui.onClick('BTN_ON', acts.on);
        ui.onClick('BTN_OFF', acts.off);
        ui.onClick('BTN_SHOW', acts.show);
        settings.onChange(() => repaint());
        await render();
        log.info('vietmap_signs ready (mode ' + settings.get('mode') + ', show ' + settings.get('show') + ')');
    },
});
