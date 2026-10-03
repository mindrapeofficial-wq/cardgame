package com.arcanum.classic;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public final class ArcanumMessagingService extends FirebaseMessagingService {
    @Override public void onMessageReceived(RemoteMessage message) { PushNotifications.show(this,message.getData()); }
    // The next foreground session obtains and registers the latest token using its game session.
    // Never persist a game authentication token in the messaging service.
}
