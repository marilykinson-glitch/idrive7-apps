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
    animate(ref, o) { calls.push(['animate', ref, Object.assign({}, o)]); return 7; }
    stop(ref, anim) { calls.push(['stop', ref, anim]); }
    close() { calls.push(['close']); }
}
module.exports = { ClusterRender, calls };
`);

const PORT = 18000 + (process.pid % 2000);
Object.assign(process.env, {
    VMS_OAP: D.oap, VMS_RUN: D.run, VMS_WOC_RUN: D.wocRun, VMS_NFT: path.join(D.bin, 'nft'), VMS_CR_CLIENT: FAKE_CR,
    VMS_PORT: String(PORT), VMS_LOOPBACK: '1', VMS_PHONE_STALE_MS: '600', VMS_RULE_MS: '100000000',
    VMS_GRABBER: path.join(T, 'no-grabber-yet'), VMS_SCREEN_MS: '50', VMS_XDG_RUNTIME_DIR: '/run/wayland-test',
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
    assert.deepStrictEqual(d, { app: null, on: true, show: 'both', side: 'right', hudSide: 'left', size: 'medium', bmw: 'hide', screen: true, camera: true, warn: 5, mapPos: null, hudPos: null });
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
    assert.deepStrictEqual(g.hud, { size: 100, x: 138, y: 107 }, 'the HUD on the left by default');
    g = vms.geometry(Object.assign({}, d, { side: 'right', hudSide: 'right', size: 'medium' }), vms.wocStatus(Date.now()));
    assert.deepStrictEqual(g.map, { size: 128, x: 1088 - 200 - 128, y: 36 });
    // the box reaches 770, the HUD shows up to about 740 (720 with room): the sign stays inside it
    assert.deepStrictEqual(g.hud, { size: 80, x: 720 - 80 - 8, y: 107 });
    woc({ hud_width_pct: 0 });
    g = vms.geometry(Object.assign({}, d, { side: 'right', hudSide: 'right', size: 'medium' }), vms.wocStatus(Date.now()));
    assert.deepStrictEqual(g.hud, { size: 80, x: 173 + 50 + 453 - 80 - 8, y: 140 + 8 });
    woc({ hud_width_pct: 85, hud_x: -800, hud_y: 900 });
    g = vms.geometry(Object.assign({}, d, { side: 'left', size: 'medium' }), vms.wocStatus(Date.now()));
    assert.deepStrictEqual(g.hud, { size: 80, x: 88, y: 188 }, 'held inside what the HUD shows');

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
        [['map', 'overlay', 128, 128, 760, 36, false, 1, false], ['hud', 'overlay', 80, 80, 138, 107, false, 1, false]]);
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

    // placed by hand on the app's Position page: that place, held inside the target
    app.settings({ mapX: 500, mapY: 300, hudX: 760, hudY: -20 });
    woc({ state: 'showing', cluster: 1, hud: 1, hud_state: 'showing' });
    d = vms.desired(Date.now());
    g = vms.geometry(d, vms.wocStatus(Date.now()));
    assert.deepStrictEqual(g.map, { size: 128, x: 500, y: 300 });
    assert.deepStrictEqual(g.hud, { size: 80, x: 720, y: 0 }, 'held inside the HUD');
    // the Position page open: a sign to place without the phone (60), shown where it is put
    const data = path.join(D.oap, 'oap_12301', 'data');
    fs.writeFileSync(path.join(data, 'preview.json'), JSON.stringify({ at: new Date().toISOString() }));
    await sleep(700);           // the phone's last word is old by now
    let s = vms.tick();
    assert.strictEqual(s.placing, true);
    assert.strictEqual(s.limit, 60);
    assert.deepStrictEqual(vms._last().shown.sort(), ['hud', 'map']);
    assert(calls('set').some((c) => c[2].x === 500 && c[2].y === 300) || calls('image').some((c) => c[1].target === 'map' && c[1].x === 500 && c[1].y === 300),
        'the map sign at its place');
    st = status();
    assert.deepStrictEqual([st.placing, st.geometry.map.placed, st.geometry.hud.x], [true, true, 720]);
    // a step to the right: the same layer, moved
    const images = calls('image').length;
    app.settings({ mapX: 510, mapY: 300, hudX: 760, hudY: -20 });
    vms.tick();
    assert(calls('set').some((c) => c[2].x === 510 && c[2].y === 300), 'moved');
    assert.strictEqual(calls('image').length, images, 'no new layer for a move');
    // BMW's sign hides nothing while placing
    app.bmw({ at: new Date().toISOString(), limit: 50, valid: true });
    assert.deepStrictEqual(vms.tick().map.visible, true);
    fs.writeFileSync(path.join(data, 'preview.json'), JSON.stringify({ at: new Date(Date.now() - 10000).toISOString() }));
    s = vms.tick();
    assert.strictEqual(s.placing, false);
    assert.deepStrictEqual(vms._last().shown, [], 'the page closed: no sign without the phone');

    // --- the centre screen (CarPlay): the sign read in BMW's grabber's picture ---
    const FIX = path.join(__dirname, 'fixtures');
    const GRAB_LOG = path.join(T, 'grabs.log'), WHICH = path.join(T, 'which');
    const grabber = path.join(D.bin, 'winston-grabber');
    fs.writeFileSync(grabber, '#!/bin/sh\necho "XDG=$XDG_RUNTIME_DIR $*" >> ' + GRAB_LOG + '\nfor a; do out="$a"; done\n' +
        'w=$(cat ' + WHICH + ')\n[ "$w" = fail ] && { echo "grab: no picture" >&2; exit 3; }\ncp "$w" "$out"\n', { mode: 0o755 });
    fs.writeFileSync(WHICH, path.join(FIX, 'centre-80.jpg'));
    const grabs = () => (fs.existsSync(GRAB_LOG) ? fs.readFileSync(GRAB_LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
    const until = async (fn, what) => {
        for (let i = 0; i < 60; i++) { vms.tick(); if (fn()) return; await sleep(60); }
        throw new Error('never: ' + what + ' ' + JSON.stringify(vms._last()));
    };
    app.settings({ screen: 'on' });
    app.bmw({ at: new Date(Date.now() - 60000).toISOString(), limit: 50, valid: true });
    woc({ state: 'showing', cluster: 1, hud: 1, hud_state: 'showing' });
    vms.CFG.grabber = grabber;
    await until(() => vms._last().limit === 80, 'the centre screen\'s 80');
    assert.deepStrictEqual(vms._last().shown.sort(), ['hud', 'map']);
    st = status();
    assert.strictEqual(st.source, 'screen');
    assert.strictEqual(st.screen.limit, 80);
    assert(st.screen.shots >= 2, 'two pictures agree first');
    assert.strictEqual(grabs()[0], 'XDG=/run/wayland-test --screen=center --geometry=960x360 --num-frames=1 -p jpeg_msdk(num_frames=1),file ' + path.join(D.run, 'centre.jpg'));
    // the sign goes from the centre screen: gone after two pictures without it
    fs.writeFileSync(WHICH, path.join(FIX, 'centre-none.jpg'));
    await until(() => vms._last().limit === null, 'no sign');
    assert.strictEqual(vms._last().why, 'no sign on the centre screen');
    // the phone first: while it sends, no picture is taken
    fs.writeFileSync(WHICH, path.join(FIX, 'centre-80.jpg'));
    a = await send({ t: 'vms', v: 1, seq: 20, limit: 50 });
    assert.strictEqual(vms._last().limit, 50);
    const before = grabs().length;
    await sleep(200);
    vms.tick();
    assert.strictEqual(grabs().length, before, 'no picture while the phone speaks');
    assert.strictEqual(status().source, 'phone');
    // off in the app's settings: no pictures
    await sleep(700);
    app.settings({ screen: 'off' });
    vms.tick();
    const n2 = grabs().length;
    await sleep(200);
    vms.tick();
    assert.strictEqual(grabs().length, n2);
    assert.strictEqual(vms.decide(Date.now()).reading, false);
    await sleep(300);
    assert(!fs.existsSync(path.join(D.run, 'centre.jpg')), 'the picture is not kept');
    // a grabber that cannot scale: the screen's own size after two failures
    app.settings({ screen: 'on' });
    fs.writeFileSync(WHICH, 'fail');
    await until(() => /grabber failed/.test(status().screen.error || '') && status().screen.geometry === 'full', 'the full size');
    assert.strictEqual(vms._last().why, 'the centre screen cannot be read');
    fs.writeFileSync(WHICH, path.join(FIX, 'centre-80.jpg'));
    const k = grabs().length;
    await until(() => grabs().length > k + 1, 'another picture');
    assert(!/--geometry/.test(grabs()[grabs().length - 1]), 'no --geometry now');

    // --- faster than the sign: the sign flashes (a step animation of scale 1 / 0), as BMW's own does ---
    vms.CFG.grabber = path.join(T, 'no-grabber');
    app.settings({});
    woc({ state: 'showing', cluster: 1, hud: 1, hud_state: 'showing' });
    const speedFile = path.join(D.oap, 'oap_12301', 'data', 'speed.json');
    const speedIs = (kmh) => fs.writeFileSync(speedFile, JSON.stringify({ at: new Date().toISOString(), kmh }));
    await sleep(700);
    speedIs(70);
    a = await send({ t: 'vms', v: 1, seq: 30, limit: 60 });
    const px0 = calls('pixels').length;
    let w = vms.tick();
    assert.strictEqual(w.over, true, '70 is over 60 + 5');
    const anims = calls('animate');
    assert(anims.length >= 2 && anims.every((c) => c[2].property === 'scale' && c[2].loop === true && c[2].interp === 'step'), 'both signs flash');
    assert(/^0:1,1,1 \d+:0,0,0 \d+:1,1,1$/.test(anims[0][2].keys), 'on, off, on: ' + anims[0][2].keys);
    vms.tick();
    vms.tick();
    assert.strictEqual(calls('pixels').length, px0, 'the sign itself is not redrawn to flash');
    assert.strictEqual(status().over, true);
    assert.strictEqual(status().speed, 70);
    speedIs(64);
    a = await send({ t: 'vms', v: 1, seq: 31, limit: 60 });
    w = vms.tick();
    assert.strictEqual(w.over, false, '64 is within 60 + 5');
    assert(calls('stop').length >= 2, 'the flashing stops');
    app.settings({ warn: '0' });
    speedIs(61);
    a = await send({ t: 'vms', v: 1, seq: 32, limit: 60 });
    assert.strictEqual(vms.tick().over, true, 'warn above the sign itself');
    app.settings({ warn: 'off' });
    speedIs(120);
    assert.strictEqual(vms.tick().over, false, 'the warning off');
    app.settings({});
    fs.writeFileSync(speedFile, JSON.stringify({ at: new Date(Date.now() - 10000).toISOString(), kmh: 120 }));
    a = await send({ t: 'vms', v: 1, seq: 33, limit: 60 });
    assert.strictEqual(vms.tick().over, false, 'an old speed warns of nothing');

    // --- BMW's front camera: what a car's limit is among the signs it sees ---
    const camera = require(path.join(__dirname, '..', 'vietmap-signs', 'camera.js'));
    const ev = (signs) => ({ eventDataQualifier: 'EVENT_DATA_AVAILABLE', trafficSignRecognition: { numberSigns: signs.length, speedLimitUnit: 'KM_H' },
        trafficSign: signs.map((x) => Object.assign({ value: 0, trafficSignForm: 'ROUND', firstSupplementalType: 'SIGNAL_UNFILLED',
            secondSupplementalType: 'SIGNAL_UNFILLED', additionalInfo: 'NO_ADDITIONAL_RESTRICTION' }, x)) });
    const SL = (value, plate) => Object.assign({ type: 'SPEED_LIMIT', value }, plate ? { firstSupplementalType: plate } : {});
    assert.deepStrictEqual(camera.pick(ev([SL(60, 'SS_TRUCK'), { type: 'NO_STANDING_ANYTIME' }, SL(80)])), { limit: 80, end: false, values: [60, 80], single: true }, 'the truck\'s 60 is not ours');
    assert.strictEqual(camera.pick(ev([SL(60, 'SS_TRAILER'), SL(80, 'GENERIC_SUPPLEMENTAL')])).limit, 80);
    assert.deepStrictEqual(camera.pick(ev([SL(50), SL(50), SL(50), SL(60)])), { limit: 50, end: false, values: [50, 50, 50, 60], single: false }, 'most of them');
    assert.strictEqual(camera.pick(ev([SL(60), SL(80)])).limit, 80, 'a tie: the higher');
    assert.strictEqual(camera.pick(ev([SL(60, 'SS_RAIN')])).limit, 0, 'only in the rain');
    assert.strictEqual(camera.pick(ev([{ type: 'NO_ENTRY' }])), null, 'no speed limit: nothing');
    assert.strictEqual(camera.pick(ev([SL(57)])), null, 'not a limit a sign carries');
    assert.strictEqual(camera.pick(ev([{ type: 'END_OF_SPEED_LIMIT', value: 60 }])).end, true);
    assert.strictEqual(camera.pick(Object.assign(ev([SL(60)]), { eventDataQualifier: 'EVENT_DATA_NOT_AVAILABLE' })), null);
    // held until another, an end, or 3 km; a change next to another limit once a second event agrees
    const cs = camera.createState({ holdKm: 3 });
    let t0 = 1000000;
    assert.strictEqual(camera.onEvent(cs, ev([SL(80), SL(60, 'SS_TRUCK')]), t0), 80);
    assert.strictEqual(camera.onEvent(cs, ev([SL(60), SL(50)]), t0 + 1000), 80, 'not yet: two limits, first time');
    assert.strictEqual(camera.onEvent(cs, ev([SL(60), SL(50)]), t0 + 3000), 60, 'the second event agrees');
    assert.strictEqual(camera.onEvent(cs, ev([SL(40)]), t0 + 4000), 40, 'alone in its event: at once');
    camera.onSpeed(cs, { speedVehicleCentreOfGravity: 3840 }, t0 + 4000);           // 60 km/h
    for (let k = 1; k <= 200; k++) camera.onSpeed(cs, { speedVehicleCentreOfGravity: 3840 }, t0 + 4000 + k * 1000);   // 200 s: 3.3 km
    assert.strictEqual(camera.speed(cs, t0 + 204000), 60);
    assert.strictEqual(camera.current(cs, t0 + 204000), 0, 'dropped after 3 km');
    camera.onEvent(cs, ev([SL(50)]), t0 + 205000);
    assert.strictEqual(camera.onEvent(cs, ev([{ type: 'END_OF_SPEED_LIMIT' }]), t0 + 206000), 0, 'an end sign ends it');
    camera.onSpeed(cs, { speedVehicleCentreOfGravity: 65535 }, t0 + 207000);
    assert.strictEqual(cs.speed, 60, 'the invalid value is not a speed');

    // the camera's sign comes before the phone's; off in the settings, the phone's again
    const C = vms._cam;
    a = await send({ t: 'vms', v: 1, seq: 40, limit: 60 });
    camera.onEvent(C, ev([SL(80)]), Date.now());
    w = vms.tick();
    assert.deepStrictEqual([w.limit, w.source], [80, 'camera']);
    assert.strictEqual(status().camera.limit, 80);
    app.settings({ camera: 'off' });
    a = await send({ t: 'vms', v: 1, seq: 41, limit: 60 });
    w = vms.tick();
    assert.deepStrictEqual([w.limit, w.source], [60, 'phone']);
    app.settings({});
    // the camera's own speed comes before the app's file
    camera.onSpeed(C, { speedVehicleCentreOfGravity: 6400 }, Date.now());      // 100 km/h
    a = await send({ t: 'vms', v: 1, seq: 42, limit: 60 });
    w = vms.tick();
    assert.deepStrictEqual([w.speed, w.over], [100, true], 'over the camera\'s 80');

    // camera.start: BMW's generator makes the descriptions, the binding subscribes to both and keeps them
    const genFake = path.join(T, 'gen-fake.js');
    fs.writeFileSync(genFake, `const fs = require('fs'); const [db, man, uid, out] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(man, 'utf8')); const i = Object.keys(m.proxies)[0];
fs.mkdirSync(out); fs.writeFileSync(out + '/' + i.replace(/\\./g, '_') + '.json', JSON.stringify({ name: i, m: m.proxies[i] }));`);
    const subs = [];
    const fakeBinding = { buildProxy: (cfg, inst) => Promise.resolve({ init: () => Promise.resolve(), subscribeToAvailability: (f) => f(true),
        subscribe: (o) => { subs.push([cfg.name, o.name]); if (o.name === 'TrafficSignRecognitionFrontCamera') setTimeout(() => o.onReceive(ev([SL(70)])), 10); return Promise.resolve(); } }) };
    const cs2 = camera.createState();
    const lines = [];
    const held = camera.start(cs2, { run: path.join(T, 'camrun'), catalog: '/nowhere.json', gen: genFake, someip: fakeBinding, log: (l) => lines.push(l) });
    fs.mkdirSync(path.join(T, 'camrun'), { recursive: true });
    for (let k = 0; k < 100 && !(cs2.ready && cs2.limit); k++) await sleep(30);
    assert.strictEqual(cs2.limit, 70, lines.join(' / '));
    assert.deepStrictEqual(subs.map((x) => x[1]).sort(), ['TrafficSignRecognitionFrontCamera', 'statusCarSpeed2']);
    assert.strictEqual(held.length, 2, 'the proxies are kept');
    assert(fs.existsSync(path.join(T, 'camrun', 'someip', 'camera', 'de_bmw_environmentalmodel_SignRecognitionFrontCamera.json')));

    console.log('vietmap-signs: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
