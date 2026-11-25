'use strict';
/**
 * MGU Diagnostics - reads the fault memory of every control unit over the head
 * unit's diagnostic transport (TASU, see diag.js) and can clear it.
 *
 *   Scan  : UDS 19 02 <mask> to all ECUs (0xDF), like BMW's own teleservice
 *           job READ_PRIMARY_DTCS; optional info memory 19 17 <mask> 01.
 *   Clear : UDS 14 FF FF FF to all control units at once, then to each unit with faults that did not confirm
 *           (press twice to confirm), then scans again.
 *   Check Control: the active messages from CheckControlMaster, named via the
 *           cluster's KombiInterface_2 lists.
 *   MGU status: live vehicle-synced clock (KombiIF) with running second hand,
 *           MGU CPU/RAM/OAP/GPU telemetry, passive vehicle bus vitals, and network interfaces.
 *
 * Pages: faults (6 per page) -> Check Control -> control units that answered -> MGU status.
 * Where the kit runs the screen, all the faults are on one page and each list scrolls.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { fitText } = require('./kit/text-layout');
const { diagnosticText } = require('./diagnostic-text');
const { t: translateUI, plural, getLanguage } = require('./kit/i18n');
const { Diag, parseDtcReply, statusInfo, hex, NRC } = require('./kit/diag');
const { MguAppsMonitor, parseDfOutput, storageTargets, viewRows, diagnoseHealth, fmtSize } = require('./mgu-apps');
const DEMO = require('./demo');

const W = 1600, H = 520, PER_PAGE = 6, EXTRA_PAGES = 4;
const GO = '#2fd27a';
const uiPair = (en, vi) => (getLanguage() === 'en' ? en : vi);
const pad2 = (n) => String(n).padStart(2, '0');

// diagnostic addresses -> control unit (unknown ones show as "ECU 0x..")
const { ECU } = require('./kit/ecus');
// Fault texts, first match wins:
//  1. dtc_texts.js   this car's own coding tool export (kit/tools/dtc_texts.py; not in git)
//  2. known_texts.js a few hand-written ones (in git)
//  3. dtc_db/        a fault text database imported with kit/tools/dtc_texts.py --db (not in git: it is
//                    BMW's). Each unit's SGBD index (UDS 22 F1 50, what BMW's diagnostic tools identify it by)
//                    picks its texts: sgbd_index.json "<address> <index>" -> texts/<SGBD>.json;
//                    dtc_texts.json there holds "<address>:<code>" ones; unit_names.json names the unit.
//  4. dtc_db/code_texts.json  a fault code list (kit/tools/dtc_texts.py --codes) for faults with no
//                    text above: "<code>": text (any unit) or { "<address>": text } (those units only).
//  5. dtc_db/tables/ fault text tables (kit/tools/dtc_tables.py; BMW's, not in git), split so only the
//                    units that report faults are read: variant/<sgbd>.json the text for exactly that
//                    unit type, addr/<address>.json the text all types at that address agree on (both
//                    before 3.), codes.json code-only texts and ambiguous.json "<code>": how many
//                    different texts a code has (when nothing else knows it).
// The build packs dtc_db/ into one compressed file, dtc_db.pack (kit/runtime/pack.js): ~19 MB of
// texts take ~3.5 MB, and a lookup inflates only the few KB that hold its code.
const DB = require('./kit/pack').open(path.join(__dirname, 'dtc_db'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const req = (m) => { try { return require(m); } catch (e) { return {}; } };
const OWN = Object.assign({}, req('./known_texts'), req('./dtc_texts'));
const text = (key) => OWN[key] || DB.get('dtc_texts.json', key);
const SGBD = DB.json('sgbd_index.json');
const UNIT_NAMES = DB.json('unit_names.json');
const HAS_DB = Object.keys(SGBD).length > 0;
let ids = {};                     // "12" -> "0F26E8" (unit's SGBD index); '' = asked, gave none
const variant = (a) => {
    const v = ids[hex(a)] ? SGBD[hex(a) + ' ' + ids[hex(a)]] : null;
    return v && /^[A-Za-z0-9_]+$/.test(v) ? v : null;
};
// SGBD variants identify the actual ECU type and remain useful when a different
// BMW model puts that ECU at a different diagnostic address. The bundled fault
// catalog contains the variant IDs but not BMW's unit_names.json, so name common
// ECU families here and retain the exact variant in the fallback label when unknown.
const ECU_FAMILY_VI = {
    ACSM: 'Túi khí ACSM', ADCAM: 'Camera hỗ trợ lái', ICAM: 'Camera xe ICAM', AHM: 'Kéo moóc AHM',
    AMP: 'Âm thanh AMP', AMPH: 'Âm thanh AMPH', AMPT: 'Âm thanh AMPT',
    ATM: 'Viễn thông ATM', BAT: 'Pin BAT', BATT: 'Pin BATT', BCP: 'Điều khiển pin BCP',
    BDC: 'Thân xe BDC', BFH: 'Cửa BFH', BFS: 'Cửa BFS',
    CAS: 'Truy cập và khởi động CAS', CCU: 'Điều khiển trung tâm CCU', CDM: 'Điều khiển trung tâm CDM',
    CID: 'Màn hình CID', CIC: 'Thông tin giải trí CIC', CICM: 'Thông tin giải trí CICM',
    DCS: 'Camera tài xế', DME: 'Động cơ DME', DKG: 'Hộp số ly hợp kép DKG',
    DSC: 'Phanh DSC', DWA: 'Chống trộm DWA',
    EHC: 'Treo tự cân bằng EHC', EKP: 'Bơm nhiên liệu EKP', ELV: 'Khóa cổ lái ELV',
    EME: 'Truyền động điện EME', EMF: 'Phanh đỗ điện EMF', EPS: 'Trợ lực lái EPS', EGS: 'Hộp số EGS',
    FAS: 'Hệ thống hỗ trợ lái FAS',
    FEM: 'Thân xe FEM', FLA: 'Chiếu sáng xa FLA', FLE: 'Đèn trước FLE',
    FLM: 'Đèn trước FLM', FRM: 'Khoang chân FRM', FRR: 'Radar trước FRR',
    FZD: 'Trần xe FZD', GS: 'Hộp số EGS', GWS: 'Cần số GWS', HKFM: 'Cửa hậu HKFM',
    HU: 'Màn hình giải trí HU', HUD: 'Hiển thị kính lái HUD', HVS: 'Pin cao áp HVS',
    ICAM2: 'Camera xe ICAM', ICM: 'Khung gầm ICM', IHKA: 'Điều hòa IHKA',
    KAFAS: 'Camera KAFAS', KLE: 'Sạc trên xe KLE', KOMB: 'Đồng hồ KOMB', KOMBI: 'Đồng hồ KOMBI',
    LMV: 'Thân xe LMV', MGU: 'Thông tin giải trí MGU', MEVD: 'Động cơ MEVD',
    MRR: 'Radar tầm trung MRR', MSD: 'Động cơ MSD', MSV: 'Động cơ MSV',
    NBT: 'Thông tin giải trí NBT', NBTEVO: 'Thông tin giải trí NBT EVO', NIVI: 'Quan sát ban đêm NIVI',
    OBC: 'Sạc trên xe OBC', PDC: 'Cảm biến đỗ xe PDC', PMA: 'Hỗ trợ đỗ xe PMA',
    RAD: 'Bộ thu thanh RAD', RAM: 'Âm thanh RAM', RDC: 'Áp suất lốp RDC',
    REM: 'Thân xe phía sau REM', RSE: 'Giải trí hàng ghế sau RSE',
    SAS: 'Cảm biến lái SAS', SME: 'Pin cao áp SME', SPNM: 'Ghế SPNM',
    SRR: 'Radar góc SRR', SVT: 'Cấu hình xe SVT', SZL: 'Công tắc cột lái SZL',
    TCB: 'Viễn thông TCB', TFM: 'Bình nhiên liệu TFM', TMS: 'Đèn TMS',
    TRSVC: 'Camera lùi TRSVC', TSG: 'Cửa kính TSG', TVM: 'Video TVM',
    USS: 'Cảm biến đỗ xe', VDP: 'Giảm chấn VDP', ZBE: 'Giao diện trung tâm ZBE',
    VIP: 'Giao tiếp xe VIP', ZGW: 'Cổng xe ZGW',
};
const ECU_FAMILY_SORTED = Object.keys(ECU_FAMILY_VI).sort((a, b) => b.length - a.length);
const variantUnitName = (v) => {
    if (!v) return null;
    const id = v.toUpperCase();
    const family = ECU_FAMILY_SORTED.find((x) => id.startsWith(x));
    if (family === 'SRR') {
        const position = { '_VR': 'trước phải', '_VL': 'trước trái', '_HR': 'sau phải', '_HL': 'sau trái' };
        const suffix = Object.keys(position).find((x) => id.endsWith(x));
        if (suffix) return 'Radar ' + position[suffix];
    }
    if (family === 'FLM' || family === 'FLE') {
        if (id.endsWith('_L')) return 'Đèn trước trái';
        if (id.endsWith('_R')) return 'Đèn trước phải';
    }
    return family ? ECU_FAMILY_VI[family] : 'Hộp điều khiển BMW ' + id;
};
// Normalize legacy German names, but preserve Unicode from translated/OEM text.
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[\x00-\x1f\x7f]/g, '');
// a summary where the texts for a unit family differ in wording but agree on the fault
const FAMILY = {
    '23:D1C604': 'Assist sensors: Unexpected Ethernet communication/link',
    '61:03178A': 'Telematics: Mobile network connection limited',
    // BMW descriptions for RAM audio speaker faults, used when the ECU type reply is unavailable.
    '37:031D06': 'Front right speaker output lines: Disconnected line',
    '37:031D7E': 'Tweeter, rear left 2, speaker output lines: Cable interruption',
    '37:031D83': 'Tweeter, rear right 2, speaker output lines: Cable interruption',
    '37:031D8D': 'Tweeter, rear left, speaker output lines: Cable interruption',
};
function describe(addr, rawCode) {
    const code = String(rawCode).trim().toUpperCase().replace(/^0X/, '').padStart(6, '0');
    const key = hex(addr) + ':' + code;
    const own = text(key);
    if (own) return ascii(own);
    const v = variant(addr);
    const iv = (v && DB.get('tables/variant/' + v.toLowerCase() + '.json', code)) || DB.get('tables/addr/' + hex(addr) + '.json', code);
    if (iv) return ascii(iv);
    const t = (v && DB.get('texts/' + v + '.json', code)) || text('*:' + code);
    if (t) return ascii(t);
    const c = DB.get('code_texts.json', code);
    const ct = (typeof c === 'string' ? c : c && c[hex(addr)]) || DB.get('tables/codes.json', code) || FAMILY[key];
    if (ct) return ascii(ct);
    const n = DB.get('tables/ambiguous.json', code);
    return n > 0 ? n + ' possible texts (depends on unit type)' : null;
}
// a unit the database identified is named by what it is (same on every model); else the address table
const ecuName = (a, lang) => {
    const lng = lang || getLanguage();
    const v = variant(a);
    const named = v && UNIT_NAMES[v] && ascii(UNIT_NAMES[v]);
    if (lng === 'vi' && v) return named || variantUnitName(v);
    const raw = named || ECU[a] || v || ('ECU 0x' + hex(a));
    if (lng === 'en') return raw;
    const localized = translateUI(raw);
    return localized !== raw ? localized : (lng === 'vi' ? (v ? variantUnitName(v) : 'Hộp điều khiển 0x' + hex(a)) : raw);
};
// Names in the fault list have a narrow column. Use stable, recognizable ECU family labels there.
const ECU_SHORT = {
    ACSM: ['Túi khí ACSM', 'Airbag ACSM'], ADCAM: ['Camera hỗ trợ lái', 'Driver camera'], ICAM: ['Camera ICAM', 'ICAM camera'],
    AHM: ['Kéo moóc AHM', 'Trailer AHM'], AMP: ['Âm thanh AMP', 'Audio AMP'], AMPH: ['Âm thanh AMP', 'Audio AMP'], AMPT: ['Âm thanh AMP', 'Audio AMP'],
    ATM: ['Viễn thông ATM', 'Telematics ATM'], TCB: ['Viễn thông TCB', 'Telematics TCB'], BAT: ['Pin BAT', 'Battery BAT'], BATT: ['Pin BAT', 'Battery BAT'], BCP: ['Pin BCP', 'Battery control'],
    BDC: ['Thân xe BDC', 'Body BDC'], FEM: ['Thân xe FEM', 'Body FEM'], REM: ['Thân xe REM', 'Rear body REM'], BFH: ['Cửa BFH', 'Door BFH'], BFS: ['Cửa BFS', 'Door BFS'],
    CAS: ['Khởi động CAS', 'Start CAS'], CCU: ['Điều khiển CCU', 'Central control CCU'], CDM: ['Điều khiển CDM', 'Central control CDM'],
    CID: ['Màn hình CID', 'Display CID'], CIC: ['Giải trí CIC', 'Infotainment CIC'], CICM: ['Giải trí CICM', 'Infotainment CICM'], NBT: ['Giải trí NBT', 'Infotainment NBT'], NBTEVO: ['Giải trí NBT EVO', 'Infotainment NBT EVO'],
    DCS: ['Camera tài xế', 'Driver camera'], DME: ['Động cơ DME', 'Engine DME'], MEVD: ['Động cơ MEVD', 'Engine MEVD'], DKG: ['Hộp số DKG', 'Gearbox DKG'], DSC: ['Phanh DSC', 'Brakes DSC'], DWA: ['Chống trộm DWA', 'Alarm DWA'],
    EHC: ['Treo EHC', 'Suspension EHC'], EGS: ['Hộp số EGS', 'EGS gearbox'], EKP: ['Bơm xăng EKP', 'Fuel pump EKP'], ELV: ['Khóa lái ELV', 'Steering lock ELV'], EME: ['Mô-tơ EME', 'E-motor EME'], EMF: ['Phanh đỗ EMF', 'Parking brake EMF'], EPS: ['Trợ lực lái EPS', 'Steering EPS'],
    FAS: ['Hỗ trợ lái FAS', 'Driver assistance FAS'], FLA: ['Đèn pha FLA', 'High beam FLA'], FLE: ['Đèn trước', 'Headlight'], FLM: ['Đèn trước', 'Headlight'], FRM: ['Đèn và thân xe FRM', 'Footwell FRM'], FRR: ['Radar trước FRR', 'Front radar FRR'],
    FZD: ['Trần xe FZD', 'Roof FZD'], GS: ['Hộp số EGS', 'EGS gearbox'], GWS: ['Cần số GWS', 'Gear selector GWS'], HKFM: ['Cửa hậu HKFM', 'Tailgate HKFM'], HU: ['Màn hình HU', 'Head unit HU'], HUD: ['Kính lái HUD', 'Head-up display'],
    HVS: ['Pin cao áp HVS', 'High-voltage battery'], ICM: ['Khung gầm ICM', 'Chassis ICM'], IHKA: ['Điều hòa IHKA', 'Climate IHKA'], KAFAS: ['Camera KAFAS', 'KAFAS camera'], KLE: ['Sạc KLE', 'Charger KLE'], KOMB: ['Đồng hồ KOMBI', 'Cluster KOMBI'], KOMBI: ['Đồng hồ KOMBI', 'Cluster KOMBI'],
    MGU: ['Màn hình MGU', 'Head unit MGU'], MRR: ['Radar MRR', 'Radar MRR'], MSD: ['Động cơ MSD', 'Engine MSD'], MSV: ['Động cơ MSV', 'Engine MSV'], NIVI: ['Camera đêm NIVI', 'Night vision NIVI'], OBC: ['Sạc OBC', 'Charger OBC'],
    PDC: ['Cảm biến đỗ PDC', 'Parking sensors PDC'], PMA: ['Hỗ trợ đỗ PMA', 'Parking assist PMA'], RAD: ['Radio RAD', 'Radio RAD'], RAM: ['Âm thanh RAM', 'Audio RAM'], RDC: ['Áp suất lốp RDC', 'Tyre pressure RDC'], RSE: ['Giải trí sau RSE', 'Rear entertainment RSE'],
    SAS: ['Cảm biến lái SAS', 'Steering sensor SAS'], SME: ['Pin cao áp SME', 'High-voltage battery SME'], SPNM: ['Ghế SPNM', 'Seat SPNM'], SRR: ['Radar góc', 'Corner radar'], SVT: ['Cấu hình xe SVT', 'Vehicle order SVT'], SZL: ['Công tắc lái SZL', 'Steering switch SZL'],
    TFM: ['Bình xăng TFM', 'Fuel tank TFM'], TMS: ['Đèn TMS', 'Light TMS'], TRSVC: ['Camera lùi', 'Reversing camera'], TSG: ['Cửa kính TSG', 'Window TSG'], TVM: ['Video TVM', 'Video TVM'], USS: ['Cảm biến đỗ xe', 'Parking sensors'], VDP: ['Giảm chấn VDP', 'Dampers VDP'], ZBE: ['Giao diện ZBE', 'Interface ZBE'], VIP: ['Giao tiếp VIP', 'Vehicle interface VIP'], ZGW: ['Cổng trung tâm ZGW', 'Central gateway ZGW'],
};
const ECU_ADDR_SHORT = {
    0x01: ['Túi khí ACSM', 'Airbag ACSM'], 0x06: ['Camera ICAM', 'ICAM camera'], 0x07: ['Pin cao áp SME', 'HV battery SME'],
    0x08: ['Radar góc SRR', 'Corner radar SRR'], 0x0D: ['Cửa hậu HKFM', 'Tailgate HKFM'], 0x10: ['Thân xe BDC', 'Body gateway BDC'],
    0x12: ['Động cơ DME', 'Engine DME'], 0x13: ['Động cơ DME 2', 'Engine DME 2'], 0x14: ['Sạc OBC', 'Charger OBC'],
    0x18: ['Hộp số EGS', 'Gearbox EGS'], 0x1D: ['Bình xăng TFM', 'Fuel tank TFM'], 0x20: ['Radar góc SRR', 'Corner radar SRR'],
    0x21: ['Radar trước FRR', 'Front radar FRR'], 0x23: ['Cảm biến lái SAS', 'Steering sensors SAS'],
    0x28: ['Radar góc SRR', 'Corner radar SRR'], 0x29: ['Phanh DSC', 'Brakes DSC'], 0x2A: ['Radar góc SRR', 'Corner radar SRR'],
    0x2C: ['Cảm biến đỗ xe', 'Parking sensors'], 0x30: ['Trợ lực lái EPS', 'Steering EPS'], 0x37: ['Âm thanh RAM', 'Audio RAM'],
    0x38: ['xDrive VTG', 'xDrive VTG'], 0x39: ['Trợ lực phanh DSC', 'Brake booster DSC'], 0x3A: ['Mô-tơ EME', 'E-motor EME'],
    0x40: ['Thân xe BDC', 'Body BDC'], 0x43: ['Đèn trước FLM', 'Headlight FLM'], 0x44: ['Đèn trước FLM', 'Headlight FLM'],
    0x45: ['Camera tài xế', 'Driver camera'], 0x56: ['Trần xe FZD', 'Roof FZD'], 0x5D: ['Camera KAFAS', 'KAFAS camera'],
    0x5E: ['Cần số GWS', 'Gear selector GWS'], 0x60: ['Đồng hồ KOMBI', 'Cluster KOMBI'], 0x61: ['Viễn thông ATM', 'Telematics ATM'],
    0x63: ['Màn hình HU', 'Head unit HU'], 0x64: ['Cảm biến đỗ PDC', 'Parking sensors PDC'], 0x67: ['Giao diện ZBE', 'Interface ZBE'],
    0x6D: ['Ghế SM', 'Seat module SM'], 0x76: ['Giảm chấn VDP', 'Dampers VDP'], 0x78: ['Điều hòa IHKA', 'Climate IHKA'],
};
const ECU_SHORT_FAMILIES = Object.keys(ECU_SHORT).sort((x, y) => y.length - x.length);
function ecuListName(a) {
    const v = variant(a), id = v && v.toUpperCase();
    if (id) {
        const family = ECU_SHORT_FAMILIES.find((x) => id.startsWith(x));
        if (family) {
            if (family === 'SRR') {
                const pos = { '_VR': 'trước phải', '_VL': 'trước trái', '_HR': 'sau phải', '_HL': 'sau trái' };
                const suffix = Object.keys(pos).find((x) => id.endsWith(x));
                if (suffix) return getLanguage() === 'vi' ? 'Radar ' + pos[suffix] : 'Radar ' + suffix.slice(1);
            }
            if ((family === 'FLM' || family === 'FLE') && (id.endsWith('_L') || id.endsWith('_R')))
                return getLanguage() === 'vi' ? 'Đèn trước ' + (id.endsWith('_L') ? 'trái' : 'phải') : 'Headlight ' + (id.endsWith('_L') ? 'left' : 'right');
            return ECU_SHORT[family][getLanguage() === 'vi' ? 0 : 1];
        }
        return (getLanguage() === 'vi' ? 'Hộp BMW ' : 'BMW ECU ') + id.slice(0, 14);
    }
    const addressName = ECU_ADDR_SHORT[a];
    if (addressName) return addressName[getLanguage() === 'vi' ? 0 : 1];
    const known = ECU[a];
    if (known) {
        const localized = translateUI(known);
        if (localized !== known) return localized;
        return known;
    }
    return (getLanguage() === 'vi' ? 'Hộp ' : 'ECU ') + '0x' + hex(a);
}

const CONDITIONS = {
    PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12,
};
const WEEKDAYS_VI = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CG_MEM = '/sys/fs/cgroup/memory/oap.slice/nodejs.slice/';
const GPU_FREQ_FILE = '/sys/class/drm/card0/gt_act_freq_mhz';
const SOC_TEMP_FILE = '/sys/class/thermal/thermal_zone0/temp';
const GPS_SYNC_FILE = '/run/gps-timesync/status.json';

function nrcLabel(code) {
    if (!code) return '';
    return NRC[code] ? translateUI(NRC[code]) : uiPair('NRC 0x', 'Mã NRC 0x') + hex(code);
}

function whyText(why) {
    if (!why) return uiPair('unknown', 'không rõ');
    if (why.kind === 'no_answer') return uiPair('no answer', 'không phản hồi');
    if (why.kind === 'engine_on') return uiPair('refused now (engine on? ignition only)', 'từ chối (hãy tắt máy, chỉ bật điện)');
    if (why.kind === 'nrc') return nrcLabel(why.code);
    if (why.kind === 'reply') return uiPair('reply ', 'phản hồi ') + why.hex;
    return String(why.text || why);
}

function ecuShortByLang(a, lang) {
    const isVi = lang === 'vi';
    const v = variant(a), id = v && v.toUpperCase();
    if (id) {
        const family = ECU_SHORT_FAMILIES.find((x) => id.startsWith(x));
        if (family) {
            if (family === 'SRR') {
                const pos = { '_VR': 'trước phải', '_VL': 'trước trái', '_HR': 'sau phải', '_HL': 'sau trái' };
                const suffix = Object.keys(pos).find((x) => id.endsWith(x));
                if (suffix) return isVi ? 'Radar ' + pos[suffix] : 'Radar ' + suffix.slice(1);
            }
            if ((family === 'FLM' || family === 'FLE') && (id.endsWith('_L') || id.endsWith('_R')))
                return isVi ? 'Đèn trước ' + (id.endsWith('_L') ? 'trái' : 'phải') : 'Headlight ' + (id.endsWith('_L') ? 'left' : 'right');
            return ECU_SHORT[family][isVi ? 0 : 1];
        }
        return (isVi ? 'Hộp BMW ' : 'BMW ECU ') + id.slice(0, 14);
    }
    const addressName = ECU_ADDR_SHORT[a];
    if (addressName) return addressName[isVi ? 0 : 1];
    const known = ECU[a];
    if (known) return isVi ? translateUI(known) : known;
    return (isVi ? 'Hộp ' : 'ECU ') + '0x' + hex(a);
}

function fmtBytes(bytes) {
    if (!(bytes >= 0) || !isFinite(bytes)) return '--';
    const gb = bytes / 1073741824;
    if (gb >= 100) return Math.round(gb) + ' GB';
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return Math.round(bytes / 1048576) + ' MB';
}

function classifyIface(name) {
    const s = String(name || '').toLowerCase();
    if (/tun|tap|wg|tailscale|utun/.test(s)) return 'VPN';
    if (/usb|ncm|rndis/.test(s)) return 'USB';
    if (/wl|wifi|wlan/.test(s)) return 'WLAN';
    if (/\.\d+$|vlan/.test(s)) return 'VLAN';
    if (/^eth|^en/.test(s)) return 'ENET';
    return 'LAN';
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diag = await new Diag(ctx.signals, log).init();

        /* ---------- state ---------- */
        const FILE = path.join(ctx.dataDir, 'last_scan.json');
        const loadSavedScan = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return null; } };
        let scan = loadSavedScan();   // { at, demo, ecus: [{ addr, dtcs: [{code,status,mem}], nrc }] }
        const IDS = path.join(ctx.dataDir, 'ecu_ids.json');
        ids = readJson(IDS);
        let phase = 'idle', msg = null, msgTimer = null, replies = 0, busy = false, version = 0, demoCleared = false;
        const changed = () => { version++; loop && loop.kick(); };
        const setMsg = (en, vi, opts) => {
            if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
            if (!en) { msg = null; return; }
            const o = typeof opts === 'boolean' ? { crit: opts } : (opts || {});
            msg = {
                en,
                vi: vi || en,
                crit: !!o.crit,
                scope: o.scope || 'faults', // 'faults': Faults tab only; 'page': only on msg.page
                page: o.page,
                transient: !!o.transient,
            };
            if (o.ttlMs) {
                msgTimer = setTimeout(() => { msgTimer = null; msg = null; changed(); }, o.ttlMs);
            }
        };
        const curMsgFor = (isFaultsPage, curPage) => {
            if (!msg) return '';
            const txt = typeof msg === 'string' ? translateUI(msg) : uiPair(msg.en, msg.vi);
            if (phase === 'scanning' || phase === 'clearing') return txt;
            if (msg.scope === 'page') return msg.page === curPage ? txt : '';
            return isFaultsPage ? txt : '';
        };
        const isMsgCrit = () => phase === 'error' || !!(msg && msg.crit);
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.available);

        /* ---------- live vehicle clock & passive car vitals ---------- */
        const clock = {
            wallMs: 0,           // vehicle local wall-clock epoch ms (UTC-encoded broken-down fields)
            monoAt: 0,           // Date.now() when wallMs was anchored
            exact: false,        // locked on a 5-second transition edge
            lastKey: '',
            tzMin: null,         // minutes from UTC ((statusTimeZonesOffset - 32) * 15)
            autoAdjust: null,
            gpsSync: null,
        };
        const carInfo = {
            bat12: null,
            coolant: null,
            oil: null,
            odoKm: null,
            rangeKm: null,
            condition: null,
        };

        ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
            statusTimeDate: (v) => {
                if (!v) return;
                const raw = Number(v.statusTimeZonesOffset);
                if (Number.isFinite(raw) && raw >= 0 && raw <= 104) {
                    const next = (raw - 32) * 15;
                    if (next !== clock.tzMin) { clock.tzMin = next; changed(); }
                }
                const ca = v.statusCheckboxTimeAdjustAutomatically;
                if (ca !== undefined) {
                    const auto = ca === 1 || ca === 'CHECKBOX_ZEITEINSTELLUNG_AUTOMATISCH_AKTIV';
                    if (auto !== clock.autoAdjust) { clock.autoAdjust = auto; changed(); }
                }
            },
            statusShowTimeDate: (v) => {
                if (!v) return;
                const yr = Number(v.displayDateYear), mo = Number(v.displayDateMonth), dy = Number(v.displayDateDay);
                const hr = Number(v.displayHour), mi = Number(v.displayMinute), sc = Number(v.displaySecond);
                if (!(yr >= 2020 && yr <= 2099 && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31 && hr >= 0 && hr <= 23 && mi >= 0 && mi <= 59 && sc >= 0 && sc <= 59)) return;
                const now = Date.now();
                const wallMs = Date.UTC(yr, mo - 1, dy, hr, mi, sc);
                const key = yr + '-' + mo + '-' + dy + ' ' + hr + ':' + mi + ':' + sc;
                const isEdge = clock.lastKey !== '' && key !== clock.lastKey;
                clock.lastKey = key;
                if (!clock.monoAt) {
                    clock.wallMs = wallMs;
                    clock.monoAt = now;
                    clock.exact = false;
                    changed();
                } else if (isEdge) {
                    const pred = clock.wallMs + (now - clock.monoAt);
                    const err = wallMs - pred;
                    if (!clock.exact || Math.abs(err) > 1200) {
                        clock.wallMs = wallMs;
                        clock.monoAt = now;
                    } else {
                        clock.wallMs += err * 0.25;
                    }
                    clock.exact = true;
                    changed();
                } else {
                    const pred = clock.wallMs + (now - clock.monoAt);
                    if (Math.abs(pred - (wallMs + 2500)) > 6500) {
                        clock.wallMs = wallMs;
                        clock.monoAt = now;
                        clock.exact = false;
                        changed();
                    }
                }
            },
            statusRangeTankStatus: (v) => {
                if (!v) return;
                const odo = Number(v.mileageKilometre), rng = Number(v.range);
                let upd = false;
                if (Number.isFinite(odo) && odo > 0 && odo < 16777215 && odo !== carInfo.odoKm) { carInfo.odoKm = odo; upd = true; }
                if (Number.isFinite(rng) && rng >= 0 && rng < 4095 && rng !== carInfo.rangeKm) { carInfo.rangeKm = rng; upd = true; }
                if (upd) changed();
            },
        }, log, { pollMs: 5000 }).catch((e) => log.warn('KombiIF: ' + e));

        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusBattery2: (v) => {
                const c = v && Number(v.conditionBatteryChargingCondition);
                if (Number.isFinite(c) && c >= 0 && c <= 100 && c !== carInfo.bat12) { carInfo.bat12 = c; changed(); }
            },
            statusEngineTemperature: (v) => {
                if (!v) return;
                const tc = Number(v.temperatureEngineDrive), to = Number(v.temperatureEngineOilDrive);
                let upd = false;
                if (Number.isFinite(tc) && tc !== 255 && tc - 48 !== carInfo.coolant) { carInfo.coolant = tc - 48; upd = true; }
                if (Number.isFinite(to) && to !== 255 && to - 48 !== carInfo.oil) { carInfo.oil = to - 48; upd = true; }
                if (upd) changed();
            },
        }, log).catch((e) => log.warn('CDS: ' + e));

        ctx.signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: (v) => {
                const raw = v && v.statusConditionVehicle;
                const n = typeof raw === 'number' ? raw : CONDITIONS[raw];
                if (n >= 1 && n <= 12 && n !== carInfo.condition) { carInfo.condition = n; changed(); }
            },
        }, log).catch((e) => log.warn('VehicleCondition: ' + e));

        /** Effective timezone offset in minutes (prefers vehicle KombiIF, then gps-timesync, then OS). */
        function effectiveTzMin(nowMs) {
            if (clock.tzMin !== null) return clock.tzMin;
            if (clock.gpsSync && Number.isFinite(clock.gpsSync.tzOffsetMin)) return clock.gpsSync.tzOffsetMin;
            if (clock.monoAt > 0) {
                const est = Math.round(((clock.wallMs + (nowMs - clock.monoAt)) - nowMs) / 900000) * 15;
                if (est >= -720 && est <= 840) return est;
            }
            return -new Date(nowMs).getTimezoneOffset();
        }

        function formatZone(tzMin) {
            const sign = tzMin < 0 ? '-' : '+', abs = Math.abs(tzMin);
            return 'UTC' + sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
        }

        /** Convert any epoch ms into vehicle-aligned broken-down wall time ms. */
        function wallAt(epochMs) {
            if (clock.monoAt > 0) return clock.wallMs + (epochMs - clock.monoAt);
            return epochMs + effectiveTzMin(epochMs) * 60000;
        }

        function nowClock(nowMs, smoothSec) {
            const tzMin = effectiveTzMin(nowMs);
            const synced = clock.monoAt > 0;
            const gpsActive = !synced && !!(clock.gpsSync && Number.isFinite(clock.gpsSync.tzOffsetMin));
            const wallNow = wallAt(nowMs);
            const d = new Date(wallNow);
            const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1, day = d.getUTCDate(), dow = d.getUTCDay();
            const hour = d.getUTCHours(), min = d.getUTCMinutes(), sec = d.getUTCSeconds(), ms = d.getUTCMilliseconds();
            const secFrac = smoothSec ? sec + ms / 1000 : sec;
            const zone = formatZone(tzMin);
            const wk = getLanguage() === 'en' ? WEEKDAYS_EN[dow] : WEEKDAYS_VI[dow];
            const dateStr = getLanguage() === 'en' ? year + '.' + pad2(month) + '.' + pad2(day) : pad2(day) + '.' + pad2(month) + '.' + year;
            let driftSec = null;
            if (synced) {
                const carUtcMs = wallNow - tzMin * 60000;
                driftSec = Math.round((carUtcMs - nowMs) / 1000);
            }
            return {
                synced, gpsActive, exact: clock.exact, autoAdjust: clock.autoAdjust,
                tzMin, zone, driftSec,
                time: pad2(hour) + ':' + pad2(min) + ':' + pad2(sec),
                dateLine: wk + ' · ' + dateStr,
                isoLocal: year + '-' + pad2(month) + '-' + pad2(day) + 'T' + pad2(hour) + ':' + pad2(min) + ':' + pad2(sec) +
                    (tzMin < 0 ? '-' : '+') + pad2(Math.floor(Math.abs(tzMin) / 60)) + ':' + pad2(Math.abs(tzMin) % 60),
                hour, min, sec, secFrac,
            };
        }

        const when = (ms) => {
            const d = new Date(wallAt(ms));
            return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '. ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
        };

        /* ---------- hardware, storage & installed apps sampler ---------- */
        const appsMon = new MguAppsMonitor({
            selfId: ctx.spec.id || 'mgu_diagnostics',
            selfTitle: ctx.spec.title || 'MGU Diagnostics',
            selfVersion: ctx.spec.version || '0.2.0',
            dataDir: ctx.dataDir,
        });
        const sys = {
            sampledAt: 0, gpsCheckedAt: 0, diskCheckedAt: 0, diskBusy: false, prevCpu: null,
            cpuPct: null, cpuHist: [], cpuCores: 0, load1: null,
            memUsedMB: 0, memTotalMB: 0, ramPct: 0,
            diskTotalBytes: null, diskFreeBytes: null, diskUsedPct: 0,
            oapUsedMB: null, oapCapMB: null, oapFailCnt: null, rssMB: 0, swapMB: null,
            gpuMHz: null, socTempC: null, upSec: 0,
            osLabel: '', activeIf: [], reports: 0, reportBytes: 0,
        };
        const safeOs = (fn, fallback) => { try { return fn ? fn() : fallback; } catch (e) { return fallback; } };
        const readNumFile = (f) => { try { const n = Number(fs.readFileSync(f, 'utf8').trim()); return Number.isFinite(n) ? n : null; } catch (e) { return null; } };
        const DF_BIN = fs.existsSync('/bin/df') ? '/bin/df' : fs.existsSync('/usr/bin/df') ? '/usr/bin/df' : 'df';

        function applyDiskStats(info) {
            if (!info || !(info.totalBytes > 0)) return;
            const pct = G.clamp(Math.round((info.totalBytes - info.freeBytes) * 100 / info.totalBytes), 0, 100);
            const diff = sys.diskTotalBytes !== info.totalBytes || sys.diskFreeBytes !== info.freeBytes;
            sys.diskTotalBytes = info.totalBytes;
            sys.diskFreeBytes = info.freeBytes;
            sys.diskUsedPct = pct;
            if (diff) changed();
        }

        function refreshStorage(nowMs) {
            if (sys.diskBusy || (sys.diskCheckedAt && nowMs - sys.diskCheckedAt < 15000)) return;
            sys.diskCheckedAt = nowMs;
            sys.diskBusy = true;
            const pf = safeOs(os.platform, '');
            // Query explicit internal MGU paths only (never bare `df -kP`, which walks USB sticks and /dev/mapper aliases)
            const targets = storageTargets(ctx.dataDir, pf);
            try {
                cp.execFile(DF_BIN, ['-kP'].concat(targets), { timeout: 2500 }, (err, stdout) => {
                    const parsed = parseDfOutput(stdout, pf);
                    if (parsed) {
                        sys.diskBusy = false;
                        applyDiskStats(parsed);
                        return;
                    }
                    try {
                        cp.execFile(DF_BIN, ['-kP', ctx.dataDir], { timeout: 2000 }, (e2, out2) => {
                            sys.diskBusy = false;
                            const p2 = parseDfOutput(out2, pf);
                            if (p2) applyDiskStats(p2);
                        });
                    } catch (e3) { sys.diskBusy = false; }
                });
            } catch (e) {
                sys.diskBusy = false;
            }
        }

        function readCpuTicks() {
            try {
                const c = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
                if (c.length >= 4 && c.every(Number.isFinite)) {
                    return { idle: c[3] + (c[4] || 0), total: c.reduce((a, b) => a + b, 0) };
                }
            } catch (e) { /* non-Linux */ }
            try {
                const cpus = os.cpus() || [];
                let idle = 0, total = 0;
                for (let i = 0; i < cpus.length; i++) {
                    const t = cpus[i] && cpus[i].times;
                    if (!t) continue;
                    idle += t.idle || 0;
                    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
                }
                if (total > 0) return { idle, total };
            } catch (e) { /* unavailable */ }
            return null;
        }

        function sampleSystem(nowMs) {
            if (nowMs - sys.sampledAt < 950) return;
            sys.sampledAt = nowMs;

            // CPU delta & history
            const ticks = readCpuTicks();
            if (ticks) {
                if (sys.prevCpu && ticks.total > sys.prevCpu.total) {
                    const pct = G.clamp(100 * (1 - (ticks.idle - sys.prevCpu.idle) / (ticks.total - sys.prevCpu.total)), 0, 100);
                    sys.cpuPct = pct;
                    sys.cpuHist.push(pct);
                    if (sys.cpuHist.length > 32) sys.cpuHist.shift();
                }
                sys.prevCpu = ticks;
            }
            if (!sys.cpuCores) sys.cpuCores = safeOs(() => (os.cpus() || []).length, 0);
            const la = safeOs(os.loadavg, null);
            sys.load1 = Array.isArray(la) && Number.isFinite(la[0]) && la[0] > 0 ? la[0] : null;

            // Memory: prefer Linux /proc/meminfo MemAvailable over MemFree so page cache isn't counted as used
            let memTotal = 0, memUsed = 0, swapUsed = null;
            try {
                const m = fs.readFileSync('/proc/meminfo', 'utf8');
                const kb = (k) => { const x = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(m); return x ? Number(x[1]) : null; };
                const tot = kb('MemTotal'), avail = kb('MemAvailable');
                if (tot && avail !== null) { memTotal = tot / 1024; memUsed = Math.max(0, tot - avail) / 1024; }
                const st = kb('SwapTotal'), sf = kb('SwapFree');
                if (st !== null && sf !== null && st > 0) swapUsed = Math.max(0, st - sf) / 1024;
            } catch (e) { /* non-Linux */ }
            if (!memTotal) {
                const tot = safeOs(os.totalmem, 0), fr = safeOs(os.freemem, 0);
                if (tot > 0) { memTotal = tot / 1048576; memUsed = Math.max(0, tot - fr) / 1048576; }
            }
            sys.memTotalMB = memTotal;
            sys.memUsedMB = memUsed;
            sys.ramPct = memTotal > 0 ? Math.round(memUsed * 100 / memTotal) : 0;
            sys.swapMB = swapUsed;

            // OAP cgroup memory & process RSS
            const cgU = readNumFile(CG_MEM + 'memory.usage_in_bytes');
            const cgL = readNumFile(CG_MEM + 'memory.limit_in_bytes');
            const cgF = readNumFile(CG_MEM + 'memory.failcnt');
            sys.oapUsedMB = cgU !== null && cgU >= 0 ? cgU / 1048576 : null;
            sys.oapCapMB = cgL !== null && cgL > 0 && cgL / 1048576 < 65536 ? cgL / 1048576 : null;
            sys.oapFailCnt = cgF !== null && cgF >= 0 ? cgF : null;
            sys.rssMB = safeOs(() => Math.round(process.memoryUsage().rss / 1048576), 0);

            // GPU frequency & SoC temperature on MGU
            const gf = readNumFile(GPU_FREQ_FILE);
            sys.gpuMHz = gf !== null && gf > 0 && gf < 5000 ? Math.round(gf) : null;
            const rawTemp = readNumFile(SOC_TEMP_FILE);
            if (rawTemp !== null) {
                const c = rawTemp > 1000 ? rawTemp / 1000 : rawTemp;
                sys.socTempC = c >= 5 && c <= 125 ? Math.round(c) : null;
            }

            sys.upSec = Math.max(0, Math.floor(safeOs(os.uptime, 0)));
            if (!sys.osLabel) {
                const pf = safeOs(os.platform, ''), rl = safeOs(os.release, ''), ar = safeOs(os.arch, '');
                const name = pf === 'linux' ? 'MGU Linux' : pf === 'darwin' ? 'macOS' : pf;
                sys.osLabel = [name, rl ? rl.split('-')[0] : '', ar].filter(Boolean).join(' · ');
            }

            // Network interfaces
            const interfaces = safeOs(os.networkInterfaces, {}) || {};
            sys.activeIf = Object.keys(interfaces).map((name) => ({
                name,
                kind: classifyIface(name),
                addresses: (interfaces[name] || []).filter((x) => !x.internal && (x.family === 'IPv4' || x.family === 4)).map((x) => x.address),
            })).filter((x) => x.addresses.length);

            // Saved reports inventory
            let reports = 0, reportBytes = 0;
            try {
                const dir = path.join(ctx.dataDir, 'reports');
                if (fs.existsSync(dir)) fs.readdirSync(dir).forEach((f) => {
                    try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) { reports++; reportBytes += st.size; } } catch (e) {}
                });
            } catch (e) { /* ignore */ }
            sys.reports = reports;
            sys.reportBytes = reportBytes;

            // Storage capacity & free space (refreshed asynchronously every 15 s)
            refreshStorage(nowMs);

            // Optional gps-timesync daemon status (every 5 s)
            if (nowMs - sys.gpsCheckedAt >= 5000) {
                sys.gpsCheckedAt = nowMs;
                try {
                    const gs = JSON.parse(fs.readFileSync(GPS_SYNC_FILE, 'utf8'));
                    const t = gs && gs.updatedUtc ? Date.parse(gs.updatedUtc) : 0;
                    clock.gpsSync = gs && (!t || Math.abs(nowMs - t) < 10 * 60000) ? gs : null;
                } catch (e) { clock.gpsSync = null; }
            }
        }
        // Prime CPU ticks once at startup so the first visit to MGU status already has a CPU % reading
        sampleSystem(Date.now());

        /* ---------- Check Control ---------- */
        const cc = new Map();          // ccmId -> { ecu, reason }
        const ccNames = new Map();     // id -> { name, color }
        const walk = (o, fn) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach((x) => walk(x, fn)); return; }
            fn(o);
            Object.keys(o).forEach((k) => { if (o[k] && typeof o[k] === 'object') walk(o[k], fn); });
        };
        const names = (v) => walk(v, (o) => {
            const id = o.cCIdentifer !== undefined ? o.cCIdentifer : o.cCIdentifier;
            const nm = o.cCShortName || o.cCName;
            if (id !== undefined && nm) { ccNames.set(id, { name: String(nm), color: o.cCColor }); changed(); }
        });
        ctx.signals.watch('de.bmw.infotainment.checkcontrol.CheckControlMaster', '1', {
            basicList: (v) => walk(v, (o) => {
                if (o.ccmId === undefined) return;
                const on = o.activeState === 'AKTIV' || o.activeState === 0;
                if (on) cc.set(o.ccmId, { ecu: o.requestorDiagAddr, reason: String(o.reason) }); else cc.delete(o.ccmId);
                changed();
            }),
        }, log);
        ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', { ccList: names, newCCMessage: names }, log);

        /* ---------- scan / clear ---------- */
        let clearArmed = null;
        const refreshBarLabels = () => {
            ui.text('BTN_SCAN', phase === 'scanning' ? 'Scanning...' : scan ? 'Scan again' : 'Scan now');
            ui.text('BTN_CLEAR', clearArmed ? 'Yes, clear' : 'Clear all');
        };
        const disarmClear = () => {
            if (clearArmed) { clearTimeout(clearArmed); clearArmed = null; ui.text('BTN_CLEAR', 'Clear all'); }
        };

        async function doScan() {
            if (busy) return;
            disarmClear();
            busy = true; phase = 'scanning'; replies = 0; setMsg(null); changed();
            ui.text('BTN_SCAN', 'Scanning...');
            try {
                if (useDemo()) {
                    const demoEcus = JSON.parse(JSON.stringify(DEMO.ecus));
                    if (demoCleared) {
                        demoEcus.forEach((e) => { e.dtcs = e.dtcs.filter((d) => d.mem !== 'fault' || (d.status & 1)); });
                    }
                    for (let i = 1; i <= demoEcus.length; i++) { await new Promise((r) => setTimeout(r, 140)); replies = i; changed(); }
                    scan = { at: Date.now(), demo: true, ecus: demoEcus };
                } else {
                    const mask = settings.get('scope') === 'all' ? 0xFF : 0x0C;
                    const byEcu = new Map();
                    const read = async (params, mem) => {
                        const res = await diag.functional(0x19, params, { onReply: (e, n) => { replies = Math.max(replies, n); changed(); } });
                        res.forEach((uds, addr) => {
                            const p = parseDtcReply(uds, params);
                            const e = byEcu.get(addr) || { addr, dtcs: [], nrc: null };
                            p.dtcs.forEach((d) => e.dtcs.push({ code: d.code, status: d.status, mem }));
                            if (!p.ok && mem === 'fault') e.nrc = p.nrc;
                            byEcu.set(addr, e);
                        });
                    };
                    await read([0x02, mask], 'fault');
                    let infoFailed = false;
                    if (settings.get('info')) {
                        setMsg('Reading info memory...', 'Đang đọc bộ nhớ thông tin...'); changed();
                        try { await read([0x17, mask, 0x01], 'info'); } catch (e) { infoFailed = true; log.warn('info memory: ' + e); }
                    }
                    scan = { at: Date.now(), demo: false, ecus: Array.from(byEcu.values()), infoFailed };
                    try { fs.writeFileSync(FILE, JSON.stringify(scan)); } catch (e) { log.warn('save scan: ' + e); }
                    await identify(scan.ecus.map((e) => e.addr));
                }
                scan.ecus.sort((a, b) => b.dtcs.length - a.dtcs.length || a.addr - b.addr);
                const n = scan.ecus.reduce((s, e) => s + e.dtcs.length, 0);
                log.info('scan: ' + scan.ecus.length + ' control units, ' + n + ' faults');
                if (!scan.ecus.length) {
                    setMsg('No control unit answered - ignition on?', 'Không có hộp điều khiển phản hồi — hãy bật điện xe');
                } else if (scan.infoFailed) {
                    setMsg('Info memory not read this time (unit busy) - scan again for it', 'Chưa đọc được bộ nhớ thông tin (hộp đang bận) — hãy quét lại');
                } else {
                    setMsg(null);
                }
                phase = 'done';
            } catch (e) {
                log.warn('scan failed: ' + e);
                const detail = e && e.message ? e.message : String(e);
                phase = 'error';
                setMsg('Scan failed: ' + detail, 'Quét lỗi thất bại: ' + detail, true);
            }
            busy = false;
            if (!onLivePage()) page = 0;
            ui.text('BTN_SCAN', scan ? 'Scan again' : 'Scan now');
            changed();
        }

        // If TASU comes online shortly after boot while demo='auto' showed demo data, switch to real vehicle scan
        diag.on('available', (avail) => {
            changed();
            if (avail && settings.get('demo') === 'auto' && scan && scan.demo && !busy) {
                log.info('TASU became available; switching from demo fallback to live vehicle');
                scan = loadSavedScan();
                if (settings.get('autoScan')) doScan();
                else { refreshBarLabels(); changed(); }
            }
        });

        /**
         * Ask every unit that answered the scan for its SGBD index once (22 F1 50), so the database can
         * give its faults a text and the unit its name; kept in data/ecu_ids.json.
         */
        async function identify(addrs) {
            const todo = HAS_DB ? addrs.filter((a) => ids[hex(a)] === undefined) : [];
            if (!todo.length) return;
            let i = 0;
            for (const a of todo) {
                const idx = ++i;
                setMsg('Identifying control units... ' + idx + '/' + todo.length, 'Đang nhận diện hộp điều khiển... ' + idx + '/' + todo.length);
                changed();
                try {
                    const r = await diag.physical(a, 0x22, [0xF1, 0x50], 3000,
                        (u) => (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50) || (u[0] === 0x7F && u[1] === 0x22));
                    if (!r) { log.info('unit ' + hex(a) + ': no answer to 22 F1 50 (asked again next scan)'); continue; }
                    ids[hex(a)] = r[0] === 0x62 && r.length >= 6 ? hex(((r[3] << 16) | (r[4] << 8) | r[5]) >>> 0, 6) : '';
                    log.info('unit ' + hex(a) + ': SGBD index ' + (ids[hex(a)] || 'none') + (variant(a) ? ' -> ' + variant(a) : ''));
                } catch (e) { log.warn('identify ' + hex(a) + ': ' + e); }
            }
            try { fs.writeFileSync(IDS, JSON.stringify(ids)); } catch (e) { log.warn('save ids: ' + e); }
            setMsg(null);
        }

        const RETRY_NRC = [0x22, 0x31, 0x33, 0x7E, 0x7F];
        async function clearUnit(addr) {
            const ask = () => diag.physical(addr, 0x14, [0xFF, 0xFF, 0xFF], 8000, (u) => u[0] === 0x54 || (u[0] === 0x7F && u[1] === 0x14));
            const session = (n) => diag.physical(addr, 0x10, [n], 3000, (u) => (u[0] === 0x50 && u[1] === n) || (u[0] === 0x7F && u[1] === 0x10));
            let r = await ask();
            if (!r) r = await ask();
            if (r && r[0] === 0x7F && RETRY_NRC.indexOf(r[2]) >= 0) {
                const first = r;
                const ext = await session(0x03);
                if (ext && ext[0] === 0x50) {
                    r = (await ask()) || first;
                    await session(0x01);
                }
                log.info('clear ' + hex(addr) + ': refused (' + (NRC[first[2]] || hex(first[2])) + ') - extended session: ' + (ext ? (ext[0] === 0x50 ? 'yes' : 'refused') : 'no answer') + ', then ' + (r[0] === 0x54 ? 'cleared' : 'still refused'));
            }
            if (r && r[0] === 0x54) return { ok: true };
            const why = !r ? { kind: 'no_answer' }
                : r[0] === 0x7F ? (r[2] === 0x22 ? { kind: 'engine_on' } : { kind: 'nrc', code: r[2] })
                    : { kind: 'reply', hex: r.map((x) => hex(x)).join('') };
            log.warn('clear ' + hex(addr) + ': ' + JSON.stringify(why));
            return { ok: false, why };
        }

        const clearLabel = () => { changed(); return ui.text('BTN_CLEAR', clearArmed ? 'Yes, clear' : 'Clear all'); };
        async function doClear() {
            if (busy) return;
            const targets = scan ? scan.ecus.filter((e) => e.dtcs.some((d) => d.mem === 'fault')) : [];
            if (!targets.length) {
                if (scan) setMsg('Nothing to clear', 'Không có lỗi để xóa');
                else setMsg('Scan first, then clear', 'Hãy quét xe trước, rồi mới xóa lỗi');
                changed();
                return;
            }
            if (!clearArmed) {
                try {
                    const f = writeReport(uiPair('Before confirming fault-memory clear', 'Trước khi xác nhận xóa bộ nhớ lỗi'));
                    log.info('pre-clear report saved: ' + f);
                } catch (e) {
                    const detail = e && e.message ? e.message : String(e);
                    setMsg('Could not save report; faults were not cleared: ' + detail, 'Không lưu được báo cáo; chưa xóa lỗi: ' + detail, true);
                    changed();
                    return;
                }
                clearArmed = setTimeout(() => { clearArmed = null; setMsg(null); clearLabel(); }, 5000);
                const cnt = targets.length;
                setMsg('Clears ' + cnt + ' ' + (cnt === 1 ? 'control unit' : 'control units') + ' - press again within 5 s',
                    'Sắp xóa lỗi trên ' + cnt + ' hộp — bấm lần nữa trong 5 giây');
                changed();
                return clearLabel();
            }
            clearTimeout(clearArmed); clearArmed = null; clearLabel();
            busy = true; phase = 'clearing'; changed();
            let ok = 0;
            const failed = [], cleared = [];
            let all = new Map();
            if (!scan.demo) {
                setMsg('Clearing all control units...', 'Đang xóa bộ nhớ lỗi tất cả hộp...'); changed();
                try { all = await diag.functional(0x14, [0xFF, 0xFF, 0xFF], { idleMs: 5000 }); } catch (err) { log.warn('clear all: ' + err); }
                log.info('clear all: ' + Array.from(all.values()).filter((u) => u[0] === 0x54).length + ' units cleared');
            }
            for (const e of targets) {
                const r = all.get(e.addr);
                if (r && r[0] === 0x54) { ok++; cleared.push(e.addr); continue; }
                setMsg('Clearing ' + ecuName(e.addr, 'en') + '...', 'Đang xóa lỗi ' + ecuName(e.addr, 'vi') + '...'); changed();
                if (scan.demo) { await new Promise((r) => setTimeout(r, 260)); ok++; cleared.push(e.addr); continue; }
                try {
                    const res = await clearUnit(e.addr);
                    if (res.ok) { ok++; cleared.push(e.addr); } else failed.push({ addr: e.addr, why: res.why });
                } catch (err) {
                    log.warn('clear ' + hex(e.addr) + ': ' + err);
                    failed.push({ addr: e.addr, why: { kind: 'text', text: err && err.message ? err.message : String(err) } });
                }
            }
            log.info('cleared ' + ok + '/' + targets.length + (failed.length ? ' - failed: ' + failed.length : ''));
            if (scan.demo) demoCleared = true;
            busy = false;
            const cnt = targets.length;
            const doneEn = 'Cleared ' + ok + ' of ' + cnt + ' ' + (cnt === 1 ? 'control unit' : 'control units');
            const doneVi = 'Đã xóa ' + ok + '/' + cnt + ' hộp điều khiển';
            setMsg(doneEn + ' - scanning again', doneVi + ' — đang quét lại');
            changed();
            await new Promise((r) => setTimeout(r, 1200));
            await doScan();
            const backAddrs = scan ? scan.ecus.filter((e) => cleared.indexOf(e.addr) >= 0 && e.dtcs.some((d) => d.mem === 'fault')).map((e) => e.addr) : [];
            if (backAddrs.length) log.info('faults back at once after the clear: ' + backAddrs.map((a) => ecuName(a, 'en')).join(', '));
            if (!msg) {
                if (failed.length) {
                    const shownFail = failed.slice(0, 2);
                    const moreFail = failed.length > 2 ? ' (+' + (failed.length - 2) + ')' : '';
                    const enList = shownFail.map((f) => ecuShortByLang(f.addr, 'en') + ': ' + whyText(f.why)).join('; ') + moreFail;
                    const viList = shownFail.map((f) => ecuShortByLang(f.addr, 'vi') + ': ' + whyText(f.why)).join('; ') + moreFail;
                    setMsg('Not cleared - ' + enList, 'Không xóa được — ' + viList, { crit: true, scope: 'faults', transient: true, ttlMs: 12000 });
                } else if (backAddrs.length) {
                    const shownBack = backAddrs.slice(0, 3);
                    const moreCnt = backAddrs.length - shownBack.length;
                    const enNames = shownBack.map((a) => ecuShortByLang(a, 'en')).join(', ') + (moreCnt > 0 ? ' +' + moreCnt : '');
                    const viNames = shownBack.map((a) => ecuShortByLang(a, 'vi')).join(', ') + (moreCnt > 0 ? ' +' + moreCnt : '');
                    const enMsg = backAddrs.length > 3
                        ? 'Cleared · Active faults remain on ' + backAddrs.length + ' units (' + enNames + ')'
                        : 'Cleared · Active faults remain: ' + enNames;
                    const viMsg = backAddrs.length > 3
                        ? 'Đã xóa · Còn lỗi hiện hữu ở ' + backAddrs.length + ' hộp (' + viNames + ')'
                        : 'Đã xóa · Còn lỗi hiện hữu: ' + viNames;
                    setMsg(enMsg, viMsg, { scope: 'faults', transient: true, ttlMs: 12000 });
                } else {
                    setMsg(doneEn, doneVi, { scope: 'faults', transient: true, ttlMs: 10000 });
                }
            }
            changed();
        }

        /* ---------- drawing ---------- */
        let page = 0;
        let perPage = PER_PAGE;
        let scrolls = false;
        let gliding = false;
        let appSort = 'ram';     // 'ram' | 'cpu' | 'disk' | 'name'
        let appFilter = 'all';   // 'all' | 'apps' | 'running'
        const SORT_ORDER = ['ram', 'cpu', 'disk', 'name'];
        const SORT_LABELS = { ram: 'Sort: RAM', cpu: 'Sort: CPU', disk: 'Sort: Disk', name: 'Sort: Name' };
        const FILTER_ORDER = ['all', 'apps', 'running'];
        const FILTER_LABELS = { all: 'Show: All', apps: 'Show: Apps', running: 'Show: Running' };
        const scroll = { faults: { y: 0, max: 0 }, cc: { y: 0, max: 0 }, ecus: { y: 0, max: 0 }, apps: { y: 0, max: 0 } };
        let only = null;
        const faults = () => (scan ? [].concat(...scan.ecus.map((e) => e.dtcs.map((d) => Object.assign({ addr: e.addr }, d)))) : []);
        const listed = () => (only === null ? faults() : faults().filter((d) => d.addr === only));
        const pageCount = () => (scrolls ? 1 : Math.max(1, Math.ceil(listed().length / perPage))) + EXTRA_PAGES;
        const isStatusPage = () => page === pageCount() - 2;
        const isAppsPage = () => page === pageCount() - 1;
        const onLivePage = () => isStatusPage() || isAppsPage();
        const shownList = () => {
            const fp = pageCount() - EXTRA_PAGES;
            if (page < fp) return scroll.faults;
            if (page === fp) return scroll.cc;
            if (page === fp + 1) return scroll.ecus;
            if (page === fp + 3) return scroll.apps;
            return null;
        };
        ctx.onScroll((dy) => {
            const s = shownList();
            if (!s) return false;
            const y = G.clamp(s.y + dy, 0, s.max), moved = y !== s.y;
            s.y = y;
            if (moved) changed();
            return moved;
        });
        const showOnly = (addr) => { only = addr; page = 0; scroll.faults.y = 0; changed(); };
        const ccList = () => (scan && scan.demo ? DEMO.cc : Array.from(cc.entries()).map(([id, m]) => Object.assign({ id }, m, ccNames.get(id) || {})));

        // A local, shareable report is written before any clear attempt. It contains diagnostic data only.
        function writeReport(tag) {
            if (!scan) return null;
            const dir = path.join(ctx.dataDir, 'reports');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            const nowMs = Date.now(), clk = nowClock(nowMs, false);
            sampleSystem(nowMs);
            const appSnap = appsMon.sample(nowMs, { gpuActive: false });
            const adv = diagnoseHealth(appSnap, sys, getLanguage());
            const stamp = clk.isoLocal.replace(/[:.+]/g, '-');
            const file = path.join(dir, 'mgu-diagnostics-' + stamp + '.json');
            const report = {
                app: 'MGU Diagnostics',
                version: ctx.spec.version,
                createdAt: new Date(nowMs).toISOString(),
                vehicleTime: clk.isoLocal,
                clockSyncedToVehicle: clk.synced,
                reason: tag || uiPair('User saved report', 'Người dùng lưu báo cáo'),
                source: scan.demo ? 'demo' : 'vehicle',
                scanAt: new Date(scan.at).toISOString(),
                scanVehicleTime: when(scan.at),
                mguSystem: {
                    os: sys.osLabel || null,
                    uptimeSeconds: sys.upSec,
                    cpuPercent: sys.cpuPct !== null ? Math.round(sys.cpuPct) : null,
                    load1: sys.load1,
                    ramUsedMB: Math.round(sys.memUsedMB),
                    ramTotalMB: Math.round(sys.memTotalMB),
                    oapUsedMB: sys.oapUsedMB !== null ? Math.round(sys.oapUsedMB) : null,
                    oapLimitMB: sys.oapCapMB !== null ? Math.round(sys.oapCapMB) : null,
                    storageTotalBytes: sys.diskTotalBytes,
                    storageFreeBytes: sys.diskFreeBytes,
                    installedApps: appSnap.appCount,
                    installedTools: appSnap.toolCount,
                    healthStatus: adv.badge,
                    healthHeadline: adv.headline,
                },
                controlUnits: scan.ecus.map((e) => ({
                    address: '0x' + hex(e.addr),
                    name: ecuName(e.addr),
                    faults: e.dtcs.map((d) => ({
                        code: d.code,
                        status: d.status,
                        memory: d.mem,
                        description: describe(e.addr, d.code) ? diagnosticText(describe(e.addr, d.code)) : null,
                    })),
                })),
                checkControl: ccList().map((m) => ({
                    id: m.id,
                    message: m.name ? diagnosticText(m.name) : null,
                    severity: m.color || null,
                    ecu: m.ecu === undefined ? null : '0x' + hex(m.ecu),
                })),
            };
            fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
            return file;
        }

        function fit(cv, txt, size, max, opt) {
            return fitText(cv, txt, size, max, opt);
        }
        function litText(cv, txt, x, y, size, col, opt) {
            return cv.text(String(txt), x, y, size, col, Object.assign({ literal: true }, opt));
        }
        function fitLit(cv, txt, size, max, opt) {
            return fitText(cv, String(txt), size, max, Object.assign({ literal: true }, opt));
        }

        function tile(cv, t, i, label, value, sub, col, literalSub) {
            const w = (1552 - 3 * 16) / 4, x = 24 + i * (w + 16);
            G.panel(cv, t, x, 44, w, 115, label);
            cv.text(value, x + 18, 142, 64, col, { font: 'num', literal: true });
            if (sub) cv.text(sub, x + w - 18, 142, 22, t.dim, { align: 'right', literal: !!literalSub });
        }

        function header(cv, t) {
            const fp = pageCount() - EXTRA_PAGES, sel = page < fp ? 0 : page - fp + 1;
            G.frame(cv, t, ['Faults' + (fp > 1 ? '  ' + (Math.min(page, fp - 1) + 1) + '/' + fp : ''), 'Check Control', 'Control units', 'MGU status', 'Apps'], sel,
                [(scan && scan.demo || (!scan && useDemo())) && { text: 'DEMO' }]);
        }

        function tiles(cv, t) {
            const f = faults(), active = f.filter((d) => d.status & 1).length, n = scan ? scan.ecus.length : null;
            const fm = f.filter((d) => d.mem === 'fault').length, im = f.length - fm;
            tile(cv, t, 0, 'Control units', phase === 'scanning' ? String(replies) : n === null ? '--' : String(n), phase === 'scanning' ? 'answering...' : 'answered', t.text);
            tile(cv, t, 1, 'Faults', scan ? String(fm) : '--', im ? '+ ' + im + uiPair(' info', ' thông tin') : 'stored', !scan ? t.dim : fm ? t.warn : GO, !!im);
            tile(cv, t, 2, 'Active now', scan ? String(active) : '--', 'present right now', !scan ? t.dim : active ? t.crit : GO);
            const c = ccList().length;
            tile(cv, t, 3, 'Check Control', String(c), plural(c, 'messages', 'messages'), c ? t.warn : GO);
        }

        function listPanel(cv, t, title, buttons, isFaultsPage) {
            const p = G.panel(cv, t, 24, 176, 1552, 336, title);
            let bx = 42 + cv.textWidth(String(title), 26, { font: 'bold' }) + 28;
            (buttons || []).forEach((b) => { bx += G.button(cv, t, bx, 189, 0, 40, b.label, b.run, b) + 12; });
            let right = curMsgFor(!!isFaultsPage, page);
            if (!right && scan) right = uiPair('Last scan ', 'Lần quét gần nhất ') + when(scan.at);
            if (phase === 'scanning' || phase === 'clearing') {
                const w = 300, x = 1552 - w, f = ((Date.now() / 1200) % 1);
                cv.roundRect(x, 195, w, 8, 4, t.track);
                cv.roundRect(x + f * (w - 80), 195, 80, 8, 4, t.accent);
                if (!right) right = phase === 'scanning' ? uiPair('Asking every control unit...', 'Đang hỏi từng hộp điều khiển...') : '';
                if (right) litText(cv, fitLit(cv, right, 22, Math.max(180, x - bx - 32)), x - 20, 212, 22, t.text, { align: 'right' });
            } else if (right) {
                litText(cv, fitLit(cv, right, 22, Math.max(240, 1552 - bx - 24)), 1552, 212, 22, isMsgCrit() ? t.crit : t.dim, { align: 'right' });
            }
            return p;
        }

        function scrolled(cv, t, p, s, key, clipTop, top, bottom, draw) {
            if (!scrolls) { draw(0); return; }
            const end = p.y + p.h - 12;
            s.max = Math.max(0, top + bottom - end);
            s.y = G.clamp(s.y, 0, s.max);
            const sy = G.smooth('dtcScroll:' + key, s.y, 22);
            if (sy !== s.y) gliding = true;
            cv.clip(p.x, clipTop, p.w, p.y + p.h - 4 - clipTop);
            draw(sy, clipTop, p.y + p.h - 4);
            cv.noclip();
            if (!s.max) return;
            const vis = end - clipTop, bh = Math.max(40, vis * vis / (vis + s.max));
            const bar = { x: p.x + p.w - 11, y: clipTop + (vis - bh) * sy / s.max, w: 6, h: bh };
            cv.roundRect(bar.x, bar.y, bar.w, bar.h, 3, withAlpha(t.text, 0.3));
            cv.scroll = { y: clipTop, bar };
        }

        function drawFaults(cv, t) {
            const f = listed(), pages = scrolls ? 1 : Math.max(1, Math.ceil(f.length / perPage));
            const isBusy = phase === 'scanning' || phase === 'clearing';
            const titleBase = only === null ? 'Faults' : translateUI('Faults') + ' · ' + ecuListName(only);
            const p = listPanel(cv, t, titleBase + (pages > 1 ? '  ' + (page + 1) + '/' + pages : ''), [
                { label: phase === 'scanning' ? 'Scanning...' : scan ? 'Scan again' : 'Scan now', run: () => doScan(), key: 'scan', busy: isBusy },
                { label: clearArmed ? 'Yes, clear' : 'Clear all', run: () => doClear(), key: 'clear', busy: isBusy || !faults().length, color: clearArmed ? t.crit : null },
                only !== null && { label: 'All units', run: () => showOnly(null), key: 'all' },
            ].filter(Boolean), true);
            const mid = Math.round((p.y + p.h - G.BOTTOM) / 2);
            if (!scan) {
                cv.text(phase === 'scanning' ? 'Scanning...' : 'Press "Scan now" (ignition on)', 800, 369 + mid, 32, t.dim, { align: 'center' });
                return;
            }
            if (!f.length && phase !== 'scanning') {
                cv.circle(800, 327 + mid, 40, withAlpha(GO, 0.2));
                cv.polyline([[782, 327 + mid], [796, 342 + mid], [820, 312 + mid]], 7, GO);
                cv.text(scan.ecus.length ? 'No faults stored' : 'No answer', 800, 433 + mid, 32, t.text, { align: 'center', font: 'bold' });
                return;
            }
            const rows = scrolls ? f : f.slice(page * perPage, page * perPage + perPage);
            scrolled(cv, t, p, scroll.faults, 'faults', 233, 239, rows.length * 46 - 12, (sy, from, to) => rows.forEach((d, i) => {
                const y = 239 + i * 46 - sy;
                if (y + 41 < from || y > to) return;
                const s = statusInfo(d.status), col = t[s.sev] || t.dim;
                cv.roundRect(48, y, 170, 34, 6, withAlpha(col, 0.22));
                cv.text(s.label, 133, y + 25, 20, col, { align: 'center', font: 'bold', spacing: 0.5 });
                litText(cv, d.code, 246, y + 28, 32, t.text, { font: 'bold', spacing: 1 });
                litText(cv, fitLit(cv, ecuListName(d.addr), 26, 680 - 420 - 16), 420, y + 27, 26, t.text);
                const desc = describe(d.addr, d.code);
                const infoPrefix = uiPair('INFO: ', 'THÔNG TIN: ');
                const txt = desc ? (d.mem === 'info' ? infoPrefix : '') + diagnosticText(desc) : d.mem === 'info' ? uiPair('INFO MEMORY', 'BỘ NHỚ THÔNG TIN') : '';
                if (txt) litText(cv, fitLit(cv, txt, 22, 1552 - 680), 680, y + 27, 22, t.dim);
                if (i < rows.length - 1) cv.fillRect(48, y + 40, 1504, 1, withAlpha(t.tick, 0.25));
            }));
        }

        function drawCC(cv, t) {
            const p = listPanel(cv, t, 'Check Control messages'), dy = p.y + p.h - G.BOTTOM;
            const l = ccList();
            if (!l.length) { cv.text('No active Check Control messages', 800, 369 + Math.round(dy / 2), 30, t.dim, { align: 'center' }); return; }
            const COL = { RED: t.crit, YELLOW: t.warn, ORANGE: t.warn, GREEN: GO, WHITE: t.text };
            const rows = scrolls ? l : l.slice(0, perPage);
            scrolled(cv, t, p, scroll.cc, 'cc', 229, 231, rows.length * 47 - 7, (sy, from, to) => rows.forEach((m, i) => {
                const y = 231 + i * 47 - sy;
                if (y + 41 < from || y > to) return;
                cv.circle(66, y + 18, 9, COL[m.color] || t.dim);
                const label = m.name ? diagnosticText(m.name) : uiPair('Message ', 'Thông báo ') + m.id;
                litText(cv, fitLit(cv, label, 28, m.ecu !== undefined ? 1020 : 1440, { font: 'bold' }), 92, y + 27, 28, t.text, { font: 'bold' });
                if (m.ecu !== undefined) litText(cv, fitLit(cv, ecuListName(m.ecu), 22, 420), 1552, y + 27, 22, t.dim, { align: 'right' });
                if (i < rows.length - 1) cv.fillRect(48, y + 40, 1504, 1, withAlpha(t.tick, 0.25));
            }));
            if (l.length > rows.length) litText(cv, '+ ' + (l.length - rows.length) + ' ' + uiPair('more', 'khác'), 1552, 506 + dy, 22, t.dim, { align: 'right' });
        }

        function drawEcus(cv, t) {
            const p = listPanel(cv, t, 'Control units that answered'), dy = p.y + p.h - G.BOTTOM;
            const l = scan ? scan.ecus.slice().sort((a, b) => a.addr - b.addr) : [];
            if (!l.length) { cv.text(scan ? 'No control unit answered' : 'Scan first', 800, 369 + Math.round(dy / 2), 30, t.dim, { align: 'center' }); return; }
            const cols = 5, cw = 296, ch = 55;
            const shown = scrolls ? l : l.slice(0, cols * (5 + Math.floor(dy / ch)));
            scrolled(cv, t, p, scroll.ecus, 'ecus', 229, 233, Math.ceil(shown.length / cols) * ch - 6, (sy, from, to) => shown.forEach((e, i) => {
                const x = 48 + (i % cols) * (cw + 8), y = 233 + Math.floor(i / cols) * ch - sy;
                if (y + ch < from || y > to) return;
                const act = e.dtcs.some((d) => d.status & 1), n = e.dtcs.length;
                const col = act ? t.crit : n ? t.warn : GO;
                cv.roundRect(x, y, cw, ch - 6, 6, withAlpha(col, 0.12));
                cv.fillRect(x, y, 5, ch - 6, col);
                const badge = n ? n + ' ' + plural(n, 'fault', 'faults') : translateUI('OK');
                const bw = cv.textWidth(badge, 22, { font: 'bold', literal: true });
                const maxNameW = cw - bw - 42;
                litText(cv, fitLit(cv, ecuListName(e.addr), 22, maxNameW, { font: 'bold' }), x + 18, y + (e.nrc ? 23 : 32), 22, t.text, { font: 'bold' });
                if (e.nrc) litText(cv, fitLit(cv, nrcLabel(e.nrc), 19, maxNameW), x + 18, y + 44, 19, t.dim);
                litText(cv, badge, x + cw - 12, y + 32, 22, col, { align: 'right', font: 'bold' });
                const ty = Math.max(y, from), th = Math.min(y + ch - 6, to) - ty;
                if (cv.own && th >= 20) cv.target(x, ty, cw, th, () => showOnly(e.addr), 'ecu' + e.addr, 6);
            }));
        }

        function drawAnalogClock(cv, t, cx, cy, r, clk) {
            const S = r + 8;
            const dial = G.layer(['sysClockDial', r, t.name].join('|'), 2 * S, 2 * S, (c) => {
                c.circle(S, S, r, withAlpha('#b4bccc', 0.055));
                c.arc(S, S, r - 3, r, 0, 360, withAlpha(t.tick, 0.72));
                c.arc(S, S, r - 15, r - 14, 0, 360, withAlpha(t.tick, 0.2));
                for (let i = 0; i < 60; i++) {
                    const a = (i * 6) * Math.PI / 180, sx = Math.sin(a), cy_ = -Math.cos(a);
                    const major = i % 5 === 0, quarter = i % 15 === 0;
                    const ri = r - (quarter ? 18 : major ? 15 : 10), ro = r - 5;
                    c.line(S + sx * ri, S + cy_ * ri, S + sx * ro, S + cy_ * ro,
                        quarter ? 3.4 : major ? 2.2 : 1.2,
                        quarter ? t.text : major ? withAlpha(t.text, 0.85) : withAlpha(t.tick, 0.45));
                }
                const nums = [['12', 0, -1], ['3', 1, 0], ['6', 0, 1], ['9', -1, 0]];
                const lr = r - 30;
                nums.forEach((n) => {
                    c.text(n[0], S + n[1] * lr, S + n[2] * lr + 7, 19, t.text, { align: 'center', font: 'bold', literal: true });
                });
                G.stripes(c, t, S - 18, S - Math.round(r * 0.46), 36);
                c.text('MGU', S, S - Math.round(r * 0.27), 13, t.dim, { align: 'center', font: 'bold', spacing: 2, literal: true });
            }, cv.textScale);
            cv.blit(dial, Math.round(cx) - S, Math.round(cy) - S);

            const secCol = t.crit || t.sel || t.accent;
            if (clk.secFrac > 0.05) {
                cv.arc(cx, cy, r - 3, r, 0, clk.secFrac * 6, withAlpha(secCol, 0.65));
            }

            const ha = (((clk.hour % 12) + clk.min / 60 + clk.secFrac / 3600) * 30) * Math.PI / 180;
            const ma = ((clk.min + clk.secFrac / 60) * 6) * Math.PI / 180;
            const sa = (clk.secFrac * 6) * Math.PI / 180;

            const hx = Math.sin(ha), hy = -Math.cos(ha);
            cv.line(cx - hx * 10, cy - hy * 10, cx + hx * (r * 0.48), cy + hy * (r * 0.48), 7.5, withAlpha('#000000', 0.35));
            cv.line(cx - hx * 10, cy - hy * 10, cx + hx * (r * 0.48), cy + hy * (r * 0.48), 5.2, t.text);

            const mx = Math.sin(ma), my = -Math.cos(ma);
            cv.line(cx - mx * 12, cy - my * 12, cx + mx * (r * 0.67), cy + my * (r * 0.67), 5.5, withAlpha('#000000', 0.35));
            cv.line(cx - mx * 12, cy - my * 12, cx + mx * (r * 0.67), cy + my * (r * 0.67), 3.6, t.text);

            // Running second hand (kim giây) with counterweight
            const sx = Math.sin(sa), sy = -Math.cos(sa);
            cv.line(cx - sx * 21, cy - sy * 21, cx + sx * (r * 0.83), cy + sy * (r * 0.83), 4.5, withAlpha(secCol, 0.22));
            cv.line(cx - sx * 21, cy - sy * 21, cx + sx * (r * 0.83), cy + sy * (r * 0.83), 2.2, secCol);
            cv.circle(cx - sx * 14, cy - sy * 14, 3.8, secCol);
            cv.circle(cx, cy, 6.5, t.bg);
            cv.circle(cx, cy, 4.8, secCol);
            cv.circle(cx, cy, 1.8, '#ffffff');
        }

        function miniBar(cv, t, x, y, w, h, pct, col) {
            cv.roundRect(x, y, w, h, h / 2, withAlpha('#d4d8de', 0.22));
            const fw = G.clamp(pct || 0, 0, 100) / 100 * w;
            if (fw > 1.5) cv.roundRect(x, y, Math.max(h, fw), h, h / 2, col);
        }

        function vehicleStateText(t, demoMode) {
            const c = carInfo.condition;
            if (c === 10) return { text: uiPair('Drive-ready (READY)', 'Sẵn sàng chạy (READY)'), col: GO };
            if (c === 8) return { text: uiPair('Starting drive readiness', 'Đang khởi động xe'), col: t.accent };
            if (c === 7) return { text: uiPair('Ignition ON (PAD)', 'Bật khóa điện (PAD)'), col: GO };
            if (c === 5) return { text: uiPair('Accessory / Living', 'Chế độ chờ (Wohnen)'), col: t.accent };
            if (c === 12) return { text: uiPair('Shutting down', 'Đang tắt điện'), col: t.dim };
            if (c >= 1 && c <= 3) return { text: uiPair('Parked', 'Đang đỗ xe'), col: t.dim };
            if (diag.available) return { text: uiPair('Diagnostic bus active', 'Bus chẩn đoán đang mở'), col: GO };
            if (demoMode) return { text: uiPair('Simulated ignition', 'Mô phỏng bật điện'), col: t.warn };
            return { text: uiPair('Waiting for vehicle bus', 'Đang chờ tín hiệu xe'), col: t.dim };
        }

        function drawSystem(cv, t, nowMs, gpuActive) {
            sampleSystem(nowMs);
            const clk = nowClock(nowMs, gpuActive);
            const demoMode = (scan && scan.demo) || (!scan && useDemo());

            /* ---- 1. Left Hero Panel: Vehicle-Synced System Clock ---- */
            const pClock = G.panel(cv, t, 24, 44, 488, 468, 'System clock');
            const ex = pClock.h - 468;
            const r = 95 + Math.min(12, Math.floor(ex * 0.18));
            const cx = 268, cy = 198 + Math.round(ex * 0.38);

            // Live pulse indicator + zone in header corner
            const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(nowMs / 320));
            const liveCol = clk.synced ? GO : clk.gpsActive ? t.accent : t.warn;
            const zTxt = clk.zone;
            const zw = cv.textWidth(zTxt, 18, { font: 'bold', literal: true });
            cv.circle(494 - zw - 12, 76, 4.5, withAlpha(liveCol, gpuActive ? pulse : 0.9));
            litText(cv, zTxt, 494, 82, 18, t.accent, { align: 'right', font: 'bold' });

            drawAnalogClock(cv, t, cx, cy, r, clk);

            const dyBase = cy + r;
            litText(cv, clk.time, cx, dyBase + 50, 48, t.text, { align: 'center', font: 'num' });
            litText(cv, clk.dateLine, cx, dyBase + 80, 20, t.dim, { align: 'center', font: 'bold' });

            const footTop = pClock.y + pClock.h - 108;
            cv.fillRect(42, footTop, 452, 1, withAlpha(t.tick, 0.25));

            const syncBadge = clk.synced
                ? uiPair('SYNCED TO VEHICLE CLOCK (KOMBI)', 'ĐỒNG BỘ THEO GIỜ XE (KOMBI)')
                : clk.gpsActive
                    ? uiPair('SYNCED VIA GPS TIMESYNC', 'ĐỒNG BỘ QUA GPS TIMESYNC')
                    : demoMode
                        ? uiPair('SYSTEM CLOCK · WAITING CAR SYNC', 'GIỜ HỆ THỐNG · CHỜ ĐỒNG BỘ XE')
                        : uiPair('MGU INTERNAL CLOCK', 'ĐỒNG HỒ NỘI BỘ MGU');
            cv.roundRect(48, footTop + 12, 440, 32, 8, withAlpha(liveCol, 0.16));
            litText(cv, fitLit(cv, syncBadge, 17, 420, { font: 'bold' }), cx, footTop + 34, 17, liveCol, { align: 'center', font: 'bold' });

            const modeLabel = clk.autoAdjust === true ? uiPair('Auto time ON', 'Tự chỉnh giờ: Bật')
                : clk.autoAdjust === false ? uiPair('Manual car clock', 'Giờ xe: Chỉnh tay')
                    : clock.gpsSync && clock.gpsSync.inSync ? uiPair('GPS daemon aligned', 'GPS TimeSync: Chuẩn')
                        : uiPair('Live 1s cadence', 'Nhịp kim giây: Thực');
            litText(cv, uiPair('Clock source', 'Chế độ giờ'), 48, footTop + 66, 17, t.dim);
            litText(cv, modeLabel, 488, footTop + 66, 17, t.text, { align: 'right', font: 'bold' });

            let driftTxt;
            if (clk.synced && clk.driftSec !== null) {
                const absD = Math.abs(clk.driftSec);
                driftTxt = absD <= 3 ? uiPair('Aligned (' + clk.driftSec + 's)', 'Khớp nhân MGU (' + clk.driftSec + 's)')
                    : absD < 120 ? uiPair('Offset ' + (clk.driftSec > 0 ? '+' : '') + clk.driftSec + 's compensated', 'Đã bù lệch ' + (clk.driftSec > 0 ? '+' : '') + clk.driftSec + 's')
                        : uiPair('Offset ' + Math.round(clk.driftSec / 60) + 'm compensated', 'Đã bù lệch ' + Math.round(clk.driftSec / 60) + ' phút');
            } else {
                driftTxt = uiPair('Awaiting KOMBI broadcast', 'Chờ bản tin giờ từ KOMBI');
            }
            litText(cv, uiPair('MGU kernel check', 'So khớp nhân MGU'), 48, footTop + 91, 17, t.dim);
            litText(cv, fitLit(cv, driftTxt, 17, 270), 488, footTop + 91, 17, clk.synced ? GO : t.dim, { align: 'right' });

            /* ---- 2. Middle-Top Panel: MGU Hardware & Resources ---- */
            G.panel(cv, t, 528, 44, 516, 244, 'MGU hardware');
            const rendTxt = gpuActive
                ? (sys.gpuMHz ? 'GPU ' + sys.gpuMHz + ' MHz · 60 FPS' : 'GPU 60 FPS')
                : uiPair('SOFTWARE', 'PHẦN MỀM');
            litText(cv, rendTxt, 1026, 82, 17, gpuActive ? GO : t.dim, { align: 'right', font: 'bold' });

            // 1. CPU load + sparkline
            const cpuVal = sys.cpuPct !== null ? Math.round(sys.cpuPct) : null;
            const cpuCol = cpuVal === null ? t.dim : cpuVal >= 85 ? t.crit : cpuVal >= 65 ? t.warn : GO;
            const coreInfo = (sys.cpuCores ? sys.cpuCores + ' ' + uiPair('cores', 'lõi') : 'CPU') +
                (sys.load1 !== null ? ' · ' + uiPair('load ', 'tải ') + sys.load1.toFixed(2) : '');
            litText(cv, uiPair('CPU · ', 'Vi xử lý · ') + coreInfo, 546, 112, 17, t.dim);
            if (sys.cpuHist.length >= 2) {
                const sx0 = 852, sw = 92, sy1 = 114, sh = 19;
                const pts = sys.cpuHist.map((v, idx) => [
                    sx0 + (idx / Math.max(1, sys.cpuHist.length - 1)) * sw,
                    sy1 - G.clamp(v, 0, 100) / 100 * sh,
                ]);
                cv.fillUnder(pts, sy1, withAlpha(cpuCol, 0.18));
                cv.polyline(pts, 2, withAlpha(cpuCol, 0.9));
            }
            litText(cv, cpuVal !== null ? cpuVal + '%' : '--', 1026, 112, 21, cpuVal !== null ? cpuCol : t.dim, { align: 'right', font: 'bold' });
            miniBar(cv, t, 546, 119, 480, 6, cpuVal || 0, cpuCol);

            // 2. System RAM
            const ramCol = sys.ramPct >= 88 ? t.crit : sys.ramPct >= 75 ? t.warn : t.accent;
            litText(cv, uiPair('System RAM', 'Bộ nhớ RAM'), 546, 149, 17, t.dim);
            const ramTxt = sys.memTotalMB > 0
                ? Math.round(sys.memUsedMB) + ' / ' + Math.round(sys.memTotalMB) + ' MB (' + sys.ramPct + '%)'
                : uiPair('Unavailable', 'Không có dữ liệu');
            litText(cv, ramTxt, 1026, 149, 18, t.text, { align: 'right', font: 'bold' });
            miniBar(cv, t, 546, 156, 480, 6, sys.ramPct, ramCol);

            // 3. MGU Storage (total capacity & free space)
            const hasDisk = sys.diskTotalBytes !== null && sys.diskFreeBytes !== null;
            const freeGB = hasDisk ? sys.diskFreeBytes / 1073741824 : null;
            const diskCol = !hasDisk ? t.dim : (sys.diskUsedPct >= 92 || freeGB < 1) ? t.crit : (sys.diskUsedPct >= 80 || freeGB < 3) ? t.warn : GO;
            litText(cv, uiPair('MGU storage', 'Dung lượng MGU'), 546, 186, 17, t.dim);
            const diskTxt = hasDisk
                ? uiPair(fmtBytes(sys.diskTotalBytes) + ' · ' + fmtBytes(sys.diskFreeBytes) + ' free',
                    fmtBytes(sys.diskTotalBytes) + ' · Trống ' + fmtBytes(sys.diskFreeBytes))
                : uiPair('Checking...', 'Đang đọc...');
            litText(cv, diskTxt, 1026, 186, 18, hasDisk ? diskCol : t.dim, { align: 'right', font: 'bold' });
            miniBar(cv, t, 546, 193, 480, 6, hasDisk ? sys.diskUsedPct : 0, diskCol);

            // 4. OAP pool / Process RSS & SoC temp / Swap
            const hasCgroup = sys.oapUsedMB !== null && sys.oapCapMB !== null;
            const oapLabel = hasCgroup ? uiPair('OAP apps pool', 'Vùng nhớ OAP') : uiPair('App RSS memory', 'Bộ nhớ tiến trình');
            const oapVal = hasCgroup
                ? Math.round(sys.oapUsedMB) + ' / ' + Math.round(sys.oapCapMB) + ' MB'
                : sys.rssMB + ' MB RSS';
            const extraHw = sys.socTempC !== null ? 'SoC ' + sys.socTempC + ' °C'
                : sys.swapMB !== null ? 'Swap ' + Math.round(sys.swapMB) + ' MB' : '';
            litText(cv, oapLabel, 546, 224, 17, t.dim);
            litText(cv, oapVal + (extraHw ? '  ·  ' + extraHw : ''), 1026, 224, 17, t.text, { align: 'right', font: 'bold' });
            cv.fillRect(546, 238, 480, 1, withAlpha(t.tick, 0.22));

            // 5. Live ticking uptime
            const upD = Math.floor(sys.upSec / 86400), upH = Math.floor((sys.upSec % 86400) / 3600);
            const upM = Math.floor((sys.upSec % 3600) / 60), upS = sys.upSec % 60;
            const upStr = (upD > 0 ? upD + uiPair('d ', ' ngày ') : '') + pad2(upH) + ':' + pad2(upM) + ':' + pad2(upS);
            litText(cv, uiPair('MGU uptime', 'Thời gian MGU chạy'), 546, 265, 17, t.dim);
            litText(cv, upStr, 1026, 265, 21, t.accent, { align: 'right', font: 'bold' });

            /* ---- 3. Right-Top Panel: Vehicle Link & Bus Vitals ---- */
            G.panel(cv, t, 1060, 44, 516, 244, 'Vehicle link & vitals');
            const linkCol = diag.available ? GO : demoMode ? t.warn : t.dim;
            const linkTxt = diag.available ? uiPair('TASU READY', 'TASU SẴN SÀNG')
                : demoMode ? uiPair('DEMO MODE', 'MÔ PHỎNG') : uiPair('OFFLINE', 'CHƯA KẾT NỐI');
            const lw = Math.max(132, cv.textWidth(linkTxt, 16, { font: 'bold', literal: true }) + 28);
            cv.roundRect(1558 - lw, 58, lw, 28, 7, withAlpha(linkCol, 0.2));
            litText(cv, linkTxt, 1558 - lw / 2, 78, 16, linkCol, { align: 'center', font: 'bold' });

            const vst = vehicleStateText(t, demoMode);
            litText(cv, uiPair('Vehicle state', 'Trạng thái điện xe'), 1078, 120, 17, t.dim);
            litText(cv, fitLit(cv, vst.text, 18, 290, { font: 'bold' }), 1558, 120, 18, vst.col, { align: 'right', font: 'bold' });

            const batVal = carInfo.bat12 !== null ? carInfo.bat12 : (demoMode ? 88 : null);
            const batCol = batVal === null ? t.dim : batVal < 35 ? t.crit : batVal < 55 ? t.warn : GO;
            litText(cv, uiPair('12 V battery charge', 'Mức nạp ắc-quy 12V'), 1078, 154, 17, t.dim);
            litText(cv, batVal !== null ? batVal + '%' + (carInfo.bat12 === null && demoMode ? ' (demo)' : '') : '--',
                1558, 154, 19, batCol, { align: 'right', font: 'bold' });

            const cool = carInfo.coolant !== null ? carInfo.coolant : (demoMode ? 89 : null);
            const oil = carInfo.oil !== null ? carInfo.oil : (demoMode ? 96 : null);
            const tempStr = cool !== null || oil !== null
                ? (cool !== null ? cool + ' °C' : '--') + '  /  ' + (oil !== null ? oil + ' °C' : '--')
                : '--';
            litText(cv, uiPair('Coolant / oil temp', 'Nhiệt độ nước / dầu'), 1078, 188, 17, t.dim);
            litText(cv, tempStr, 1558, 188, 18, cool !== null || oil !== null ? t.text : t.dim, { align: 'right', font: 'bold' });

            const sgbdCount = Object.keys(ids).filter((k) => ids[k]).length;
            const odoVal = carInfo.odoKm !== null ? carInfo.odoKm.toLocaleString('en-US') + ' km' : null;
            litText(cv, odoVal ? uiPair('Odometer · SGBD IDs', 'Số ODO · Định danh hộp') : uiPair('Identified SGBD variants', 'Hộp đã định danh SGBD'), 1078, 222, 17, t.dim);
            litText(cv, (odoVal ? odoVal + ' · ' : '') + sgbdCount + ' SGBD', 1558, 222, 18, t.text, { align: 'right', font: 'bold' });

            cv.fillRect(1078, 238, 480, 1, withAlpha(t.tick, 0.22));
            litText(cv, uiPair('UDS transport', 'Đường truyền UDS'), 1078, 264, 17, t.dim);
            const busNote = diag.busy > 0
                ? uiPair('0xF2 -> 0xDF · ' + diag.busy + ' retries', '0xF2 -> 0xDF · ' + diag.busy + ' lần thử lại')
                : uiPair('0xF2 -> 0xDF · Clean link', '0xF2 -> 0xDF · Ổn định');
            litText(cv, busNote, 1558, 264, 17, diag.busy > 0 ? t.warn : t.text, { align: 'right', font: 'bold' });

            /* ---- 4. Middle-Bottom Panel: Diagnostic Summary & Health Ring ---- */
            const pDiag = G.panel(cv, t, 528, 304, 516, 208, 'Diagnostic summary');
            const exB = pDiag.h - 208;
            const scanStamp = scan ? when(scan.at) : uiPair('Not scanned', 'Chưa quét');
            litText(cv, scanStamp, 1026, 344, 17, scan ? (scan.demo ? t.warn : GO) : t.dim, { align: 'right', font: 'bold' });

            const f = faults(), activeFaults = f.filter((d) => d.status & 1).length;
            const fm = f.filter((d) => d.mem === 'fault').length, im = f.length - fm;
            const totalUnits = scan ? scan.ecus.length : 0;
            const cleanUnits = scan ? scan.ecus.filter((e) => !e.dtcs.length).length : 0;
            const healthPct = totalUnits > 0 ? Math.round(cleanUnits * 100 / totalUnits) : null;
            const hCol = !scan ? t.dim : activeFaults > 0 ? t.crit : fm > 0 ? t.warn : GO;

            const rcx = 598, rcy = 428 + Math.round(exB * 0.45), rr = 48;
            cv.arc(rcx, rcy, rr - 9, rr, 0, 360, t.track);
            if (healthPct !== null && healthPct > 0) {
                cv.arc(rcx, rcy, rr - 9, rr, 0, Math.max(6, healthPct * 3.6), hCol, { round: true });
            }
            litText(cv, healthPct !== null ? healthPct + '%' : '--', rcx, rcy + 6, 24, healthPct !== null ? t.text : t.dim, { align: 'center', font: 'bold' });
            litText(cv, uiPair('CLEAN', 'SẠCH LỖI'), rcx, rcy + 25, 12, t.dim, { align: 'center', font: 'bold', spacing: 1 });

            const rowGap = 31 + Math.floor(exB * 0.22);
            const ry0 = 385 + Math.round(exB * 0.1);
            const summaryRows = [
                [uiPair('Units clean / total', 'Hộp sạch / đã phản hồi'), scan ? cleanUnits + ' / ' + totalUnits : '--', t.text],
                [uiPair('Stored / info faults', 'Lỗi lưu / thông tin'), scan ? fm + (im ? ' (+' + im + ')' : '') : '--', !scan ? t.dim : fm ? t.warn : GO],
                [uiPair('Active faults now', 'Lỗi đang hoạt động'), scan ? String(activeFaults) : '--', !scan ? t.dim : activeFaults ? t.crit : GO],
                [uiPair('CC & saved reports', 'CC & báo cáo đã lưu'), ccList().length + ' CC · ' + sys.reports + ' (' + Math.round(sys.reportBytes / 1024) + ' KB)', t.text],
            ];
            summaryRows.forEach((row, idx) => {
                const y = ry0 + idx * rowGap;
                litText(cv, row[0], 666, y, 17, t.dim);
                litText(cv, row[1], 1026, y, 18, row[2], { align: 'right', font: 'bold' });
            });

            /* ---- 5. Right-Bottom Panel: Network Interfaces & OS ---- */
            const pNet = G.panel(cv, t, 1060, 304, 516, 208, 'Network interfaces');
            const ifCount = sys.activeIf.length;
            litText(cv, ifCount ? ifCount + ' ' + uiPair('active', 'đang mở') : uiPair('Offline', 'Ngoại tuyến'),
                1558, 344, 17, ifCount ? GO : t.dim, { align: 'right', font: 'bold' });

            const maxIfRows = 3 + Math.floor(exB / 32);
            if (!ifCount) {
                litText(cv, uiPair('No active IPv4 interface detected', 'Không phát hiện địa chỉ IPv4 đang hoạt động'),
                    1318, 418 + Math.round(exB * 0.4), 19, t.dim, { align: 'center' });
            } else {
                sys.activeIf.slice(0, maxIfRows).forEach((n, idx) => {
                    const y = 384 + idx * 32;
                    cv.circle(1082, y - 6, 4.5, GO);
                    cv.roundRect(1095, y - 19, 54, 22, 5, withAlpha(t.accent, 0.18));
                    litText(cv, n.kind, 1122, y - 3, 13, t.accent, { align: 'center', font: 'bold' });
                    litText(cv, fitLit(cv, n.name, 18, 140, { font: 'bold' }), 1158, y, 18, t.text, { font: 'bold' });
                    litText(cv, fitLit(cv, n.addresses.join(', '), 18, 245), 1558, y, 18, t.text, { align: 'right' });
                });
                if (ifCount > maxIfRows) {
                    litText(cv, '+' + (ifCount - maxIfRows) + ' ' + uiPair('more', 'khác'), 1558, pNet.y + pNet.h - 42, 15, t.dim, { align: 'right' });
                }
            }
            const netFootY = pNet.y + pNet.h - 18;
            cv.fillRect(1078, netFootY - 23, 480, 1, withAlpha(t.tick, 0.22));
            litText(cv, fitLit(cv, sys.osLabel || 'MGU OS', 16, 300), 1078, netFootY, 16, t.dim);
            litText(cv, uiPair('Read-only · Safe', 'Chỉ đọc · An toàn'), 1558, netFootY, 16, GO, { align: 'right', font: 'bold' });
        }

        function drawApps(cv, t, nowMs, gpuActive) {
            sampleSystem(nowMs);
            const snap = appsMon.sample(nowMs, { gpuActive });
            const lang = getLanguage();

            /* ---- 1. Top Summary Cards + Lag & Crash Advisor ---- */
            G.panel(cv, t, 24, 44, 316, 115, 'Installed on MGU');
            litText(cv, String(snap.appCount + snap.toolCount), 42, 140, 58, t.text, { font: 'num' });
            litText(cv, uiPair(snap.appCount + ' apps · ' + snap.toolCount + ' tools', snap.appCount + ' app · ' + snap.toolCount + ' dịch vụ'),
                322, 111, 17, t.text, { align: 'right', font: 'bold' });
            litText(cv, snap.runningCount + ' ' + uiPair('active now', 'đang chạy'), 322, 139, 17, GO, { align: 'right', font: 'bold' });

            G.panel(cv, t, 356, 44, 396, 115, 'System load');
            const gStats = ctx.display && ctx.display.gpu && ctx.display.gpu.stats;
            const fpsTxt = gStats && gStats.fps > 0 ? gStats.fps + ' FPS' : '60 FPS';
            const gpuHz = sys.gpuMHz || snap.gpuMHz;
            const gpuHead = gpuActive ? (gpuHz ? 'GPU ' + gpuHz + ' MHz · ' + fpsTxt : 'GPU ' + fpsTxt) : uiPair('SOFTWARE', 'PHẦN MỀM');
            litText(cv, gpuHead, 734, 80, 16, gpuActive ? GO : t.dim, { align: 'right', font: 'bold' });

            const cpuV = sys.cpuPct !== null ? Math.round(sys.cpuPct) : null;
            const cpuCol = cpuV === null ? t.dim : cpuV >= 85 ? t.crit : cpuV >= 65 ? t.warn : GO;
            const hasCg = sys.oapUsedMB !== null && sys.oapCapMB !== null && sys.oapCapMB > 0;
            const oapPct = hasCg ? G.clamp(Math.round(sys.oapUsedMB * 100 / sys.oapCapMB), 0, 100) : sys.ramPct;
            const oapCol = oapPct >= 84 ? t.crit : oapPct >= 70 ? t.warn : t.accent;

            litText(cv, 'CPU ' + (cpuV !== null ? cpuV + '%' : '--'), 374, 112, 17, cpuCol, { font: 'bold' });
            litText(cv, hasCg ? ('OAP ' + Math.round(sys.oapUsedMB) + '/' + Math.round(sys.oapCapMB) + ' MB') : ('RAM ' + sys.ramPct + '%'),
                734, 112, 17, oapCol, { align: 'right', font: 'bold' });
            miniBar(cv, t, 374, 119, 166, 6, cpuV || 0, cpuCol);
            miniBar(cv, t, 560, 119, 174, 6, oapPct, oapCol);

            const ramLine = sys.memTotalMB > 0 ? 'RAM ' + Math.round(sys.memUsedMB) + '/' + Math.round(sys.memTotalMB) + ' MB' : 'RAM --';
            const oapNote = snap.oapFailDelta > 0 ? uiPair('OOM hits: ' + snap.oapFailDelta, 'Tràn OAP: ' + snap.oapFailDelta)
                : snap.oapPeakMB ? uiPair('Peak ' + snap.oapPeakMB + 'M', 'Đỉnh ' + snap.oapPeakMB + 'M')
                    : (sys.swapMB !== null ? 'Swap ' + Math.round(sys.swapMB) + 'M' : '');
            litText(cv, ramLine, 374, 144, 16, t.dim);
            if (oapNote) litText(cv, oapNote, 734, 144, 16, snap.oapFailDelta > 0 ? t.crit : t.dim, { align: 'right' });

            G.panel(cv, t, 768, 44, 808, 115, 'Lag & crash advisor');
            const adv = diagnoseHealth(snap, sys, lang);
            const advCol = adv.level === 'crit' ? t.crit : adv.level === 'warn' ? t.warn : GO;
            const bw = Math.max(118, cv.textWidth(adv.badge, 15, { font: 'bold', literal: true }) + 26);
            cv.roundRect(1558 - bw, 58, bw, 26, 6, withAlpha(advCol, 0.2));
            litText(cv, adv.badge, 1558 - bw / 2, 76, 15, advCol, { align: 'center', font: 'bold' });
            litText(cv, fitLit(cv, adv.headline, 18, 772, { font: 'bold' }), 786, 113, 18, t.text, { font: 'bold' });
            litText(cv, fitLit(cv, adv.advice, 17, 772), 786, 141, 17, adv.level === 'ok' ? t.dim : advCol);

            /* ---- 2. Scrollable Installed Apps & Resource Table ---- */
            const p = G.panel(cv, t, 24, 176, 1552, 336, 'MGU apps & resources');
            const panelTitle = translateUI('MGU apps & resources');
            let bx = 42 + cv.textWidth(panelTitle, 26, { font: 'bold', literal: true }) + 22;
            const controls = [
                {
                    label: SORT_LABELS[appSort],
                    key: 'appSort',
                    run: () => { appSort = SORT_ORDER[(SORT_ORDER.indexOf(appSort) + 1) % SORT_ORDER.length]; scroll.apps.y = 0; changed(); },
                },
                {
                    label: FILTER_LABELS[appFilter],
                    key: 'appFilter',
                    run: () => { appFilter = FILTER_ORDER[(FILTER_ORDER.indexOf(appFilter) + 1) % FILTER_ORDER.length]; scroll.apps.y = 0; changed(); },
                },
                {
                    label: 'Refresh',
                    key: 'appRefresh',
                    run: () => {
                        sys.diskCheckedAt = 0;
                        refreshStorage(Date.now());
                        appsMon.sample(Date.now(), { force: true, gpuActive });
                        changed();
                    },
                },
            ];
            controls.forEach((b) => {
                const w = G.button(cv, t, bx, 189, 0, 40, translateUI(b.label), b.run, { key: b.key });
                if (w > 0) bx += w + 10;
            });

            const diskSummary = (snap.measuredDiskBytes > 0 ? uiPair('Pkgs ' + fmtSize(snap.measuredDiskBytes), 'Gói cài ' + fmtSize(snap.measuredDiskBytes)) : '') +
                (sys.diskTotalBytes !== null && sys.diskFreeBytes !== null
                    ? (snap.measuredDiskBytes > 0 ? ' · ' : '') + uiPair(fmtBytes(sys.diskFreeBytes) + ' / ' + fmtBytes(sys.diskTotalBytes) + ' free',
                        'Trống ' + fmtBytes(sys.diskFreeBytes) + ' / ' + fmtBytes(sys.diskTotalBytes))
                    : '');
            if (diskSummary) {
                litText(cv, fitLit(cv, diskSummary, 19, Math.max(200, 1552 - bx - 16)), 1552, 213, 19, t.dim, { align: 'right' });
            }

            // Column headers
            const hdrCol = (key) => (appSort === key ? t.accent : t.dim);
            litText(cv, uiPair('APP / SERVICE', 'ỨNG DỤNG / DỊCH VỤ'), 48, 250, 15, hdrCol('name'), { font: 'bold', spacing: 0.6 });
            litText(cv, uiPair('VERSION', 'PHIÊN BẢN'), 510, 250, 15, t.dim, { font: 'bold', spacing: 0.6 });
            litText(cv, uiPair('STATE · GPU', 'TRẠNG THÁI · GPU'), 668, 250, 15, t.dim, { font: 'bold', spacing: 0.6 });
            litText(cv, 'CPU', 1028, 250, 15, hdrCol('cpu'), { align: 'right', font: 'bold', spacing: 0.6 });
            litText(cv, uiPair('RAM USAGE', 'BỘ NHỚ RAM'), 1304, 250, 15, hdrCol('ram'), { align: 'right', font: 'bold', spacing: 0.6 });
            litText(cv, uiPair('STORAGE', 'DUNG LƯỢNG'), 1536, 250, 15, hdrCol('disk'), { align: 'right', font: 'bold', spacing: 0.6 });
            cv.fillRect(48, 257, 1504, 1, withAlpha(t.tick, 0.35));

            const allRows = viewRows(snap, appFilter, appSort, lang);
            const dy = p.y + p.h - G.BOTTOM;
            if (!allRows.length) {
                litText(cv, uiPair('No matching apps or processes', 'Không có ứng dụng phù hợp bộ lọc'),
                    800, 380 + Math.round(dy / 2), 26, t.dim, { align: 'center' });
                return;
            }

            const rowH = 43;
            const maxNonScroll = 5 + Math.floor(dy / rowH);
            const rows = scrolls ? allRows : allRows.slice(0, maxNonScroll);
            scrolled(cv, t, p, scroll.apps, 'apps', 260, 264, rows.length * rowH - 6, (sy, from, to) => rows.forEach((r, i) => {
                const y = 264 + i * rowH - sy;
                if (y + rowH < from || y > to) return;

                // 1. Kind badge + App / Service name
                const kindInfo = r.kind === 'app'
                    ? { txt: 'APP', col: t.accent }
                    : r.kind === 'tool'
                        ? { txt: uiPair('TOOL', 'DỊCH VỤ'), col: '#3ec7e8' }
                        : { txt: uiPair('CORE', 'HỆ THỐNG'), col: t.dim };
                cv.roundRect(48, y + 5, 70, 24, 5, withAlpha(kindInfo.col, 0.18));
                litText(cv, kindInfo.txt, 83, y + 22, 13, kindInfo.col, { align: 'center', font: 'bold' });

                const nameSuffix = r.self ? uiPair(' (This app)', ' (Đang mở)') : (r.procCount > 1 ? ' ×' + r.procCount : '');
                litText(cv, fitLit(cv, r.title + nameSuffix, 21, 364, { font: 'bold' }), 128, y + 24, 21, r.running ? t.text : t.dim, { font: 'bold' });

                // 2. Version
                const verTxt = !r.version ? '--' : (/^\d/.test(r.version) ? 'v' + r.version : r.version);
                litText(cv, fitLit(cv, verTxt, 18, 144), 510, y + 24, 18, t.dim);

                // 3. State + GPU pill
                let stTxt, stCol, pillOn = true;
                if (r.justRestarted) {
                    stTxt = uiPair('CRASH / RESTART', 'VỪA CRASH');
                    stCol = t.crit;
                } else if (r.memLeakMB >= 24) {
                    stTxt = uiPair('RAM +' + r.memLeakMB + 'M', 'TĂNG +' + r.memLeakMB + 'M');
                    stCol = t.warn;
                } else if (r.pendingReboot) {
                    stTxt = uiPair('NEEDS REBOOT', 'CHỜ REBOOT');
                    stCol = t.warn;
                } else if (r.running && r.gpuTag) {
                    stTxt = r.gpuTag;
                    stCol = r.gpuTag === 'Software' ? t.dim : GO;
                } else if (r.running) {
                    stTxt = uiPair('RUNNING', 'ĐANG CHẠY');
                    stCol = GO;
                } else {
                    stTxt = uiPair('Stopped', 'Đang nghỉ');
                    stCol = t.dim;
                    pillOn = false;
                }
                if (pillOn) {
                    const pw = Math.min(218, Math.max(96, cv.textWidth(stTxt, 15, { font: 'bold', literal: true }) + 22));
                    cv.roundRect(668, y + 4, pw, 26, 6, withAlpha(stCol, 0.18));
                    litText(cv, fitLit(cv, stTxt, 15, pw - 14, { font: 'bold' }), 668 + pw / 2, y + 22, 15, stCol, { align: 'center', font: 'bold' });
                } else {
                    litText(cv, stTxt, 668, y + 23, 17, t.dim);
                }

                // 4. CPU %
                if (r.running && r.cpuPct !== null) {
                    const cCol = r.cpuPct >= 30 ? t.crit : r.cpuPct >= 12 ? t.warn : r.cpuPct >= 1 ? t.text : t.dim;
                    const cTxt = (r.cpuPct >= 10 ? r.cpuPct.toFixed(0) : r.cpuPct.toFixed(1)) + '%';
                    litText(cv, cTxt, 1028, y + 21, 20, cCol, { align: 'right', font: 'bold' });
                    miniBar(cv, t, 964, y + 28, 64, 4, G.clamp(r.cpuPct * 2, 0, 100), cCol);
                } else {
                    litText(cv, '--', 1028, y + 23, 18, t.dim, { align: 'right' });
                }

                // 5. RAM usage (Private own memory + total RSS / Swap)
                if (r.running && r.memBytes > 0) {
                    const ownMB = Math.max(1, Math.round(r.memBytes / 1048576));
                    const rssMB = Math.max(ownMB, Math.round(r.rssBytes / 1048576));
                    const swapMB = Math.round((r.swapBytes || 0) / 1048576);
                    const mCol = (r.kind !== 'system' && ownMB >= 140) ? t.crit : (r.kind !== 'system' && ownMB >= 90) ? t.warn : t.text;
                    const detail = swapMB > 0 ? (ownMB + ' MB · Swap ' + swapMB + 'M') : (ownMB + ' MB · RSS ' + rssMB + 'M');
                    litText(cv, fitLit(cv, detail, 19, 248, { font: 'bold' }), 1304, y + 21, 19, mCol, { align: 'right', font: 'bold' });
                    const barScale = r.kind === 'system' ? 1200 : 220;
                    miniBar(cv, t, 1184, y + 28, 120, 4, G.clamp(ownMB * 100 / barScale, 0, 100), mCol === t.text ? t.accent : mCol);
                } else {
                    litText(cv, '--', 1304, y + 23, 18, t.dim, { align: 'right' });
                }

                // 6. Disk size
                if (r.diskBytes !== null && r.diskBytes > 0) {
                    const dCol = r.diskBytes >= 80 * 1048576 ? t.warn : t.text;
                    litText(cv, fmtSize(r.diskBytes), 1536, y + 23, 19, dCol, { align: 'right', font: 'bold' });
                } else if (r.diskProtected) {
                    litText(cv, uiPair('OAP sandbox', 'Bảo mật OAP'), 1536, y + 23, 16, t.dim, { align: 'right' });
                } else {
                    litText(cv, '--', 1536, y + 23, 18, t.dim, { align: 'right' });
                }

                if (i < rows.length - 1) cv.fillRect(48, y + rowH - 5, 1504, 1, withAlpha(t.tick, 0.22));
            }));
            if (!scrolls && allRows.length > rows.length) {
                litText(cv, '+ ' + (allRows.length - rows.length) + ' ' + uiPair('more', 'khác'), 1536, 506 + dy, 18, t.dim, { align: 'right' });
            }
        }

        let drawn = -1, drawnSec = -1, drawnAppsSlot = -1;
        async function render(force) {
            const nowMs = Date.now();
            const gpuActive = !!(ctx.display && ctx.display.active && ctx.display.active('MAIN'));
            const statusTab = isStatusPage(), appsTab = isAppsPage();
            const curSec = Math.floor(nowMs / 1000), curAppsSlot = Math.floor(nowMs / 2000);
            const liveTick = (statusTab && (gpuActive || curSec !== drawnSec)) || (appsTab && curAppsSlot !== drawnAppsSlot);
            if (!force && drawn === version && !gliding && phase !== 'scanning' && phase !== 'clearing' && !liveTick) return;
            drawn = version;
            if (statusTab) drawnSec = curSec;
            if (appsTab) drawnAppsSlot = curAppsSlot;
            gliding = false;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const fp0 = pageCount() - EXTRA_PAGES;
            scrolls = !!cv.own;
            perPage = PER_PAGE + Math.floor((G.pageBottom(cv) - G.BOTTOM) / 47);
            const fp = pageCount() - EXTRA_PAGES;
            if (fp !== fp0) page = page >= fp0 ? fp + page - fp0 : Math.min(page, fp - 1);
            page = Math.min(page, pageCount() - 1);
            if (page === fp + 2) drawSystem(cv, t, nowMs, gpuActive);
            else if (page === fp + 3) drawApps(cv, t, nowMs, gpuActive);
            else {
                tiles(cv, t);
                if (page < fp) drawFaults(cv, t); else if (page === fp) drawCC(cv, t); else drawEcus(cv, t);
            }
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_SCAN', () => doScan());
        ui.onClick('BTN_CLEAR', () => doClear());
        ui.onClick('BTN_REPORT', () => {
            try {
                const f = writeReport(uiPair('User saved report', 'Người dùng lưu báo cáo'));
                if (f) {
                    setMsg('Diagnostic report saved', 'Đã lưu báo cáo chẩn đoán', { scope: 'page', page, transient: true, ttlMs: 5000 });
                    log.info('report saved: ' + f);
                } else {
                    setMsg('Scan the vehicle before saving a report', 'Hãy quét xe trước khi lưu báo cáo', { scope: 'page', page, transient: true, ttlMs: 5000 });
                }
            } catch (e) {
                const detail = e && e.message ? e.message : String(e);
                setMsg('Could not save report: ' + detail, 'Không lưu được báo cáo: ' + detail, { crit: true, scope: 'page', page, transient: true, ttlMs: 6000 });
                log.warn('report: ' + e);
            }
            changed();
        });
        ctx.hideButton('BTN_SCAN');
        ctx.hideButton('BTN_CLEAR');
        ctx.onLayout(changed);
        const onSwitchPage = (nextPage) => {
            if (nextPage !== page && phase !== 'scanning' && phase !== 'clearing') {
                disarmClear();
                if (msg && msg.transient) setMsg(null);
            }
            page = nextPage;
            changed();
        };
        ui.onClick('BTN_PAGE', () => onSwitchPage((page + 1) % pageCount()));
        ctx.onTab((i) => {
            const fp = pageCount() - EXTRA_PAGES;
            const nextPage = i === 0 && page < fp ? (page + 1) % fp : i === 0 ? 0 : fp + i - 1;
            onSwitchPage(nextPage);
        });

        // 4 fps in software fallback ensures 1-second clock transitions land promptly (<250 ms jitter);
        // GPU renderer paces at up to 60 fps for silky second-hand motion.
        var loop = ctx.loop('MAIN', 4, () => render(false));
        let scannedOnOpen = false;
        const maybeAuto = () => {
            if (scannedOnOpen || !settings.get('autoScan')) return;
            scannedOnOpen = true;
            setTimeout(doScan, 1800);
        };
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) { maybeAuto(); redraw(); } });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        if (ui.isVisible('MAIN')) maybeAuto();
        settings.onChange((key, val) => {
            if (key === 'demo') {
                demoCleared = false;
                if (val === 'off' && scan && scan.demo) {
                    scan = loadSavedScan();
                    if (scan && scan.demo) scan = null;
                } else if (val === 'on' && (!scan || !scan.demo) && !busy) {
                    doScan();
                }
            }
            if (key === 'language') refreshBarLabels();
            changed();
        });
        refreshBarLabels();
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
