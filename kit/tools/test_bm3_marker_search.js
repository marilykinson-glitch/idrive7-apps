'use strict';

// BM3 CustomROM marker search (bm3_protocol.js identify): simulated DMEs with the marker at other
// places, out-of-range flash, refused reads, DMEs that append dynamic definitions. No SDK, vehicle or
// capture needed:
//   node kit/tools/test_bm3_marker_search.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Bm3Protocol, searchPlan } = require('../../apps/live_adjustments/bm3_protocol');

const PROFILE = { rom: '011000', mapSwActAddr: 'D001D006', burbleActAddr: 'D001D099', wmbaCmd: '3d',
    liveTuneTables: { KF_DZWMIN_SPORT_SOT: { address: 'D001D116', factor: 2 } } };
const PROFILES = { '011000': PROFILE };
const READ_ONLY = [0x2C, 0x22];

/** A DME with `mb` MB of flash at 0x80000000 (0xFF where nothing was put), `marks` = { address: text }.
 * opts: refuse2C (NRC), append (definitions add up, as ISO 14229 allows), noClear (2C 03 refused). */
function dme(mb, marks, opts) {
    opts = opts || {};
    const calls = [];
    let defs = [];
    const byte = (a) => {
        for (const at of Object.keys(marks)) {
            const start = parseInt(at, 16), text = Buffer.from(marks[at], 'latin1');
            if (a >= start && a < start + text.length) return text[a - start];
        }
        return 0xFF;
    };
    const diag = { available: true, physical: async (target, sid, data, timeout, accept) => {
        assert.strictEqual(target, 0x12);
        assert(READ_ONLY.indexOf(sid) >= 0, 'not a read: service ' + sid.toString(16));
        calls.push([sid].concat(data));
        await new Promise(setImmediate);
        let reply;
        if (sid === 0x2C && data[0] === 0x03) {
            if (opts.noClear) reply = [0x7F, 0x2C, 0x12];
            else { defs = []; reply = [0x6C, 0x03, 0xF3, 0x01]; }
        } else if (sid === 0x2C && data[0] === 0x02) {
            const address = Buffer.from(data.slice(4, 8)).readUInt32BE(0), size = (data[8] << 8) | data[9];
            if (opts.refuse2C) reply = [0x7F, 0x2C, opts.refuse2C];
            else if (address < 0x80000000 || address + size > 0x80000000 + mb * 0x100000) reply = [0x7F, 0x2C, 0x31];
            else {
                if (!opts.append) defs = [];
                defs.push({ address, size });
                reply = [0x6C, 0x02, 0xF3, 0x01];
            }
        } else if (sid === 0x22) {
            if (!defs.length) reply = [0x7F, 0x22, 0x31];
            else {
                const out = [];
                defs.forEach((d) => { for (let i = 0; i < d.size; i++) out.push(byte(d.address + i)); });
                reply = [0x62, 0xF3, 0x01].concat(out);
            }
        }
        assert(accept(reply), 'reply not accepted: ' + Buffer.from(reply).toString('hex'));
        return reply;
    } };
    return { diag, calls, defines: () => calls.filter((c) => c[0] === 0x2C && c[1] === 0x02) };
}

function protocol(d, dataDir, lines) {
    return new Bm3Protocol(d.diag, PROFILES, { bm3MarkerAddress: '807FFE50' },
        { dataDir, log: { info: (m) => lines.push(m) }, onProgress() {} });
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bm3-')); }
const definedAt = (c) => Buffer.from(c.slice(5, 9)).toString('hex').toUpperCase();

(async () => {
    // the plan: 16 "same offset" places, then the last 4 KB of every MB, covering it to the last byte
    const plan = searchPlan();
    assert.strictEqual(plan[0].address, 0x800FFE50);
    assert.strictEqual(plan[7].address, 0x807FFE50);
    for (let b = 1; b <= 16; b++) {
        const end = 0x80000000 + b * 0x100000;
        const reads = plan.filter((p) => p.block === b && p !== plan[b - 1]).map((p) => p.address);
        for (let a = end - 0x1000; a < end; a++) assert(reads.some((r) => a >= r && a < r + 0xFF), 'gap at ' + a.toString(16));
        for (let a = end - 0x1000; a < end - 0x10; a++) {
            assert(reads.some((r) => a >= r && a + 16 <= r + 0xFF), 'a 16-byte marker at ' + a.toString(16) + ' is split');
        }
    }

    // 1. The working G22 case: marker at the configured place: one define + one read, as before.
    let lines = [], dir = tmp();
    let d = dme(8, { '807FFE50': 'BM3_R#011000#' });
    let p = protocol(d, dir, lines);
    assert.deepStrictEqual(await p.identify(), { rom: '011000', address: '807FFE50' });
    assert.strictEqual(d.calls.length, 2);
    assert.deepStrictEqual(d.calls[0].slice(0, 4), [0x2C, 0x02, 0xF3, 0x01]);
    assert(!fs.existsSync(path.join(dir, 'bm3_marker.json')), 'nothing saved for the configured place');

    // 2. 16 MB flash, marker at the same distance below the end of 16 MB: found in the first pass.
    lines = []; dir = tmp();
    d = dme(16, { '80FFFE50': 'BM3_R#011000#' });
    p = protocol(d, dir, lines);
    assert.strictEqual((await p.identify()).address, '80FFFE50');
    assert.strictEqual(p.rom, '011000');
    assert(d.defines().length <= 17, 'first pass only: ' + d.defines().length);
    assert(lines.some((l) => /no marker, read FFFF/.test(l)), lines.join('\n'));
    assert(lines.some((l) => /found at 80FFFE50 .*BM3_R#011000#/.test(l)), lines.join('\n'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bm3_marker.json'), 'utf8')).address, '80FFFE50');
    // the next app run reads the saved place first: one define + one read, no search
    d = dme(16, { '80FFFE50': 'BM3_R#011000#' });
    p = protocol(d, dir, []);
    assert.strictEqual((await p.identify()).address, '80FFFE50');
    assert.strictEqual(d.calls.length, 2);
    assert.strictEqual(definedAt(d.calls[0]), '80FFFE50');

    // 3. 8 MB flash, marker elsewhere in the last 4 KB, across two reads' boundary: found in the tails.
    lines = []; dir = tmp();
    const straddle = (0x80800000 - 0x1000 + 0xF0 - 6).toString(16).toUpperCase();
    d = dme(8, { [straddle]: 'BM3_R#011000#' });
    p = protocol(d, dir, lines);
    assert.strictEqual((await p.identify()).address.slice(0, 4), '807F');
    assert.strictEqual(p.rom, '011000');

    // 4. 4 MB flash: the configured place does not exist (NRC 31): search, found below 4 MB.
    lines = []; dir = tmp();
    d = dme(4, { '803FFE50': 'BM3_R#011000#' });
    p = protocol(d, dir, lines);
    assert.strictEqual((await p.identify()).address, '803FFE50');
    assert(lines.some((l) => /807FFE50: no memory there \(NRC 31\)/.test(l)), lines.join('\n'));

    // 5. No marker anywhere (8 MB): the search ends, blocks without flash are skipped after one
    //    refusal, the note says how much was read, and it does not search again in this run.
    lines = []; dir = tmp();
    d = dme(8, {});
    p = protocol(d, dir, lines);
    await assert.rejects(() => p.identify(), /marker absent \(807FFE50 and \d+ other places read\)/);
    const searched = d.defines().length;
    assert(searched > 100 && searched < 8 * 19 + 16, 'reads: ' + searched);
    assert(lines.some((l) => /not found: .*NRC 31.*808xxxxx/.test(l)), lines.join('\n'));
    const before = d.calls.length;
    await assert.rejects(() => p.identify(), /marker absent/);
    assert.strictEqual(d.calls.length - before, 2, 'no second search in the same run');
    assert(!fs.existsSync(path.join(dir, 'bm3_marker.json')));

    // 6. A DME that refuses the define (security, as an MHD DME): the check ends at once, no search.
    lines = []; dir = tmp();
    d = dme(8, {}, { refuse2C: 0x33 });
    p = protocol(d, dir, lines);
    await assert.rejects(() => p.identify(), /NRC 33/);
    assert.strictEqual(d.calls.length, 1);

    // 7. A DME that keeps old definitions and refuses to clear them: each read is attributed to the
    //    right place (the last 255 bytes), the marker is found where it is.
    lines = []; dir = tmp();
    d = dme(16, { '80BFFE50': 'BM3_R#011000#' }, { append: true, noClear: true });
    p = protocol(d, dir, lines);
    assert.strictEqual((await p.identify()).address, '80BFFE50');
    assert(lines.some((l) => /clearing F301 refused/.test(l)), lines.join('\n'));
    // ...and one that appends but clears
    d = dme(16, { '80BFFE50': 'BM3_R#011000#' }, { append: true });
    p = protocol(d, tmp(), []);
    assert.strictEqual((await p.identify()).address, '80BFFE50');

    // 8. A marker found elsewhere with an unknown ROM: rejected (no profile, nothing verified), the
    //    marker text is in the note and the log, the place is kept so the next run does not search.
    lines = []; dir = tmp();
    d = dme(16, { '80FFFE50': 'BM3_R#ZZ9999#' });
    p = protocol(d, dir, lines);
    await assert.rejects(() => p.identify(), /not uniquely matched in marker \(BM3_R#ZZ9999#\)/);
    assert.strictEqual(p.profile, null);
    assert.strictEqual(p.rom, null);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bm3_marker.json'), 'utf8')).address, '80FFFE50');

    // 9. The DME goes quiet in the middle: the search stops after three silent reads.
    lines = []; dir = tmp();
    d = dme(8, {});
    let n = 0;
    const physical = d.diag.physical;
    d.diag.physical = async function () { return ++n > 4 ? null : physical.apply(this, arguments); };
    p = protocol(d, dir, lines);
    await assert.rejects(() => p.identify(), /marker absent/);
    assert(n < 20, 'stopped after silence: ' + n);
    assert(lines.some((l) => /stopped answering/.test(l)), lines.join('\n'));

    console.log('BM3 marker search checks passed (configured / saved / first pass / tails / no flash / not found / refused / appending DME / unknown ROM / silent DME).');
})().catch((e) => { console.error(e); process.exit(1); });
