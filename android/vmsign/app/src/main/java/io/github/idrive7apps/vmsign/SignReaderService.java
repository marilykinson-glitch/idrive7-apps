package io.github.idrive7apps.vmsign;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Display;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Reads the texts in VietMap Live's windows (its floating speed bubble among them) once a second and
 * at each change there, for Engine to find the sign in. Only windows of a package named "...vietmap..."
 * are read; of the others only the package names are kept, for the screen's list.
 *
 * VietMap's bubble draws its numbers itself (no text for Android to hand over), so each of VietMap's
 * windows is also photographed in turn (Android 14 and later: that window alone, whatever covers it;
 * Android 11 to 13: the screen, cut to the window) and the red-ringed sign in it read (SignOcr).
 *
 * While VietMap shows a window and "keep the screen on" is set, a 1x1 accessibility overlay keeps the
 * screen from going off, since a locked or dark screen shows no bubble to read.
 */
public class SignReaderService extends AccessibilityService {
    static volatile SignReaderService running = null;
    private static final int MAX_NODES = 800;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean scanQueued = false;
    private View keepOn = null;

    // pictures of VietMap's windows: one at a time, one window after the other
    private final ExecutorService ocrThread = Executors.newSingleThreadExecutor();
    private boolean shooting = false;
    private long shotAt = 0;
    private int turn = 0;
    /** window id -> what its last picture held, and when */
    private final Map<Integer, Shot> shots = new HashMap<>();

    private static final class Shot {
        final long at;
        final List<SignOcr.Ring> rings;
        Shot(long at, List<SignOcr.Ring> rings) { this.at = at; this.rings = rings; }
    }

    private final Runnable loop = new Runnable() {
        @Override public void run() {
            scan();
            handler.postDelayed(this, 1000);
        }
    };
    private final Runnable soon = new Runnable() {
        @Override public void run() { scanQueued = false; scan(); }
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        running = this;
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                    | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                    | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                    | AccessibilityEvent.TYPE_WINDOWS_CHANGED;
            info.notificationTimeout = 300;
            setServiceInfo(info);
        }
        CarLink.get(this).start();
        handler.removeCallbacks(loop);
        handler.post(loop);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        if (Engine.isVietMap(event.getPackageName()) && !scanQueued) {
            scanQueued = true;
            handler.postDelayed(soon, 150);
        }
    }

    @Override
    public void onInterrupt() { }

    @Override
    public void onDestroy() {
        ocrThread.shutdownNow();
        handler.removeCallbacksAndMessages(null);
        setKeepOn(false);
        running = null;
        CarLink.get(this).stop();
        super.onDestroy();
    }

    private void scan() {
        List<Engine.Item> items = new ArrayList<>();
        Set<String> pkgs = new LinkedHashSet<>();
        List<int[]> vietmap = new ArrayList<>();          // {window id, left, top, right, bottom}
        StringBuilder note = new StringBuilder();
        List<AccessibilityWindowInfo> windows;
        try { windows = getWindows(); } catch (RuntimeException e) { windows = new ArrayList<>(); }
        for (AccessibilityWindowInfo win : windows) {
            AccessibilityNodeInfo root;
            try { root = win.getRoot(); } catch (RuntimeException e) { root = null; }
            if (root == null) continue;
            CharSequence pkg = root.getPackageName();
            if (pkg != null) pkgs.add(pkg.toString());
            if (Engine.isVietMap(pkg)) {
                int[] count = { 0 };
                int before = items.size();
                // where an item is: the child numbers from its window's root (kept for a pick of an
                // item without a view id; the window's place in the list changes, so it is left out)
                walk(root, pkg.toString(), "r", items, count, 0);
                Rect b = new Rect();
                win.getBoundsInScreen(b);
                vietmap.add(new int[] { win.getId(), b.left, b.top, b.right, b.bottom });
                if (note.length() > 0) note.append('\n');
                note.append("Cửa sổ VietMap #").append(win.getId()).append(": ").append(b.width()).append('x').append(b.height())
                        .append(" · ").append(count[0]).append(" phần tử, ").append(items.size() - before).append(" có chữ");
            }
        }
        Engine.windowsNote = note.toString();
        items.addAll(ocrItems(vietmap));
        Engine.setWindowItems(this, items, pkgs);
        setKeepOn(!vietmap.isEmpty() && Engine.prefs(this).getBoolean("keepOn", true));
        if (!vietmap.isEmpty()) shoot(vietmap);
    }

    /** The rings read in the last pictures of the windows still there: the biggest is the sign. */
    private List<Engine.Item> ocrItems(List<int[]> vietmap) {
        long now = SystemClock.uptimeMillis();
        List<SignOcr.Ring> all = new ArrayList<>();
        Set<Integer> ids = new LinkedHashSet<>();
        for (int[] w : vietmap) ids.add(w[0]);
        synchronized (shots) {
            java.util.Iterator<Map.Entry<Integer, Shot>> it = shots.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<Integer, Shot> e = it.next();
                if (!ids.contains(e.getKey() / 2)) { it.remove(); continue; }
                if (now - e.getValue().at < 4000) all.addAll(e.getValue().rings);
            }
        }
        java.util.Collections.sort(all, new java.util.Comparator<SignOcr.Ring>() {
            @Override public int compare(SignOcr.Ring a, SignOcr.Ring b) { return b.size() - a.size(); }
        });
        List<Engine.Item> out = new ArrayList<>();
        for (int i = 0; i < all.size(); i++) {
            SignOcr.Ring r = all.get(i);
            String text = r.number > 0 ? String.valueOf(r.number) : (r.text.length() > 0 ? r.text : "?");
            out.add(new Engine.Item("vn.vietmap.live", null, text, i == 0 ? Engine.OCR_SIGN : "ocr:ring" + (i + 1)));
        }
        return out;
    }

    /**
     * One picture, the two ways in turn: the next VietMap window alone (Android 14+), and the screen
     * cut to VietMap's windows (Android 11+). Whichever finds the sign counts.
     */
    private void shoot(List<int[]> vietmap) {
        long now = SystemClock.uptimeMillis();
        if (shooting || now - shotAt < 700 || Build.VERSION.SDK_INT < 30) {
            if (Build.VERSION.SDK_INT < 30) Engine.ocrNote = "Đọc hình biển cần Android 11 trở lên";
            return;
        }
        shooting = true;
        shotAt = now;
        boolean windowTurn = Build.VERSION.SDK_INT >= 34 && (turn++ % 2 == 0);
        try {
            if (windowTurn) {
                final int[] w = vietmap.get((turn / 2) % vietmap.size());
                takeScreenshotOfWindow(w[0], ocrThread, callback(java.util.Collections.singletonList(w), true));
            } else {
                takeScreenshot(Display.DEFAULT_DISPLAY, ocrThread, callback(vietmap, false));
            }
        } catch (RuntimeException e) {
            shooting = false;
            setNote(windowTurn, "không chụp được: " + e.getMessage());
        }
    }

    private static void setNote(boolean windowOnly, String note) {
        if (windowOnly) Engine.ocrNote = "Chụp cửa sổ: " + note;
        else Engine.ocrNote2 = "Chụp màn hình: " + note;
    }

    private TakeScreenshotCallback callback(final List<int[]> wins, final boolean windowOnly) {
        return new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult result) {
                try {
                    HardwareBuffer hb = result.getHardwareBuffer();
                    Bitmap hw = Bitmap.wrapHardwareBuffer(hb, result.getColorSpace());
                    Bitmap pic = hw == null ? null : hw.copy(Bitmap.Config.ARGB_8888, false);
                    hb.close();
                    if (pic == null) { done(windowOnly, "ảnh rỗng"); return; }
                    StringBuilder sb = new StringBuilder();
                    for (int[] w : wins) {
                        Bitmap part = pic;
                        if (!windowOnly) {
                            Rect r = new Rect(w[1], w[2], w[3], w[4]);
                            if (!r.intersect(0, 0, pic.getWidth(), pic.getHeight()) || r.width() < 8 || r.height() < 8) continue;
                            part = Bitmap.createBitmap(pic, r.left, r.top, r.width(), r.height());
                        }
                        List<SignOcr.Ring> rings = SignOcr.read(part);
                        synchronized (shots) { shots.put(w[0] * 2 + (windowOnly ? 0 : 1), new Shot(SystemClock.uptimeMillis(), rings)); }
                        if (windowOnly) Engine.windowShot = SignOcr.thumbnail(part); else Engine.screenShot = SignOcr.thumbnail(part);
                        if (sb.length() > 0) sb.append(" · ");
                        sb.append("#").append(w[0]).append(' ').append(part.getWidth()).append('x').append(part.getHeight())
                                .append(", ").append(SignOcr.stats(part)).append(": ").append(rings.size()).append(" vòng đỏ");
                        for (SignOcr.Ring r : rings) sb.append(r.number > 0 ? " [" + r.number + "]" : " [?" + r.text.replace('\n', ' ') + "]");
                    }
                    done(windowOnly, sb.length() > 0 ? sb.toString() : "cửa sổ nằm ngoài màn hình");
                } catch (RuntimeException e) {
                    done(windowOnly, "lỗi đọc hình: " + e.getMessage());
                }
            }

            @Override public void onFailure(int errorCode) {
                done(windowOnly, errorCode == ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT ? null : "không chụp được (mã " + errorCode + ")");
            }
        };
    }

    /** On the main thread: the next picture may go, and what was read counts at once. */
    private void done(final boolean windowOnly, final String note) {
        handler.post(new Runnable() {
            @Override public void run() {
                shooting = false;
                if (note != null) setNote(windowOnly, note);
                if (!scanQueued) { scanQueued = true; handler.post(soon); }
            }
        });
    }

    private void walk(AccessibilityNodeInfo n, String pkg, String where, List<Engine.Item> out, int[] count, int depth) {
        if (n == null || count[0] >= MAX_NODES || depth > 40) return;
        count[0]++;
        CharSequence text = n.getText(), desc = n.getContentDescription();
        String id = n.getViewIdResourceName();
        String cls = n.getClassName() == null ? "" : n.getClassName().toString();
        int dot = cls.lastIndexOf('.');
        String place = where + "/" + (dot >= 0 ? cls.substring(dot + 1) : cls);
        if (text != null && text.length() > 0) out.add(new Engine.Item(pkg, id, text.toString(), place));
        if (desc != null && desc.length() > 0 && (text == null || !desc.toString().contentEquals(text))) {
            out.add(new Engine.Item(pkg, id == null ? null : id + "#desc", desc.toString(), place + "#desc"));
        }
        int k = n.getChildCount();
        for (int i = 0; i < k; i++) {
            AccessibilityNodeInfo c;
            try { c = n.getChild(i); } catch (RuntimeException e) { c = null; }
            walk(c, pkg, where + "/" + i, out, count, depth + 1);
        }
    }

    /** The 1x1 overlay that keeps the screen on while VietMap shows a window. */
    private void setKeepOn(boolean on) {
        if (on == (keepOn != null)) return;
        WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        if (wm == null) return;
        try {
            if (on) {
                View v = new View(this);
                WindowManager.LayoutParams lp = new WindowManager.LayoutParams(1, 1,
                        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                        PixelFormat.TRANSLUCENT);
                lp.gravity = Gravity.TOP | Gravity.START;
                wm.addView(v, lp);
                keepOn = v;
            } else {
                wm.removeView(keepOn);
                keepOn = null;
            }
        } catch (RuntimeException e) {
            keepOn = null;
        }
    }

    /** From the screen: the keep-on setting changed. */
    static void refresh() {
        SignReaderService s = running;
        if (s != null) s.handler.post(s.soon);
    }
}
