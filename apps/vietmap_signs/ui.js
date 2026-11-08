'use strict';
/**
 * ui.js - the VietMap signs screen, a pure draw(cv, G, t, v, act) for the car and the preview.
 *
 * Left: the sign the phone sends now (grey when there is none), as the cluster shows it. Right: on or
 * off, where it shows, and what the helper reports (the phone, BMW's own sign, the cluster, the HUD).
 * Bottom: On, Off, Show on (each press picks the next).
 *
 * v = { on, show, shows: [[key, label]], limit, phoneLimit, pending, lines: [{ text, kind }], note, noteKind,
 *       page (0: the sign, 1: Position), editing ('map' | 'hud'), status (the helper's), map / hud: geometry() }
 *
 * The Position page: pictures of the cluster's map area and the HUD with the sign on each; a tap on
 * one puts the sign's middle there (hit()), the buttons move the one being edited by STEP pixels.
 */
const W = 1600, H = 520;
const TABS = ['VietMap signs', 'Position'];
const STEP = 10;
// the sign's sizes and default places, as the helper has them (kit/vietmap-signs), for before it reports
const SIZES = { small: { map: 96, hud: 64 }, medium: { map: 128, hud: 80 }, large: { map: 160, hud: 100 } };
const TARGETS = { map: { w: 1088, h: 480 }, hud: { w: 800, h: 480 } };
// the pictures on the Position page: where, and how much smaller than the target
const PICS = { map: { x: 64, y: 132, k: 0.5 }, hud: { x: 680, y: 132, k: 0.5 } };

/** Where the sign is on a target: what the helper reports, else what is saved, else its default. */
function geometry(status, settings, t) {
    const T = TARGETS[t], k = t === 'map' ? ['mapX', 'mapY'] : ['hudX', 'hudY'];
    const size = (SIZES[settings && settings.get('size')] || SIZES.medium)[t];
    const g = status && status.geometry && status.geometry[t];
    const saved = settings && Number.isFinite(settings.get(k[0])) && Number.isFinite(settings.get(k[1]));
    let x, y;
    if (saved) { x = settings.get(k[0]); y = settings.get(k[1]); }
    else if (g) { x = g.x; y = g.y; }
    else if (t === 'map') { x = T.w - 200 - size; y = 36; }
    else { x = 138; y = 107; }
    return { x, y, size, w: T.w, h: T.h, placed: !!saved };
}

/** A tap on the Position page: { target, x, y } in that target's pixels, or null. */
function hit(px, py) {
    for (const t of ['map', 'hud']) {
        const p = PICS[t], T = TARGETS[t];
        const x = (px - p.x) / p.k, y = (py - p.y) / p.k;
        if (x >= 0 && y >= 0 && x <= T.w && y <= T.h) return { target: t, x, y };
    }
    return null;
}

function sign(cv, cx, cy, R, limit, t, G) {
    const on = !!limit;
    cv.circle(cx, cy, R, on ? '#ffffff' : G.withAlpha('#ffffff', 0.25));
    cv.circle(cx, cy, R * 0.93, on ? '#d71920' : G.withAlpha('#ffffff', 0.18));
    cv.circle(cx, cy, R * 0.69, on ? '#ffffff' : (t.bg || '#101418'));
    const text = on ? String(limit) : '–';
    const size = text.length >= 3 ? R * 0.62 : R * 0.78;
    cv.text(text, cx, cy + size * 0.36, size, on ? '#111111' : t.dim, { align: 'center', font: 'bold' });
}

function drawPosition(cv, G, t, v, act) {
    const go = t.go || '#2fd27a', acc = t.accent || '#81c4ff';
    const st = v.status || {};
    const limit = v.limit || v.phoneLimit || 60;
    cv.text('Tap a picture to put the sign there; the buttons move it ' + STEP + ' px', 64, G.TOP + 36, 18, t.dim, { font: 'label' });
    ['map', 'hud'].forEach((tg) => {
        const p = PICS[tg], T = TARGETS[tg], g = v[tg], on = v.editing === tg;
        const w = T.w * p.k, h = T.h * p.k;
        cv.text(tg === 'map' ? 'Cluster map' : 'HUD', p.x, p.y - 12, 18, on ? acc : t.text, { font: 'bold' });
        cv.roundRect(p.x, p.y, w, h, 8, G.withAlpha('#ffffff', 0.05));
        if (tg === 'map') {
            // the map area fades towards its sides: the clear middle
            cv.roundRect(p.x + 120 * p.k, p.y, (T.w - 240) * p.k, h, 8, G.withAlpha('#ffffff', 0.06));
        } else {
            const seen = (st.geometry && st.geometry.hud && st.geometry.hud.seen) || { x: 80, y: 90, w: 640, h: 300 };
            cv.roundRect(p.x + seen.x * p.k, p.y + seen.y * p.k, seen.w * p.k, seen.h * p.k, 6, G.withAlpha('#ffffff', 0.08));
            const box = st.waze && st.waze.hudBox;
            if (box) cv.strokeRoundRect(p.x + box.x * p.k, p.y + box.y * p.k, box.w * p.k, box.h * p.k, 4, 1.5, G.withAlpha(acc, 0.5));
        }
        cv.strokeRoundRect(p.x, p.y, w, h, 8, on ? 3 : 1.5, on ? acc : G.withAlpha('#ffffff', 0.25));
        const r = g.size * p.k / 2;
        sign(cv, p.x + (g.x + g.size / 2) * p.k, p.y + (g.y + g.size / 2) * p.k, r, limit, t, G);
        cv.text((g.placed ? 'Placed' : 'Default') + ' · ' + g.x + ', ' + g.y, p.x, p.y + h + 26, 16, t.dim, { font: 'label' });
    });
    const shown = (st.shown || []);
    const note = st.placing && shown.length ? 'The sign shows on ' + shown.map((x) => (x === 'map' ? 'the cluster' : 'the HUD')).join(' and ')
        : v.note || '';
    if (note) cv.text(note, 64, G.TOP + 440, 18, shown.length ? go : t.dim, { font: 'label' });
    // the buttons: which one, the four steps, the default place
    const bx = 1150, bw = 120, bh = 52;
    G.button(cv, t, bx, G.TOP + 64, 380, bh, v.editing === 'map' ? 'Editing: cluster' : 'Editing: HUD', act.editing || (() => {}), { key: 'vmsEd' });
    G.button(cv, t, bx + 130, G.TOP + 140, bw, bh, 'Up', act.up || (() => {}), { key: 'vmsUp' });
    G.button(cv, t, bx, G.TOP + 204, bw, bh, 'Left', act.left || (() => {}), { key: 'vmsL' });
    G.button(cv, t, bx + 260, G.TOP + 204, bw, bh, 'Right', act.right || (() => {}), { key: 'vmsR' });
    G.button(cv, t, bx + 130, G.TOP + 268, bw, bh, 'Down', act.down || (() => {}), { key: 'vmsDn' });
    G.button(cv, t, bx, G.TOP + 350, 380, bh, 'Default place', act.reset || (() => {}), { key: 'vmsRs' });
    return cv;
}

function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);
    G.frame(cv, t, TABS, v.page || 0, []);
    if (v.page === 1) {
        G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
        return drawPosition(cv, G, t, v, act);
    }
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    const on = !!v.on;
    const go = t.go || '#2fd27a', red = t.crit || '#ef2b2d';

    // --- the sign ---
    const cx = 330, cy = G.TOP + 175, R = 118;
    sign(cv, cx, cy, R, v.limit || v.phoneLimit, t, G);
    const cap = v.limit ? 'On the cluster now' : v.phoneLimit ? 'From the phone, not shown' : 'No sign from the phone';
    cv.text(cap, cx, cy + R + 40, 18, t.dim, { align: 'center', font: 'label' });

    // --- on / off, where, the helper's report ---
    const rx = 640;
    cv.text(on ? 'ON' : 'OFF', rx, G.TOP + 100, 64, on ? go : t.text, { font: 'bold', spacing: 2 });
    const showLabel = ((v.shows || []).filter((o) => o[0] === v.show)[0] || [null, ''])[1];
    cv.text(showLabel, rx, G.TOP + 140, 24, t.text, { font: 'label' });
    (v.lines || []).slice(0, 6).forEach((l, i) => {
        const cl = l.kind === 'warn' ? (t.warn || '#d29922') : l.kind === 'go' ? go : t.dim;
        cv.text(l.text, rx, G.TOP + 186 + i * 28, 18, cl, { font: 'label' });
    });

    if (v.note) {
        const nc = v.noteKind === 'warn' ? (t.warn || '#d29922') : v.noteKind === 'go' ? go : t.dim;
        cv.text(v.note, W / 2, bottom - 80, 18, nc, { align: 'center', font: 'label' });
    }

    // --- On / Off / Show on, the active one red (drawn where the app owns the screen) ---
    const specs = [['On', act.on, on], ['Off', act.off, !on], [showLabel || 'Show on', act.show, false]];
    const bw = 260, bh = 56, gap = 26, by = bottom - 56;
    let bx = (W - (specs.length * bw + (specs.length - 1) * gap)) / 2;
    specs.forEach((s, i) => {
        const opts = { key: 'vms' + i, busy: !!v.pending && i < 2 };
        if (s[2]) Object.assign(opts, { color: red, primary: true });
        G.button(cv, t, bx, by, bw, bh, s[0], s[1] || (() => {}), opts);
        bx += bw + gap;
    });
    return cv;
}

module.exports = { draw, W, H, geometry, hit, STEP, TABS, PICS };
