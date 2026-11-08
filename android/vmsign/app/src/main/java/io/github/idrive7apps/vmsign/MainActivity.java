package io.github.idrive7apps.vmsign;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;
import java.util.Locale;

/**
 * The one screen: the permissions it needs, VietMap's sign as read now, the car's answer, test signs,
 * the settings, and everything read in VietMap's windows, where a tap picks the item that is the sign.
 */
public class MainActivity extends Activity {
    /** While this screen shows, the screen is never made dark. */
    static volatile boolean visible = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView a11y, notif, battery, sign, signSrc, car, link, pkgs, diag;
    private ImageView shotWindow, shotScreen;
    private TextView dimState;
    private Bitmap shownWindow, shownScreen;
    private Button a11yBtn, notifBtn, batteryBtn;
    private LinearLayout itemsBox;
    private String itemsSig = "";

    private static final int GREEN = Color.parseColor("#2FD27A");
    private static final int AMBER = Color.parseColor("#E0A030");
    private static final int DIM = Color.parseColor("#9AA4B0");
    private static final int RED = Color.parseColor("#D71920");

    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            render();
            handler.postDelayed(this, 500);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int p = dp(16);
        root.setPadding(p, p, p, p * 3);
        scroll.addView(root);
        setContentView(scroll);

        root.addView(text("VietMap Signs", 24, true, Color.WHITE));
        root.addView(text("Biển tốc độ của VietMap Live lên đồng hồ và HUD BMW · " + Engine.VERSION, 14, false, DIM));

        // 1. permissions
        root.addView(header("1. Quyền"));
        a11y = text("", 15, false, Color.WHITE);
        root.addView(a11y);
        a11yBtn = button("Mở Trợ năng", new View.OnClickListener() {
            @Override public void onClick(View v) { open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
        });
        root.addView(a11yBtn);
        root.addView(text("Trong Trợ năng: Ứng dụng đã tải xuống → VietMap Signs → Bật. Nếu bị chặn (\"cài đặt bị hạn chế\"): "
                + "Cài đặt → Ứng dụng → VietMap Signs → ⋮ (góc trên) → Cho phép cài đặt bị hạn chế, rồi bật lại.", 13, false, DIM));
        notif = text("", 15, false, Color.WHITE);
        root.addView(notif);
        notifBtn = button("Quyền đọc thông báo (không bắt buộc)", new View.OnClickListener() {
            @Override public void onClick(View v) { open(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")); }
        });
        root.addView(notifBtn);
        battery = text("", 15, false, Color.WHITE);
        root.addView(battery);
        batteryBtn = button("Không giới hạn pin", new View.OnClickListener() {
            @Override public void onClick(View v) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                if (!open(i)) open(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            }
        });
        root.addView(batteryBtn);
        root.addView(button("Cài đặt ứng dụng (Xiaomi: bật Tự khởi chạy)", new View.OnClickListener() {
            @Override public void onClick(View v) {
                open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            }
        }));

        // 2. VietMap's sign
        root.addView(header("2. Biển VietMap đọc được"));
        sign = text("–", 56, true, Color.WHITE);
        sign.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(sign);
        signSrc = text("", 14, false, DIM);
        root.addView(signSrc);

        // 3. the car
        root.addView(header("3. Xe"));
        car = text("", 15, false, Color.WHITE);
        root.addView(car);
        link = text("", 13, false, DIM);
        root.addView(link);
        LinearLayout tests = new LinearLayout(this);
        tests.setOrientation(LinearLayout.HORIZONTAL);
        for (final int n : new int[] { 50, 80, 120 }) {
            tests.addView(button("Thử " + n, new View.OnClickListener() {
                @Override public void onClick(View v) { test(n); }
            }), weight());
        }
        tests.addView(button("Dừng thử", new View.OnClickListener() {
            @Override public void onClick(View v) { test(0); }
        }), weight());
        root.addView(tests);
        root.addView(text("Biển thử hiện 15 giây (cần Waze on cluster đang hiện bản đồ Google Maps trên đồng hồ).", 13, false, DIM));

        // 4. settings
        root.addView(header("4. Cài đặt"));
        CheckBox keep = new CheckBox(this);
        keep.setText("Giữ màn hình sáng khi VietMap đang mở (bong bóng chỉ đọc được khi màn hình sáng và không khoá)");
        keep.setChecked(Engine.prefs(this).getBoolean("keepOn", true));
        keep.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton b, boolean on) {
                Engine.prefs(MainActivity.this).edit().putBoolean("keepOn", on).apply();
                SignReaderService.refresh();
            }
        });
        root.addView(keep);
        CheckBox dark = new CheckBox(this);
        dark.setText("Màn hình tối khi đã nối xe: cả màn hình đen, độ sáng thấp nhất, chỉ chừa bong bóng VietMap "
                + "(chạm nút ☼ mờ để mở lại 2 phút). Đừng bấm nút nguồn: khoá máy là ngừng đọc.");
        dark.setChecked(Engine.prefs(this).getBoolean("dim", true));
        dark.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton b, boolean on) {
                Engine.prefs(MainActivity.this).edit().putBoolean("dim", on).apply();
                SignReaderService.refresh();
            }
        });
        root.addView(dark);
        dimState = text("", 13, false, DIM);
        root.addView(dimState);
        root.addView(text("IP của xe (để trống: tự dò)", 14, false, DIM));
        LinearLayout ipRow = new LinearLayout(this);
        ipRow.setOrientation(LinearLayout.HORIZONTAL);
        final EditText ip = new EditText(this);
        ip.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        ip.setHint(CarLink.DEFAULT_CAR);
        ip.setText(Engine.prefs(this).getString("carIp", ""));
        ip.setSingleLine(true);
        ipRow.addView(ip, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 2f));
        ipRow.addView(button("Lưu", new View.OnClickListener() {
            @Override public void onClick(View v) {
                Engine.prefs(MainActivity.this).edit().putString("carIp", ip.getText().toString().trim()).apply();
                CarLink.get(MainActivity.this).sendNow();
            }
        }), weight());
        root.addView(ipRow);

        // 5. what is read in VietMap
        root.addView(header("5. Chữ đọc được trong VietMap"));
        root.addView(text("App tự đọc số trong biển vòng đỏ của VietMap (dòng \"hình biển vòng đỏ lớn nhất\"). "
                + "Nếu nó đọc nhầm, bấm vào dòng có SỐ CỦA BIỂN để chọn cố định; bấm lại để bỏ chọn.", 13, false, DIM));
        itemsBox = new LinearLayout(this);
        itemsBox.setOrientation(LinearLayout.VERTICAL);
        root.addView(itemsBox);
        pkgs = text("", 12, false, DIM);
        root.addView(pkgs);
        diag = text("", 12, false, DIM);
        root.addView(diag);
        shotWindow = new ImageView(this);
        root.addView(text("Ảnh màn hình cắt theo cửa sổ VietMap:", 12, false, DIM));
        shotScreen = new ImageView(this);
        shotScreen.setAdjustViewBounds(true);
        shotScreen.setBackgroundColor(Color.parseColor("#404040"));
        root.addView(shotScreen);
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        SignReaderService.refresh();
        handler.removeCallbacks(refresh);
        handler.post(refresh);
    }

    @Override
    protected void onPause() {
        visible = false;
        SignReaderService.refresh();
        handler.removeCallbacks(refresh);
        super.onPause();
    }

    private void test(int n) {
        Engine.testLimit = n;
        Engine.testUntil = n > 0 ? System.currentTimeMillis() + 15000 : 0;
        CarLink.get(this).sendNow();
    }

    private void render() {
        long now = System.currentTimeMillis();
        boolean a11yOn = enabled(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        boolean running = SignReaderService.running != null;
        a11y.setText("Đọc VietMap (Trợ năng): " + (running ? "đang chạy" : a11yOn ? "đã bật, chưa chạy" : "CHƯA BẬT"));
        a11y.setTextColor(running ? GREEN : AMBER);
        a11yBtn.setVisibility(running ? View.GONE : View.VISIBLE);
        boolean notifOn = enabled("enabled_notification_listeners");
        notif.setText("Đọc thông báo VietMap: " + (notifOn ? "đã bật" : "tắt (không bắt buộc)"));
        notif.setTextColor(notifOn ? GREEN : DIM);
        notifBtn.setVisibility(notifOn ? View.GONE : View.VISIBLE);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        boolean free = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        battery.setText("Pin: " + (free ? "không giới hạn" : "đang bị tối ưu (có thể bị tắt khi chạy nền)"));
        battery.setTextColor(free ? GREEN : AMBER);
        batteryBtn.setVisibility(free ? View.GONE : View.VISIBLE);

        int n = Engine.limit;
        sign.setText(n > 0 ? String.valueOf(n) : "–");
        sign.setTextColor(n > 0 ? RED : DIM);
        String key = Engine.pickedKey(this);
        if (Engine.testing()) signSrc.setText("Đang gửi biển thử " + Engine.testLimit);
        else if (n > 0) signSrc.setText("Từ " + Engine.source + (Engine.picked ? " (bạn đã chọn)" : " (tự nhận)"));
        else if (key.length() > 0) signSrc.setText("Dòng đã chọn đang không có số (VietMap chưa hiện biển?)");
        else signSrc.setText("Chưa thấy biển trong VietMap (mở VietMap cho bong bóng hiện biển)");

        if (Engine.carAddr != null && now - Engine.ackAt < 5000) {
            String shown = Engine.carShown.length() > 0 ? "đang hiện trên " + Engine.carShown : "chưa hiện: " + Engine.why(Engine.carWhy);
            car.setText("Đã nối xe " + Engine.carAddr + " (helper " + Engine.carVersion + ") · " + shown);
            car.setTextColor(Engine.carShown.length() > 0 ? GREEN : Color.WHITE);
        } else if (Engine.carAddr != null) {
            car.setText("Mất liên lạc với xe " + Engine.carAddr + " (" + ago(now - Engine.ackAt) + ")");
            car.setTextColor(AMBER);
        } else {
            car.setText("Chưa thấy xe. Cần: xe đã cài VietMap signs từ mgu Store, điện thoại nối Wi-Fi của xe (Android Auto không dây) hoặc xe bắt hotspot của điện thoại.");
            car.setTextColor(AMBER);
        }
        link.setText(Engine.linkNote);

        renderItems(key);
        renderDiag();
        dimState.setText(Engine.dimNote);
    }

    private void renderItems(String key) {
        List<Engine.Item> items = Engine.allItems();
        StringBuilder sig = new StringBuilder(key).append('\n');
        for (Engine.Item it : items) sig.append(it.key()).append('=').append(it.text).append('\n');
        String s = sig.toString();
        if (s.equals(itemsSig)) return;
        itemsSig = s;
        itemsBox.removeAllViews();
        if (items.isEmpty()) {
            itemsBox.addView(text(SignReaderService.running == null ? "(Trợ năng chưa chạy)" : "(Chưa đọc được gì trong VietMap)", 14, false, DIM));
        }
        for (final Engine.Item it : items) {
            boolean sel = it.key().equals(key);
            String label = (sel ? "✔ " : "") + it.text.replace('\n', ' ') + "\n   " + it.shortId() + (it.number > 0 ? "  · số " + it.number : "");
            TextView row = text(label, 14, sel, sel ? GREEN : it.number > 0 ? Color.WHITE : DIM);
            row.setPadding(dp(8), dp(8), dp(8), dp(8));
            row.setBackgroundColor(sel ? Color.parseColor("#1F3A2A") : Color.parseColor("#1A1E24"));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = dp(4);
            row.setLayoutParams(lp);
            row.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    Engine.pick(MainActivity.this, it.key().equals(Engine.pickedKey(MainActivity.this)) ? "" : it.key());
                    itemsSig = "";
                    render();
                }
            });
            itemsBox.addView(row);
        }
        StringBuilder ps = new StringBuilder();
        synchronized (Engine.LOCK) {
            for (String p : Engine.packages) { if (ps.length() > 0) ps.append(", "); ps.append(p); }
        }
        pkgs.setText(ps.length() > 0 ? "Cửa sổ đang mở: " + ps : "");
    }

    private void renderDiag() {
        String w = Engine.windowsNote, o = Engine.ocrNote;
        String o2 = Engine.ocrNote2;
        diag.setText((w.length() > 0 ? w : "Chưa thấy cửa sổ VietMap") + (o.length() > 0 ? "\n" + o : "") + (o2.length() > 0 ? "\n" + o2 : ""));
        Bitmap a = Engine.windowShot, b = Engine.screenShot;
        if (a != shownWindow) { shownWindow = a; shotWindow.setImageBitmap(a); }
        if (b != shownScreen) { shownScreen = b; shotScreen.setImageBitmap(b); }
    }

    private boolean enabled(String setting) {
        String s = Settings.Secure.getString(getContentResolver(), setting);
        return s != null && s.toLowerCase(Locale.ROOT).contains(getPackageName().toLowerCase(Locale.ROOT) + "/");
    }

    private boolean open(Intent i) {
        try { startActivity(i); return true; } catch (Exception e) { return false; }
    }

    private static String ago(long ms) {
        long s = ms / 1000;
        return s < 60 ? s + " giây trước" : (s / 60) + " phút trước";
    }

    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

    private TextView text(String s, float sp, boolean bold, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(2), 0, dp(2));
        return t;
    }

    private TextView header(String s) {
        TextView t = text(s, 18, true, Color.WHITE);
        t.setPadding(0, dp(20), 0, dp(6));
        return t;
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        return b;
    }

    private static LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }
}
