'use strict';
/**
 * mgu-apps.js - Deterministic MGU internal storage reader + installed apps/tools
 * inventory, live per-app CPU/RAM/GPU/disk profiler, and lag/crash advisor.
 *
 * Compatible with Node 8.7+ on BMW MGU Linux (strictly ES2017, read-only,
 * handles EACCES / ENOENT on sandboxed OAP folders gracefully).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const KB = 1024;
const MB = 1048576;
const GB = 1073741824;
const PAGE = 4096;
const HZ = 100;
const MAINAPP_UID = 12201;
const FIRST_APP_UID = 10000;

const STORE_STATE = '/var/opt/mgu-deploy/state.json';
const KEPT_DIR = '/var/opt/mgu-deploy/kept';
const VAR_OPT = '/var/opt';
const OAP_DIR = '/var/opt/public/oap';
const UIDS_TXT = '/var/opt/public/oap/oap_12201/security/uids.txt';
const UPLINK_UIDS = '/var/opt/mgu-uplink/uids.d';
const CG_MEM = '/sys/fs/cgroup/memory/oap.slice/nodejs.slice/';
const DRM_CARD = '/sys/class/drm/card0/';

// Friendly bilingual labels [en, vi] for known MGU apps, Store tools, and core HMI processes
const KNOWN_TITLES = {
    mgu_diagnostics: ['MGU Diagnostics', 'MGU Diagnostics'],
    robertn_store: ['MGU Store', 'MGU Store'],
    jap_ridetube: ['RideTube (YouTube)', 'RideTube (YouTube)'],
    'jap-ridetube-d': ['RideTube Video Service', 'Dịch vụ Video RideTube'],
    robertn_waze_cluster: ['Waze on Cluster', 'Waze trên đồng hồ'],
    'waze-on-cluster': ['Waze Cluster Service', 'Dịch vụ Waze đồng hồ'],
    vietmap_signs: ['VietMap Signs', 'Biển báo VietMap'],
    'vietmap-signs': ['VietMap Signs Helper', 'Trợ thủ Biển báo VietMap'],
    vietmap_cluster: ['VietMap on Cluster', 'VietMap trên đồng hồ'],
    'vietmap-cluster': ['VietMap Cluster Helper', 'Trợ thủ VietMap đồng hồ'],
    thoi_tiet: ['Weather', 'Thời tiết'],
    'thoi-tiet': ['Weather Helper', 'Trợ thủ Thời tiết'],
    xinhan_cam: ['Turn-Signal Camera', 'Camera xi-nhan'],
    'xinhan-cam': ['Turn-Signal Helper', 'Dịch vụ Camera xi-nhan'],
    anh_dai_dien: ['Car Avatar & Icons', 'Hình xe & Giao diện'],
    'anh-dai-dien': ['Car Avatar Service', 'Dịch vụ Hình xe'],
    car_vitals: ['M Vitals', 'Thông số vận hành M'],
    live_data: ['Live Data', 'Dữ liệu xe trực tiếp'],
    live_adjustments: ['Engine Config', 'Cấu hình động cơ'],
    live_adjustments2: ['Engine Config', 'Cấu hình động cơ'],
    edrive: ['eDrive', 'Điện cao áp eDrive'],
    sys_monitor: ['System Monitor', 'Giám sát hệ thống'],
    ambient_config: ['Ambient Config', 'Đèn viền nội thất'],
    iteriodev_ambient: ['Ambient Lighting', 'Hiệu ứng đèn viền'],
    iteriodev_seats: ['Seat Comfort', 'Tiện nghi ghế ngồi'],
    'iteriodev-comfort': ['Comfort Service', 'Dịch vụ tiện nghi'],
    'iteriodev-screencast': ['Screencast', 'Truyền màn hình'],
    'iteriodev-tailscale': ['Tailscale VPN', 'Mạng Tailscale VPN'],
    cluster_themes: ['Cluster Themes', 'Giao diện đồng hồ'],
    idrive_hud_widgets: ['HUD Widgets', 'Tiện ích kính lái HUD'],
    doom: ['DOOM', 'Trò chơi DOOM'],
    draggy: ['Drag Timer', 'Đo tăng tốc Drag'],
    dtc_scanner: ['Fault Scanner', 'Quét mã lỗi DTC'],
    dyno: ['Virtual Dyno', 'Đo công suất Dyno'],
    gforce: ['G-Force', 'Gia tốc G-Force'],
    redline: ['Redline', 'Vòng tua Redline'],
    service: ['Service', 'Bảo dưỡng xe'],
    warmup: ['Warm-Up', 'Làm nóng động cơ'],
    zf8hp: ['ZF 8HP Gearbox', 'Hộp số ZF 8HP'],
    brake_test: ['Brake Test', 'Đo quãng đường phanh'],
    'mgu-render': ['MGU GPU Renderer', 'Bộ dựng GPU MGU'],
    'idrive7-renderd': ['Renderd GPU Engine', 'Nhân đồ họa Renderd'],
    'mgu-renderd': ['Renderd GPU Engine', 'Nhân đồ họa Renderd'],
    'cluster-render': ['Cluster GPU Renderer', 'Bộ dựng GPU đồng hồ'],
    'mgu-updater': ['MGU Store Updater', 'Trình cập nhật Store'],
    'mgu-uplink': ['MGU Internet Uplink', 'Cầu nối mạng Store'],
    'mgu-deploy': ['MGU Deploy Core', 'Trình cài đặt gói MGU'],
    'mgu-inputgate': ['iDrive Input Gate', 'Cổng điều khiển núm xoay'],
    'app-privacy': ['App Privacy Guard', 'Bảo vệ riêng tư OAP'],
    'mgu-python': ['Python Runtime', 'Môi trường Python'],
    'jap-node22': ['Node.js 22 Runtime', 'Môi trường Node.js 22'],
    'gps-timesync': ['GPS TimeSync', 'Đồng bộ giờ GPS'],
    oap_mainapp: ['BMW OAP MainApp', 'Quản lý ứng dụng OAP'],
    hmi_main3d: ['BMW iDrive 3D HMI', 'Giao diện gốc BMW 3D HMI'],
};

// Companion daemon tools paired with an OAP frontend app (used when filtering to 'apps' view)
const COMPANION_OF_APP = {
    jap_ridetube: 'jap-ridetube-d',
    robertn_waze_cluster: 'waze-on-cluster',
    vietmap_signs: 'vietmap-signs',
    vietmap_cluster: 'vietmap-cluster',
    thoi_tiet: 'thoi-tiet',
    xinhan_cam: 'xinhan-cam',
    anh_dai_dien: 'anh-dai-dien',
    robertn_store: 'mgu-updater',
};

function readText(file, errOut) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (errOut) errOut.code = e.code; return null; }
}

function readNum(file) {
    const s = readText(file);
    if (s === null) return null;
    const n = Number(s.trim());
    return Number.isFinite(n) ? n : null;
}

function readJson(file) {
    const s = readText(file);
    if (!s || s.length > 2 * MB) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
}

function listDir(dir, errOut) {
    try { return fs.readdirSync(dir); } catch (e) { if (errOut) errOut.code = e.code; return []; }
}

function tidyId(id) {
    return String(id || '').split(/[_-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || String(id || '');
}

function titleFor(id, customTitle, lang) {
    const k = KNOWN_TITLES[id];
    if (k) return lang === 'en' ? k[0] : k[1];
    if (customTitle && customTitle !== id) return customTitle;
    return tidyId(id);
}

function fmtSize(bytes) {
    if (bytes === null || bytes === undefined || !(bytes >= 0) || !isFinite(bytes)) return '--';
    if (bytes >= GB) {
        const g = bytes / GB;
        return (g >= 100 ? Math.round(g) : g.toFixed(1)) + ' GB';
    }
    if (bytes >= MB) {
        const m = bytes / MB;
        return (m >= 100 ? Math.round(m) : m.toFixed(1)) + ' MB';
    }
    if (bytes >= KB) return Math.max(1, Math.round(bytes / KB)) + ' KB';
    return Math.round(bytes) + ' B';
}

/* ============================================================================
 * 1. Deterministic MGU Internal Storage Reader
 *    - Excludes USB drives (/usb in /sys/block realpath, /media mounts, vfat/exfat)
 *    - Excludes virtual/loop/mapper duplicate counts via st_dev deduplication
 *    - Anchors total capacity to the internal MGU boot flash when present
 * ============================================================================ */

function unescapeMountPath(s) {
    return String(s || '').replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\');
}

function parseMounts(mountsText) {
    const byMnt = Object.create(null);
    const byDev = Object.create(null);
    String(mountsText || '').split('\n').forEach((line) => {
        const p = line.trim().split(/\s+/);
        if (p.length < 4) return;
        const dev = p[0], mnt = unescapeMountPath(p[1]), fstype = p[2], opts = p[3].split(',');
        const rw = opts.indexOf('rw') >= 0 && opts.indexOf('ro') < 0;
        const rec = { dev, mnt, fstype, rw };
        byMnt[mnt] = rec;
        if (!byDev[dev] || (!byDev[dev].rw && rw)) byDev[dev] = rec;
    });
    return { byMnt, byDev };
}

function isRealLocalFs(fstype, platform) {
    if (!fstype) return true;
    if (platform === 'darwin') return /^(apfs|hfs)$/i.test(fstype);
    return /^(ext[234]|f2fs|xfs|btrfs|ubifs|jfs)$/i.test(fstype);
}

function baseBlockName(devPath) {
    const m = /^\/dev\/(mmcblk\d+|nvme\d+n\d+|sd[a-z]+|vd[a-z]+)/.exec(String(devPath || ''));
    return m ? m[1] : null;
}

function inspectBlockDevices(opts) {
    const o = opts || {};
    const sysBlock = o.sysBlockDir || '/sys/block';
    const mounts = o.mounts || parseMounts(o.mountsText !== undefined ? o.mountsText : readText('/proc/mounts'));
    const readBlockNum = o.readBlockNum || ((b, leaf) => readNum(path.join(sysBlock, b, leaf)));
    const readBlockLink = o.readBlockLink || ((b) => {
        const p = path.join(sysBlock, b);
        try { return fs.realpathSync(p); } catch (e) {
            try { return fs.readlinkSync(p); } catch (e2) { return ''; }
        }
    });
    const names = o.blockNames || listDir(sysBlock);
    const externalDevs = [];
    const internal = [];

    names.forEach((b) => {
        if (!/^(mmcblk\d+|nvme\d+n\d+|sd[a-z]+|vd[a-z]+)$/.test(b)) return;
        const rem = readBlockNum(b, 'removable');
        const link = String(readBlockLink(b) || '');
        // USB storage enclosures / SSDs often report removable=0 in SCSI, so inspect sysfs bus path too
        const isUsb = /(?:^|\/)usb\d*(?:\/|$)/i.test(link);
        if (rem === 1 || isUsb) {
            externalDevs.push('/dev/' + b);
            return;
        }
        const sectors = readBlockNum(b, 'size');
        if (sectors !== null && sectors * 512 >= 512 * MB) {
            internal.push({ name: b, bytes: sectors * 512 });
        }
    });

    // Prefer the physical disk that actually backs /var/opt or / when identifiable
    const bootDisks = new Set();
    ['/var/opt', '/var/opt/public', '/'].forEach((mp) => {
        const info = mounts.byMnt[mp];
        const bn = info && baseBlockName(info.dev);
        if (bn) bootDisks.add(bn);
    });
    let hwBytes = null;
    if (internal.length) {
        const matched = internal.filter((d) => bootDisks.has(d.name));
        const pick = matched.length ? matched : [internal[0]];
        hwBytes = pick.reduce((s, d) => s + d.bytes, 0);
    }
    return { hwBytes, externalDevs };
}

function readInternalDiskBytes(opts) {
    return inspectBlockDevices(opts).hwBytes;
}

function storageTargets(dataDir, platform) {
    const candidates = platform === 'darwin'
        ? [dataDir, '/System/Volumes/Data', '/']
        : ['/var/opt', '/var/opt/public', '/', dataDir];
    const seen = Object.create(null);
    const out = [];
    candidates.forEach((p) => {
        if (!p || seen[p]) return;
        seen[p] = true;
        try { if (fs.existsSync(p)) out.push(p); } catch (e) { /* ignore */ }
    });
    return out.length ? out : ['/'];
}

function parseDfOutput(stdout, platform, opts) {
    const o = opts || {};
    const mountsText = o.mountsText !== undefined ? o.mountsText : (platform === 'darwin' ? '' : (readText('/proc/mounts') || ''));
    const mounts = parseMounts(mountsText);
    const blk = inspectBlockDevices({
        sysBlockDir: o.sysBlockDir,
        mounts,
        mountsText,
        blockNames: o.blockNames,
        readBlockNum: o.readBlockNum,
        readBlockLink: o.readBlockLink,
    });
    const statDev = o.statDev !== undefined ? o.statDev : ((mnt) => {
        try { const st = fs.statSync(mnt); return st && Number.isFinite(st.dev) ? st.dev : null; } catch (e) { return null; }
    });

    const rawRows = [];
    String(stdout || '').split('\n').slice(1).forEach((line) => {
        const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/.exec(line.trim());
        if (!m) return;
        const dev = m[1], totalK = Number(m[2]), usedK = Number(m[3]), availK = Number(m[4]), mnt = m[5].trim();
        if (!(totalK > 0) || !/^\/dev\//.test(dev)) return;
        if (/^\/dev\/(loop|ram|zram|fd|sr|shm|mtd|nbd)/.test(dev)) return;
        if (/^\/(media|mnt\/usb|run\/media)(\/|$)/.test(mnt)) return;
        if (blk.externalDevs.some((pfx) => dev.indexOf(pfx) === 0)) return;
        const mInfo = mounts.byMnt[mnt] || mounts.byDev[dev] || null;
        if (mInfo && !isRealLocalFs(mInfo.fstype, platform)) return;
        const isRw = !mountsText ? true : (mInfo ? !!mInfo.rw : true);
        rawRows.push({ dev, totalK, usedK, availK, mnt, isRw });
    });

    if (!rawRows.length) return null;

    if (platform === 'darwin') {
        const pick = rawRows.find((r) => r.mnt === '/System/Volumes/Data') || rawRows.find((r) => r.mnt === '/') || rawRows[0];
        return { totalBytes: pick.totalK * KB, freeBytes: pick.availK * KB };
    }

    // If real partition devices (/dev/sda*, /dev/mmcblk*, /dev/nvme*) are present alongside virtual
    // /dev/dm-* or /dev/mapper/* aliases without st_dev info, avoid counting virtual mapper overlays twice.
    const hasPhysicalRows = rawRows.some((r) => /^\/dev\/(mmcblk\d+|nvme\d+n\d+|sd[a-z]+|vd[a-z]+)/.test(r.dev));
    const byFs = new Map();
    rawRows.forEach((r) => {
        const sdev = statDev ? statDev(r.mnt) : null;
        if (sdev === null && hasPhysicalRows && /^\/dev\/(dm-|mapper\/)/.test(r.dev)) return;
        const key = sdev !== null ? ('stdev:' + sdev)
            : (r.dev === '/dev/root' ? ('geom:' + r.totalK + ':' + r.usedK) : ('geom:' + r.totalK + ':' + r.usedK + ':' + r.availK));
        const prev = byFs.get(key);
        if (!prev) {
            byFs.set(key, { totalK: r.totalK, usedK: r.usedK, availK: r.availK, isRw: r.isRw, mnt: r.mnt });
        } else if (!prev.isRw && r.isRw) {
            prev.isRw = true;
            prev.availK = r.availK;
            prev.mnt = r.mnt;
        }
    });

    let totalK = 0, freeK = 0;
    byFs.forEach((v) => {
        totalK += v.totalK;
        if (v.isRw) freeK += v.availK;
    });

    const mountedBytes = totalK * KB;
    const rwFreeBytes = freeK * KB;
    // Anchor total capacity to physical MGU flash chip when available so logical mounts never inflate it to ~600 GB
    const totalBytes = blk.hwBytes !== null && blk.hwBytes > 0 ? blk.hwBytes : mountedBytes;
    if (!(totalBytes > 0)) return null;
    return {
        totalBytes,
        freeBytes: Math.max(0, Math.min(totalBytes, rwFreeBytes)),
    };
}

/* ============================================================================
 * 2. Safe Non-Symlink-Following Directory Size Calculator
 * ============================================================================ */

function dirSizeBytes(rootDir, maxEntries) {
    const limit = maxEntries || 2800;
    const err = {};
    let st;
    try { st = fs.lstatSync(rootDir); } catch (e) { return { bytes: null, denied: e.code === 'EACCES' || e.code === 'EPERM' }; }
    if (st.isSymbolicLink()) return { bytes: 0, denied: false };
    if (st.isFile()) return { bytes: st.size, denied: false };
    if (!st.isDirectory()) return { bytes: 0, denied: false };

    const firstEntries = listDir(rootDir, err);
    if (err.code === 'EACCES' || err.code === 'EPERM') return { bytes: null, denied: true };

    let total = 0, count = 0;
    const stack = [{ dir: rootDir, names: firstEntries }];
    while (stack.length && count < limit) {
        const cur = stack.pop();
        for (let i = 0; i < cur.names.length && count < limit; i++) {
            const name = cur.names[i];
            if (!name || name === '.' || name === '..') continue;
            count++;
            const full = path.join(cur.dir, name);
            let fst;
            try { fst = fs.lstatSync(full); } catch (e) { continue; }
            if (fst.isSymbolicLink()) continue;
            if (fst.isFile()) total += fst.size;
            else if (fst.isDirectory()) {
                const sub = listDir(full);
                if (sub.length) stack.push({ dir: full, names: sub });
            }
        }
    }
    return { bytes: total, denied: false };
}

/* ============================================================================
 * 3. Linux /proc Parsers & GPU Role Attribution
 * ============================================================================ */

function parseProcStatus(text) {
    const o = { name: '', state: '', uid: -1, rss: null, anon: null, swap: 0, threads: 0 };
    String(text || '').split('\n').forEach((line) => {
        const i = line.indexOf(':');
        if (i < 0) return;
        const k = line.slice(0, i), v = line.slice(i + 1).trim();
        const kb = () => Number(v.split(/\s+/)[0]) * KB;
        if (k === 'Name') o.name = v;
        else if (k === 'State') o.state = v.charAt(0);
        else if (k === 'Uid') o.uid = Number(v.split(/\s+/)[0]);
        else if (k === 'VmRSS') o.rss = kb();
        else if (k === 'RssAnon') o.anon = kb();
        else if (k === 'VmSwap') o.swap = kb();
        else if (k === 'Threads') o.threads = Number(v);
    });
    return o;
}

function parseProcStatm(text) {
    const f = String(text || '').trim().split(/\s+/).map(Number);
    if (f.length < 3 || !isFinite(f[1]) || !isFinite(f[2])) return null;
    return Math.max(0, (f[1] - f[2]) * PAGE);
}

function parseProcStat(text) {
    const s = String(text || ''), end = s.lastIndexOf(')');
    if (end < 0) return null;
    const f = s.slice(end + 2).split(' ');
    const utime = Number(f[11]), stime = Number(f[12]), start = Number(f[19]);
    if (!isFinite(utime) || !isFinite(stime)) return null;
    return { ticks: utime + stime, start: isFinite(start) ? start : null };
}

function parseTotalCpuTicks(text) {
    const first = String(text || '').split('\n')[0] || '';
    if (!/^cpu\s/.test(first)) return null;
    const v = first.trim().split(/\s+/).slice(1).map((n) => Number(n) || 0);
    const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
    return total > 0 ? total : null;
}

function gpuBadgeFor(id, kind, running, cpuPct, isSelf, gpuActive) {
    if (!running) return null;
    if (isSelf) return gpuActive ? 'GPU 60fps' : 'Software';
    if (id === 'mgu-render' || id === 'idrive7-renderd' || id === 'mgu-renderd') return gpuActive ? 'GPU 60fps' : 'GPU GL';
    if (id === 'cluster-render') return 'GPU Cluster';
    if (id === 'hmi_main3d') return 'GPU 3D HMI';
    if (id === 'jap_ridetube' || id === 'jap-ridetube-d') return (cpuPct !== null && cpuPct >= 2) ? 'GPU Video' : 'Video';
    if (id === 'waze-on-cluster' || id === 'robertn_waze_cluster' || id === 'vietmap_cluster' || id === 'vietmap-cluster') return 'GPU Map';
    if (id === 'iteriodev-screencast' || id === 'xinhan_cam' || id === 'xinhan-cam') return 'GPU Video';
    if (kind === 'app' && cpuPct !== null && cpuPct >= 1.2) return 'GPU UI';
    return null;
}

/* ============================================================================
 * 4. Installed Apps & Live Resource Monitor
 * ============================================================================ */

class MguAppsMonitor {
    constructor(opts) {
        const o = opts || {};
        this.procRoot = o.procRoot || '/proc';
        this.selfId = o.selfId || 'mgu_diagnostics';
        this.selfTitle = o.selfTitle || 'MGU Diagnostics';
        this.selfVersion = o.selfVersion || '0.2.0';
        this.selfDataDir = o.dataDir || '';
        this.selfPid = process.pid;
        this.selfUid = typeof process.getuid === 'function' ? process.getuid() : -1;
        this.prevProc = null;       // { totalTicks, ticks: Map<pid, number> }
        this.cmdCache = new Map();  // pid -> string[]
        this.baselineMem = new Map(); // id -> { at, bytes }
        this.leaderPids = new Map();  // id -> { pid, restarts }
        this.diskCache = { at: 0, map: new Map() };
        this.regCache = { sig: '', data: null };
        this.lastSnap = null;
        this.sampledAt = 0;
        this.t0 = Date.now();
        this.initialOapFail = null;
    }

    hasRealProc() {
        return fs.existsSync(path.join(this.procRoot, 'self', 'status'));
    }

    _procArgs(pid) {
        if (this.cmdCache.has(pid)) return this.cmdCache.get(pid);
        const raw = readText(path.join(this.procRoot, String(pid), 'cmdline')) || '';
        const argv = raw.replace(/\0+$/, '') ? raw.replace(/\0+$/, '').split('\0') : [];
        this.cmdCache.set(pid, argv);
        return argv;
    }

    _readRegistry() {
        let stateMtime = 0, uidsMtime = 0;
        try { stateMtime = fs.statSync(STORE_STATE).mtime.getTime(); } catch (e) {}
        try { uidsMtime = fs.statSync(UIDS_TXT).mtime.getTime(); } catch (e) {}
        const uplinkFiles = listDir(UPLINK_UIDS).filter((n) => !/^\./.test(n)).sort();
        const sig = stateMtime + '|' + uidsMtime + '|' + uplinkFiles.join(',');
        if (this.regCache.data && this.regCache.sig === sig) return this.regCache.data;

        const appsById = new Map();     // id -> { id, uid, version, customTitle, pendingReboot }
        const uidToAppId = new Map();   // uid -> id
        const toolsById = new Map();    // id -> { id, version, customTitle, pendingReboot }
        const uidToToolId = new Map();  // uid -> toolId
        const pendingSet = new Set();

        const st = readJson(STORE_STATE);
        if (st && Array.isArray(st.pending_reboot)) {
            st.pending_reboot.forEach((p) => { if (p && p.id) pendingSet.add(String(p.id)); });
        }
        if (st && st.apps && typeof st.apps === 'object') {
            Object.keys(st.apps).forEach((id) => {
                const entry = st.apps[id] || {};
                const uid = Number(entry.uid);
                const ver = entry.version ? String(entry.version) : null;
                appsById.set(id, { id, uid: uid >= FIRST_APP_UID ? uid : null, version: ver, customTitle: null, pendingReboot: pendingSet.has(id) });
                if (uid >= FIRST_APP_UID) uidToAppId.set(uid, id);
            });
        }
        if (st && st.tools && typeof st.tools === 'object') {
            Object.keys(st.tools).forEach((id) => {
                const entry = st.tools[id] || {};
                const ver = entry.version ? String(entry.version) : null;
                let compTitle = null;
                if (ver) {
                    const comp = readJson(path.join(KEPT_DIR, id, ver, 'component.json'));
                    if (comp && typeof comp.title === 'string' && comp.title) compTitle = comp.title;
                }
                toolsById.set(id, { id, version: ver, customTitle: compTitle, pendingReboot: pendingSet.has(id) });
            });
        }

        // Also check standalone mgu-renderd if installed outside Store
        if (!toolsById.has('idrive7-renderd') && !toolsById.has('mgu-renderd') && fs.existsSync('/var/opt/mgu-renderd')) {
            toolsById.set('mgu-renderd', { id: 'mgu-renderd', version: null, customTitle: null, pendingReboot: false });
        }

        // Fallback/extra OAP apps from uids.txt or /var/opt/public/oap/oap_*
        const uidsRaw = readText(UIDS_TXT);
        if (uidsRaw) {
            uidsRaw.split(/\r?\n/).forEach((line) => {
                const m = /^(\d+)=([A-Za-z0-9_.-]+)$/.exec(line.trim());
                if (!m) return;
                const uid = Number(m[1]), id = m[2];
                if (uid === MAINAPP_UID) return;
                if (!appsById.has(id)) {
                    const pkg = readJson(path.join(OAP_DIR, 'oap_' + uid, 'source', 'package.json'));
                    const spec = readJson(path.join(OAP_DIR, 'oap_' + uid, 'source', 'javascript', 'kit', 'app-spec.json'));
                    appsById.set(id, {
                        id, uid,
                        version: (spec && spec.version) || (pkg && pkg.version) || null,
                        customTitle: (spec && spec.title) || null,
                        pendingReboot: pendingSet.has(id),
                    });
                }
                if (!uidToAppId.has(uid)) uidToAppId.set(uid, id);
            });
        }

        // Always ensure self app is registered with exact live version
        const existingSelf = appsById.get(this.selfId);
        const selfUid = existingSelf && existingSelf.uid ? existingSelf.uid : (this.selfUid >= FIRST_APP_UID ? this.selfUid : null);
        appsById.set(this.selfId, {
            id: this.selfId,
            uid: selfUid,
            version: this.selfVersion || (existingSelf && existingSelf.version) || null,
            customTitle: this.selfTitle,
            pendingReboot: pendingSet.has(this.selfId),
        });
        if (selfUid) uidToAppId.set(selfUid, this.selfId);

        // Map dynamic tool UIDs from /var/opt/mgu-uplink/uids.d/<tool>
        uplinkFiles.forEach((toolName) => {
            const content = readText(path.join(UPLINK_UIDS, toolName)) || '';
            content.split('\n').forEach((l) => {
                l.split('#')[0].split(/[\s,]+/).forEach((tok) => {
                    const u = Number(tok);
                    if (tok && u >= FIRST_APP_UID && !uidToToolId.has(u)) uidToToolId.set(u, toolName);
                });
            });
        });

        const data = { appsById, uidToAppId, toolsById, uidToToolId, pendingCount: pendingSet.size };
        this.regCache = { sig, data };
        return data;
    }

    _refreshDiskSizes(reg, nowMs, force) {
        if (!force && this.diskCache.at && nowMs - this.diskCache.at < 30000) return this.diskCache.map;
        const map = new Map();

        reg.appsById.forEach((app) => {
            let appRoot = app.uid ? path.join(OAP_DIR, 'oap_' + app.uid) : null;
            if (app.id === this.selfId && (!appRoot || !fs.existsSync(appRoot)) && this.selfDataDir) {
                const parent = path.dirname(this.selfDataDir);
                appRoot = fs.existsSync(path.join(parent, 'source')) ? parent : this.selfDataDir;
            }
            if (!appRoot) { map.set('app:' + app.id, { bytes: null, protected: false }); return; }
            const r = dirSizeBytes(appRoot, 2600);
            map.set('app:' + app.id, { bytes: r.bytes, protected: !!r.denied });
        });

        reg.toolsById.forEach((tool) => {
            let sum = 0, anyFound = false, denied = false;
            const dirs = [path.join(VAR_OPT, tool.id), path.join(KEPT_DIR, tool.id)];
            if (tool.id === 'idrive7-renderd') dirs.push('/var/opt/mgu-renderd');
            dirs.forEach((d) => {
                if (!fs.existsSync(d)) return;
                const r = dirSizeBytes(d, 2600);
                if (r.bytes !== null) { sum += r.bytes; anyFound = true; }
                else if (r.denied) denied = true;
            });
            map.set('tool:' + tool.id, { bytes: anyFound ? sum : null, protected: !anyFound && denied });
        });

        this.diskCache = { at: nowMs, map };
        return map;
    }

    _matchToolFromCmd(procName, argv, reg) {
        if (procName === 'HmiMain3D' || (argv[0] && /\/HmiMain3D$/.test(argv[0]))) return { kind: 'system', id: 'hmi_main3d' };
        if (procName === 'mgu-render') return { kind: 'tool', id: reg.toolsById.has('mgu-render') ? 'mgu-render' : 'mgu-renderd' };
        if (procName === 'mgu-renderd') return { kind: 'tool', id: reg.toolsById.has('idrive7-renderd') ? 'idrive7-renderd' : 'mgu-renderd' };
        if (procName === 'cluster-render') return { kind: 'tool', id: 'cluster-render' };
        for (let i = 0; i < argv.length; i++) {
            const a = argv[i] || '';
            if (/oap-mainapp21?\//.test(a) || /\/oap_12201\//.test(a)) return { kind: 'system', id: 'oap_mainapp' };
            const mOpt = /^\/var\/opt\/([^/]+)\//.exec(a);
            if (mOpt && mOpt[1] !== 'public') {
                const dirName = mOpt[1] === 'mgu-renderd' && reg.toolsById.has('idrive7-renderd') ? 'idrive7-renderd' : mOpt[1];
                return { kind: 'tool', id: dirName };
            }
            const mOap = /\/oap_(\d+)\//.exec(a);
            if (mOap) {
                const u = Number(mOap[1]);
                if (u === MAINAPP_UID) return { kind: 'system', id: 'oap_mainapp' };
                if (reg.uidToAppId.has(u)) return { kind: 'app', id: reg.uidToAppId.get(u) };
            }
        }
        return null;
    }

    sample(nowMs, opts) {
        const o = opts || {};
        const force = !!o.force;
        if (!force && this.lastSnap && nowMs - this.sampledAt < 1800) return this.lastSnap;
        this.sampledAt = nowMs;

        if (!this.hasRealProc()) {
            this.lastSnap = this._sampleSynthetic(nowMs, !!o.gpuActive);
            return this.lastSnap;
        }

        const reg = this._readRegistry();
        const disks = this._refreshDiskSizes(reg, nowMs, force);

        // GPU & OAP cgroup counters
        const gpuAct = readNum(DRM_CARD + 'gt_act_freq_mhz');
        const gpuMax = readNum(DRM_CARD + 'gt_max_freq_mhz') || readNum(DRM_CARD + 'gt_RP0_freq_mhz');
        const oapFail = readNum(CG_MEM + 'memory.failcnt');
        const oapPeakBytes = readNum(CG_MEM + 'memory.max_usage_in_bytes');
        if (oapFail !== null && this.initialOapFail === null) this.initialOapFail = oapFail;
        const oapFailDelta = oapFail !== null && this.initialOapFail !== null ? Math.max(0, oapFail - this.initialOapFail) : 0;

        // CPU total ticks & system uptime
        const totalTicks = parseTotalCpuTicks(readText(path.join(this.procRoot, 'stat')));
        const upSec = Number(String(readText(path.join(this.procRoot, 'uptime')) || '').split(' ')[0]) || Math.floor(os.uptime() || 0);
        const dTotal = this.prevProc && totalTicks && totalTicks > this.prevProc.totalTicks
            ? (totalTicks - this.prevProc.totalTicks) : 0;
        const nextTicks = new Map();

        // Initialize rows for all installed apps and tools
        const items = new Map();
        const ensureItem = (key, id, kind, version, customTitle, pendingReboot, diskInfo) => {
            if (items.has(key)) return items.get(key);
            const d = diskInfo || { bytes: null, protected: false };
            const it = {
                key, id, kind, // 'app' | 'tool' | 'system'
                version: version || null,
                customTitle: customTitle || null,
                self: kind === 'app' && id === this.selfId,
                running: false,
                procCount: 0,
                mainPid: null,
                minAgeSec: null,
                cpuPct: null,
                memBytes: 0,
                rssBytes: 0,
                swapBytes: 0,
                diskBytes: d.bytes,
                diskProtected: !!d.protected,
                pendingReboot: !!pendingReboot,
                justRestarted: false,
                restarts: 0,
                memLeakMB: 0,
                gpuTag: null,
            };
            items.set(key, it);
            return it;
        };

        reg.appsById.forEach((a) => {
            ensureItem('app:' + a.id, a.id, 'app', a.version, a.customTitle, a.pendingReboot, disks.get('app:' + a.id));
        });
        reg.toolsById.forEach((tl) => {
            ensureItem('tool:' + tl.id, tl.id, 'tool', tl.version, tl.customTitle, tl.pendingReboot, disks.get('tool:' + tl.id));
        });

        // Walk /proc/<pid>
        const pids = listDir(this.procRoot).filter((n) => /^\d+$/.test(n)).map(Number);
        pids.forEach((pid) => {
            const pdir = path.join(this.procRoot, String(pid));
            const stText = readText(path.join(pdir, 'status'));
            if (!stText) return;
            const ps = parseProcStatus(stText);
            if (ps.rss === null) return; // kernel thread

            let own = ps.anon;
            if (own === null) {
                const sm = parseProcStatm(readText(path.join(pdir, 'statm')));
                own = sm !== null ? sm : ps.rss;
            }
            const pstat = parseProcStat(readText(path.join(pdir, 'stat')));
            let cpu = null, ageSec = null;
            if (pstat) {
                nextTicks.set(pid, pstat.ticks);
                const prevT = this.prevProc && this.prevProc.ticks.get(pid);
                if (prevT !== undefined && dTotal > 0) {
                    cpu = Math.max(0, Math.min(100, ((pstat.ticks - prevT) / dTotal) * 100));
                }
                if (pstat.start !== null && upSec > 0) {
                    ageSec = Math.max(0, upSec - pstat.start / HZ);
                }
            }

            let target = null;
            if (pid === this.selfPid || (this.selfUid >= FIRST_APP_UID && ps.uid === this.selfUid)) {
                target = items.get('app:' + this.selfId);
            } else if (ps.uid === MAINAPP_UID) {
                target = ensureItem('system:oap_mainapp', 'oap_mainapp', 'system', 'Stock', null, false, null);
            } else if (ps.uid >= FIRST_APP_UID && reg.uidToAppId.has(ps.uid)) {
                target = items.get('app:' + reg.uidToAppId.get(ps.uid));
            } else if (ps.uid >= FIRST_APP_UID && reg.uidToToolId.has(ps.uid)) {
                const tid = reg.uidToToolId.get(ps.uid);
                target = items.get('tool:' + tid) || ensureItem('tool:' + tid, tid, 'tool', null, null, false, disks.get('tool:' + tid));
            } else if (ps.uid >= 12203 && ps.uid <= 12450) {
                const bmwId = 'bmw_oap_' + ps.uid;
                target = ensureItem('app:' + bmwId, bmwId, 'app', 'BMW', 'BMW App ' + ps.uid, false, { bytes: null, protected: true });
            } else {
                const argv = this._procArgs(pid);
                const matched = this._matchToolFromCmd(ps.name, argv, reg);
                if (matched) {
                    const k = matched.kind + ':' + matched.id;
                    target = items.get(k) || ensureItem(k, matched.id, matched.kind, matched.kind === 'system' ? 'Stock' : null, null, false, disks.get(k));
                }
            }

            if (!target) return;
            target.running = true;
            target.procCount++;
            target.memBytes += own || 0;
            target.rssBytes += ps.rss || 0;
            target.swapBytes += ps.swap || 0;
            if (cpu !== null) target.cpuPct = (target.cpuPct || 0) + cpu;
            if (target.mainPid === null || pid < target.mainPid) target.mainPid = pid;
            if (ageSec !== null && (target.minAgeSec === null || ageSec < target.minAgeSec)) target.minAgeSec = ageSec;
        });

        if (totalTicks) this.prevProc = { totalTicks, ticks: nextTicks };
        this.cmdCache.forEach((v, pid) => { if (!nextTicks.has(pid)) this.cmdCache.delete(pid); });

        // Post-process crash/restart detection, memory growth, and GPU tags
        let totalMeasuredDisk = 0, runningCount = 0;
        items.forEach((it) => {
            if (it.diskBytes !== null && it.diskBytes > 0) totalMeasuredDisk += it.diskBytes;
            if (it.running) {
                runningCount++;
                const prevPid = this.leaderPids.get(it.key);
                if (prevPid) {
                    if (prevPid.pid !== it.mainPid) {
                        prevPid.restarts++;
                        prevPid.pid = it.mainPid;
                        prevPid.at = nowMs;
                    }
                    it.restarts = prevPid.restarts;
                    if (prevPid.restarts > 0 && nowMs - prevPid.at < 180000) it.justRestarted = true;
                } else {
                    this.leaderPids.set(it.key, { pid: it.mainPid, restarts: 0, at: 0 });
                }
                // Detect recent daemon / MainApp crash-respawn even before our app opened
                if (!it.justRestarted && upSec > 300 && it.minAgeSec !== null && it.minAgeSec < 75 && (it.kind !== 'app' || it.id === 'oap_mainapp')) {
                    it.justRestarted = true;
                }
                const base = this.baselineMem.get(it.key);
                if (!base) {
                    this.baselineMem.set(it.key, { at: nowMs, bytes: it.memBytes });
                } else if (nowMs - base.at >= 45000 && it.memBytes - base.bytes >= 16 * MB) {
                    it.memLeakMB = Math.round((it.memBytes - base.bytes) / MB);
                }
            }
            it.gpuTag = gpuBadgeFor(it.id, it.kind, it.running, it.cpuPct, it.self, !!o.gpuActive);
        });

        const allRows = Array.from(items.values());
        this.lastSnap = {
            at: nowMs,
            synthetic: false,
            rows: allRows,
            appCount: reg.appsById.size,
            toolCount: reg.toolsById.size,
            runningCount,
            pendingCount: reg.pendingCount,
            measuredDiskBytes: totalMeasuredDisk,
            gpuMHz: gpuAct,
            gpuMaxMHz: gpuMax,
            oapFailCnt: oapFail,
            oapFailDelta,
            oapPeakMB: oapPeakBytes !== null && oapPeakBytes > 0 ? Math.round(oapPeakBytes / MB) : null,
            upSec,
        };
        return this.lastSnap;
    }

    _sampleSynthetic(nowMs, gpuActive) {
        const t = (nowMs - this.t0) / 1000;
        const wob = (i, amp) => Math.sin(t * 0.9 + i * 1.3) * amp;
        const selfDisk = this.selfDataDir ? (dirSizeBytes(path.dirname(this.selfDataDir), 600).bytes || 4.8 * MB) : 4.8 * MB;
        const defs = [
            // [id, kind, ver, running, cpu, memMB, rssMB, diskMB, pending]
            ['hmi_main3d', 'system', 'Stock', true, 8.4, 860, 1140, null, false],
            ['oap_mainapp', 'system', 'Stock', true, 1.4, 118, 224, null, false],
            ['jap_ridetube', 'app', '0.3.47', true, 6.8, 96, 158, 12.4, false],
            ['jap-ridetube-d', 'tool', '0.3.36', true, 5.2, 68, 112, 38.6, false],
            ['robertn_waze_cluster', 'app', '0.6.14', true, 2.4, 74, 132, 6.2, false],
            ['waze-on-cluster', 'tool', '0.14.6', true, 3.1, 52, 88, 18.5, false],
            [this.selfId, 'app', this.selfVersion, true, 1.6, 54, 108, selfDisk / MB, false],
            ['mgu-render', 'tool', '0.6.25', true, 2.9, 58, 90, 9.4, false],
            ['cluster-render', 'tool', '0.8.2', true, 1.8, 44, 72, 7.8, false],
            ['robertn_store', 'app', '0.9.41', true, 0.7, 66, 122, 8.1, false],
            ['mgu-updater', 'tool', '0.8.53', true, 0.3, 32, 76, 14.2, false],
            ['vietmap_signs', 'app', '0.7.1', true, 0.9, 48, 96, 5.4, false],
            ['vietmap-signs', 'tool', '0.7.1', true, 0.5, 24, 58, 6.8, false],
            ['car_vitals', 'app', '2.27.9', false, 0, 0, 0, 3.2, false],
            ['live_adjustments2', 'app', '0.7.15', false, 0, 0, 0, 4.1, false],
            ['thoi_tiet', 'app', '0.7.17', true, 0.4, 42, 88, 3.6, false],
            ['thoi-tiet', 'tool', '0.4.5', true, 0.2, 19, 48, 4.2, false],
            ['anh_dai_dien', 'app', '0.10.0', false, 0, 0, 0, 2.9, false],
            ['anh-dai-dien', 'tool', '0.10.0', false, 0, 0, 0, 41.8, false],
            ['jap-node22', 'tool', '22.23.4', false, 0, 0, 0, 96.4, false],
            ['mgu-python', 'tool', '1.0.3', false, 0, 0, 0, 44.0, false],
        ];
        const rows = defs.map((d, i) => {
            const running = d[3];
            const cpu = running ? Math.max(0.1, d[4] + wob(i, d[4] * 0.18)) : null;
            const mem = running ? Math.round((d[5] + wob(i + 2, 1.8)) * MB) : 0;
            const rss = running ? Math.round((d[6] + wob(i + 2, 2.2)) * MB) : 0;
            const isSelf = d[0] === this.selfId;
            return {
                key: d[1] + ':' + d[0],
                id: d[0],
                kind: d[1],
                version: d[2],
                customTitle: isSelf ? this.selfTitle : null,
                self: isSelf,
                running,
                procCount: running ? (d[0] === 'hmi_main3d' ? 2 : 1) : 0,
                mainPid: running ? 400 + i * 29 : null,
                minAgeSec: running ? 1800 : null,
                cpuPct: cpu,
                memBytes: mem,
                rssBytes: rss,
                swapBytes: 0,
                diskBytes: d[7] !== null ? Math.round(d[7] * MB) : null,
                diskProtected: false,
                pendingReboot: d[8],
                justRestarted: false,
                restarts: 0,
                memLeakMB: 0,
                gpuTag: gpuBadgeFor(d[0], d[1], running, cpu, isSelf, gpuActive),
            };
        });
        const appCount = rows.filter((r) => r.kind === 'app').length;
        const toolCount = rows.filter((r) => r.kind === 'tool').length;
        const runningCount = rows.filter((r) => r.running).length;
        const measuredDiskBytes = rows.reduce((s, r) => s + (r.diskBytes || 0), 0);
        return {
            at: nowMs,
            synthetic: true,
            rows,
            appCount,
            toolCount,
            runningCount,
            pendingCount: 0,
            measuredDiskBytes,
            gpuMHz: gpuActive ? 700 : 350,
            gpuMaxMHz: 750,
            oapFailCnt: 0,
            oapFailDelta: 0,
            oapPeakMB: 612,
            upSec: 3840,
        };
    }
}

/**
 * Filter & sort snapshot rows for display.
 * filterMode: 'all' | 'apps' | 'running'
 * sortBy:     'ram' | 'cpu' | 'disk' | 'name'
 */
function viewRows(snap, filterMode, sortBy, lang) {
    if (!snap || !Array.isArray(snap.rows)) return [];
    const byToolId = new Map();
    snap.rows.forEach((r) => { if (r.kind === 'tool') byToolId.set(r.id, r); });

    let list;
    if (filterMode === 'apps') {
        // Roll companion daemon CPU/RAM/Disk into its parent OAP app so the user sees full per-app impact
        list = snap.rows.filter((r) => r.kind === 'app').map((r) => {
            const compId = COMPANION_OF_APP[r.id];
            const comp = compId ? byToolId.get(compId) : null;
            if (!comp) return Object.assign({ title: titleFor(r.id, r.customTitle, lang) }, r);
            const mergedDisk = (r.diskBytes !== null || comp.diskBytes !== null)
                ? ((r.diskBytes || 0) + (comp.diskBytes || 0)) : null;
            const running = r.running || comp.running;
            const cpuPct = (r.cpuPct !== null || comp.cpuPct !== null)
                ? ((r.cpuPct || 0) + (comp.cpuPct || 0)) : null;
            return Object.assign({}, r, {
                title: titleFor(r.id, r.customTitle, lang),
                running,
                procCount: r.procCount + comp.procCount,
                cpuPct,
                memBytes: r.memBytes + comp.memBytes,
                rssBytes: r.rssBytes + comp.rssBytes,
                swapBytes: r.swapBytes + comp.swapBytes,
                diskBytes: mergedDisk,
                diskProtected: mergedDisk === null && r.diskProtected,
                justRestarted: r.justRestarted || comp.justRestarted,
                pendingReboot: r.pendingReboot || comp.pendingReboot,
                gpuTag: r.gpuTag || comp.gpuTag,
            });
        });
    } else {
        list = snap.rows.map((r) => Object.assign({ title: titleFor(r.id, r.customTitle, lang) }, r));
        if (filterMode === 'running') list = list.filter((r) => r.running);
    }

    const cmpName = (a, b) => {
        const la = a.title.toLowerCase(), lb = b.title.toLowerCase();
        return la < lb ? -1 : la > lb ? 1 : 0;
    };

    list.sort((a, b) => {
        if (sortBy === 'name') return cmpName(a, b);
        if (sortBy === 'cpu') {
            const ca = a.running && a.cpuPct !== null ? a.cpuPct : -1;
            const cb = b.running && b.cpuPct !== null ? b.cpuPct : -1;
            if (cb !== ca) return cb - ca;
            return (b.memBytes - a.memBytes) || cmpName(a, b);
        }
        if (sortBy === 'disk') {
            const da = a.diskBytes !== null ? a.diskBytes : -1;
            const db = b.diskBytes !== null ? b.diskBytes : -1;
            if (db !== da) return db - da;
            return (b.memBytes - a.memBytes) || cmpName(a, b);
        }
        // Default: 'ram' (running memory first, then disk size, then name)
        if (b.memBytes !== a.memBytes) return b.memBytes - a.memBytes;
        if (a.running !== b.running) return a.running ? -1 : 1;
        const da = a.diskBytes !== null ? a.diskBytes : -1;
        const db = b.diskBytes !== null ? b.diskBytes : -1;
        if (db !== da) return db - da;
        return cmpName(a, b);
    });
    return list;
}

/**
 * Actionable lag & crash diagnostic advisor based on live MGU telemetry.
 */
function diagnoseHealth(snap, sys, lang) {
    const isEn = lang === 'en';
    const rows = viewRows(snap, 'all', 'ram', lang);
    const nonSystem = rows.filter((r) => r.kind !== 'system' && !r.self);
    const topRam = nonSystem.find((r) => r.running && r.memBytes > 0) || rows.find((r) => r.running && r.memBytes > 0) || null;
    const byCpu = viewRows(snap, 'running', 'cpu', lang);
    const topCpu = byCpu.find((r) => r.kind !== 'system' && r.cpuPct !== null && r.cpuPct >= 2) || byCpu[0] || null;
    const crashed = rows.find((r) => r.justRestarted) || null;
    const leaking = rows.find((r) => r.memLeakMB >= 24) || null;

    const oapPct = sys && sys.oapUsedMB !== null && sys.oapCapMB > 0
        ? Math.round((sys.oapUsedMB * 100) / sys.oapCapMB) : null;
    const freeGB = sys && sys.diskFreeBytes !== null ? sys.diskFreeBytes / GB : null;
    const cpuPct = sys && sys.cpuPct !== null ? Math.round(sys.cpuPct) : null;
    const cores = (sys && sys.cpuCores) || 4;
    const load1 = sys && sys.load1 !== null ? sys.load1 : null;
    const upSec = (sys && sys.upSec) || (snap && snap.upSec) || 0;

    // 1. Critical OAP cgroup pool saturation -> main cause of OAP app crashes on MGU!
    if ((oapPct !== null && oapPct >= 84) || (snap && snap.oapFailDelta > 0)) {
        const hog = topRam ? (topRam.title + ' (' + Math.round(topRam.memBytes / MB) + ' MB)') : 'OAP Node.js';
        return {
            level: 'crit',
            badge: isEn ? 'CRASH RISK' : 'NGUY CƠ VĂNG APP',
            headline: isEn
                ? 'OAP memory pool critical (' + (oapPct || '--') + '%) · Top consumer: ' + hog
                : 'Vùng nhớ OAP chạm ngưỡng (' + (oapPct || '--') + '%) · Ngốn nhất: ' + hog,
            advice: isEn
                ? 'Fix: Uninstall unused background apps in MGU Store or hold volume knob 30s to reboot MGU.'
                : 'Xử lý: Gỡ bớt app chạy nền ít dùng trong MGU Store hoặc giữ nút nguồn 30 giây khởi động lại đầu.',
        };
    }

    // 2. Service / App recently crashed & respawned
    if (crashed) {
        return {
            level: 'crit',
            badge: isEn ? 'CRASH DETECTED' : 'PHÁT HIỆN CRASH',
            headline: isEn
                ? crashed.title + ' restarted unexpectedly · Check its RAM/CPU load below'
                : crashed.title + ' vừa tự khởi động lại · Dấu hiệu quá tải RAM hoặc lỗi gói',
            advice: isEn
                ? 'Fix: Update or remove this package in MGU Store if crashes repeat, then restart head unit.'
                : 'Xử lý: Cập nhật hoặc gỡ gói này trong MGU Store nếu văng liên tục, sau đó khởi động lại màn hình.',
        };
    }

    // 3. System-wide RAM critical
    if (sys && sys.ramPct >= 88) {
        const hog = topRam ? (topRam.title + ' (' + Math.round(topRam.memBytes / MB) + ' MB)') : 'HMI';
        return {
            level: 'crit',
            badge: isEn ? 'LOW RAM' : 'THIẾU RAM',
            headline: isEn
                ? 'System RAM at ' + sys.ramPct + '% · Largest active: ' + hog
                : 'RAM hệ thống đầy ' + sys.ramPct + '% · Đang ăn nhiều nhất: ' + hog,
            advice: isEn
                ? 'Fix: Stop video/screencast services or reboot MGU (Store > Settings > Restart head unit).'
                : 'Xử lý: Tắt bớt dịch vụ video/truyền màn hình hoặc vào MGU Store > Cài đặt > Khởi động lại đầu.',
        };
    }

    // 4. High CPU / Load average: distinguish normal post-boot storm (< 4 min) vs sustained CPU hog
    if ((cpuPct !== null && cpuPct >= 75) || (load1 !== null && load1 >= cores * 1.5)) {
        if (upSec > 0 && upSec < 240) {
            return {
                level: 'warn',
                badge: isEn ? 'BOOTING LOAD' : 'MỚI KHỞI ĐỘNG',
                headline: isEn
                    ? 'MGU booted ' + Math.floor(upSec / 60) + 'm' + (upSec % 60) + 's ago · Services still starting (load ' + (load1 ? load1.toFixed(1) : cpuPct + '%') + ')'
                    : 'MGU mới bật ' + Math.floor(upSec / 60) + 'p' + (upSec % 60) + 's · Các dịch vụ đang nạp đồng thời (tải ' + (load1 ? load1.toFixed(1) : cpuPct + '%') + ')',
                advice: isEn
                    ? 'Tip: Wait 1-2 min for startup load to settle; remove unused autostart tools if boot stays slow.'
                    : 'Gợi ý: Đợi 1–2 phút tải sẽ tự hạ; nếu khởi động luôn chậm hãy gỡ bớt dịch vụ chạy ngầm ít dùng.',
            };
        }
        const cpuHog = topCpu ? (topCpu.title + (topCpu.cpuPct !== null ? ' (' + topCpu.cpuPct.toFixed(1) + '%)' : '')) : 'CPU';
        return {
            level: 'warn',
            badge: isEn ? 'HIGH CPU' : 'TẢI CPU CAO',
            headline: isEn
                ? 'Sustained CPU load (' + (cpuPct !== null ? cpuPct + '%' : 'load ' + load1.toFixed(1)) + ') · Top: ' + cpuHog
                : 'CPU tải cao kéo dài (' + (cpuPct !== null ? cpuPct + '%' : 'tải ' + load1.toFixed(1)) + ') · Cao nhất: ' + cpuHog,
            advice: isEn
                ? 'Fix: Sort by CPU below to spot stuck helpers; restart head unit in Store Settings if UI lags.'
                : 'Xử lý: Bấm Xếp: CPU bên dưới để tìm gói treo; khởi động lại MGU trong Cài đặt Store nếu màn bị trễ.',
        };
    }

    // 5. Memory leak growth or low disk space or pending reboot
    if (leaking) {
        return {
            level: 'warn',
            badge: isEn ? 'RAM GROWING' : 'RAM ĐANG TĂNG',
            headline: isEn
                ? leaking.title + ' grew by +' + leaking.memLeakMB + ' MB during this session'
                : leaking.title + ' đã tăng thêm +' + leaking.memLeakMB + ' MB RAM trong phiên chạy này',
            advice: isEn
                ? 'Fix: Update this app in MGU Store or restart head unit before OAP memory fills up.'
                : 'Xử lý: Kiểm tra bản cập nhật mới trong MGU Store hoặc khởi động lại đầu trước khi tràn RAM OAP.',
        };
    }

    if (freeGB !== null && freeGB < 3) {
        const byDisk = viewRows(snap, 'all', 'disk', lang);
        const bigDisk = byDisk[0] && byDisk[0].diskBytes ? (byDisk[0].title + ' ' + fmtSize(byDisk[0].diskBytes)) : '/var/opt';
        return {
            level: 'warn',
            badge: isEn ? 'LOW STORAGE' : 'SẮP ĐẦY BỘ NHỚ',
            headline: isEn
                ? 'Only ' + freeGB.toFixed(1) + ' GB free on MGU · Largest measured: ' + bigDisk
                : 'Chỉ còn trống ' + freeGB.toFixed(1) + ' GB trên MGU · Gói nặng nhất: ' + bigDisk,
            advice: isEn
                ? 'Fix: Clear RideTube video cache or remove heavy unused runtimes/tools in MGU Store.'
                : 'Xử lý: Xóa cache video RideTube hoặc gỡ các bộ công cụ nặng không dùng trong MGU Store.',
        };
    }

    if (snap && snap.pendingCount > 0) {
        return {
            level: 'warn',
            badge: isEn ? 'REBOOT PENDING' : 'CHỜ KHỞI ĐỘNG LẠI',
            headline: isEn
                ? snap.pendingCount + ' installed update(s) waiting for MGU head-unit restart'
                : 'Có ' + snap.pendingCount + ' gói cập nhật đang chờ khởi động lại đầu MGU để áp dụng',
            advice: isEn
                ? 'Fix: Open MGU Store > Settings > Restart head unit when parked safely.'
                : 'Xử lý: Khi đỗ xe an toàn, mở MGU Store > Cài đặt > Khởi động lại màn hình để đồng bộ gói.',
        };
    }

    // 6. Healthy normal state
    const topDesc = topRam
        ? (topRam.title + ' (' + Math.max(1, Math.round(topRam.memBytes / MB)) + ' MB' +
            (topRam.cpuPct !== null ? ' · CPU ' + topRam.cpuPct.toFixed(1) + '%' : '') + ')')
        : (isEn ? 'Normal' : 'Bình thường');
    return {
        level: 'ok',
        badge: isEn ? 'HEALTHY' : 'ỔN ĐỊNH',
        headline: isEn
            ? 'Resources healthy · Top active app: ' + topDesc
            : 'Tài nguyên ổn định · Đang dùng nhiều nhất: ' + topDesc,
        advice: isEn
            ? 'If MGU ever lags or crashes: check OAP RAM (<85%), sort by CPU/RAM, or hold volume knob 30s.'
            : 'Mẹo khi đầu lag/văng app: kiểm tra Vùng nhớ OAP (<85%), lọc Đang chạy, hoặc giữ nút nguồn 30s.',
    };
}

module.exports = {
    MguAppsMonitor,
    readInternalDiskBytes,
    parseDfOutput,
    storageTargets,
    dirSizeBytes,
    viewRows,
    diagnoseHealth,
    fmtSize,
    titleFor,
};
