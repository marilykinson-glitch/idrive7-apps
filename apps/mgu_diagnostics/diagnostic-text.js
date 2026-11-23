'use strict';
// Never apply the instrument/UI word-replacement dictionary to diagnostic prose.
const path = require('path');
const { getLanguage, dict, plural } = require('./kit/i18n');
let db = null;
let reverseVi = null;
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
// A few vehicle services return the already-localized Vietnamese text instead of the
// English diagnostic catalog key. Build a conservative exact reverse index so English
// mode can still show the canonical diagnostic wording without guessing word by word.
function englishSource(value) {
    if (!reverseVi) {
        reverseVi = Object.create(null);
        const locale = require('./kit/locale.json');
        const strings = locale.strings || {};
        Object.keys(strings).forEach((english) => {
            const vietnamese = strings[english];
            if (typeof vietnamese !== 'string' || english.indexOf('|') >= 0 || vietnamese.indexOf('|') >= 0 || vietnamese.length < 5) return;
            const key = vietnamese.trim().replace(/[.]$/, '').toLowerCase();
            if (!reverseVi[key] && /^[\x00-\x7f]+$/.test(english)) reverseVi[key] = english;
        });
        Object.keys(KNOWN_VI).forEach((english) => {
            const key = KNOWN_VI[english].trim().replace(/[.]$/, '').toLowerCase();
            reverseVi[key] = english;
        });
    }
    const key = String(value).trim().replace(/[.]$/, '').toLowerCase();
    return reverseVi[key] || null;
}
function diagnosticText(value) {
    const source = String(value == null ? '' : value);
    const language = getLanguage();
    const exactKey = source.trim().replace(/[.]$/, '').toLowerCase();
    const english = englishSource(source);
    // If the head unit has already localized a vehicle message, don't prefix it as
    // an unknown original, and translate it back to the catalog wording in English.
    if (english && language === 'en') return english;
    if (english && language === 'vi') return source;
    // Do not leave an untranslated Vietnamese sentence visible in English mode.
    // Vehicle text is diagnostic detail, so make the missing catalog entry explicit;
    // the DTC/Check Control identifier remains visible beside it.
    if (language === 'en' && /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(source)) {
        return 'Vietnamese vehicle message (English translation unavailable)';
    }
    if (language === 'vi' && Object.prototype.hasOwnProperty.call(KNOWN_VI, exactKey)) return KNOWN_VI[exactKey];
    const ambiguous = /^(\d+) possible texts \(depends on unit type\)$/.exec(source);
    if (ambiguous && language === 'zh-CN') return ambiguous[1] + ' 个候选说明（取决于单元型号）';
    if (ambiguous && language !== 'en') {
        const n = Number(ambiguous[1]);
        return n + ' ' + plural(n, 'possible texts (depends on unit type)', 'possible texts (depends on unit type)');
    }
    if ((language === 'zh-CN' || language === 'ru' || language === 'vi') && !db) db = require('./kit/pack').open(path.join(__dirname, 'diagnostic_i18n'));
    const lookup = english || source;
    if (language === 'vi') return db.get('vi.json', lookup) || dict[lookup] || (english ? source : 'Mô tả gốc: ' + source);
    return !db ? lookup : db.get(language + '.json', lookup) || dict[lookup] || lookup;
}
module.exports = { diagnosticText };
