package com.arcanum.classic;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.installations.FirebaseInstallations;
import com.google.android.gms.tasks.Task;
import java.util.Map;

final class PushNotifications {
    static final String[] CATEGORIES = {"challenges", "friends", "packs", "messages"};
    static final String[] CHANNEL_NAMES = {"Retos a combate", "Solicitudes de amistad", "Sobres gratuitos", "Mensajes privados"};
    static volatile boolean foreground;
    private static Task<Void> resetting;
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("arcanum-push", Context.MODE_PRIVATE); }
    static boolean configured() { return !BuildConfig.FIREBASE_APP_ID.isEmpty() && !BuildConfig.FIREBASE_API_KEY.isEmpty()
            && !BuildConfig.FIREBASE_PROJECT_ID.isEmpty() && !BuildConfig.FIREBASE_SENDER_ID.isEmpty(); }
    static boolean enabled(Context c) { return prefs(c).getBoolean("enabled", false); }
    static boolean permission(Context c) {
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        return manager != null && manager.areNotificationsEnabled() &&
                (Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
    }
    static void createChannels(Context c) {
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        for (int i=0;i<CATEGORIES.length;i++) {
            NotificationChannel channel = new NotificationChannel("arcanum-"+CATEGORIES[i],CHANNEL_NAMES[i],
                    CATEGORIES[i].equals("packs") ? NotificationManager.IMPORTANCE_DEFAULT : NotificationManager.IMPORTANCE_HIGH);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(channel);
        }
    }
    static void disable(Context c) {
        prefs(c).edit().putBoolean("enabled",false).remove("account").apply();
        c.getSystemService(NotificationManager.class).cancelAll();
        if (configured()) {
            FirebaseMessaging.getInstance().setAutoInitEnabled(false);
            Task<Void> prior=resetting;
            resetting=(prior==null ? FirebaseMessaging.getInstance().deleteToken()
                    : prior.continueWithTask(task -> FirebaseMessaging.getInstance().deleteToken()))
                    .continueWithTask(task -> FirebaseInstallations.getInstance().delete());
        }
    }
    static Task<String> token() {
        return resetting==null ? FirebaseMessaging.getInstance().getToken()
                : resetting.continueWithTask(task -> FirebaseMessaging.getInstance().getToken());
    }
    static void bindAccount(Context c,String account) {
        if (!account.matches("[0-9a-fA-F-]{36}")) return;
        String previous = prefs(c).getString("account", "");
        if (!previous.equals(account)) disable(c);
        prefs(c).edit().putString("account",account).apply();
    }
    static String category(Map<String,String> data) {
        for(String category:CATEGORIES) if(category.equals(data.get("category"))) return category;
        return null;
    }
    static void show(Context c, Map<String,String> data) {
        String category=category(data),owner=prefs(c).getString("account", "");
        if (!enabled(c)||!permission(c)||foreground||category==null||owner.isEmpty()||!owner.equals(data.get("accountId"))) return;
        try { if(Long.parseLong(data.get("expiresAt")) < System.currentTimeMillis()) return; } catch(Exception ignored) { return; }
        String route=data.get("route");
        if (!"home".equals(route)&&!"friends".equals(route)&&!"shop".equals(route)&&!"messages".equals(route)) return;
        createChannels(c);
        String text="messages".equals(category)?"Tienes un mensaje privado en ARCANUM.":
                "friends".equals(category)?"Tienes una solicitud de amistad.":
                "packs".equals(category)?"Tu sobre gratuito está disponible para reclamar.":"Te han retado a un combate.";
        Intent intent=new Intent(c,MainActivity.class).putExtra("notificationRoute",route).putExtra("notificationAccount",owner)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending=PendingIntent.getActivity(c,category.hashCode(),intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification notification=new Notification.Builder(c,"arcanum-"+category)
                .setSmallIcon(R.drawable.notification_icon).setContentTitle("ARCANUM TCG").setContentText(text)
                .setAutoCancel(true).setContentIntent(pending).setVisibility(Notification.VISIBILITY_PRIVATE).build();
        c.getSystemService(NotificationManager.class).notify(category.hashCode(),notification);
    }
}
