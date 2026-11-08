package io.github.idrive7apps.vmsign;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Rect;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The speed-limit sign in a picture of one of VietMap's windows: a red ring (the sign's border) with a
 * number inside, read on the phone with ML Kit's text recognition (bundled, offline). VietMap's
 * bubble draws its numbers itself, so they are not text Android can hand over; the picture is.
 * The speed you drive is never in a red ring, so it is never taken for the sign.
 * Runs on the caller's thread (not the main one): it waits for the recognizer.
 */
final class SignOcr {
    /** One ring found: where, and the number read in it (0: none). */
    static final class Ring {
        final Rect box;
        final int number;
        final String text;
        Ring(Rect box, int number, String text) { this.box = box; this.number = number; this.text = text; }
        int size() { return Math.max(box.width(), box.height()); }
    }

    private static TextRecognizer recognizer;
    private static synchronized TextRecognizer recognizer() {
        if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        return recognizer;
    }

    /** Every red ring in the picture, the biggest first, with what is written in it. */
    static List<Ring> read(Bitmap picture) {
        List<Ring> out = new ArrayList<>();
        for (Rect box : rings(picture)) {
            if (out.size() >= 3) break;
            String text = recognize(inside(picture, box));
            out.add(new Ring(box, number(text), text == null ? "" : text));
        }
        return out;
    }

    /** Red rings: red, roughly round and square, not red in the middle. Biggest first. */
    static List<Rect> rings(Bitmap b) {
        int w = b.getWidth(), h = b.getHeight();
        List<Rect> found = new ArrayList<>();
        if (w < 16 || h < 16 || (long) w * h > 4_000_000L) return found;
        int[] px = new int[w * h];
        b.getPixels(px, 0, w, 0, 0, w, h);
        boolean[] red = new boolean[w * h];
        for (int i = 0; i < px.length; i++) {
            int c = px[i];
            int a = c >>> 24, r = (c >> 16) & 255, g = (c >> 8) & 255, bl = c & 255;
            red[i] = isRed(a, r, g, bl);
        }
        boolean[] seen = new boolean[w * h];
        int[] stack = new int[w * h];
        for (int start = 0; start < px.length; start++) {
            if (!red[start] || seen[start]) continue;
            int sp = 0, count = 0, minX = w, maxX = -1, minY = h, maxY = -1;
            stack[sp++] = start;
            seen[start] = true;
            while (sp > 0) {
                int p = stack[--sp];
                int x = p % w, y = p / w;
                count++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (x > 0 && red[p - 1] && !seen[p - 1]) { seen[p - 1] = true; stack[sp++] = p - 1; }
                if (x < w - 1 && red[p + 1] && !seen[p + 1]) { seen[p + 1] = true; stack[sp++] = p + 1; }
                if (y > 0 && red[p - w] && !seen[p - w]) { seen[p - w] = true; stack[sp++] = p - w; }
                if (y < h - 1 && red[p + w] && !seen[p + w]) { seen[p + w] = true; stack[sp++] = p + w; }
            }
            int bw = maxX - minX + 1, bh = maxY - minY + 1;
            if (count < 40 || Math.min(bw, bh) < 20) continue;
            float aspect = (float) bw / bh;
            if (aspect < 0.8f || aspect > 1.25f) continue;
            float fill = (float) count / (bw * bh);
            int cx = minX + bw / 2, cy = minY + bh / 2;
            if (red[cy * w + cx] || fill < 0.10f || fill > 0.65f) continue;
            found.add(new Rect(minX, minY, maxX + 1, maxY + 1));
        }
        Collections.sort(found, new Comparator<Rect>() {
            @Override public int compare(Rect a, Rect b2) { return b2.width() * b2.height() - a.width() * a.height(); }
        });
        return found;
    }

    static boolean isRed(int a, int r, int g, int b) {
        return a > 64 && r >= 120 && r - g >= 50 && r - b >= 40;
    }

    /** For the screen: how much of the picture is red, and how much see-through. */
    static String stats(Bitmap b) {
        int w = b.getWidth(), h = b.getHeight();
        int step = Math.max(1, (int) Math.sqrt((double) w * h / 40000));
        int n = 0, red = 0, clear = 0;
        long sr = 0, sg = 0, sb = 0;
        for (int y = 0; y < h; y += step) {
            for (int x = 0; x < w; x += step) {
                int c = b.getPixel(x, y);
                int a = c >>> 24, r = (c >> 16) & 255, g = (c >> 8) & 255, bl = c & 255;
                n++;
                if (a < 32) { clear++; continue; }
                sr += r; sg += g; sb += bl;
                if (isRed(a, r, g, bl)) red++;
            }
        }
        int solid = Math.max(1, n - clear);
        return "đỏ " + (100 * red / Math.max(1, n)) + "%, trong suốt " + (100 * clear / Math.max(1, n)) + "%, màu TB "
                + (sr / solid) + "/" + (sg / solid) + "/" + (sb / solid);
    }

    /** A small copy for the screen. */
    static Bitmap thumbnail(Bitmap b) {
        int w = b.getWidth(), h = b.getHeight();
        float k = Math.min(1f, 480f / Math.max(w, h));
        return k >= 1f ? b.copy(Bitmap.Config.ARGB_8888, false)
                : Bitmap.createScaledBitmap(b, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)), true);
    }

    /** The disc inside the ring, black on white, scaled up for the recognizer, with a white margin. */
    static Bitmap inside(Bitmap src, Rect ring) {
        int inset = Math.round(Math.max(ring.width(), ring.height()) * 0.15f);
        Rect r = new Rect(ring.left + inset, ring.top + inset, ring.right - inset, ring.bottom - inset);
        if (r.width() < 4 || r.height() < 4) r = new Rect(ring);
        Bitmap crop = Bitmap.createBitmap(src, r.left, r.top, r.width(), r.height());
        int th = 160, tw = Math.max(8, Math.round(r.width() * (160f / r.height())));
        Bitmap big = Bitmap.createScaledBitmap(crop, tw, th, true);
        int[] px = new int[tw * th];
        big.getPixels(px, 0, tw, 0, 0, tw, th);
        for (int i = 0; i < px.length; i++) {
            int c = px[i];
            int luma = (((c >> 16) & 255) * 299 + ((c >> 8) & 255) * 587 + (c & 255) * 114) / 1000;
            boolean ink = luma < 120 && (c >>> 24) > 128;
            px[i] = ink ? Color.BLACK : Color.WHITE;
        }
        int m = 24;
        Bitmap out = Bitmap.createBitmap(tw + 2 * m, th + 2 * m, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        cv.drawColor(Color.WHITE);
        Bitmap ink = Bitmap.createBitmap(px, tw, th, Bitmap.Config.ARGB_8888);
        cv.drawBitmap(ink, m, m, null);
        return out;
    }

    private static String recognize(Bitmap b) {
        try {
            Task<Text> t = recognizer().process(InputImage.fromBitmap(b, 0));
            Text text = Tasks.await(t, 3, TimeUnit.SECONDS);
            return text == null ? null : text.getText();
        } catch (Exception e) {
            return null;
        }
    }

    /** The number read, with the letters a recognizer takes digits for put right; 0 when not a limit. */
    static int number(String text) {
        if (text == null) return 0;
        String t = text.replaceAll("\\s+", "")
                .replace('O', '0').replace('o', '0').replace('D', '0').replace('Q', '0')
                .replace('I', '1').replace('l', '1').replace('|', '1')
                .replace('S', '5').replace('s', '5').replace('B', '8').replace('Z', '2').replace('z', '2');
        return Engine.numberIn(t);
    }

    private SignOcr() { }
}
