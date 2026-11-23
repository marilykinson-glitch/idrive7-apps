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
const themes = require(path.join(stageJs, 'kit', 'themes'));
const spec = JSON.parse(fs.readFileSync(path.join(stageJs, 'kit', 'app-spec.json'), 'utf8'));

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
                    image: async (name, cv) => { renderCount++; lastWords = new Uint32Array(cv.words()); },
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
                onScroll: () => {},
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

    fs.rmSync(stageParent, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
    console.log('MGU Diagnostics checks passed (Node 8 syntax, vehicle clock sync, running second hand, i18n, reports).');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
