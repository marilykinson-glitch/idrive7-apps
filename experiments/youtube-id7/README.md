# YouTube 0.3.10 • Tiếng Việt cho BMW iDrive 7

App được tích hợp vào `mgu-repo.json` trên nhánh `main`. Store tự build bằng SDK trên xe.

## Cài trong MGU Store

1. Làm mới nguồn `marilykinson-glitch/idrive7-apps` nhánh **main**.
2. Giữ nguồn `marilykinson-glitch/ridetube:releases` cho dịch vụ `jap-ridetube-d` và `marilykinson-glitch/mgu-apps:releases` cho `jap-node22`. Giữ nguồn mặc định cho `mgu-render` và `mgu-inputgate`.
3. Chọn **YouTube • Tiếng Việt 0.3.10**, bấm **Update** hoặc **Install**.

Nguồn `marilykinson-glitch/ridetube:releases` cũng cung cấp gói app tiếng Việt đã đóng gói sẵn, cùng ID và phiên bản. Không cần cài cả hai bản.

## Việt hóa

Việt hóa giao diện tìm kiếm, đăng nhập, thư viện, kênh, trình phát, thiết lập và các thông báo thường gặp. Dùng Noto Sans với đầy đủ dấu tiếng Việt, chuẩn hóa Unicode NFC và chỉnh chữ menu vừa ô. Giữ nguyên tên video, kênh, danh sách phát do YouTube cung cấp.

Dựa trên RideTube commit `63364945d85344071dda0821464c4822372001e7`, giữ giấy phép GPL-3.0-or-later và thông báo bản quyền. Giữ các chức năng phát, tìm kiếm, đăng nhập, danh sách phát, chất lượng video và SponsorBlock. Giữ điều kiện video chỉ hiện khi tốc độ hợp lệ bằng 0, cập nhật trong 5 giây; khi di chuyển chỉ còn âm thanh. Chưa hỗ trợ xuất riêng ra màn hình sau BMW.

Kiểm tra tự động nằm trong repo `marilykinson-glitch/ridetube`: bộ kiểm tra ứng dụng từ upstream và kiểm tra glyph, Unicode NFC/NFD, độ rộng menu, bản dịch thông báo. CI bỏ SDK giả trước khi phát hành; bản cài dùng SDK từ xe. Bản 0.3.10 chưa được xác nhận chạy trên xe thực tế.
