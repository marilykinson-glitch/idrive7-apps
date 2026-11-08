'use strict';
/**
 * jpeg.js - a baseline JPEG decoder (ITU T.81 sequential Huffman, 8-bit), for the centre screen's
 * pictures BMW's grabber writes (jpeg_msdk). No dependencies, Node 8.
 *
 *   const { decode } = require('./jpeg');
 *   const img = decode(buffer);          // { width, height, data }: RGB, 3 bytes a pixel, row by row
 *
 * Grey (1 component) and YCbCr (3) pictures, any sampling factors (4:2:0, 4:2:2, 4:4:4), restart
 * intervals. Progressive and arithmetic-coded pictures are refused (an Error).
 * MIT, as the rest of this repository.
 */

const ZIGZAG = new Int32Array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
    28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
    47, 55, 62, 63]);

// the 1-D IDCT's cosines: COS[x * 8 + u] = c(u) cos((2x + 1) u pi / 16) / 2
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2;
}

/** A Huffman table from its 16 counts and its symbols: canonical codes by length (T.81 F.2.2.3). */
function huffman(counts, symbols) {
    const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
    let code = 0, k = 0;
    for (let l = 1; l <= 16; l++) {
        const n = counts[l - 1];
        if (n) {
            valptr[l] = k;
            mincode[l] = code;
            code += n;
            k += n;
            maxcode[l] = code - 1;
        }
        code <<= 1;
    }
    maxcode[17] = 0x7fffffff;
    return { maxcode, valptr, mincode, symbols };
}

function decode(buf) {
    if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
    const qt = [], dc = [], ac = [];
    let frame = null, restart = 0, pos = 2;
    const u16 = (p) => (buf[p] << 8) | buf[p + 1];

    while (pos < buf.length) {
        if (buf[pos] !== 0xff) { pos++; continue; }
        const marker = buf[pos + 1];
        pos += 2;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { if (marker === 0xff) pos--; continue; }
        if (marker === 0xd9) break;
        const len = u16(pos), end = pos + len;
        const p0 = pos + 2;
        if (marker === 0xdb) {                                   // DQT
            let p = p0;
            while (p < end) {
                const pq = buf[p] >> 4, tq = buf[p] & 15;
                p++;
                const t = new Int32Array(64);
                for (let i = 0; i < 64; i++) { t[ZIGZAG[i]] = pq ? u16(p + i * 2) : buf[p + i]; }
                p += pq ? 128 : 64;
                qt[tq] = t;
            }
        } else if (marker === 0xc4) {                            // DHT
            let p = p0;
            while (p < end) {
                const tc = buf[p] >> 4, th = buf[p] & 15;
                const counts = buf.slice(p + 1, p + 17);
                let n = 0;
                for (let i = 0; i < 16; i++) n += counts[i];
                const h = huffman(counts, buf.slice(p + 17, p + 17 + n));
                if (tc === 0) dc[th] = h; else ac[th] = h;
                p += 17 + n;
            }
        } else if (marker === 0xc0 || marker === 0xc1) {         // SOF0 / SOF1
            if (buf[p0] !== 8) throw new Error('JPEG: ' + buf[p0] + '-bit samples');
            const height = u16(p0 + 1), width = u16(p0 + 3), n = buf[p0 + 5];
            const comps = [];
            for (let i = 0; i < n; i++) {
                const q = p0 + 6 + i * 3;
                comps.push({ id: buf[q], h: buf[q + 1] >> 4, v: buf[q + 1] & 15, tq: buf[q + 2] });
            }
            frame = { width, height, comps };
        } else if (marker === 0xc2 || marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)) {
            throw new Error('JPEG: only baseline pictures (SOF 0x' + marker.toString(16) + ')');
        } else if (marker === 0xdd) {                            // DRI
            restart = u16(p0);
        } else if (marker === 0xda) {                            // SOS
            if (!frame) throw new Error('JPEG: scan before frame');
            const ns = buf[p0];
            const scan = [];
            for (let i = 0; i < ns; i++) {
                const id = buf[p0 + 1 + i * 2], t = buf[p0 + 2 + i * 2];
                const c = frame.comps.filter((x) => x.id === id)[0];
                if (!c) throw new Error('JPEG: scan names an unknown component');
                c.dc = dc[t >> 4];
                c.ac = ac[t & 15];
                scan.push(c);
            }
            pos = decodeScan(buf, end, frame, scan, qt, restart);
            continue;
        }
        pos = end;
    }
    if (!frame || !frame.comps[0].blocks) throw new Error('JPEG: no picture');
    return toRgb(frame);
}

/** The entropy-coded data of one scan (all components interleaved, as a baseline encoder writes them). */
function decodeScan(buf, start, frame, scan, qt, restart) {
    const hmax = Math.max.apply(null, frame.comps.map((c) => c.h)), vmax = Math.max.apply(null, frame.comps.map((c) => c.v));
    const mcusX = Math.ceil(frame.width / (8 * hmax)), mcusY = Math.ceil(frame.height / (8 * vmax));
    frame.hmax = hmax;
    frame.vmax = vmax;
    frame.comps.forEach((c) => {
        c.bw = mcusX * c.h;                 // blocks across, the MCUs' padding included
        c.bh = mcusY * c.v;
        if (!c.blocks) c.blocks = new Uint8Array(c.bw * c.bh * 64);
        c.q = qt[c.tq];
        if (!c.q) throw new Error('JPEG: no quantisation table ' + c.tq);
        c.pred = 0;
    });
    const single = scan.length === 1;
    let pos = start, bits = 0, nbits = 0, ended = false;

    const fill = () => {
        while (nbits <= 24) {
            let b = 0;
            if (!ended && pos < buf.length) {
                b = buf[pos];
                if (b === 0xff) {
                    const n = buf[pos + 1];
                    if (n === 0) pos += 2;
                    else { ended = true; b = 0; }         // a marker: the data ends (zeros from here)
                } else pos++;
            }
            bits = (bits << 8) | b;
            nbits += 8;
        }
    };
    const bit = () => {
        if (nbits === 0) fill();
        nbits--;
        return (bits >>> nbits) & 1;
    };
    const receive = (n) => {
        if (nbits < n) fill();
        nbits -= n;
        return (bits >>> nbits) & ((1 << n) - 1);
    };
    const extend = (v, n) => (n === 0 ? 0 : v < (1 << (n - 1)) ? v - (1 << n) + 1 : v);
    const symbol = (h) => {
        if (!h) throw new Error('JPEG: no Huffman table');
        let code = bit(), l = 1;
        while (code > h.maxcode[l]) {
            code = (code << 1) | bit();
            l++;
            if (l > 16) return 0;                       // corrupt: carry on with zeros
        }
        return h.symbols[h.valptr[l] + code - h.mincode[l]];
    };
    const coef = new Float64Array(64), tmp = new Float64Array(64);

    const block = (c, bx, by) => {
        coef.fill(0);
        const t = symbol(c.dc);
        const diff = t ? extend(receive(t), t) : 0;
        c.pred += diff;
        coef[0] = c.pred * c.q[0];
        for (let k = 1; k < 64;) {
            const rs = symbol(c.ac);
            const r = rs >> 4, s = rs & 15;
            if (s === 0) {
                if (r === 15) { k += 16; continue; }
                break;
            }
            k += r;
            if (k > 63) break;
            const z = ZIGZAG[k];
            coef[z] = extend(receive(s), s) * c.q[z];
            k++;
        }
        // IDCT: rows, then columns; + 128, clamped
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                let s = 0;
                for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * coef[y * 8 + u];
                tmp[y * 8 + x] = s;
            }
        }
        const out = c.blocks, base = (by * c.bw + bx) * 64;
        for (let x = 0; x < 8; x++) {
            for (let y = 0; y < 8; y++) {
                let s = 0;
                for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x];
                const p = Math.round(s + 128);
                out[base + y * 8 + x] = p < 0 ? 0 : p > 255 ? 255 : p;
            }
        }
    };

    const resetAt = () => {
        // byte-align, step over the RSTn marker, predictors back to 0
        nbits = 0;
        bits = 0;
        ended = false;
        while (pos < buf.length && !(buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7)) pos++;
        pos += 2;
        frame.comps.forEach((c) => { c.pred = 0; });
    };

    if (single) {
        // a non-interleaved scan: the component's own blocks, without the MCU padding
        const c = scan[0];
        const w = Math.ceil(Math.ceil(frame.width * c.h / hmax) / 8), h = Math.ceil(Math.ceil(frame.height * c.v / vmax) / 8);
        let n = 0;
        for (let by = 0; by < h; by++) {
            for (let bx = 0; bx < w; bx++) {
                if (restart && n && n % restart === 0) resetAt();
                block(c, bx, by);
                n++;
            }
        }
    } else {
        let n = 0;
        for (let my = 0; my < mcusY; my++) {
            for (let mx = 0; mx < mcusX; mx++) {
                if (restart && n && n % restart === 0) resetAt();
                for (const c of scan) {
                    for (let v = 0; v < c.v; v++) {
                        for (let h = 0; h < c.h; h++) block(c, mx * c.h + h, my * c.v + v);
                    }
                }
                n++;
            }
        }
    }
    // to the next marker after the data
    while (pos < buf.length && !(buf[pos] === 0xff && buf[pos + 1] !== 0 && !(buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7))) pos++;
    return pos;
}

/** The components' blocks to RGB (YCbCr, JFIF), each component scaled up to the picture by its sampling. */
function toRgb(frame) {
    const w = frame.width, h = frame.height, out = Buffer.alloc(w * h * 3);
    const comps = frame.comps;
    const sample = (c, x, y) => {
        const sx = Math.floor(x * c.h / frame.hmax), sy = Math.floor(y * c.v / frame.vmax);
        const bx = sx >> 3, by = sy >> 3;
        return c.blocks[(by * c.bw + bx) * 64 + (sy & 7) * 8 + (sx & 7)];
    };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 3;
            if (comps.length < 3) {
                const g = sample(comps[0], x, y);
                out[o] = out[o + 1] = out[o + 2] = g;
                continue;
            }
            const Y = sample(comps[0], x, y), cb = sample(comps[1], x, y) - 128, cr = sample(comps[2], x, y) - 128;
            const r = Y + 1.402 * cr, g = Y - 0.344136 * cb - 0.714136 * cr, b = Y + 1.772 * cb;
            out[o] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5;
            out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5;
            out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5;
        }
    }
    return { width: w, height: h, data: out };
}

module.exports = { decode };
