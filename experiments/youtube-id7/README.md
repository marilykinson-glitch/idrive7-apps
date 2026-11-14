# YouTube 0.3.9 cho BMW iDrive 7

App đã được tích hợp vào `mgu-repo.json` trên nhánh `main`. Store tự build bằng SDK trên xe; không cần trích SDK hoặc build bằng máy tính.

## Cài trong MGU Store

1. Giữ nguồn `marilykinson-glitch/idrive7-apps` ở nhánh **main** và làm mới nguồn.
2. Thêm `JustAnotherPU/ridetube:releases` để lấy dịch vụ `jap-ridetube-d` và `JustAnotherPU/mgu-apps:releases` để lấy `jap-node22`. Giữ các nguồn mặc định của Store để lấy `mgu-render` và `mgu-inputgate`.
3. Trong nguồn của mày, chọn **YouTube khi đỗ xe 0.3.9** và bấm **Install**. Chọn bản trong nguồn này, không cài app RideTube từ nguồn gốc trước.

Mã nguồn nằm ở `vendor/ridetube`, dựa trên RideTube commit `63364945d85344071dda0821464c4822372001e7`, giữ giấy phép GPL-3.0-or-later và các thông báo bản quyền. Bản vá Việt hóa menu chính và yêu cầu tốc độ hợp lệ bằng 0, cập nhật trong 5 giây, để hiện video. Khi di chuyển chỉ còn âm thanh.

Đã thử đóng gói bằng SDK giả dành riêng cho kiểm tra cấu trúc và kiểm tra cú pháp JavaScript. SDK giả và các gói kiểm tra không được đưa lên GitHub; khi cài thật, Store cung cấp SDK từ xe. Chưa thử cài hoặc phát video trên G30 LCI thực tế. Chưa có hỗ trợ xuất riêng ra màn hình sau BMW.
