'use strict';
/**
 * ui.js - the VietMap signs screen, a pure draw(cv, G, t, v, act) for the car and the preview.
 *
 * Left: the sign the phone sends now (grey when there is none), as the cluster shows it. Right: on or
 * off, where it shows, and what the helper reports (the phone, BMW's own sign, the cluster, the HUD).
 * Bottom: On, Off, Show on (each press picks the next).
 *
 * v = { on, show, shows: [[key, label]], limit, phoneLimit, pending, lines: [{ text, kind }], note, noteKind }
 */
const W = 1600, H = 520;

function sign(cv, cx, cy, R, limit, t, G) {
    const on = !!limit;
    cv.circle(cx, cy, R, on ? '#ffffff' : G.withAlpha('#ffffff', 0.25));
    cv.circle(cx, cy, R * 0.93, on ? '#d71920' : G.withAlpha('#ffffff', 0.18));
    cv.circle(cx, cy, R * 0.69, on ? '#ffffff' : (t.bg || '#101418'));
    const text = on ? String(limit) : '–';
    const size = text.length >= 3 ? R * 0.62 : R * 0.78;
    cv.text(text, cx, cy + size * 0.36, size, on ? '#111111' : t.dim, { align: 'center', font: 'bold' });
}

function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);
    G.frame(cv, t, ['VietMap signs'], 0, []);
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

module.exports = { draw, W, H };
