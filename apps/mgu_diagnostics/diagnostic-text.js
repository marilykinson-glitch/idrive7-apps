'use strict';
// Never apply the instrument/UI word-replacement dictionary to diagnostic prose.
const path = require('path');
const { getLanguage, dict, plural } = require('./kit/i18n');
let db = null;
// A few live vehicle strings from MGU7 are not present in the bundled BMW text catalog.
// Keep these exact-match translations here; unknown diagnostic prose still falls back verbatim.
const KNOWN_VI = {
    'garage door opener: lin-slave unexpected': 'Bộ mở cửa gara: thiết bị phụ LIN phản hồi ngoài dự kiến.',
    'nfc reader, inside, front: not present': 'Đầu đọc NFC phía trước bên trong: không hiện diện.',
    'hu-h: bluetooth connection function restricted': 'HU-H: Chức năng kết nối Bluetooth bị giới hạn.',
    'hu-h: ethernet: unexpected establishment of communication': 'HU-H: Ethernet tự thiết lập kết nối ngoài dự kiến.',
    'hu-h: bluetooth audio browsing function limited': 'HU-H: Chức năng duyệt âm thanh qua Bluetooth bị giới hạn.',
    'hu-h: fault in secure ethernet communication occurred': 'HU-H: Đã xảy ra lỗi truyền thông Ethernet bảo mật.',
    'debug mode active (ssh open)': 'Đang bật chế độ gỡ lỗi (SSH đang mở).',
    'hu-h: theft-proofing initialisation was not started': 'HU-H: Chưa khởi chạy quá trình chống trộm.',
    'ihka control panel: fault internal to unit': 'Bảng điều khiển IHKA: lỗi nội bộ bộ điều khiển.',
    'speaker illumination: light source 1 at lin bus has detected a fault': 'Đèn trang trí loa: phát hiện lỗi ở đèn số 1 trên bus LIN.',
    'speaker illumination: light source 6 at lin bus has detected a fault': 'Đèn trang trí loa: phát hiện lỗi ở đèn số 6 trên bus LIN.',
    'audio amplifier (booster): wrong configuration': 'Bộ khuếch đại âm thanh (booster): cấu hình không đúng.',
    'microphone: microphone driver is not calibrated': 'Micro: bộ điều khiển micro chưa được hiệu chỉnh.',
    'front right speaker output lines: disconnected line': 'Loa trước bên phải: dây tín hiệu đầu ra bị đứt.',
    'tweeter, rear left 2, speaker output lines: cable interruption': 'Tweeter sau bên trái số 2: dây tín hiệu đầu ra bị đứt.',
    'tweeter, rear right 2, speaker output lines: cable interruption': 'Tweeter sau bên phải số 2: dây tín hiệu đầu ra bị đứt.',
    'tweeter, rear left, speaker output lines: cable interruption': 'Tweeter sau bên trái: dây tín hiệu đầu ra bị đứt.'
};
function diagnosticText(value) {
    const source = String(value == null ? '' : value);
    const language = getLanguage();
    const exactKey = source.trim().replace(/[.]$/, '').toLowerCase();
    if (language === 'vi' && Object.prototype.hasOwnProperty.call(KNOWN_VI, exactKey)) return KNOWN_VI[exactKey];
    const ambiguous = /^(\d+) possible texts \(depends on unit type\)$/.exec(source);
    if (ambiguous && language === 'zh-CN') return ambiguous[1] + ' 个候选说明（取决于单元型号）';
    if (ambiguous && language !== 'en') {
        const n = Number(ambiguous[1]);
        return n + ' ' + plural(n, 'possible texts (depends on unit type)', 'possible texts (depends on unit type)');
    }
    if ((language === 'zh-CN' || language === 'ru' || language === 'vi') && !db) db = require('./kit/pack').open(path.join(__dirname, 'diagnostic_i18n'));
    if (language === 'vi') return db.get('vi.json', source) || dict[source] || 'Mô tả gốc: ' + source;
    return !db ? source : db.get(language + '.json', source) || dict[source] || source;
}
module.exports = { diagnosticText };
