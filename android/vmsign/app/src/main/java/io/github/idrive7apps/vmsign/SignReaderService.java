package io.github.idrive7apps.vmsign;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Reads the texts in VietMap Live's windows (its floating speed bubble among them) once a second and
 * at each change there, for Engine to find the sign in. Only windows of a package named "...vietmap..."
 * are read; of the others only the package names are kept, for the screen's list.
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
        handler.removeCallbacksAndMessages(null);
        setKeepOn(false);
        running = null;
        CarLink.get(this).stop();
        super.onDestroy();
    }

    private void scan() {
        List<Engine.Item> items = new ArrayList<>();
        Set<String> pkgs = new LinkedHashSet<>();
        boolean vietmapShown = false;
        List<AccessibilityWindowInfo> windows;
        try { windows = getWindows(); } catch (RuntimeException e) { windows = new ArrayList<>(); }
        for (AccessibilityWindowInfo win : windows) {
            AccessibilityNodeInfo root;
            try { root = win.getRoot(); } catch (RuntimeException e) { root = null; }
            if (root == null) continue;
            CharSequence pkg = root.getPackageName();
            if (pkg != null) pkgs.add(pkg.toString());
            if (Engine.isVietMap(pkg)) {
                vietmapShown = true;
                int[] count = { 0 };
                // where an item is: the child numbers from its window's root (kept for a pick of an
                // item without a view id; the window's place in the list changes, so it is left out)
                walk(root, pkg.toString(), "r", items, count, 0);
            }
        }
        Engine.setWindowItems(this, items, pkgs);
        setKeepOn(vietmapShown && Engine.prefs(this).getBoolean("keepOn", true));
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
