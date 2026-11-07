'use strict';

// vietmap-cluster (kit/vietmap-cluster): the helper against a made-up head unit in a temporary folder,
// with a fake screen grabber and a fake systemctl. No head unit needed:
//   node kit/tools/test_vietmap_cluster.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc-'));
const D = {
    oap: path.join(T, 'oap'), run: path.join(T, 'run'), woc: path.join(T, 'woc'), wocRun: path.join(T, 'wocrun'),
    bin: path.join(T, 'bin'), calls: path.join(T, 'calls.log'), grabs: path.join(T, 'grabs.log'),
};
Object.keys(D).forEach((k) => { if (!/\.log$/.test(D[k])) fs.mkdirSync(D[k], { recursive: true }); });
fs.writeFileSync(path.join(D.bin, 'systemctl'), '#!/bin/sh\necho "$*" >> ' + D.calls + '\n[ "$1" = is-system-running ] && echo running\nexit 0\n', { mode: 0o755 });
const grabber = path.join(D.bin, 'winston-grabber');
const setGrabber = (body) => fs.writeFileSync(grabber, '#!/bin/sh\necho "XDG=$XDG_RUNTIME_DIR $*" >> ' + D.grabs + '\n' + body + '\n', { mode: 0o755 });
setGrabber('exec sleep 30');

Object.assign(process.env, {
    VMC_OAP: D.oap, VMC_RUN: D.run, VMC_GRABBER: grabber, VMC_SYSTEMCTL: path.join(D.bin, 'systemctl'),
    VMC_WOC_DIR: D.woc, VMC_WOC_RUN: D.wocRun, VMC_XDG_RUNTIME_DIR: '/run/wayland-test',
});
const vmc = require('../vietmap-cluster/vietmap-cluster');

const calls = () => (fs.existsSync(D.calls) ? fs.readFileSync(D.calls, 'utf8').trim().split('\n').filter(Boolean) : []);
const grabs = () => (fs.existsSync(D.grabs) ? fs.readFileSync(D.grabs, 'utf8').trim().split('\n').filter(Boolean) : []);
const envFile = () => { try { return fs.readFileSync(path.join(D.run, 'woc.env'), 'utf8'); } catch (e) { return null; } };
const status = () => JSON.parse(fs.readFileSync(path.join(D.run, 'status.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const restarts = () => calls().filter((c) => c === 'restart waze-on-cluster.service').length;

function installApp(uid, id) {
    const kit = path.join(D.oap, 'oap_' + uid, 'source', 'javascript', 'kit');
    fs.mkdirSync(kit, { recursive: true });
    fs.mkdirSync(path.join(D.oap, 'oap_' + uid, 'data'), { recursive: true });
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'vietmap_cluster', 'app.json'), 'utf8'));
    spec.id = id;
    fs.writeFileSync(path.join(kit, 'app-spec.json'), JSON.stringify(spec));
    return (values) => fs.writeFileSync(path.join(D.oap, 'oap_' + uid, 'data', 'settings.json'), JSON.stringify(values));
}

(async () => {
    // views: every crop number even, the crop 1088x480 inside the captured picture
    Object.keys(vmc.VIEWS).forEach((k) => {
        const v = vmc.VIEWS[k];
        const m = /^(\d+)x(\d+):(\d+),(\d+),(\d+),(\d+)$/.exec(v.crop);
        assert(m, k);
        const n = m.slice(1).map(Number);
        assert.strictEqual(v.geometry, n[0] + 'x' + n[1]);
        n.forEach((x) => assert.strictEqual(x % 2, 0, k + ' odd number'));
        assert.deepStrictEqual([n[4], n[5]], [1088, 480], k);
        assert(n[2] + n[4] <= n[0] && n[3] + n[5] <= n[1], k + ' crop outside the picture');
        assert(n[2] >= Math.ceil(128 * n[0] / 1920), k + ' crop takes in Android Auto\'s bar');
    });
    assert.strictEqual(vmc.envLine('fit'), 'WOC_SRC_CROP=-s avb_stream= -s src_crop=1280x480:136,0,1088,480\n');

    // 1. no app, no waze-on-cluster: nothing happens, the status says so
    vmc.tick();
    assert.strictEqual(status().app, null);
    assert.strictEqual(envFile(), null);
    assert.strictEqual(calls().length, 0);

    // 2. the app, off by default: still nothing
    const save = installApp(12240, 'vietmap_cluster');
    vmc.findApp(Date.now() + 60000);          // (looked for again every 10 s while missing)
    vmc.tick();
    assert.strictEqual(status().app, 'vietmap_cluster');
    assert.strictEqual(status().on, false);
    assert.strictEqual(envFile(), null);

    // 3. on, but waze-on-cluster missing: an error, nothing touched
    save({ mode: 'on' });
    vmc.tick();
    assert.strictEqual(status().error, 'Waze on cluster is not installed');
    assert.strictEqual(envFile(), null);
    assert.strictEqual(grabs().length, 0);

    // 4. waze-on-cluster installed (its udp_port from the local conf): env file, one restart, the grabber
    fs.mkdirSync(path.join(D.woc, 'current'));
    fs.writeFileSync(path.join(D.woc, 'current', 'waze-on-cluster.conf'), 'udp_port = 20557\navb_stream = media_transport.avb_streaming.15\n');
    fs.writeFileSync(path.join(D.woc, 'waze-on-cluster.local.conf'), '# mine\nudp_port = 20999\n');
    fs.writeFileSync(path.join(D.wocRun, 'status.json'), JSON.stringify({ state: 'showing', reason: '' }));
    vmc.tick();
    await sleep(300);
    assert.strictEqual(envFile(), vmc.envLine('fit'));
    assert.strictEqual(restarts(), 1);
    assert.strictEqual(grabs().length, 1);
    assert(grabs()[0].indexOf('XDG=/run/wayland-test --screen=center --geometry=1280x480 --fps=15 --num-frames=0') === 0, grabs()[0]);
    assert(/h264_msdk\(gop=15,gop_ref_dist=1,cbr=2M\), rtp, udp udp:\/\/127\.0\.0\.1:20999$/.test(grabs()[0]), grabs()[0]);
    let s = status();
    assert.strictEqual(s.on, true); assert.strictEqual(s.applied, true); assert.strictEqual(s.grabber.running, true);
    assert.strictEqual(s.waze.state, 'showing'); assert.strictEqual(s.error, null);
    // nothing changes: no second restart or grabber
    vmc.tick(); vmc.tick();
    await sleep(200);
    assert.strictEqual(restarts(), 1);
    assert.strictEqual(grabs().length, 1);

    // 5. another view: the env file, a restart, the grabber again at its size
    save({ mode: 'on', view: 'zoom2' });
    vmc.tick();
    await sleep(300);
    assert.strictEqual(envFile(), vmc.envLine('zoom2'));
    assert.strictEqual(restarts(), 2);
    assert.strictEqual(grabs().length, 2);
    assert(/--geometry=1920x720 .*cbr=4M/.test(grabs()[1]), grabs()[1]);
    assert.strictEqual(vmc._state().grab.view, 'zoom2');

    // 6. off: grabber stopped, env file gone, waze-on-cluster restarted back to the phone's map
    const pid = status().grabber.pid;
    save({ mode: 'off', view: 'zoom2' });
    vmc.tick();
    await sleep(300);
    assert.strictEqual(envFile(), null);
    assert.strictEqual(restarts(), 3);
    assert.strictEqual(status().grabber.running, false);
    assert.throws(() => process.kill(pid, 0), 'the grabber was stopped');

    // 7. a grabber that stops at once: started again after a pause that grows, and the screen says why
    setGrabber('echo "no such screen: center" >&2; exit 3');
    save({ mode: 'on' });
    vmc.tick();
    await sleep(300);
    vmc.tick();
    assert.strictEqual(grabs().length, 3, 'not again before its pause');
    s = status();
    assert.strictEqual(s.grabber.running, false);
    assert(/screen grabber stopped: no such screen: center/.test(s.error), s.error);
    assert.strictEqual(s.grabber.lastExit.code, 3);
    assert.strictEqual(vmc._state().failures, 1);

    // 8. the app removed: everything back
    fs.rmSync(path.join(D.oap, 'oap_12240'), { recursive: true });
    vmc.tick();
    assert.strictEqual(status().app, null);
    assert.strictEqual(envFile(), null);

    // 9. installed again under another id by the Store (vietmap_cluster2): found
    const save2 = installApp(12241, 'vietmap_cluster2');
    save2({ mode: 'on', view: 'zoom1' });
    setGrabber('exec sleep 30');
    await new Promise((r) => setTimeout(r, 10));
    vmc.findApp(Date.now() + 60000);
    vmc.tick();
    await sleep(300);
    assert.strictEqual(status().app, 'vietmap_cluster2');
    assert.strictEqual(envFile(), vmc.envLine('zoom1'));
    vmc.stopGrab();

    // 10. deactivate (the Store's removal): the env file goes and waze-on-cluster restarts; again: nothing
    const before = restarts();
    let r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'vietmap-cluster', 'vietmap-cluster.js'), 'deactivate'], { encoding: 'utf8', env: process.env });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(envFile(), null);
    assert.strictEqual(restarts(), before + 1);
    assert(/back to the phone/.test(r.stdout), r.stdout);
    r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'vietmap-cluster', 'vietmap-cluster.js'), 'deactivate'], { encoding: 'utf8', env: process.env });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(restarts(), before + 1);
    assert(/nothing to undo/.test(r.stdout));

    // 11. the service: SIGTERM stops the grabber and puts waze-on-cluster back
    fs.writeFileSync(path.join(D.run, 'woc.env'), vmc.envLine('fit'));
    const svc = cp.spawn(process.execPath, [path.join(__dirname, '..', 'vietmap-cluster', 'vietmap-cluster.js'), 'run'],
        { env: Object.assign({}, process.env, { VMC_POLL_MS: '100' }), stdio: 'ignore' });
    await sleep(800);
    const n = restarts();
    svc.kill('SIGTERM');
    await new Promise((res) => svc.on('exit', res));
    assert.strictEqual(envFile(), null);
    assert.strictEqual(restarts(), n + 1, 'waze-on-cluster restarted at the stop');

    // the tool's files: component.json names what is there; the unit runs the installed script
    const kit = path.join(__dirname, '..', 'vietmap-cluster');
    const c = JSON.parse(fs.readFileSync(path.join(kit, 'component.json'), 'utf8'));
    c.files.forEach((f) => assert(fs.existsSync(path.join(kit, f.from || f.path)), f.path));
    c.units.forEach((u) => assert(fs.existsSync(path.join(kit, u.name)), u.name));
    c.dropins.forEach((d) => assert(fs.existsSync(path.join(kit, d.from || d.name)), d.name));
    const unit = fs.readFileSync(path.join(kit, 'vietmap-cluster.service'), 'utf8');
    assert(unit.indexOf('/var/opt/' + c.id + '/current/vietmap-cluster.js run') >= 0);
    assert(/^EnvironmentFile=-\/run\/vietmap-cluster\/woc\.env$/m.test(fs.readFileSync(path.join(kit, 'woc-dropin.conf'), 'utf8')));
    assert.strictEqual(require('../vietmap-cluster/vietmap-cluster.js').CFG.run, D.run);
    const src = fs.readFileSync(path.join(kit, 'vietmap-cluster.js'), 'utf8');
    assert(src.indexOf("const VERSION = '" + c.version + "'") >= 0, 'VERSION matches component.json');

    fs.rmSync(T, { recursive: true, force: true });
    console.log('vietmap-cluster checks passed (views / no app / off / no waze-on-cluster / on / view change / off / failing grabber / app gone / renamed app / deactivate / service stop / kit files).');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
