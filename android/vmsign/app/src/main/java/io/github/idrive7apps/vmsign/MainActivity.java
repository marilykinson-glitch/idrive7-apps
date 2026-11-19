package io.github.idrive7apps.vmsign;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.view.accessibility.AccessibilityManager;
import android.accessibilityservice.AccessibilityServiceInfo;
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
 * The one screen, in cards from what matters most down:
 *   the state (VietMap's sign as read now, the car), what is still to do (only while something is),
 *   pairing with the car (the 6-digit code the car's app shows), test signs, options, and, hidden
 *   until asked, the technical detail (everything read in VietMap's windows, where a tap picks the
 *   item that is the sign, and the pictures).
 */
public class MainActivity extends Activity {
    /** While this screen shows, the screen is never made dark. */
    static volatile boolean visible = false;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private static final int BG = Color.parseColor("#0F1216");
    private static final int CARD = Color.parseColor("#1A1F26");
    private static final int LINE = Color.parseColor("#2A313B");
    private static final int GREEN = Color.parseColor("#2FD27A");
    private static final int AMBER = Color.parseColor("#E0A030");
    private static final int DIM = Color.parseColor("#9AA4B0");
    private static final int RED = Color.parseColor("#D71920");
    private static final int BLUE = Color.parseColor("#4FA3FF");

    private TextView signNum, vmLine, carLine, linkLine;
    private View vmDot, carDot;
    private LinearLayout todo, todoList;
    private TextView pairState;
    private EditText codeIn;
    private LinearLayout pairCard;
    private TextView dimState;
    private LinearLayout details, itemsBox;
    private Button detailsBtn;
    private TextView pkgs, diag;
    private ImageView shotScreen;
    private Bitmap shownScreen;
    private String itemsSig = "", todoSig = "";
    private ScrollView scroll;
    /** When this screen came to the front: the reader is given a few seconds to start before it counts as not running. */
    private long resumedAt = 0;

    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            render();
            handler.postDelayed(this, 500);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG);
        scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(14), dp(18), dp(14), dp(40));
        scroll.addView(root);
        setContentView(scroll);

        root.addView(text(getString(R.string.app_name), 23, true, Color.WHITE));
        TextView sub = text("Biển tốc độ VietMap Live lên đồng hồ và HUD BMW · " + Engine.VERSION, 13, false, DIM);
        sub.setPadding(0, 0, 0, dp(6));
        root.addView(sub);

        // --- the state: the sign as read, VietMap, the car ---
        LinearLayout now = card(root, null);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        now.addView(row);
        signNum = new TextView(this);
        signNum.setGravity(Gravity.CENTER);
        signNum.setTypeface(Typeface.DEFAULT_BOLD);
        signNum.setTextSize(34);
        GradientDrawable ring = new GradientDrawable();
        ring.setShape(GradientDrawable.OVAL);
        ring.setColor(Color.WHITE);
        // not red: the reader takes red rings on the screen for VietMap's sign, and this screen can be in its picture
        ring.setStroke(dp(9), Color.parseColor("#5A6573"));
        signNum.setBackground(ring);
        row.addView(signNum, new LinearLayout.LayoutParams(dp(104), dp(104)));
        LinearLayout lines = new LinearLayout(this);
        lines.setOrientation(LinearLayout.VERTICAL);
        lines.setPadding(dp(16), 0, 0, 0);
        row.addView(lines, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        vmDot = dot();
        vmLine = text("", 15, false, Color.WHITE);
        lines.addView(dotRow(vmDot, "VietMap", vmLine));
        carDot = dot();
        carLine = text("", 15, false, Color.WHITE);
        lines.addView(dotRow(carDot, "Xe", carLine));
        linkLine = text("", 12, false, DIM);
        now.addView(linkLine);

        // --- what is still to do (hidden once all is done) ---
        todo = card(root, "Cần làm");
        todoList = new LinearLayout(this);
        todoList.setOrientation(LinearLayout.VERTICAL);
        todo.addView(todoList);

        // --- pairing ---
        pairCard = card(root, "Ghép đôi với xe");
        pairCard.addView(text("Trên màn hình xe: mở app Biển báo VietMap → tab Ghép đôi. Nhập 6 số ở đó vào đây. "
                + "Xe chỉ nhận biển từ điện thoại có đúng mã.", 13, false, DIM));
        LinearLayout codeRow = new LinearLayout(this);
        codeRow.setOrientation(LinearLayout.HORIZONTAL);
        codeRow.setGravity(Gravity.CENTER_VERTICAL);
        codeRow.setPadding(0, dp(8), 0, 0);
        codeIn = new EditText(this);
        codeIn.setInputType(InputType.TYPE_CLASS_NUMBER);
        codeIn.setFilters(new InputFilter[] { new InputFilter.LengthFilter(6) });
        codeIn.setTextSize(28);
        codeIn.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        codeIn.setLetterSpacing(0.3f);
        codeIn.setGravity(Gravity.CENTER);
        codeIn.setTextColor(Color.WHITE);
        codeIn.setHintTextColor(LINE);
        codeIn.setHint("000000");
        codeIn.setSingleLine(true);
        codeIn.setText(Engine.pairCode(this));
        codeRow.addView(codeIn, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        final Button save = primary("Lưu", new View.OnClickListener() {
            @Override public void onClick(View v) { saveCode(); }
        });
        codeRow.addView(save, new LinearLayout.LayoutParams(dp(96), ViewGroup.LayoutParams.WRAP_CONTENT));
        pairCard.addView(codeRow);
        codeIn.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) { save.setEnabled(s.length() == 6 || s.length() == 0); }
        });
        pairState = text("", 14, false, DIM);
        pairState.setPadding(0, dp(6), 0, 0);
        pairCard.addView(pairState);

        // --- test signs ---
        LinearLayout test = card(root, "Thử trên đồng hồ");
        LinearLayout tests = new LinearLayout(this);
        tests.setOrientation(LinearLayout.HORIZONTAL);
        for (final int n : new int[] { 50, 80, 120 }) {
            tests.addView(button(String.valueOf(n), new View.OnClickListener() {
                @Override public void onClick(View v) { test(n); }
            }), weight());
        }
        tests.addView(button("Dừng", new View.OnClickListener() {
            @Override public void onClick(View v) { test(0); }
        }), weight());
        test.addView(tests);
        test.addView(text("Biển thử hiện 15 giây. Cần Waze on cluster đang hiện bản đồ trên đồng hồ.", 12, false, DIM));

        // --- options ---
        LinearLayout opts = card(root, "Tuỳ chọn");
        opts.addView(check("Giữ màn hình sáng khi VietMap đang mở", "keepOn",
                "Bong bóng VietMap chỉ đọc được khi màn hình sáng và không khoá."));
        opts.addView(check("Màn hình tối khi đã nối xe", "dim",
                "Cả màn hình đen, độ sáng thấp nhất, chỉ chừa bong bóng VietMap (chạm nút ☼ mờ để mở lại 2 phút). "
                        + "Đừng bấm nút nguồn: khoá máy là ngừng đọc."));
        dimState = text("", 12, false, DIM);
        opts.addView(dimState);

        opts.addView(button("Quyền đọc thông báo VietMap (không bắt buộc)", new View.OnClickListener() {
            @Override public void onClick(View v) { open(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")); }
        }));
        opts.addView(button("Cài đặt ứng dụng (Xiaomi: bật Tự khởi chạy)", new View.OnClickListener() {
            @Override public void onClick(View v) {
                open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            }
        }));

        // --- technical detail, hidden until asked ---
        detailsBtn = button("Nâng cao & chi tiết kỹ thuật ▾", new View.OnClickListener() {
            @Override public void onClick(View v) {
                boolean show = details.getVisibility() != View.VISIBLE;
                details.setVisibility(show ? View.VISIBLE : View.GONE);
                detailsBtn.setText(show ? "Ẩn nâng cao & chi tiết ▴" : "Nâng cao & chi tiết kỹ thuật ▾");
            }
        });
        LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dl.topMargin = dp(14);
        root.addView(detailsBtn, dl);
        details = card(root, "Chữ đọc được trong VietMap");
        details.setVisibility(View.GONE);
        details.addView(text("App tự đọc số trong biển vòng đỏ của VietMap (dòng \"hình biển vòng đỏ lớn nhất\"). "
                + "Nếu nó đọc nhầm, bấm vào dòng có SỐ CỦA BIỂN để chọn cố định; bấm lại để bỏ chọn.", 12, false, DIM));
        itemsBox = new LinearLayout(this);
        itemsBox.setOrientation(LinearLayout.VERTICAL);
        details.addView(itemsBox);
        pkgs = text("", 12, false, DIM);
        details.addView(pkgs);
        diag = text("", 12, false, DIM);
        details.addView(diag);
        details.addView(text("Ảnh màn hình cắt theo cửa sổ VietMap:", 12, false, DIM));
        shotScreen = new ImageView(this);
        shotScreen.setAdjustViewBounds(true);
        shotScreen.setBackgroundColor(Color.parseColor("#404040"));
        details.addView(shotScreen);
        details.addView(text("Địa chỉ IP của xe (thường không cần)", 14, true, Color.WHITE));
        details.addView(text("App tự tìm xe trên Wi-Fi. Chỉ điền khi dòng Xe ở trên cứ báo \"Chưa thấy xe\" dù điện thoại "
                + "đã nối Wi-Fi của xe: điền IP của đầu xe trên mạng đó (Wi-Fi của xe thường là " + CarLink.DEFAULT_CAR + "). Để trống là tự dò.", 12, false, DIM));
        LinearLayout ipRow = new LinearLayout(this);
        ipRow.setOrientation(LinearLayout.HORIZONTAL);
        final EditText ip = new EditText(this);
        ip.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        ip.setHint(CarLink.DEFAULT_CAR);
        ip.setTextColor(Color.WHITE);
        ip.setHintTextColor(LINE);
        ip.setText(Engine.prefs(this).getString("carIp", ""));
        ip.setSingleLine(true);
        ipRow.addView(ip, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        ipRow.addView(button("Lưu", new View.OnClickListener() {
            @Override public void onClick(View v) {
                Engine.prefs(MainActivity.this).edit().putString("carIp", ip.getText().toString().trim()).apply();
                hideKeyboard(ip);
                CarLink.get(MainActivity.this).sendNow();
            }
        }), new LinearLayout.LayoutParams(dp(96), ViewGroup.LayoutParams.WRAP_CONTENT));
        details.addView(ipRow);
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        resumedAt = System.currentTimeMillis();
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

    private void saveCode() {
        String c = codeIn.getText().toString().trim();
        if (c.length() != 0 && !c.matches("\\d{6}")) return;
        Engine.prefs(this).edit().putString("pairCode", c).apply();
        Engine.carPaired = null;          // not known for the new code until the car answers
        hideKeyboard(codeIn);
        CarLink.get(this).sendNow();
        render();
    }

    private void test(int n) {
        Engine.testLimit = n;
        Engine.testUntil = n > 0 ? System.currentTimeMillis() + 15000 : 0;
        CarLink.get(this).sendNow();
    }

    private void render() {
        long now = System.currentTimeMillis();
        boolean a11yOn = enabled(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) || bound();
        boolean running = SignReaderService.running != null;
        // turned on but not (yet) running: the system starts it a moment after the app; only after a few
        // seconds is that a problem (the phone stopped it: off and on again in Accessibility fixes it)
        boolean starting = a11yOn && !running && now - resumedAt < 6000;
        boolean stuck = a11yOn && !running && !starting;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        boolean free = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        String code = Engine.pairCode(this);
        boolean carSeen = Engine.carAddr != null && now - Engine.ackAt < 5000;
        boolean wrong = carSeen && Boolean.FALSE.equals(Engine.carPaired);

        // the sign
        int n = Engine.outgoing();
        signNum.setText(n > 0 ? String.valueOf(n) : "–");
        signNum.setTextColor(n > 0 ? Color.BLACK : DIM);
        signNum.setAlpha(n > 0 ? 1f : 0.45f);
        String key = Engine.pickedKey(this);
        if (starting) set(vmDot, vmLine, DIM, "Đang khởi động trình đọc…");
        else if (!running) set(vmDot, vmLine, AMBER, a11yOn ? "Trợ năng đã bật nhưng không chạy" : "Chưa bật quyền đọc VietMap");
        else if (Engine.testing()) set(vmDot, vmLine, BLUE, "Đang gửi biển thử " + Engine.testLimit);
        else if (Engine.limit > 0) set(vmDot, vmLine, GREEN, "Đang đọc biển " + Engine.limit + (Engine.picked ? " (dòng bạn chọn)" : ""));
        else if (key.length() > 0) set(vmDot, vmLine, DIM, "Dòng đã chọn chưa có số");
        else set(vmDot, vmLine, DIM, "Chưa thấy biển (mở VietMap Live)");

        // the car
        if (wrong) set(carDot, carLine, RED, "Xe báo sai mã ghép đôi");
        else if (carSeen) {
            String shown = Engine.carShown.length() > 0 ? "đang hiện trên " + Engine.carShown : "chưa hiện: " + Engine.why(Engine.carWhy);
            set(carDot, carLine, Engine.carShown.length() > 0 ? GREEN : Color.WHITE, "Đã nối · " + shown);
        } else if (Engine.carAddr != null) set(carDot, carLine, AMBER, "Mất liên lạc (" + ago(now - Engine.ackAt) + ")");
        else set(carDot, carLine, AMBER, "Chưa thấy xe");
        String ln = carSeen ? "Xe " + Engine.carAddr + " · trợ thủ " + Engine.carVersion : Engine.linkNote;
        if (!carSeen && Engine.carAddr == null) ln = (ln.length() > 0 ? ln + "\n" : "")
                + "Cần: điện thoại nối Wi-Fi của xe (Android Auto không dây) hoặc xe bắt hotspot của điện thoại.";
        linkLine.setText(ln);

        // what is still to do
        StringBuilder sig = new StringBuilder();
        if (!a11yOn) sig.append('a');
        else if (stuck) sig.append('s');
        if (!free) sig.append('b');
        if (code.length() == 0 || wrong) sig.append(wrong ? 'w' : 'c');
        String ts = sig.toString();
        if (!ts.equals(todoSig)) {
            todoSig = ts;
            todoList.removeAllViews();
            if (stuck) todoItem("Trợ năng đã bật nhưng không chạy",
                    "Điện thoại đã dừng trình đọc (hay gặp sau khi cập nhật app hoặc khi máy tiết kiệm pin). Trong Trợ năng: "
                            + "tắt " + getString(R.string.app_name) + " rồi bật lại. Đặt Pin: Không giới hạn để khỏi bị dừng nữa.",
                    "Mở Trợ năng", new View.OnClickListener() {
                        @Override public void onClick(View v) { open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
                    });
            if (!a11yOn) todoItem("Bật quyền Trợ năng cho app",
                    "Trợ năng → Ứng dụng đã tải xuống → " + getString(R.string.app_name) + " → Bật. Nếu bị chặn (\"cài đặt bị hạn chế\"): "
                            + "Cài đặt → Ứng dụng → " + getString(R.string.app_name) + " → ⋮ → Cho phép cài đặt bị hạn chế.",
                    "Mở Trợ năng", new View.OnClickListener() {
                        @Override public void onClick(View v) { open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
                    });
            if (!free) todoItem("Cho chạy nền không giới hạn pin", "Để Android không tắt app khi đang lái.",
                    "Không giới hạn pin", new View.OnClickListener() {
                        @Override public void onClick(View v) {
                            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                            if (!open(i)) open(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                        }
                    });
            if (code.length() == 0 || wrong) todoItem(wrong ? "Mã ghép đôi chưa đúng" : "Nhập mã ghép đôi của xe",
                    "Mã 6 số ở tab Ghép đôi của app Biển báo VietMap trên màn hình xe.",
                    "Nhập mã", new View.OnClickListener() {
                        @Override public void onClick(View v) {
                            scroll.smoothScrollTo(0, pairCard.getTop());
                            codeIn.requestFocus();
                            InputMethodManager im = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                            if (im != null) im.showSoftInput(codeIn, InputMethodManager.SHOW_IMPLICIT);
                        }
                    });
            todo.setVisibility(ts.length() > 0 ? View.VISIBLE : View.GONE);
        }

        // pairing
        if (code.length() == 0) set(null, pairState, AMBER, "Chưa nhập mã");
        else if (wrong) set(null, pairState, RED, "Xe báo sai mã. Xem lại mã ở tab Ghép đôi trên màn hình xe.");
        else if (carSeen && Boolean.TRUE.equals(Engine.carPaired)) set(null, pairState, GREEN, "✓ Đã ghép đôi với xe");
        else if (carSeen) set(null, pairState, DIM, "Trợ thủ trên xe bản cũ: cập nhật Biển báo VietMap trong mgu Store");
        else set(null, pairState, DIM, "Đã lưu mã · chờ xe trả lời");

        dimState.setText(Engine.dimNote);
        if (details.getVisibility() == View.VISIBLE) {
            renderItems(key);
            renderDiag();
        }
    }

    private void todoItem(String title, String note, String action, View.OnClickListener l) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, dp(6), 0, dp(6));
        box.addView(text("• " + title, 15, true, AMBER));
        box.addView(text(note, 12, false, DIM));
        box.addView(primary(action, l));
        todoList.addView(box);
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
            row.setBackground(rounded(sel ? Color.parseColor("#1F3A2A") : Color.parseColor("#232A33"), 8));
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
        Bitmap b = Engine.screenShot;
        if (b != shownScreen) { shownScreen = b; shotScreen.setImageBitmap(b); }
    }

    /** The system lists the reader among the accessibility services it has on (another way to ask than the setting). */
    private boolean bound() {
        try {
            AccessibilityManager am = (AccessibilityManager) getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (am == null) return false;
            for (AccessibilityServiceInfo i : am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)) {
                if (i != null && i.getResolveInfo() != null && i.getResolveInfo().serviceInfo != null
                        && getPackageName().equals(i.getResolveInfo().serviceInfo.packageName)) return true;
            }
        } catch (RuntimeException e) { /* not known */ }
        return false;
    }

    private boolean enabled(String setting) {
        String s = Settings.Secure.getString(getContentResolver(), setting);
        return s != null && s.toLowerCase(Locale.ROOT).contains(getPackageName().toLowerCase(Locale.ROOT) + "/");
    }

    private boolean open(Intent i) {
        try { startActivity(i); return true; } catch (Exception e) { return false; }
    }

    private void hideKeyboard(View v) {
        InputMethodManager im = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (im != null) im.hideSoftInputFromWindow(v.getWindowToken(), 0);
        v.clearFocus();
    }

    private static String ago(long ms) {
        long s = ms / 1000;
        return s < 60 ? s + " giây trước" : (s / 60) + " phút trước";
    }

    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(radiusDp));
        return g;
    }

    /** A card under root, with its title (or none); its content goes into the returned box. */
    private LinearLayout card(LinearLayout root, String title) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(16), dp(14), dp(16), dp(14));
        c.setBackground(rounded(CARD, 14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        root.addView(c, lp);
        if (title != null) {
            TextView t = text(title, 17, true, Color.WHITE);
            t.setPadding(0, 0, 0, dp(6));
            c.addView(t);
        }
        return c;
    }

    private View dot() {
        View d = new View(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(DIM);
        d.setBackground(g);
        return d;
    }

    private LinearLayout dotRow(View dot, String label, TextView value) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(0, dp(4), 0, dp(4));
        LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(dp(10), dp(10));
        dl.rightMargin = dp(10);
        r.addView(dot, dl);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(text(label, 12, false, DIM));
        col.addView(value);
        r.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return r;
    }

    private void set(View dot, TextView t, int color, String s) {
        t.setText(s);
        t.setTextColor(color == DIM || color == Color.WHITE ? color : color == BLUE ? Color.WHITE : color);
        if (dot != null) ((GradientDrawable) dot.getBackground()).setColor(color == Color.WHITE ? DIM : color);
    }

    private CheckBox check(String label, final String pref, String note) {
        CheckBox c = new CheckBox(this);
        c.setText(label + "\n" + note);
        c.setTextColor(Color.WHITE);
        c.setTextSize(14);
        c.setPadding(dp(4), dp(6), 0, dp(6));
        c.setChecked(Engine.prefs(this).getBoolean(pref, true));
        c.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton b, boolean on) {
                Engine.prefs(MainActivity.this).edit().putBoolean(pref, on).apply();
                SignReaderService.refresh();
            }
        });
        return c;
    }

    private TextView text(String s, float sp, boolean bold, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(2), 0, dp(2));
        return t;
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setBackground(rounded(LINE, 10));
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        lp.rightMargin = dp(4);
        b.setLayoutParams(lp);
        return b;
    }

    private Button primary(String label, View.OnClickListener l) {
        Button b = button(label, l);
        b.setBackground(rounded(Color.parseColor("#1E6FD9"), 10));
        b.setTypeface(Typeface.DEFAULT_BOLD);
        return b;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.rightMargin = dp(6);
        return lp;
    }
}
