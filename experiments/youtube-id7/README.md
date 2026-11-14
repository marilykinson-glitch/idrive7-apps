# YouTube khi đỗ xe cho BMW iDrive 7

Bản vá 0.3.9 dựa trên [RideTube](https://github.com/JustAnotherPU/ridetube), GPL-3.0-or-later, commit `63364945d85344071dda0821464c4822372001e7`. Giữ nguyên giấy phép và thông báo bản quyền khi phát hành. Bản vá đổi tên và một số mục menu sang tiếng Việt. Phần phát video yêu cầu xe đứng yên và có tín hiệu tốc độ hợp lệ, cập nhật trong 5 giây.

## Đưa lên GitHub và MGU Store

1. Fork RideTube vào tài khoản GitHub của mày. Trong checkout của fork, kiểm tra và áp dụng bản vá bằng `git apply --check youtube-id7.patch` rồi `git apply youtube-id7.patch`. Commit và push.
2. Làm theo mục [Build and test](https://github.com/JustAnotherPU/ridetube#build-and-test-on-a-computer) để build app và dịch vụ phát video. RideTube yêu cầu bản SDK trích từ app BMW của xe cho bước build. Giữ SDK ngoài GitHub.
3. Tạo catalog bằng `python3 tools/release.py --base https://github.com/marilykinson-glitch/ridetube/releases/download/catalog/` nếu tên fork là `ridetube`. Upload nội dung `dist/release/` vào GitHub Release có tag `catalog`.
4. Trong MGU Store, thêm `marilykinson-glitch/ridetube` và chọn **Releases**. Giữ nguồn `JustAnotherPU/mgu-apps` ở **Releases** để Store lấy `jap-node22`.

Bản vá giữ ID `jap_ridetube`, nên Store coi nó là một bản cập nhật của RideTube nếu xe đã cài RideTube gốc. Đã kiểm tra cú pháp, áp dụng thử bản vá và mô phỏng điều kiện hiện video. Chưa build gói ID7 hoặc thử phát trên xe.
