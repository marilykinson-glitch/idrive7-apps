'use strict';
/**
 * Synthetic checks for MGU Diagnostics:
 *   - Node 8 syntax compatibility (no ?., ??, etc.)
 *   - unique ECU addresses in demo.js and non-destructive demo clear
 *   - bidirectional Vietnamese <-> English switching without Vietnamese leaks
 *   - UDS NRC and curated fault translation coverage
 *   - live vehicle clock sync (KombiIF) across UTC host timezone + running second hand (kim giây)
 *   - cold-boot TASU availability recovery when demo='auto'
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'apps', 'mgu_diagnostics');

// 1. Node 8 compatibility check on app JS files (disallow ES2020+ ?. and ?? tokens)
for (const file of fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(APP_DIR, file), 'utf8');
    // Strip comments and string literals conservatively to check operators
    const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
    assert(!/\?\./.test(stripped), file + ': optional chaining (?.) breaks Node 8 on MGU');
    assert(!/\?\?/.test(stripped), file + ': nullish coalescing (??) breaks Node 8 on MGU');
}

// 2. Demo ECUs must have unique diagnostic addresses
const DEMO = require(path.join(APP_DIR, 'demo'));
const demoAddrs = DEMO.ecus.map((e) => e.addr);
assert.strictEqual(new Set(demoAddrs).size, demoAddrs.length, 'DEMO.ecus must not repeat ECU addresses');

// 3. Stage offline Vietnamese switchable preview into a temp copy and exercise runtime
const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-diag-test-'));
cp.execFileSync('python3', [
    path.join(ROOT, 'kit', 'tools', 'build.py'),
    '--language', 'vi', '--language-setting', '--plain-version', '--preview-only', 'mgu_diagnostics',
], { cwd: ROOT, stdio: 'pipe' });

const stageJs = path.join(ROOT, 'dist', 'mgu_diagnostics', 'source', 'javascript');
const i18n = require(path.join(stageJs, 'kit', 'i18n'));
const { diagnosticText } = require(path.join(stageJs, 'diagnostic-text'));
const { NRC } = require(path.join(stageJs, 'kit', 'diag'));
const { Recorder } = require(path.join(stageJs, 'kit', 'record'));
const { Canvas } = require(path.join(stageJs, 'kit', 'canvas'));
const G = require(path.join(stageJs, 'kit', 'gauges'));
const themes = require(path.join(stageJs, 'kit', 'themes'));
const mguApps = require(path.join(stageJs, 'mgu-apps'));
const spec = JSON.parse(fs.readFileSync(path.join(stageJs, 'kit', 'app-spec.json'), 'utf8'));

// 3b. Deterministic MGU storage checks (must never inflate ~119 GB to ~600 GB from mapper/dm/USB mounts)
{
    const GiB = 1073741824;
    const mguMounts = [
        '/dev/root / ext4 ro,noatime 0 0',
        '/dev/sda2 / ext4 ro,noatime 0 0',
        '/dev/sda6 /var/opt ext4 rw,noatime 0 0',
        '/dev/sda6 /var/opt/public ext4 rw,noatime 0 0',
        '/dev/dm-0 /mnt/nav squashfs ro 0 0',
        '/dev/mapper/speech_vol /mnt/speech ext4 ro 0 0',
        '/dev/mapper/var_opt_alias /var/opt/alias ext4 rw 0 0',
        '/dev/shm /dev/shm tmpfs rw 0 0',
        '/dev/sdb1 /media/USB500 exfat rw 0 0',
    ].join('\n');
    const noisyDf = [
        'Filesystem 1024-blocks Used Available Capacity Mounted on',
        '/dev/root 8388608 6291456 2097152 75% /',
        '/dev/sda2 8388608 6291456 2097152 75% /',
        '/dev/sda6 96468992 8178892 88290100 9% /var/opt',
        '/dev/sda6 96468992 8178892 88290100 9% /var/opt/public',
        '/dev/mapper/var_opt_alias 96468992 8178892 88290100 9% /var/opt/alias',
        '/dev/dm-0 41943040 41943040 0 100% /mnt/nav',
        '/dev/mapper/speech_vol 31457280 30000000 1457280 96% /mnt/speech',
        '/dev/shm 2889728 12000 2877728 1% /dev/shm',
        '/dev/sdb1 488386560 100000000 388386560 21% /media/USB500',
    ].join('\n');
    const stDevs = { '/': 2050, '/var/opt': 2054, '/var/opt/public': 2054, '/var/opt/alias': 2054 };
    const parsed = mguApps.parseDfOutput(noisyDf, 'linux', {
        mountsText: mguMounts,
        blockNames: ['sda', 'sdb', 'dm-0'],
        // Simulate 128 GB internal flash (119.2 GiB) + external 500 GB USB SSD with removable=0!
        readBlockNum: (b, leaf) => {
            if (leaf === 'removable') return 0;
            if (leaf === 'size') return b === 'sda' ? 250069680 : b === 'sdb' ? 976773168 : 83886080;
            return null;
        },
        readBlockLink: (b) => (b === 'sdb'
            ? '/sys/devices/pci0000:00/0000:00:15.0/usb2/2-1/2-1:1.0/host1/target1:0:0/1:0:0:0/block/sdb'
            : '/sys/devices/pci0000:00/0000:00:12.0/ata1/host0/target0:0:0/0:0:0:0/block/sda'),
        statDev: (mnt) => (Object.prototype.hasOwnProperty.call(stDevs, mnt) ? stDevs[mnt] : null),
    });
    assert(parsed, 'parseDfOutput must return storage info on MGU');
    assert.strictEqual(Math.round(parsed.totalBytes / GiB), 119, 'MGU total storage must stay locked at 119 GiB, never ~600 GB');
    assert.strictEqual(Math.round((parsed.freeBytes / GiB) * 10) / 10, 84.2, 'MGU free space must equal writable /var/opt without double-counting');
}

// 3c. Verify all 5 tabs + Settings fit inside the real 1256 px MGU header strip in both VI and EN
for (const lang of ['vi', 'en']) {
    i18n.setLanguage(lang);
    const hdrCv = new Canvas(1920, 720);
    const tabs = ['Faults  1/2', 'Check Control', 'Control units', 'MGU status', 'Apps', 'Settings'];
    G.header(hdrCv, themes.theme('m_tricolour'), 84, 0, 1256, 80, 'MGU Diagnostics', tabs, 0, [{ text: 'DEMO' }], true, true);
    const rects = hdrCv.tabRects || [];
    assert.deepStrictEqual(rects.map((x) => x.i), tabs.map((x, i) => i), lang + ': all 6 tabs must fit in 1256px MGU header');
}
i18n.setLanguage('vi');

// 3d. Verify lag & crash advisor diagnostics
{
    const baseSnap = {
        rows: [
            { id: 'jap_ridetube', kind: 'app', customTitle: null, running: true, procCount: 1, cpuPct: 42, memBytes: 160 * 1048576, rssBytes: 210 * 1048576, swapBytes: 0, diskBytes: 50 * 1048576 },
        ],
        oapFailDelta: 0,
        pendingCount: 0,
    };
    const critOap = mguApps.diagnoseHealth(baseSnap, { oapUsedMB: 910, oapCapMB: 1000, ramPct: 68, cpuPct: 35, load1: 1.5, upSec: 900, diskFreeBytes: 50e9 }, 'vi');
    assert.strictEqual(critOap.level, 'crit');
    assert(critOap.headline.indexOf('RideTube') >= 0, 'OAP saturation advisor must name top RAM hog');

    const bootLoad = mguApps.diagnoseHealth(baseSnap, { oapUsedMB: 598, oapCapMB: 1000, ramPct: 62, cpuPct: 80, load1: 8.47, upSec: 214, diskFreeBytes: 84e9 }, 'vi');
    assert.strictEqual(bootLoad.level, 'warn');
    assert(bootLoad.badge.indexOf('KHỞI ĐỘNG') >= 0, 'advisor must distinguish post-boot load storm');
}

// Verify NRC translations in Vietnamese and clean English switch
i18n.setLanguage('vi');
for (const label of Object.values(NRC)) {
    assert.notStrictEqual(i18n.t(label), label, 'untranslated Vietnamese NRC: ' + label);
}
assert(diagnosticText('Head unit: Bluetooth/Wi-Fi aerial 1: Disconnected line').indexOf('Bluetooth/Wi-Fi') >= 0);
assert(diagnosticText('BDC: LED GEN2: Headlight temperature too high').indexOf('GEN2') >= 0);
assert(diagnosticText('Telematics: Mobile network connection limited').indexOf('Mô tả gốc:') < 0);

i18n.setLanguage('en');
assert.strictEqual(
    diagnosticText('Hot film air mass meter: Intake air temp too high'),
    'Hot film air mass meter: Intake air temp too high',
    'English mode must never leak Vietnamese dictionary entries'
);
assert.strictEqual(
    diagnosticText('Front right speaker output lines: Disconnected line'),
    'Front right speaker output lines: Disconnected line'
);
i18n.setLanguage('vi');

// 4. Full app lifecycle, clock sync, second-hand motion, and TASU recovery
(async () => {
    const dataDir = path.join(stageParent, 'data');
    fs.mkdirSync(dataDir);
    let renderCount = 0, lastWords = null, gpuSim = false;
    const drawnTexts = [];
    let lastTargets = [];
    const clicks = {}, watches = {}, tasu = {};
    const settingsVals = {};
    spec.settings.forEach((s) => { settingsVals[s.key] = s.default; });
    settingsVals.autoScan = false;
    const settingListeners = [];

    const fakeMgu = {
        run: async (impl) => {
            const ctx = {
                spec,
                dataDir,
                log: { info: () => {}, warn: () => {}, error: (e) => { throw new Error(String(e)); }, debug: () => {} },
                ui: {
                    text: () => Promise.resolve(),
                    image: async (name, cv) => { renderCount++; lastWords = new Uint32Array(cv.words()); lastTargets = cv.targets || []; },
                    onClick: (name, fn) => { clicks[name] = fn; },
                    onVisible: () => {},
                    onFocus: () => {},
                    isVisible: () => true,
                },
                settings: {
                    get: (k) => settingsVals[k],
                    set: (k, v) => {
                        settingsVals[k] = v;
                        if (k === 'language' && i18n.setLanguage) i18n.setLanguage(v);
                        settingListeners.forEach((fn) => fn(k, v));
                    },
                    onChange: (fn) => settingListeners.push(fn),
                },
                display: { active: () => gpuSim },
                signals: {
                    watch: async (iface, inst, handlers) => { watches[iface] = handlers; return { available: true }; },
                    proxy: async () => ({ isAvailable: () => false }),
                    on: async (p, name, fn) => { tasu[name] = fn; },
                    onAvailable: async (p, fn) => { tasu.avail = fn; },
                    call: async () => 'NO_ERROR',
                },
                theme: () => themes.theme(settingsVals.theme),
                canvas: (w, h) => {
                    const r = new Recorder(w, h, { textScale: 1 });
                    r.own = true;
                    const origText = r.text.bind(r);
                    r.text = function (str, x, y, size, c, opts) {
                        const rendered = opts && opts.literal ? String(str) : i18n.t(str);
                        drawnTexts.push(rendered);
                        return origText(str, x, y, size, c, opts);
                    };
                    return r;
                },
                hideButton: () => {},
                onLayout: () => {},
                onScroll: (fn) => { clicks._scroll = fn; },
                onTab: (fn) => { clicks._tab = fn; },
                loop: (name, fps, fn) => { clicks._tick = fn; return { kick: () => {}, stop: () => {} }; },
            };
            await impl.start(ctx);
        },
    };

    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === './kit/mgu') return fakeMgu;
        return origLoad.apply(this, arguments);
    };
    try {
        require(path.join(stageJs, 'app.js'));
    } finally {
        Module._load = origLoad;
    }

    await new Promise((r) => setTimeout(r, 50));

    // Inject vehicle clock at 2026-11-23 14:05:10 UTC+07:00
    watches['de.bmw.infotainment.KombiIF'].statusTimeDate({
        statusTimeZonesOffset: 60, // (60 - 32) * 15 = +420 min = UTC+07:00
        statusCheckboxTimeAdjustAutomatically: 1,
    });
    watches['de.bmw.infotainment.KombiIF'].statusShowTimeDate({
        displayDateYear: 2026, displayDateMonth: 11, displayDateDay: 23,
        displayHour: 14, displayMinute: 5, displaySecond: 10,
    });

    // Open MGU status tab (tab index 3)
    drawnTexts.length = 0;
    clicks._tab(3);
    await clicks._tick();
    assert(drawnTexts.some((s) => /^14:05:1[01]$/.test(s)), 'system clock must display vehicle KombiIF time');
    assert(drawnTexts.some((s) => s.indexOf('UTC+07:00') >= 0), 'system clock must display vehicle timezone');
    assert(drawnTexts.some((s) => s.indexOf('KOMBI') >= 0), 'system clock must report KOMBI sync state');

    // Verify second hand & digital seconds advance automatically without user interaction!
    const countBefore = renderCount;
    const wordsBefore = lastWords;
    await new Promise((r) => setTimeout(r, 1100));
    drawnTexts.length = 0;
    await clicks._tick();
    assert(renderCount > countBefore, 'MGU status page must redraw every second in software mode');
    assert.notDeepStrictEqual(lastWords, wordsBefore, 'second hand and clock frame must advance');
    assert(drawnTexts.some((s) => /^14:05:1[12]$/.test(s)), 'digital clock second must tick forward');
    assert(drawnTexts.some((s) => s === 'Dung lượng MGU'), 'MGU status page must show MGU storage row');
    assert(drawnTexts.some((s) => /Trống \d/.test(s)), 'MGU status page must report total and free storage');

    // Verify GPU mode redraws sub-second for smooth second-hand sweep
    gpuSim = true;
    const gpuCount0 = renderCount;
    await new Promise((r) => setTimeout(r, 80));
    await clicks._tick();
    assert(renderCount > gpuCount0, 'GPU mode must animate sweeping second hand smoothly');
    gpuSim = false;

    // Verify static Faults tab does NOT redraw idly when nothing changed
    clicks._tab(0);
    await clicks._tick();
    const idleBefore = renderCount;
    await clicks._tick();
    assert.strictEqual(renderCount, idleBefore, 'static Faults page must not waste redraws when unchanged');

    // Run Demo scan, save report, verify report contains vehicleTime & non-mutated DEMO
    const origDemoCount = DEMO.ecus.reduce((s, e) => s + e.dtcs.length, 0);
    await clicks.BTN_SCAN();
    await clicks.BTN_REPORT();
    const reportsDir = path.join(dataDir, 'reports');
    const files = fs.readdirSync(reportsDir);
    assert.strictEqual(files.length, 1, 'report file must be saved');
    const rep = JSON.parse(fs.readFileSync(path.join(reportsDir, files[0]), 'utf8'));
    assert.strictEqual(rep.clockSyncedToVehicle, true);
    assert(/^2026-11-23T14:05:/.test(rep.vehicleTime), 'saved report must carry vehicle-synced timestamp');
    assert.strictEqual(DEMO.ecus.reduce((s, e) => s + e.dtcs.length, 0), origDemoCount, 'DEMO singleton must stay untouched');

    // Clear faults (arm + confirm) and verify clear status stays on Faults tab, never bleeding to side tabs
    await clicks.BTN_CLEAR();
    await clicks.BTN_CLEAR();
    drawnTexts.length = 0;
    await clicks._tick();
    assert(drawnTexts.some((s) => s.indexOf('Đã xóa') >= 0), 'Faults tab must show clear result right after clearing');

    drawnTexts.length = 0;
    clicks._tab(1); // Check Control tab
    await clicks._tick();
    assert(!drawnTexts.some((s) => s.indexOf('Đã xóa') >= 0), 'Check Control tab must not show Faults clear banner');
    assert(drawnTexts.some((s) => s.indexOf('Lần quét gần nhất') >= 0), 'Check Control tab must show Last scan timestamp');

    drawnTexts.length = 0;
    clicks._tab(2); // Control units tab
    await clicks._tick();
    assert(!drawnTexts.some((s) => s.indexOf('Đã xóa') >= 0), 'Control units tab must not show Faults clear banner');

    // Open new Apps & resources tab (tab index 4) and verify installed apps, versions, CPU/RAM/GPU/Disk & interactive buttons
    assert.strictEqual(i18n.t('Apps'), 'Ứng dụng');
    assert.strictEqual(i18n.t('Installed on MGU'), 'Đã cài trên MGU');
    assert.strictEqual(i18n.t('System load'), 'Tải hệ thống');
    assert.strictEqual(i18n.t('Lag & crash advisor'), 'Chẩn đoán lag / crash & Xử lý');
    assert.strictEqual(i18n.t('MGU apps & resources'), 'Chi tiết ứng dụng & tài nguyên');
    drawnTexts.length = 0;
    clicks._tab(4);
    await clicks._tick();
    assert(drawnTexts.some((s) => s === 'ỨNG DỤNG / DỊCH VỤ'), 'Apps tab must render Vietnamese table headers');
    assert(drawnTexts.some((s) => s === 'TRẠNG THÁI · GPU'), 'Apps tab must render GPU state column');
    assert(drawnTexts.some((s) => s === 'DUNG LƯỢNG'), 'Apps tab must render storage column');
    assert(drawnTexts.some((s) => s.indexOf('RideTube') >= 0), 'Apps tab must list top RAM consumer first');
    assert(drawnTexts.some((s) => /MB · RSS \d+M/.test(s)), 'Apps tab must display per-app private and RSS RAM');
    assert(lastTargets.some((t) => t.key === 'appSort'), 'Apps tab must expose interactive Sort button');
    assert(lastTargets.some((t) => t.key === 'appFilter'), 'Apps tab must expose interactive Filter button');

    // Scroll down on Apps tab (let spring glide settle across frames) and verify MGU Diagnostics + version appear
    assert.strictEqual(clicks._scroll(240), true, 'Apps tab list must support touch/knob scrolling');
    await new Promise((r) => setTimeout(r, 120));
    await clicks._tick();
    await new Promise((r) => setTimeout(r, 120));
    drawnTexts.length = 0;
    await clicks._tick();
    assert(drawnTexts.some((s) => s.indexOf('MGU Diagnostics') >= 0), 'Scrolling Apps tab must reveal MGU Diagnostics');
    assert(drawnTexts.some((s) => s === 'v' + spec.version), 'Apps tab must display current app version');

    // Exercise sort & filter cycling + English clean switch on Apps tab
    lastTargets.find((t) => t.key === 'appSort').run(); // -> Sort: CPU
    lastTargets.find((t) => t.key === 'appFilter').run(); // -> Show: Apps
    drawnTexts.length = 0;
    await clicks._tick();
    assert(drawnTexts.some((s) => s.indexOf('XẾP: CPU') >= 0), 'Sort button must cycle to CPU');
    assert(drawnTexts.some((s) => s.indexOf('LỌC: ỨNG DỤNG') >= 0), 'Filter button must cycle to Apps');

    i18n.setLanguage('en');
    drawnTexts.length = 0;
    await clicks._tick();
    assert(drawnTexts.some((s) => s === 'APP / SERVICE'), 'Apps tab must switch cleanly to English');
    assert(drawnTexts.some((s) => s.indexOf('SORT: CPU') >= 0), 'Sort button must switch to English');
    assert(!drawnTexts.some((s) => s.indexOf('ỨNG DỤNG') >= 0), 'English Apps tab must not leak Vietnamese text');
    i18n.setLanguage('vi');

    fs.rmSync(stageParent, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
    console.log('MGU Diagnostics checks passed (Node 8 syntax, vehicle clock sync, second hand, storage, tab-scoped status, i18n, reports).');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
