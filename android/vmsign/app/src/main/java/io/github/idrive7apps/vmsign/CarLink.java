package io.github.idrive7apps.vmsign;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.HandlerThread;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The sign to the car: a small JSON datagram on UDP 8471 at each change and once a second,
 *     {"t":"vms","v":1,"seq":12,"limit":60,"app":"vmsign 0.1.0"}      limit 0: no sign
 * answered by the car's helper (vietmap-signs) with {"t":"vms-ack","seq":12,"shown":[...],"why":"..."}.
 *
 * The car is found without settings: until it answers, every datagram goes to the car's own Wi-Fi
 * address (172.16.222.97 on the BMW seen so far), to the address typed on the screen, and to the
 * broadcast address of every network the phone is on (the car's Wi-Fi, which wireless Android Auto
 * uses, or the phone's hotspot with the car on it), from a socket of its own on each Wi-Fi network
 * Android lets the app use as well as from the default one. Once the car answers, only to it, by the
 * way it answered; everywhere again once it has not answered for 5 s.
 */
final class CarLink {
    static final int PORT = 8471;
    static final String DEFAULT_CAR = "172.16.222.97";

    private static CarLink instance;
    static synchronized CarLink get(Context c) {
        if (instance == null) instance = new CarLink(c.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private HandlerThread thread;
    private Handler handler;
    private int users = 0;
    private int seq = 0;
    private long socketsAt = 0;
    private final List<DatagramSocket> sockets = new ArrayList<>();
    private volatile DatagramSocket answeredOn = null;
    private int lastSent = -1;
    private long lastSentAt = 0;
    volatile int sentCount = 0, errorCount = 0;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            try { send(); } catch (RuntimeException e) { Engine.linkNote = "lỗi: " + e.getMessage(); }
            if (handler != null) handler.postDelayed(this, 1000);
        }
    };

    private CarLink(Context ctx) { this.ctx = ctx; }

    /** Each service that can feed it starts it; it runs while one does. */
    synchronized void start() {
        users++;
        if (thread != null) return;
        thread = new HandlerThread("carlink");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(tick);
    }

    synchronized void stop() {
        users = Math.max(0, users - 1);
        if (users > 0 || thread == null) return;
        final HandlerThread t = thread;
        final Handler h = handler;
        thread = null;
        handler = null;
        h.removeCallbacksAndMessages(null);
        h.post(new Runnable() { @Override public void run() { closeSockets(); t.quit(); } });
    }

    /** A change: send now, not at the next second. */
    synchronized void wake() {
        if (handler == null) return;
        int out = Engine.outgoing();
        if (out != lastSent) { handler.removeCallbacks(tick); handler.post(tick); }
    }

    /** From the screen: a test sign (or none) to the car at once, even without the services. */
    void sendNow() {
        synchronized (this) {
            if (handler != null) { handler.removeCallbacks(tick); handler.post(tick); return; }
        }
        new Thread(new Runnable() { @Override public void run() {
            try { send(); } catch (RuntimeException e) { Engine.linkNote = "lỗi: " + e.getMessage(); }
        } }).start();
    }

    private synchronized void send() {
        long now = System.currentTimeMillis();
        int out = Engine.outgoing();
        // nothing changed: once a second is enough (the car hides the sign 5 s after the last)
        if (out == lastSent && now - lastSentAt < 900) return;
        boolean answering = Engine.carAddr != null && now - Engine.ackAt < 5000 && answeredOn != null && !answeredOn.isClosed();
        if (sockets.isEmpty() || (!answering && now - socketsAt > 15000)) {
            openSockets();
            answering = false;
        }
        byte[] data;
        try {
            JSONObject m = new JSONObject();
            m.put("t", "vms");
            m.put("v", 1);
            m.put("seq", ++seq);
            m.put("limit", out);
            m.put("app", "vmsign " + Engine.VERSION);
            if (Engine.testing()) m.put("test", 1);
            data = m.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) { return; }

        int ok = 0, bad = 0;
        if (answering) {
            if (sendTo(answeredOn, data, Engine.carAddr)) ok++; else bad++;
        } else {
            Set<String> to = destinations();
            for (DatagramSocket s : sockets) {
                for (String a : to) { if (sendTo(s, data, a)) ok++; else bad++; }
            }
        }
        sentCount += ok;
        errorCount += bad;
        lastSent = out;
        lastSentAt = now;
        if (answering) Engine.linkNote = "";
        else Engine.linkNote = ok > 0 ? "đang dò xe: " + ok + " gói mỗi giây, " + sockets.size() + " đường mạng" : "không gửi được: điện thoại chưa nối mạng nào";
    }

    private static boolean sendTo(DatagramSocket s, byte[] data, String addr) {
        try {
            s.send(new DatagramPacket(data, data.length, InetAddress.getByName(addr), PORT));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** The car's last address, the one typed, the car's own, and every broadcast address the phone has. */
    private Set<String> destinations() {
        Set<String> to = new LinkedHashSet<>();
        if (Engine.carAddr != null) to.add(Engine.carAddr);
        String typed = Engine.prefs(ctx).getString("carIp", "").trim();
        if (typed.length() > 0) to.add(typed);
        to.add(DEFAULT_CAR);
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getAddress() instanceof Inet4Address && ia.getBroadcast() != null) {
                        to.add(ia.getBroadcast().getHostAddress());
                    }
                }
            }
        } catch (Exception e) { /* no interfaces listed */ }
        return to;
    }

    private synchronized void openSockets() {
        closeSockets();
        socketsAt = System.currentTimeMillis();
        try {
            DatagramSocket d = new DatagramSocket();
            d.setBroadcast(true);
            sockets.add(d);
        } catch (Exception e) { /* none */ }
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            Network[] nets;
            try { nets = cm.getAllNetworks(); } catch (RuntimeException e) { nets = new Network[0]; }
            for (Network n : nets) {
                NetworkCapabilities caps;
                try { caps = cm.getNetworkCapabilities(n); } catch (RuntimeException e) { caps = null; }
                if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
                try {
                    DatagramSocket s = new DatagramSocket();
                    n.bindSocket(s);
                    s.setBroadcast(true);
                    sockets.add(s);
                } catch (Exception e) { /* a network the app may not use */ }
            }
        }
        for (DatagramSocket s : sockets) listen(s);
    }

    private synchronized void closeSockets() {
        for (DatagramSocket s : sockets) { try { s.close(); } catch (Exception e) { /* gone */ } }
        sockets.clear();
    }

    /** The car's answers on one socket, until it is closed. */
    private void listen(final DatagramSocket s) {
        Thread t = new Thread(new Runnable() { @Override public void run() {
            byte[] buf = new byte[2048];
            while (!s.isClosed()) {
                try {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    s.receive(p);
                    JSONObject m = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    if (!"vms-ack".equals(m.optString("t"))) continue;
                    Engine.carAddr = p.getAddress().getHostAddress();
                    Engine.ackAt = System.currentTimeMillis();
                    Engine.carWhy = m.optString("why", "");
                    Engine.carVersion = m.optString("car", "");
                    JSONArray shown = m.optJSONArray("shown");
                    StringBuilder sb = new StringBuilder();
                    if (shown != null) {
                        for (int i = 0; i < shown.length(); i++) {
                            String x = shown.optString(i);
                            if (sb.length() > 0) sb.append(", ");
                            sb.append("map".equals(x) ? "đồng hồ" : "hud".equals(x) ? "HUD" : x);
                        }
                    }
                    Engine.carShown = sb.toString();
                    answeredOn = s;
                } catch (Exception e) {
                    if (s.isClosed()) return;
                }
            }
        } }, "carlink-rx");
        t.setDaemon(true);
        t.start();
    }
}
