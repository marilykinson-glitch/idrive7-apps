'use strict';
/**
 * VietMap on cluster - the centre screen's map (VietMap Live on Android Auto, or any app shown there)
 * on the instrument cluster and the HUD.
 *
 * VietMap Live draws no map for the cluster of its own (only Google Maps and Waze do, which Waze on
 * cluster shows), so its helper, the root tool vietmap-cluster (kit/vietmap-cluster, installed with
 * this app), copies the centre screen with BMW's own screen grabber into Waze on cluster, which draws
 * it in the cluster's map area and on the HUD (Waze on cluster's Show on). This app only says what is
 * wanted: its settings "mode" (on / off) and "view", saved by the kit in data/settings.json, which the
 * helper reads every 2 s; it shows what the helper reports in /run/vietmap-cluster/status.json.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const UI = require('./ui');
const { readStatus, report } = require('./status');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const views = settings.item('view').options;
        const set = (k, v) => { if (settings.get(k) !== v) { settings.set(k, v); log.info(k + ': ' + v); } repaint(); };
        const acts = {
            on: () => set('mode', 'on'),
            off: () => set('mode', 'off'),
            view: () => {
                const keys = views.map((o) => o[0]);
                set('view', keys[(keys.indexOf(settings.get('view')) + 1) % keys.length]);
            },
        };
        const render = async () => {
            const want = { on: settings.get('mode') === 'on', view: settings.get('view') };
            const r = report(readStatus(), want);
            const v = Object.assign({ on: want.on, view: want.view, views }, r);
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), v, acts);
            await ui.image('MAIN_GFX', cv);
        };
        const loop = ctx.loop('MAIN', 4, render);
        const repaint = () => (loop && loop.kick ? loop.kick() : render());

        ['BTN_ON', 'BTN_OFF', 'BTN_VIEW'].forEach((b) => ctx.hideButton && ctx.hideButton(b));
        ui.onClick('BTN_ON', acts.on);
        ui.onClick('BTN_OFF', acts.off);
        ui.onClick('BTN_VIEW', acts.view);
        settings.onChange(() => repaint());
        await render();
        log.info('vietmap_cluster ready (mode ' + settings.get('mode') + ', view ' + settings.get('view') + ')');
    },
});

