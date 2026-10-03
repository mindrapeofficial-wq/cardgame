package com.arcanum.classic;

import android.app.Application;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;

public final class ArcanumApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        if (!PushNotifications.configured()) return;
        FirebaseOptions options = new FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build();
        FirebaseApp app = FirebaseApp.getApps(this).isEmpty()
                ? FirebaseApp.initializeApp(this, options) : FirebaseApp.getInstance();
        if (app != null) app.setDataCollectionDefaultEnabled(false);
        FirebaseMessaging.getInstance().setAutoInitEnabled(PushNotifications.enabled(this));
        PushNotifications.createChannels(this);
    }
}
