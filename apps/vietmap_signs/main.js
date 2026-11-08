'use strict';
/**
 * VietMap signs - VietMap Live's speed-limit sign on the instrument cluster and the HUD.
 *
 * The VietMap signs phone app (android/vmsign) reads the number in VietMap Live's speed bubble and sends
 * it over the car's Wi-Fi to this app's helper, the root tool vietmap-signs (kit/vietmap-signs,
 * installed with this app), which draws the sign over Waze on cluster's map through cluster-render.
 * This app says what is wanted (its settings, saved by the kit in data/settings.json, which the helper
 * reads), shows what the helper reports (/run/vietmap-signs/status.json), and, while it runs, writes
 * BMW's own speed limit (bmw.js: the cluster's sign, the car's map) to data/bmw_sign.json once a
 * second, so the helper can leave the cluster to BMW's sign while it shows one.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const UI = require('./ui');
const { readStatus, report } = require('./status');
const BMW = require('./bmw');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const shows = settings.item('show').options;
        const set = (k, v) => { if (settings.get(k) !== v) { settings.set(k, v); log.info(k + ': ' + v); } repaint(); };
        // --- the Position page: the sign placed by hand on the cluster and the HUD ---
        let page = 0;                       // 0: the sign, 1: Position
        let editing = 'map';                // which target the buttons move
        let status = null;
        const keys = (t) => (t === 'map' ? ['mapX', 'mapY'] : ['hudX', 'hudY']);
        const place = (t, x, y) => {
            const g = UI.geometry(status, settings, t);
            x = Math.round(Math.max(0, Math.min(g.w - g.size, x)));
            y = Math.round(Math.max(0, Math.min(g.h - g.size, y)));
            const k = keys(t);
            if (settings.get(k[0]) !== x) settings.set(k[0], x);
            if (settings.get(k[1]) !== y) settings.set(k[1], y);
            log.info('sign on ' + t + ' at ' + x + ',' + y);
            repaint();
        };
        const step = (dx, dy) => { const g = UI.geometry(status, settings, editing); place(editing, g.x + dx, g.y + dy); };
        const acts = {
            on: () => set('mode', 'on'),
            off: () => set('mode', 'off'),
            show: () => {
                const keys = shows.map((o) => o[0]);
                set('show', keys[(keys.indexOf(settings.get('show')) + 1) % keys.length]);
            },
            editing: () => { editing = editing === 'map' ? 'hud' : 'map'; repaint(); },
            left: () => step(-UI.STEP, 0),
            right: () => step(UI.STEP, 0),
            up: () => step(0, -UI.STEP),
            down: () => step(0, UI.STEP),
            reset: () => { keys(editing).forEach((k) => settings.set(k, null)); log.info('sign on ' + editing + ': default place'); repaint(); },
        };
        ctx.onTab((i) => { page = i; repaint(); });
        // a tap on a picture of the cluster or the HUD: the sign's middle goes there
        ctx.onTap((x, y) => {
            if (page !== 1) return;
            const hit = UI.hit(x, y);
            if (!hit) return;
            editing = hit.target;
            const g = UI.geometry(status, settings, hit.target);
            place(hit.target, hit.x - g.size / 2, hit.y - g.size / 2);
        });
        // while the Position page shows, the helper shows a sign to place (data/preview.json, every second)
        const previewFile = path.join(ctx.dataDir, 'preview.json');
        let previewAt = 0;
        const previewTick = () => {
            if (page !== 1 || Date.now() - previewAt < 1000) return;
            previewAt = Date.now();
            try { fs.writeFileSync(previewFile, JSON.stringify({ at: new Date().toISOString() })); } catch (e) { /* the next one */ }
        };

        // --- BMW's own sign (bmw.js: every place it may come from), for the screen and the helper ---
        const bmwSigns = BMW.start(ctx);

        // --- the car's speed, for the helper's warning above the sign (data/speed.json, up to 4 times a second) ---
        let speed = null, speedAt = 0, speedSaved = 0;
        const speedFile = path.join(ctx.dataDir, 'speed.json');
        const saveSpeed = () => {
            const now = Date.now();
            if (speed === null || now - speedSaved < 250) return;
            speedSaved = now;
            try {
                fs.writeFileSync(speedFile + '.tmp', JSON.stringify({ at: new Date(speedAt).toISOString(), kmh: speed }));
                fs.renameSync(speedFile + '.tmp', speedFile);
            } catch (e) { /* the next one */ }
        };
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (!Number.isFinite(raw) || raw === 65535) return;
                speed = Math.round(raw * 0.015625 * 10) / 10;       // BMW's scaling, km/h
                speedAt = Date.now();
                saveSpeed();
            },
        }, log).then((sub) => { if (sub.error) log.warn('speed: ' + sub.error); }).catch((e) => log.warn('speed: ' + e));
        // a car standing still sends no new speed: the last one again, so the helper knows it is current
        setInterval(() => { if (speed !== null) { speedAt = Date.now(); saveSpeed(); } }, 1000);

        const render = async () => {
            const want = { on: settings.get('mode') !== 'off', show: settings.get('show') };
            const b = Object.assign(bmwSigns.best(), { view: bmwSigns.view() });
            status = readStatus();
            previewTick();
            const r = report(status, want, b);
            const v = Object.assign({ on: want.on, show: want.show, shows, page, editing, status,
                map: UI.geometry(status, settings, 'map'), hud: UI.geometry(status, settings, 'hud') }, r);
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
