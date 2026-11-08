'use strict';
/**
 * signread.js - the speed-limit sign in a picture of the centre screen (RGB, from jpeg.js): a red ring
 * (the sign's border, VietMap Live's widget on CarPlay among others) with dark digits on white inside,
 * the digits matched against templates of a few bold sans faces (digit-templates.json, baked by
 * kit/tools/bake_sign_templates.py). No dependencies, Node 8.
 *
 *   const { read } = require('./signread');
 *   read({ width, height, data })   // { limit (km/h, or 0), rings: [{ x, y, w, h, text, score, limit }] }
 *
 * Only a number a speed sign can carry counts: 5 to 150, a multiple of 5, each digit matched well.
 * MIT, as the rest of this repository.
 */
const fs = require('fs');
const path = require('path');

let TPL = null;
function templates() {
    if (TPL) return TPL;
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, 'digit-templates.json'), 'utf8'));
    const list = [];
    t.faces.forEach((f) => Object.keys(f.digits).forEach((d) => {
        const px = Buffer.from(f.digits[d].data, 'base64');
        list.push({ digit: Number(d), face: f.name, aspect: f.digits[d].aspect, norm: normalise(px) });
    }));
    TPL = { w: t.w, h: t.h, list };
    return TPL;
}

/** Zero mean, unit length: a dot product of two is their correlation. */
function normalise(px) {
    const n = px.length, out = new Float64Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) m += px[i];
    m /= n;
    let s = 0;
    for (let i = 0; i < n; i++) { out[i] = px[i] - m; s += out[i] * out[i]; }
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < n; i++) out[i] /= s;
    return out;
}

const isRed = (r, g, b) => r >= 120 && r - g >= 50 && r - b >= 40;

/** Red rings: red, roughly round and square, not red in the middle. Biggest first. */
function rings(img) {
    const w = img.width, h = img.height, d = img.data;
    const red = new Uint8Array(w * h);
    for (let i = 0, o = 0; i < w * h; i++, o += 3) red[i] = isRed(d[o], d[o + 1], d[o + 2]) ? 1 : 0;
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
    const found = [];
    for (let start = 0; start < w * h; start++) {
        if (!red[start] || seen[start]) continue;
        let sp = 0, count = 0, minX = w, maxX = -1, minY = h, maxY = -1;
        stack[sp++] = start;
        seen[start] = 1;
        while (sp > 0) {
            const p = stack[--sp], x = p % w, y = (p - x) / w;
            count++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (x > 0 && red[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
            if (x < w - 1 && red[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
            if (y > 0 && red[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
            if (y < h - 1 && red[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
        }
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (count < 30 || Math.min(bw, bh) < 16) continue;
        const aspect = bw / bh;
        if (aspect < 0.8 || aspect > 1.25) continue;
        const fill = count / (bw * bh);
        const cx = minX + (bw >> 1), cy = minY + (bh >> 1);
        if (red[cy * w + cx] || fill < 0.10 || fill > 0.65) continue;
        found.push({ x: minX, y: minY, w: bw, h: bh });
    }
    found.sort((a, b) => b.w * b.h - a.w * a.h);
    return found;
}

/** The digits in a ring: dark, not red, inside its white disc, read left to right. */
function digits(img, ring) {
    const W = img.width, d = img.data;
    const inset = Math.round(Math.max(ring.w, ring.h) * 0.14);
    const x0 = ring.x + inset, y0 = ring.y + inset, w = ring.w - 2 * inset, h = ring.h - 2 * inset;
    if (w < 8 || h < 8) return { text: '', score: 0 };
    // how dark each pixel is (0 white .. 255 black), red counting as white
    const ink = new Uint8Array(w * h);
    let lumMin = 255, lumMax = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = ((y0 + y) * W + x0 + x) * 3, r = d[o], g = d[o + 1], b = d[o + 2];
            const lum = isRed(r, g, b) ? 255 : (r * 299 + g * 587 + b * 114) / 1000;
            ink[y * w + x] = 255 - lum;
            if (lum < lumMin) lumMin = lum;
            if (lum > lumMax) lumMax = lum;
        }
    }
    if (lumMax - lumMin < 60) return { text: '', score: 0 };
    const thr = 255 - (lumMin + lumMax) / 2;
    const on = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) on[i] = ink[i] > thr ? 1 : 0;
    // the dark parts (8-neighbour), tall enough to be digits
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), parts = [];
    for (let s = 0; s < w * h; s++) {
        if (!on[s] || seen[s]) continue;
        let sp = 0, n = 0, minX = w, maxX = -1, minY = h, maxY = -1;
        stack[sp++] = s;
        seen[s] = 1;
        while (sp > 0) {
            const p = stack[--sp], x = p % w, y = (p - x) / w;
            n++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    const q = ny * w + nx;
                    if (on[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
                }
            }
        }
        const pw = maxX - minX + 1, ph = maxY - minY + 1;
        if (ph < h * 0.28 || ph > h * 0.98 || pw > w * 0.6 || n < 6) continue;
        parts.push({ x: minX, y: minY, w: pw, h: ph });
    }
    if (!parts.length || parts.length > 3) return { text: '', score: 0, parts: parts.length };
    parts.sort((a, b) => a.x - b.x);
    // digits stand side by side at one height
    const top = Math.min.apply(null, parts.map((p) => p.y)), bottom = Math.max.apply(null, parts.map((p) => p.y + p.h));
    if (parts.some((p) => p.h < (bottom - top) * 0.7)) return { text: '', score: 0, parts: parts.length };
    const T = templates();
    let text = '', score = 1;
    for (const p of parts) {
        const g = scaled(ink, w, p, T.w, T.h), gn = normalise(g), aspect = p.w / p.h;
        let best = null;
        for (const t of T.list) {
            let c = 0;
            for (let i = 0; i < gn.length; i++) c += gn[i] * t.norm[i];
            c -= 0.6 * Math.abs(Math.log(aspect / t.aspect));
            if (!best || c > best.c) best = { c, digit: t.digit };
        }
        text += best.digit;
        score = Math.min(score, best.c);
    }
    return { text, score };
}

/** A part of the ink picture, scaled to tw x th (bilinear). */
function scaled(ink, w, p, tw, th) {
    const out = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
            const sx = p.x + (x + 0.5) * p.w / tw - 0.5, sy = p.y + (y + 0.5) * p.h / th - 0.5;
            const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
            const x1 = Math.min(p.x + p.w - 1, x0 + 1), y1 = Math.min(p.y + p.h - 1, y0 + 1);
            const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
            const v = (ink[y0 * w + x0] * (1 - fx) + ink[y0 * w + x1] * fx) * (1 - fy) + (ink[y1 * w + x0] * (1 - fx) + ink[y1 * w + x1] * fx) * fy;
            out[y * tw + x] = v;
        }
    }
    return out;
}

const MIN_SCORE = 0.55;
const valid = (n) => n >= 5 && n <= 150 && n % 5 === 0;

/** The sign in the picture: the biggest ring with a number a sign can carry. */
function read(img) {
    const out = { limit: 0, rings: [] };
    for (const r of rings(img).slice(0, 6)) {
        const dg = digits(img, r);
        const n = dg.text ? Number(dg.text) : 0;
        const ok = !!dg.text && dg.score >= MIN_SCORE && valid(n);
        out.rings.push({ x: r.x, y: r.y, w: r.w, h: r.h, text: dg.text, score: Math.round(dg.score * 100) / 100, limit: ok ? n : 0 });
        if (ok && !out.limit) out.limit = n;
    }
    return out;
}

module.exports = { read, rings, digits, MIN_SCORE };
