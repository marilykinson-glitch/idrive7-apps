package io.github.idrive7apps.vmsign;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.List;

/**
 * VietMap's notifications, for the case its sign is in one (they can be read with the screen locked).
 * Optional: only once the user allows notification access. Other apps' notifications are not read.
 */
public class NotifReader extends NotificationListenerService {
    static volatile boolean connected = false;

    @Override
    public void onListenerConnected() {
        connected = true;
        CarLink.get(this).start();
        readAll();
    }

    @Override
    public void onListenerDisconnected() {
        connected = false;
        Engine.setNotifItems(this, new ArrayList<Engine.Item>());
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn != null && Engine.isVietMap(sbn.getPackageName())) readAll();
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (sbn != null && Engine.isVietMap(sbn.getPackageName())) readAll();
    }

    private void readAll() {
        List<Engine.Item> items = new ArrayList<>();
        StatusBarNotification[] all;
        try { all = getActiveNotifications(); } catch (RuntimeException e) { all = null; }
        if (all != null) {
            for (StatusBarNotification sbn : all) {
                if (sbn == null || !Engine.isVietMap(sbn.getPackageName())) continue;
                Notification n = sbn.getNotification();
                if (n == null) continue;
                Bundle x = n.extras;
                String base = "notification " + sbn.getId() + ":";
                add(items, sbn.getPackageName(), base + "title", x == null ? null : x.getCharSequence(Notification.EXTRA_TITLE));
                add(items, sbn.getPackageName(), base + "text", x == null ? null : x.getCharSequence(Notification.EXTRA_TEXT));
                add(items, sbn.getPackageName(), base + "big", x == null ? null : x.getCharSequence(Notification.EXTRA_BIG_TEXT));
                add(items, sbn.getPackageName(), base + "sub", x == null ? null : x.getCharSequence(Notification.EXTRA_SUB_TEXT));
                add(items, sbn.getPackageName(), base + "ticker", n.tickerText);
            }
        }
        Engine.setNotifItems(this, items);
    }

    private static void add(List<Engine.Item> items, String pkg, String where, CharSequence text) {
        if (text != null && text.length() > 0) items.add(new Engine.Item(pkg, null, text.toString(), where));
    }
}
