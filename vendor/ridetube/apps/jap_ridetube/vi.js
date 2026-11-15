'use strict';
// Display-only formatting. Never translate video/channel titles or protocol values.
const errors = {
    'search offline': 'Không kết nối được tìm kiếm. Kiểm tra Internet trên xe.',
    'feed offline': 'Không tải được danh sách video. Kiểm tra Internet trên xe.',
    'signed out': 'Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.',
    'empty search': 'Nhập từ khóa để tìm kiếm.',
    'bad channel': 'Kênh không hợp lệ.',
    'bad id': 'Video không hợp lệ.',
    'video failed, audio only': 'Không phát được hình ảnh; âm thanh vẫn tiếp tục.',
    'access_denied': 'Yêu cầu đăng nhập bị từ chối.',
    'expired_token': 'Mã đăng nhập đã hết hạn. Lấy mã mới để thử lại.',
    'timeout': 'Kết nối quá thời gian chờ.',
    'error': 'Có lỗi xảy ra'
};
function error(value) {
    const s = String(value || '');
    if (errors[s]) return errors[s];
    if (s.indexOf('video incomplete: ') === 0) return 'Video tải chưa hoàn tất: ' + s.slice(18);
    if (s.indexOf('internal error: ') === 0) return 'Lỗi dịch vụ: ' + s.slice(16);
    return s;
}
const headings = { 'Recommended': 'Đề xuất', 'Recommended for you': 'Đề xuất cho bạn', 'Continue watching': 'Xem tiếp', 'Watch later': 'Xem sau', 'Recently uploaded': 'Mới tải lên', 'Latest': 'Mới nhất', 'Popular videos': 'Video phổ biến', 'Videos': 'Video', 'Subscriptions': 'Kênh đăng ký', 'Live': 'Trực tiếp', 'Shorts': 'Shorts' };
function heading(value) { return headings[value] || value; }
function metadata(value) {
    return String(value || '').replace(/\bviews\b/g, 'lượt xem')
        .replace(/\b(\d+)\s+(second|minute|hour|day|week|month|year)s? ago\b/g, (_, n, unit) => n + ' ' + ({second:'giây',minute:'phút',hour:'giờ',day:'ngày',week:'tuần',month:'tháng',year:'năm'})[unit] + ' trước');
}
module.exports = { error, heading, metadata };
