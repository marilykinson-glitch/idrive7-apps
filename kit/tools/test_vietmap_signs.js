'use strict';

// vietmap-signs (kit/vietmap-signs): the helper against a made-up head unit in a temporary folder, with
// a fake cluster-render client, a fake nft and the phone's datagrams on 127.0.0.1. No head unit needed:
//   node kit/tools/test_vietmap_signs.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-'));
const D = { oap: path.join(T, 'oap'), run: path.join(T, 'run'), wocRun: path.join(T, 'wocrun'), bin: path.join(T, 'bin') };
Object.keys(D).forEach((k) => fs.mkdirSync(D[k], { recursive: true }));

// nft: the input chain as a file of rules, "-a list" with handles, insert, delete by handle
const RULES = path.join(T, 'rules.json');
fs.writeFileSync(RULES, JSON.stringify({ next: 10, rules: [{ h: 3, text: 'iifname "wlan_bridge" tcp dport 8470 accept comment "mgu-updater-web"' }] }));
fs.writeFileSync(path.join(D.bin, 'nft'), `#!/usr/bin/env node
const fs = require('fs');
const f = ${JSON.stringify(RULES)};
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const a = process.argv.slice(2);
if (a[0] === '-a' && a[1] === 'list') {
    console.log('table ip filter {\\n\\tchain input {');
    s.rules.forEach((r) => console.log('\\t\\t' + r.text + ' # handle ' + r.h));
    console.log('\\t}\\n}');
} else if (a[0] === 'insert') {
    s.rules.unshift({ h: s.next++, text: a.slice(5).join(' ') });
} else if (a[0] === 'delete') {
    s.rules = s.rules.filter((r) => String(r.h) !== a[a.length - 1]);
} else { process.exit(1); }
fs.writeFileSync(f, JSON.stringify(s));
`, { mode: 0o755 });

// cluster-render's client: what the helper asks of it
const FAKE_CR = path.join(T, 'cluster_render_client.js');
fs.writeFileSync(FAKE_CR, `'use strict';
const EventEmitter = require('events');
const calls = [];
class ClusterRender extends EventEmitter {
    constructor(app, p) { super(); this.app = app; this.path = p; this.backend = 'id7'; this.targets = 'map:1088x480,panel:1920x720,hud:800x480'; this.n = 1; }
    connect() { calls.push(['connect', this.app]); setImmediate(() => this.emit('ready')); }
    image(o) { calls.push(['image', Object.assign({}, o)]); return this.n++; }
    set(ref, o) { calls.push(['set', ref, Object.assign({}, o)]); }
    pixels(ref, rects, px) { calls.push(['pixels', ref, px.length]); return true; }
    drop(ref) { calls.push(['drop', ref]); }
    close() { calls.push(['close']); }
}
module.exports = { ClusterRender, calls };
`);

const PORT = 18000 + (process.pid % 2000);
Object.assign(process.env, {
    VMS_OAP: D.oap, VMS_RUN: D.run, VMS_WOC_RUN: D.wocRun, VMS_NFT: path.join(D.bin, 'nft'), VMS_CR_CLIENT: FAKE_CR,
    VMS_PORT: String(PORT), VMS_LOOPBACK: '1', VMS_PHONE_STALE_MS: '600', VMS_RULE_MS: '100000000',
});
const vms = require('../vietmap-signs/vietmap-signs');
const cr = require(FAKE_CR);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = () => JSON.parse(fs.readFileSync(path.join(D.run, 'status.json'), 'utf8'));
const rules = () => JSON.parse(fs.readFileSync(RULES, 'utf8')).rules;
const calls = (kind) => cr.calls.filter((c) => c[0] === kind);
const woc = (s) => fs.writeFileSync(path.join(D.wocRun, 'status.json'), JSON.stringify(Object.assign({ ev: 'status', state: 'showing', target: 'map',
    cluster: 1, hud: 0, hud_state: 'idle', hide_bmw_guidance: 1, hud_width_pct: 80, hud_x: 50, hud_y: 0 }, s)));

function installApp(uid, id) {
    const kit = path.join(D.oap, 'oap_' + uid, 'source', 'javascript', 'kit');
    fs.mkdirSync(kit, { recursive: true });
    fs.mkdirSync(path.join(D.oap, 'oap_' + uid, 'data'), { recursive: true });
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'vietmap_signs', 'app.json'), 'utf8'));
    spec.id = id;
    fs.writeFileSync(path.join(kit, 'app-spec.json'), JSON.stringify(spec));
    const data = path.join(D.oap, 'oap_' + uid, 'data');
    return {
        settings: (v) => fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(v)),
        bmw: (v) => fs.writeFileSync(path.join(data, 'bmw_sign.json'), JSON.stringify(v)),
    };
}

/** The phone: one datagram, the car's answer. */
function send(msg) {
    return new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        const t = setTimeout(() => { s.close(); reject(new Error('no answer to ' + JSON.stringify(msg))); }, 1500);
        s.on('message', (b) => { clearTimeout(t); s.close(); resolve(JSON.parse(b.toString('utf8'))); });
        s.send(Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)), PORT, '127.0.0.1');
    });
}
function sendNoAnswer(msg) {
    return new Promise((resolve) => {
        const s = dgram.createSocket('udp4');
        s.send(Buffer.from(msg), PORT, '127.0.0.1', () => setTimeout(() => { s.close(); resolve(); }, 150));
    });
}

(async () => {
    // --- the sign: a red ring on white, black digits, transparent outside ---
    const S = 128, px = vms.drawSign(60, S);
    assert.strictEqual(px.length, S * S * 4);
    const at = (x, y) => Array.from(px.slice((y * S + x) * 4, (y * S + x) * 4 + 4));
    assert.deepStrictEqual(at(0, 0), [0, 0, 0, 0], 'corner transparent');
    const ring = at(S / 2, Math.round(S * 0.035 + S * 0.06) + 1);
    assert(ring[0] > 180 && ring[1] < 60 && ring[2] < 70 && ring[3] === 255, 'red ring ' + ring);
    assert.deepStrictEqual(at(S / 2, Math.round(S * 0.25)), [255, 255, 255, 255], 'white inside, above the digits');
    let ink = 0;
    for (let y = 40; y < 88; y++) for (let x = 20; x < 108; x++) if (at(x, y)[0] < 60) ink++;
    assert(ink > 600, 'digits drawn: ' + ink);
    assert.strictEqual(vms.drawSign(120, 96).length, 96 * 96 * 4);

    // --- the phone's datagrams ---
    assert.deepStrictEqual(vms.parsePacket(Buffer.from('{"t":"vms","v":1,"seq":4,"limit":60,"app":"vmsign 0.1.0"}')),
        { seq: 4, limit: 60, test: false, ver: 'vmsign 0.1.0' });
    assert.strictEqual(vms.parsePacket(Buffer.from('{"t":"vms","limit":0}')).limit, null);
    assert.strictEqual(vms.parsePacket(Buffer.from('{"t":"vms","limit":60.5}')), null);
    assert.strictEqual(vms.parsePacket(Buffer.from('{"t":"vms","limit":500}')), null);
    assert.strictEqual(vms.parsePacket(Buffer.from('{"t":"other","limit":60}')), null);
    assert.strictEqual(vms.parsePacket(Buffer.from('not json')), null);
    assert.strictEqual(vms.allowedSender('127.0.0.1'), true);
    assert.strictEqual(vms.allowedSender('8.8.8.8'), false);

    // --- settings: the defaults without the app, then the app's ---
    let d = vms.desired(Date.now());
    assert.deepStrictEqual(d, { app: null, on: true, show: 'both', side: 'right', size: 'medium', bmw: 'hide' });
    vms._reset();
    const app = installApp(12301, 'vietmap_signs2');
    assert.strictEqual(vms.desired(Date.now()).app, 'vietmap_signs2');
    app.settings({ side: 'left', size: 'large', show: 'cluster', bmw: 'show', mode: 'on' });
    d = vms.desired(Date.now());
    assert.deepStrictEqual([d.side, d.size, d.show, d.bmw, d.on], ['left', 'large', 'cluster', 'show', true]);

    // --- where it goes: inside the map area's fade, inside Waze on cluster's HUD box ---
    woc({ hud: 1, hud_state: 'showing', hud_width_pct: 80 });
    let g = vms.geometry(d, vms.wocStatus(Date.now()));
    assert.deepStrictEqual(g.map, { size: 160, x: 200, y: 36 });
    // 80 %: 640x282, centred (80,99), moved 50 right (hud_x 50): (130,99)
    assert.deepStrictEqual(g.hud, { size: 100, x: 138, y: 107 });
    g = vms.geometry(Object.assign({}, d, { side: 'right', size: 'medium' }), vms.wocStatus(Date.now()));
    assert.deepStrictEqual(g.map, { size: 128, x: 1088 - 200 - 128, y: 36 });
    // the box reaches 770, the HUD shows up to 740: the sign stays inside what it shows
    assert.deepStrictEqual(g.hud, { size: 80, x: 740 - 80 - 8, y: 107 });
    woc({ hud_width_pct: 0 });
    g = vms.geometry(Object.assign({}, d, { side: 'right', size: 'medium' }), vms.wocStatus(Date.now()));
    assert.deepStrictEqual(g.hud, { size: 80, x: 173 + 50 + 453 - 80 - 8, y: 140 + 8 });
    woc({ hud_width_pct: 85, hud_x: -800, hud_y: 900 });
    g = vms.geometry(Object.assign({}, d, { side: 'left', size: 'medium' }), vms.wocStatus(Date.now()));
    assert.deepStrictEqual(g.hud, { size: 80, x: 68, y: 188 }, 'held inside what the HUD shows');

    // --- the firewall: one rule per interface at the top, put back after a reload, removed ---
    vms.ensureRules(Date.now());
    let r = rules();
    assert.strictEqual(r.length, 3);
    assert.deepStrictEqual(r.slice(0, 2).map((x) => x.text).sort(), [
        'iifname "wlan0" udp dport ' + PORT + ' accept comment "vietmap-signs"',
        'iifname "wlan_bridge" udp dport ' + PORT + ' accept comment "vietmap-signs"']);
    vms.ensureRules(Date.now());
    assert.strictEqual(rules().length, 3, 'not added twice');
    fs.writeFileSync(RULES, JSON.stringify({ next: 50, rules: [{ h: 3, text: 'iifname "wlan_bridge" tcp dport 8470 accept comment "mgu-updater-web"' }] }));
    vms.ensureRules(Date.now());
    assert.strictEqual(rules().filter((x) => /vietmap-signs/.test(x.text)).length, 2, 'put back after a ruleset load');
    assert.strictEqual(vms.removeRules(), 2);
    assert.deepStrictEqual(rules().map((x) => x.h), [3], 'the Store\'s rule kept');
    vms.ensureRules(Date.now());

    // --- the flow: phone -> sign on the map, the HUD, BMW's own sign first ---
    app.settings({});
    woc({ state: 'idle', cluster: 1, hud: 0 });
    vms.listen(() => vms.tick());
    vms.tick();
    assert.deepStrictEqual(calls('connect').map((c) => c[1]), ['vietmap-signs']);
    let a = await send({ t: 'vms', v: 1, seq: 1, limit: 60, app: 'vmsign test' });
    assert.strictEqual(a.t, 'vms-ack');
    assert.strictEqual(a.seq, 1);
    assert.deepStrictEqual(a.shown, []);
    assert.strictEqual(a.why, 'Waze on cluster shows no map there');
    assert.strictEqual(calls('image').length, 0, 'no layer while Waze on cluster shows no map');

    woc({ state: 'showing', cluster: 1, hud: 1, hud_state: 'showing' });
    a = await send({ t: 'vms', v: 1, seq: 2, limit: 60 });
    assert.deepStrictEqual(a.shown.sort(), ['hud', 'map']);
    const imgs = calls('image').map((c) => c[1]);
    assert.deepStrictEqual(imgs.map((o) => [o.target, o.klass, o.w, o.iw, o.x, o.y, o.visible, o.guide_hold, o.contend]),
        [['map', 'overlay', 128, 128, 760, 36, false, 1, false], ['hud', 'overlay', 80, 80, 652, 107, false, 1, false]]);
    assert.deepStrictEqual(calls('pixels').map((c) => c[2]), [128 * 128 * 4, 80 * 80 * 4]);
    assert(calls('set').some((c) => c[1] === 1 && c[2].visible === true), 'map layer shown');
    let st = status();
    assert.strictEqual(st.limit, 60);
    assert.strictEqual(st.phone.from, '127.0.0.1');
    assert.strictEqual(st.phone.app, 'vmsign test');
    assert.deepStrictEqual(st.shown.sort(), ['hud', 'map']);
    assert.deepStrictEqual(st.firewall.rules, ['wlan_bridge', 'wlan0']);

    // a new number: new pixels, same layers
    a = await send({ t: 'vms', v: 1, seq: 3, limit: 80 });
    assert.strictEqual(calls('image').length, 2);
    assert.strictEqual(calls('pixels').length, 4);

    // BMW shows a sign: VietMap's goes (the default), or stays ("show")
    app.bmw({ at: new Date().toISOString(), limit: 50, valid: true });
    a = await send({ t: 'vms', v: 1, seq: 4, limit: 80 });
    assert.deepStrictEqual(a.shown, []);
    assert.strictEqual(a.why, 'BMW shows its own sign');
    assert.strictEqual(status().bmw.suppress, true);
    app.settings({ bmw: 'show' });
    a = await send({ t: 'vms', v: 1, seq: 5, limit: 80 });
    assert.deepStrictEqual(a.shown.sort(), ['hud', 'map']);
    app.bmw({ at: new Date(Date.now() - 60000).toISOString(), limit: 50, valid: true });
    app.settings({});
    a = await send({ t: 'vms', v: 1, seq: 6, limit: 80 });
    assert.deepStrictEqual(a.shown.sort(), ['hud', 'map'], 'an old BMW reading hides nothing');

    // the cluster only; a bigger sign is a new layer; the left side moves it
    app.settings({ show: 'cluster', size: 'large', side: 'left' });
    a = await send({ t: 'vms', v: 1, seq: 7, limit: 80 });
    assert.deepStrictEqual(a.shown, ['map']);
    assert(calls('drop').some((c) => c[1] === 1), 'the medium map layer dropped');
    const big = calls('image').map((c) => c[1]).filter((o) => o.w === 160)[0];
    assert.deepStrictEqual([big.target, big.x, big.y], ['map', 200, 36]);
    assert(calls('set').some((c) => c[1] === 2 && c[2].visible === false), 'the HUD layer hidden');

    // Waze on cluster's "Hide BMW's turn" off: the sign keeps BMW's guidance box too
    woc({ state: 'showing', cluster: 1, hide_bmw_guidance: 0 });
    vms.tick();
    assert(calls('set').some((c) => c[2].guide_hold === 0), 'guide_hold follows Waze on cluster');

    // no sign in VietMap; then the phone goes quiet
    a = await send({ t: 'vms', v: 1, seq: 8, limit: 0 });
    assert.deepStrictEqual(a.shown, []);
    assert.strictEqual(a.why, 'no sign in VietMap');
    await send({ t: 'vms', v: 1, seq: 9, limit: 70 });
    assert.strictEqual(vms._last().shown.length, 1, JSON.stringify(vms._last()));
    await sleep(700);
    vms.tick();
    assert.deepStrictEqual(vms._last().shown, []);
    assert.strictEqual(vms._last().why, 'the phone stopped sending');

    // off in the app
    app.settings({ mode: 'off' });
    a = await send({ t: 'vms', v: 1, seq: 10, limit: 70 });
    assert.strictEqual(a.why, 'off in the app');

    // what is not ours gets no answer and counts as bad
    const bad = status().phone.bad;
    await sendNoAnswer('{"t":"vms","limit":"sixty"}');
    vms.tick();
    assert.strictEqual(status().phone.bad, bad + 1);

    // a stale Waze on cluster status shows nothing
    app.settings({});
    woc({ state: 'showing' });
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(path.join(D.wocRun, 'status.json'), old, old);
    a = await send({ t: 'vms', v: 1, seq: 11, limit: 70 });
    assert.deepStrictEqual(a.shown, []);

    console.log('vietmap-signs: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
