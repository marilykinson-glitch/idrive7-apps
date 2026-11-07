'use strict';
/**
 * ui.js - the VietMap on cluster screen, a pure draw(cv, G, t, v, act) for the car and the preview.
 *
 * Left: the centre screen as a picture (Android Auto's bar on its left) with the part the cluster
 * shows in the current view. Right: on or off, the view, and what the helper reports (the copy, the
 * cluster map). Bottom: On, Off, the view (each press picks the next).
 *
 * v = { on, view, views: [[key, label]], pending, lines: [{ text, kind }], note, noteKind }
 */
const W = 1600, H = 520;

// the part of the 1920x720 centre screen each view shows (vietmap-cluster.js VIEWS, in native pixels)
const CROPS = {
    fit: [204, 0, 1632, 720],
    zoom1: [370, 72, 1306, 576],
    zoom2: [480, 120, 1088, 480],
};
const AA_BAR = 128;

function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);
    G.frame(cv, t, ['VietMap on cluster'], 0, []);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    const on = !!v.on;
    const go = t.go || '#2fd27a', red = t.crit || '#ef2b2d';

    // --- the centre screen and the part the cluster gets ---
    const sw = 600, sh = sw * 720 / 1920, sx = 90, sy = G.TOP + 64;
    cv.text('Centre screen', sx, sy - 16, 18, t.dim, { font: 'label' });
    cv.roundRect(sx, sy, sw, sh, 10, G.withAlpha('#ffffff', 0.08));
    cv.roundRect(sx, sy, sw * AA_BAR / 1920, sh, 10, G.withAlpha('#ffffff', 0.05));
    // a few "roads" so it reads as a map
    const k = sw / 1920;
    [[300, 600, 1700, 300], [600, 80, 1100, 700], [1200, 650, 1850, 150], [450, 260, 1500, 560]].forEach((r) =>
        cv.line(sx + r[0] * k, sy + r[1] * k, sx + r[2] * k, sy + r[3] * k, 3, G.withAlpha('#ffffff', 0.16)));
    const c = CROPS[v.view] || CROPS.fit;
    const col = on ? (t.accent || '#81c4ff') : G.withAlpha('#ffffff', 0.35);
    cv.roundRect(sx + c[0] * k, sy + c[1] * k, c[2] * k, c[3] * k, 6, G.withAlpha(on ? (t.accent || '#81c4ff') : '#ffffff', 0.12));
    cv.strokeRoundRect(sx + c[0] * k, sy + c[1] * k, c[2] * k, c[3] * k, 6, 3, col);
    cv.text('Cluster', sx + (c[0] + c[2] / 2) * k, sy + (c[1] + c[3] / 2) * k + 8, 22, col, { align: 'center', font: 'bold' });
    cv.text('Open VietMap Live on the centre screen: the cluster shows what it shows', sx, sy + sh + 32, 16, t.dim, { font: 'label' });

    // --- on / off, view, the helper's report ---
    const rx = 820;
    cv.text(on ? 'ON' : 'OFF', rx, G.TOP + 100, 64, on ? go : t.text, { font: 'bold', spacing: 2 });
    const viewLabel = ((v.views || []).filter((o) => o[0] === v.view)[0] || [null, ''])[1];
    cv.text(viewLabel, rx, G.TOP + 140, 24, t.text, { font: 'label' });
    (v.lines || []).slice(0, 5).forEach((l, i) => {
        const cl = l.kind === 'warn' ? (t.warn || '#d29922') : l.kind === 'go' ? go : t.dim;
        cv.text(l.text, rx, G.TOP + 190 + i * 30, 18, cl, { font: 'label' });
    });

    if (v.note) {
        const nc = v.noteKind === 'warn' ? (t.warn || '#d29922') : v.noteKind === 'go' ? go : t.dim;
        cv.text(v.note, W / 2, bottom - 80, 18, nc, { align: 'center', font: 'label' });
    }

    // --- On / Off / view, the active one red (drawn where the app owns the screen) ---
    const specs = [['On', act.on, on], ['Off', act.off, !on], [viewLabel || 'View', act.view, false]];
    const bw = 260, bh = 56, gap = 26, by = bottom - 56;
    let bx = (W - (specs.length * bw + (specs.length - 1) * gap)) / 2;
    specs.forEach((s, i) => {
        const opts = { key: 'vmc' + i, busy: !!v.pending && i < 2 };
        if (s[2]) Object.assign(opts, { color: red, primary: true });
        G.button(cv, t, bx, by, bw, bh, s[0], s[1] || (() => {}), opts);
        bx += bw + gap;
    });
    return cv;
}

module.exports = { draw, W, H, CROPS };
