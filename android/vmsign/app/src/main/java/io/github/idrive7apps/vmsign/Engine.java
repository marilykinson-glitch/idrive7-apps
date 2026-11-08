package io.github.idrive7apps.vmsign;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What the app knows, shared by the services, the car link and the screen, and the choice of the
 * number that is VietMap's speed-limit sign.
 *
 * The accessibility service lists the texts in VietMap Live's windows (its speed bubble among them)
 * and the red-ringed numbers in pictures of them, the notification reader those of VietMap's
 * notifications. The sign is the number in the item the user picked on the screen (by package and
 * view id), or, before a pick, the one item whose view id names a limit, or the biggest red-ringed
 * number in VietMap's windows.
 */
final class Engine {
    static final String VERSION = "0.2.0";
    /** The biggest red-ringed number in VietMap's windows (SignOcr): the sign, when no line is picked. */
    static final String OCR_SIGN = "ocr:sign";
    static final String PREFS = "vmsign";

    /** One text in VietMap's windows or notifications. */
    static final class Item {
        final String pkg, id, text, where;
        final int number;
        Item(String pkg, String id, String text, String where) {
            this.pkg = pkg == null ? "" : pkg;
            this.id = id == null ? "" : id;
            this.text = text == null ? "" : text;
            this.where = where == null ? "" : where;
            this.number = numberIn(this.text);
        }
        /** The key a pick is kept by: the package and the view id (or where it is, without one). */
        String key() { return pkg + "|" + (id.length() > 0 ? id : where); }
        String shortId() {
            if (OCR_SIGN.equals(where)) return "hình biển vòng đỏ lớn nhất";
            if (where.startsWith("ocr:ring")) return "hình vòng đỏ thứ " + where.substring(8);
            String s = id.length() > 0 ? id : where;
            int i = s.indexOf(":id/");
            return i >= 0 ? s.substring(i + 4) : s;
        }
    }

    static final Object LOCK = new Object();
    static List<Item> windowItems = Collections.emptyList();
    static List<Item> notifItems = Collections.emptyList();
    static Set<String> packages = new LinkedHashSet<>();
    static long scanAt = 0;

    static volatile int limit = 0;            // VietMap's sign now, 0: none
    static volatile String source = "";       // where it came from
    static volatile boolean picked = false;   // from the user's pick (else guessed)

    // the car's answers (CarLink)
    static volatile String carAddr = null;
    static volatile long ackAt = 0;
    static volatile String carWhy = "";
    static volatile String carShown = "";
    static volatile String carVersion = "";
    static volatile String linkNote = "";

    // what the screen shows about VietMap's windows and their pictures
    static volatile String windowsNote = "";
    static volatile String ocrNote = "";

    // a test sign from the screen
    static volatile int testLimit = 0;
    static volatile long testUntil = 0;

    private static final Pattern NUMBER = Pattern.compile("(?<![0-9])([0-9]{1,3})(?![0-9])");
    private static final Pattern HINT = Pattern.compile("limit|max|sign|bien|bienbao|gioihan|gioi_han|maxspeed|speedlimit|speed_limit|toc_?do_?toi_?da", Pattern.CASE_INSENSITIVE);
    private static final Pattern NOT_LIMIT = Pattern.compile("current|cur_|curspeed|my_?speed|real|gps|distance|km_left|time|clock", Pattern.CASE_INSENSITIVE);

    /** A speed-limit number in the text: 5 to 150 km/h in steps of 5, the only number there. */
    static int numberIn(String text) {
        if (text == null) return 0;
        Matcher m = NUMBER.matcher(text);
        int found = 0, count = 0;
        while (m.find()) {
            count++;
            if (count > 1) return 0;
            found = Integer.parseInt(m.group(1));
        }
        return found >= 5 && found <= 150 && found % 5 == 0 ? found : 0;
    }

    static boolean isVietMap(CharSequence pkg) {
        return pkg != null && pkg.toString().toLowerCase(Locale.ROOT).contains("vietmap");
    }

    static SharedPreferences prefs(Context c) { return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static String pickedKey(Context c) { return prefs(c).getString("pick", ""); }
    static void pick(Context c, String key) { prefs(c).edit().putString("pick", key == null ? "" : key).apply(); update(c); }

    static List<Item> allItems() {
        synchronized (LOCK) {
            List<Item> all = new ArrayList<>(windowItems);
            all.addAll(notifItems);
            return all;
        }
    }

    static void setWindowItems(Context c, List<Item> items, Set<String> pkgs) {
        synchronized (LOCK) {
            windowItems = items;
            packages = pkgs;
            scanAt = System.currentTimeMillis();
        }
        update(c);
    }

    static void setNotifItems(Context c, List<Item> items) {
        synchronized (LOCK) { notifItems = items; }
        update(c);
    }

    /** The sign from what is seen now, and to the car with it. */
    static void update(Context c) {
        String key = pickedKey(c);
        List<Item> all = allItems();
        int n = 0;
        String src = "";
        boolean byPick = false;
        if (key.length() > 0) {
            for (Item it : all) {
                if (it.key().equals(key) && it.number > 0) { n = it.number; src = it.shortId(); byPick = true; break; }
            }
        } else {
            // without a pick only an item whose view id names a limit counts: the bubble's other
            // number (the speed you drive) must never show as a sign
            List<Item> hinted = new ArrayList<>();
            for (Item it : all) {
                if (it.number <= 0 || !isVietMap(it.pkg)) continue;
                String id = it.id + " " + it.where;
                if (NOT_LIMIT.matcher(id).find()) continue;
                if (HINT.matcher(id).find()) hinted.add(it);
            }
            Item best = hinted.size() > 0 ? hinted.get(0) : null;
            if (best == null) {
                for (Item it : all) { if (OCR_SIGN.equals(it.where) && it.number > 0) { best = it; break; } }
            }
            if (best != null) { n = best.number; src = best.shortId(); }
        }
        limit = n;
        source = src;
        picked = byPick;
        CarLink.get(c).wake();
    }

    /** What goes to the car: a test sign while one runs, else VietMap's. */
    static int outgoing() {
        if (testLimit > 0 && System.currentTimeMillis() < testUntil) return testLimit;
        return limit;
    }
    static boolean testing() { return testLimit > 0 && System.currentTimeMillis() < testUntil; }

    /** The car's reasons, in Vietnamese. */
    static String why(String w) {
        if (w == null || w.length() == 0) return "";
        switch (w) {
            case "off in the app": return "đang Tắt trong app VietMap signs trên xe";
            case "no phone yet": return "xe chưa nhận được gì";
            case "the phone stopped sending": return "xe không còn nhận được";
            case "no sign in VietMap": return "chưa có biển";
            case "BMW shows its own sign": return "BMW đang hiện biển của xe (ưu tiên)";
            case "cluster-render is not installed": return "trên xe chưa cài cluster-render (Waze on cluster)";
            case "Waze on cluster is not installed": return "trên xe chưa cài Waze on cluster";
            case "Waze on cluster shows no map there": return "đồng hồ chưa hiện bản đồ (mở Google Maps trên Android Auto)";
            default: return w;
        }
    }

    private Engine() { }
}
