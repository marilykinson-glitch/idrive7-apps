'use strict';
/**
 * VietMap signs - VietMap Live's speed-limit sign on the instrument cluster and the HUD.
 *
 * The VietMap signs phone app (android/vmsign) reads the number in VietMap Live's speed bubble and sends
 * it over the car's Wi-Fi to this app's helper, the root tool vietmap-signs (kit/vietmap-signs,
 * installed with this app), which draws the sign over Waze on cluster's map through cluster-render.
 * This app says what is wanted (its settings, saved by the kit in data/settings.json, which the helper
 * reads), and shows what the helper reports (/run/vietmap-signs/status.json). BMW's own front camera's
 * sign, which comes first, is read by the helper itself (apps are not given it).
 *
 * What changes often goes to the helper's folder for this app in RAM (/run/vietmap-signs/app), never to
 * flash: preview.json while the Position page shows, and the car's speed only while the helper says it
 * has none of its own (status speed_own false). The pairing code the phone app needs is there too.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const UI = require('./ui');
const { readStatus, report, RUN_APP, speedStamp } = require('./status');

/** A small file into the helper's folder for this app in RAM; false when it cannot be written there. */
function putRam(name, data) {
    const f = path.join(RUN_APP, name);
    try {
        fs.writeFileSync(f + '.tmp', data);
        fs.renameSync(f + '.tmp', f);
        return true;
    } catch (e) { return false; }
}
/** Into RAM, else (that folder not writable for this app: an older helper) the data folder, which it reads too. */
function put(name, data, dataDir) {
    if (putRam(name, data)) return true;
    try {
        const f = path.join(dataDir, name);
        fs.writeFileSync(f + '.tmp', data);
        fs.renameSync(f + '.tmp', f);
        return true;
    } catch (e) { return false; }
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const shows = settings.item('show').options;
        const set = (k, v) => { if (settings.get(k) !== v) { settings.set(k, v); log.info(k + ': ' + v); } repaint(); };
        // --- the Position page: the sign placed by hand on the cluster and the HUD ---
        let page = 0;                       // 0: the sign, 1: Position, 2: Pairing
        let editing = 'map';                // which target the buttons move
        let status = null;
        const keys = (t) => (t === 'map' ? ['mapX', 'mapY'] : ['hudX', 'hudY']);
        // a drag in progress: where the sign is now, saved when the finger comes up (settings are on flash)
        let drag = null;
        const clampTo = (t, x, y) => {
            const g = UI.geometry(status, settings, t);
            return { x: Math.round(Math.max(0, Math.min(g.w - g.size, x))), y: Math.round(Math.max(0, Math.min(g.h - g.size, y))) };
        };
        const place = (t, x, y) => {
            const at = clampTo(t, x, y);
            x = at.x; y = at.y;
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
            // a new pairing code: the helper makes it (the phone app then needs the new one)
            newCode: () => { if (put('pair-new', '1', ctx.dataDir)) { log.info('pairing: new code asked'); codeAt = 0; } repaint(); },
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
        // a finger on the sign in a picture drags it: on the car at once (the helper reads the settings it
        // shows), saved once when it comes up
        if (ctx.onDrag) ctx.onDrag((phase, x, y) => {
            const hit = UI.hit(x, y);
            if (phase === 'start') {
                // only on the Position page (a move, an end or a cancel ends what was begun there, wherever)
                if (page !== 1 || !hit) return false;
                const g = UI.geometry(status, settings, hit.target);
                const grab = Math.max(g.size, 90);
                if (Math.abs(hit.x - (g.x + g.size / 2)) > grab || Math.abs(hit.y - (g.y + g.size / 2)) > grab) return false;
                editing = hit.target;
                drag = { t: hit.target, offX: g.x - hit.x, offY: g.y - hit.y, x: g.x, y: g.y, at: Date.now() };
                repaint();
                return true;
            }
            if (!drag) return false;
            if (phase === 'move' || phase === 'end') {
                // the picture the drag began on, even when the finger leaves it
                const P = UI.PICS[drag.t];
                const tx = (x - P.x) / P.k, ty = (y - P.y) / P.k;
                const at = clampTo(drag.t, tx + drag.offX, ty + drag.offY);
                drag.x = at.x; drag.y = at.y; drag.at = Date.now();
            }
            if (phase === 'end') { const d = drag; drag = null; place(d.t, d.x, d.y); previewAt = 0; previewTick(); return true; }
            if (phase === 'cancel') drag = null;
            previewTick();
            repaint();
            return true;
        });
        // while the Position page shows, the helper shows a sign to place (data/preview.json, every second)
        let previewAt = 0;
        // (with a drag under way, where the sign is now: the helper shows it there at once, 12 times a second)
        const previewTick = () => {
            if (page !== 1 || Date.now() - previewAt < (drag ? 80 : 1000)) return;
            previewAt = Date.now();
            put('preview.json', JSON.stringify(Object.assign({ at: new Date().toISOString() }, drag ? { drag: { t: drag.t, x: drag.x, y: drag.y } } : {})), ctx.dataDir);
        };
        // the pairing code, as the helper gives it (a few times a minute is plenty)
        let code = null, codeAt = 0;
        const readCode = () => {
            // the helper's status has it (0.6.1 on), else its file in the RAM folder
            const sc = status && !status.stale && status.pairing && status.pairing.code;
            if (sc && /^\d{6}$/.test(String(sc))) return String(sc);
            if (Date.now() - codeAt < 3000) return code;
            codeAt = Date.now();
            try { const j = JSON.parse(fs.readFileSync(path.join(RUN_APP, 'pair.json'), 'utf8')); code = /^\d{6}$/.test(String(j.code)) ? String(j.code) : null; } catch (e) { code = null; }
            return code;
        };

        // --- the car's speed, for the helper's warning above the sign: only while the helper has none of its
        // own (it reads the car's speed itself as root; speed_own in its status), into RAM, up to 4 times a second ---
        let speed = null, speedAt = 0, heardAt = 0, speedSaved = 0, speedNeeded = false, neededAt = 0;
        const helperNeedsSpeed = () => {
            const now = Date.now();
            if (now - neededAt < 1000) return speedNeeded;
            neededAt = now;
            const s = readStatus();
            speedNeeded = !!s && !s.stale && s.speed_own === false;
            return speedNeeded;
        };
        const saveSpeed = () => {
            const now = Date.now();
            if (speed === null || now - speedSaved < 250 || !helperNeedsSpeed()) return;
            speedSaved = now;
            put('speed.json', JSON.stringify({ at: new Date(speedAt).toISOString(), kmh: speed }), ctx.dataDir);
        };
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (!Number.isFinite(raw) || raw === 65535) return;
                speed = Math.round(raw * 0.015625 * 10) / 10;       // BMW's scaling, km/h
                speedAt = heardAt = Date.now();
                saveSpeed();
            },
        }, log).then((sub) => { if (sub.error) log.warn('speed: ' + sub.error); }).catch((e) => log.warn('speed: ' + e));
        // a car standing still sends no new speed: the last one again, so the helper knows it is current -
        // only a standstill one, for a minute (speedStamp); a moving speed that stops coming goes stale
        setInterval(() => {
            const at = speedStamp(speed, heardAt, Date.now());
            if (at === null) return;
            speedAt = at;
            saveSpeed();
        }, 1000);

        const render = async () => {
            const want = { on: settings.get('mode') !== 'off', show: settings.get('show') };
            status = readStatus();
            if (drag && Date.now() - drag.at > 10000) drag = null;      // its finger's lift never came
            previewTick();
            const r = report(status, want);
            const geo = (t) => {
                const g = UI.geometry(status, settings, t);
                return drag && drag.t === t ? Object.assign({}, g, { x: drag.x, y: drag.y, placed: true }) : g;
            };
            const v = Object.assign({ on: want.on, show: want.show, shows, page, editing, status, code: readCode(), dragging: !!drag,
                map: geo('map'), hud: geo('hud') }, r);
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
