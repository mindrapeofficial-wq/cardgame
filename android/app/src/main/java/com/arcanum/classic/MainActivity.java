package com.arcanum.classic;

import android.app.Activity;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String GAME_URL = "https://cardgame-l9ld.onrender.com/";
    private static final String GAME_HOST = "cardgame-l9ld.onrender.com";

    private FrameLayout root;
    private WebView webView;
    private View loadingView;
    private boolean combatMode;
    private PlayBilling billing;
    private static final int MIC_PERMISSION_REQUEST = 4101;
    private PermissionRequest pendingMicRequest;
    private JSONObject pendingAuth;
    private JSONObject pendingNotification;
    private String permissionRequest="";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureFullscreenWindow();
        root = new FrameLayout(this);
        root.setFitsSystemWindows(false);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                // System bars never create a gutter. Keep editable fields above the keyboard.
                int keyboard = insets.isVisible(WindowInsets.Type.ime())
                        ? insets.getInsets(WindowInsets.Type.ime()).bottom : 0;
                view.setPadding(0, 0, 0, keyboard);
                return insets;
            });
        }
        enableImmersiveMode();
        showLoading();
        createWebView(savedInstanceState);
        billing = new PlayBilling(this, event -> runOnUiThread(() -> {
            if (webView == null || !trustedGamePage()) return;
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('arcanum:billing',{detail:"
                    + event.toString() + "}));", null);
        }));
        acceptLaunchIntent(getIntent());
    }

    private void showLoading() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(32, 32, 32, 32);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.arcanum_logo);
        logo.setAdjustViewBounds(true);
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(220, 220);
        logoParams.bottomMargin = 18;
        box.addView(logo, logoParams);

        TextView text = new TextView(this);
        text.setText("Conectando con ARCANUM TCG...");
        text.setTextColor(Color.rgb(225, 194, 122));
        text.setTextSize(16f);
        text.setGravity(Gravity.CENTER);
        box.addView(text, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        loadingView = box;
        root.addView(box, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void createWebView(Bundle savedInstanceState) {
        try {
            WebView.setWebContentsDebuggingEnabled(false);
            webView = new WebView(this);
            webView.setBackgroundColor(Color.BLACK);
            webView.setVisibility(View.INVISIBLE);
            webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);

            WebSettings s = webView.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setJavaScriptCanOpenWindowsAutomatically(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setLoadWithOverviewMode(true);
            s.setUseWideViewPort(true);
            s.setSupportZoom(false);
            s.setBuiltInZoomControls(false);
            s.setDisplayZoomControls(false);
            s.setUserAgentString(s.getUserAgentString() + " ArcanumTCGAndroid/1.2.8 GooglePlay");

            CookieManager cookies = CookieManager.getInstance();
            cookies.setAcceptCookie(true);
            cookies.setAcceptThirdPartyCookies(webView, false);

            webView.addJavascriptInterface(new AndroidBridge(), "ArcanumAndroid");
            webView.setWebChromeClient(new WebChromeClient() {
                // Voice chat: the game page may use the microphone after the player allows it in
                // Android. Any other page or resource is refused.
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    boolean audioOnly = request.getResources().length == 1 &&
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(request.getResources()[0]);
                    Uri origin = request.getOrigin();
                    if (!audioOnly || origin == null || !"https".equalsIgnoreCase(origin.getScheme()) ||
                            !GAME_HOST.equalsIgnoreCase(origin.getHost())) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                        return;
                    }
                    if (pendingMicRequest != null) pendingMicRequest.deny();
                    pendingMicRequest = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_PERMISSION_REQUEST);
                }

                @Override
                public void onPermissionRequestCanceled(PermissionRequest request) {
                    if (request == pendingMicRequest) pendingMicRequest = null;
                }
            });
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    String scheme = uri.getScheme();
                    String host = uri.getHost();
                    // Digital purchases in this edition use Google Play Billing.
                    if (host != null && (host.equalsIgnoreCase("checkout.stripe.com") ||
                            host.equalsIgnoreCase("buy.stripe.com"))) return true;

                    if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                        if ("https".equalsIgnoreCase(scheme) && host != null &&
                                (GAME_HOST.equalsIgnoreCase(host) || "arcanumgames.es".equalsIgnoreCase(host))) {
                            return false;
                        }
                        openExternal(uri);
                        return true;
                    }

                    if ("mailto".equalsIgnoreCase(scheme) ||
                            "tel".equalsIgnoreCase(scheme) ||
                            "intent".equalsIgnoreCase(scheme)) {
                        openExternal(uri);
                        return true;
                    }

                    return true;
                }

                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    revealWebView();
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    revealWebView();
                    injectMobileOptimizations();
                    CookieManager.getInstance().flush();
                    dispatchPendingEvents();
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame()) showOfflinePage();
                }
            });

            root.addView(webView, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            if (savedInstanceState != null && webView.restoreState(savedInstanceState) != null) {
                return;
            }

            webView.loadUrl(GAME_URL);
        } catch (Throwable ignored) {
            showStartupError();
        }
    }

    private void revealWebView() {
        if (webView == null) return;
        webView.setVisibility(View.VISIBLE);
        if (loadingView != null) {
            root.removeView(loadingView);
            loadingView = null;
        }
    }

    private void showStartupError() {
        if (loadingView != null) root.removeView(loadingView);

        TextView error = new TextView(this);
        error.setText("ARCANUM TCG\n\nAndroid no pudo iniciar el componente web del juego.\n" +
                "Actualiza Chrome o Android System WebView y vuelve a abrir la aplicación.");
        error.setTextColor(Color.WHITE);
        error.setGravity(Gravity.CENTER);
        error.setTextSize(16f);
        error.setPadding(36, 36, 36, 36);

        root.addView(error, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void showOfflinePage() {
        if (webView == null) return;

        String html = "<!doctype html><html><head><meta name='viewport' " +
                "content='width=device-width,initial-scale=1'>" +
                "<style>html,body{margin:0;background:#020202;color:#e8e1d2;" +
                "font-family:sans-serif;height:100%}body{display:grid;place-items:center;" +
                "padding:24px;box-sizing:border-box;text-align:center}h1{color:#e1c27a;" +
                "font-family:serif;letter-spacing:.08em}button{margin-top:16px;padding:12px 20px;" +
                "border:1px solid #d6b163;background:#171208;color:#f5df9a;border-radius:8px;" +
                "font-size:16px}</style></head><body><div><h1>ARCANUM TCG</h1>" +
                "<p>No se pudo conectar con el servidor.</p><button onclick=\"location.href='" +
                GAME_URL + "'\">Reintentar</button></div></body></html>";

        webView.loadDataWithBaseURL(GAME_URL, html, "text/html", "UTF-8", null);
        revealWebView();
    }

    private void injectMobileOptimizations() {
        if (webView == null || !trustedGamePage()) return;

        String js = "(function(){" +
                "var m=document.querySelector('meta[name=viewport]');" +
                "if(!m){m=document.createElement('meta');m.name='viewport';document.head.appendChild(m);}" +
                "m.content='width=device-width,initial-scale=1,maximum-scale=5,viewport-fit=cover';" +
                "var s=document.getElementById('arcanum-tcg-android-mobile');" +
                "if(!s){s=document.createElement('style');s.id='arcanum-tcg-android-mobile';document.head.appendChild(s);}" +
                "s.textContent='html{min-height:100%;-webkit-text-size-adjust:100%;text-size-adjust:100%;}" +
                "body{min-height:100dvh!important;width:100%!important;max-width:none!important;margin:0!important;" +
                "overflow-x:hidden!important;overscroll-behavior:none;-webkit-tap-highlight-color:transparent;}" +
                "#appShell{width:100%!important;max-width:none!important;min-height:100dvh!important;}" +
                "main{width:100%!important;min-width:0!important;}input,select,textarea{font-size:16px!important;}" +
                "button,input,select,textarea{touch-action:manipulation;}" +
                "table{max-width:100%;}.arc-modal{max-height:calc(100dvh - 1rem)!important;}';" +
                "var shell=document.getElementById('appShell');" +
                "var sync=function(){var active=!!(shell&&shell.classList.contains('duel-mode'));" +
                "try{window.ArcanumAndroid.setCombatMode(active);}catch(e){}};" +
                "if(shell&&!window.__arcanumAndroidDuelObserver){" +
                "window.__arcanumAndroidDuelObserver=new MutationObserver(sync);" +
                "window.__arcanumAndroidDuelObserver.observe(shell,{attributes:true,attributeFilter:['class']});}" +
                "sync();})();";

        webView.evaluateJavascript(js, null);
    }

    private void setCombatMode(boolean active) {
        if (combatMode == active) return;
        combatMode = active;

        if (active) {
            try {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            } catch (Throwable ignored) {}
            enableImmersiveMode();
        } else {
            try {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            } catch (Throwable ignored) {}
            // Keep the Android app edge-to-edge after combat. Only the
            // landscape lock belongs to combat; immersive fullscreen belongs
            // to the native app itself so returning to the lobby never leaves
            // system-bar gutters or a visible outer margin.
            enableImmersiveMode();
        }
    }

    private void enableImmersiveMode() {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                getWindow().setDecorFitsSystemWindows(false);
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(
                            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_FULLSCREEN |
                        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
                        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                        View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            }
        } catch (Throwable ignored) {}
    }

    private void configureFullscreenWindow() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = android.os.Build.VERSION.SDK_INT >= 30
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
    }

    private void exitImmersiveMode() {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                getWindow().setDecorFitsSystemWindows(true);
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                }
            } else {
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
        } catch (Throwable ignored) {}
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {}
    }

    public final class AndroidBridge {
        @JavascriptInterface public void openSocialLogin(final String url) {
            runOnUiThread(() -> {
                if (!trustedGamePage()) return;
                try {
                    Uri uri=Uri.parse(url),redirect=Uri.parse(uri.getQueryParameter("redirect_to"));
                    String provider=uri.getQueryParameter("provider"),challenge=uri.getQueryParameter("code_challenge");
                    if (!"https".equals(uri.getScheme()) || !"mrmvmoyysxuopqexbxfk.supabase.co".equals(uri.getHost()) ||
                            !"/auth/v1/authorize".equals(uri.getPath()) || !("google".equals(provider)||"apple".equals(provider)) ||
                            !"s256".equals(uri.getQueryParameter("code_challenge_method")) || challenge==null ||
                            !challenge.matches("[A-Za-z0-9_-]{43,128}") || !"https".equals(redirect.getScheme()) ||
                            !GAME_HOST.equals(redirect.getHost()) || !"/oauth-callback.html".equals(redirect.getPath())) return;
                    // OAuth providers require a real browser, never the embedded WebView.
                    openExternal(uri);
                } catch (Exception ignored) {}
            });
        }
        @JavascriptInterface public void bindPushAccount(final String account) {
            runOnUiThread(() -> { if(trustedGamePage()) PushNotifications.bindAccount(MainActivity.this,account); });
        }
        @JavascriptInterface public void getPushState(final String requestId) {
            runOnUiThread(() -> { if(trustedGamePage()) pushState(requestId,false); });
        }
        @JavascriptInterface public void enableNotifications(final String requestId) {
            runOnUiThread(() -> {
                if(!trustedGamePage()||!PushNotifications.configured()||requestId.length()>100) { pushState(requestId,false); return; }
                if(android.os.Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        !=android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    permissionRequest=requestId;requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},41);
                } else pushState(requestId,true);
            });
        }
        @JavascriptInterface public void disableNotifications() {
            runOnUiThread(() -> { if(trustedGamePage()) PushNotifications.disable(MainActivity.this); });
        }
        @JavascriptInterface
        public void setCombatMode(final boolean active) {
            runOnUiThread(() -> { if (trustedGamePage()) MainActivity.this.setCombatMode(active); });
        }

        @JavascriptInterface
        public void loadPlayProducts() {
            runOnUiThread(() -> { if (billing != null && trustedGamePage()) billing.loadProducts(); });
        }
        @JavascriptInterface
        public void purchasePlayProduct(final String productId, final String accountHash) {
            runOnUiThread(() -> { if (billing != null && trustedGamePage()) billing.purchase(productId, accountHash); });
        }
        @JavascriptInterface
        public void restorePlayPurchases() {
            runOnUiThread(() -> { if (billing != null && trustedGamePage()) billing.restore(); });
        }
    }

    private void nativeEvent(String name,JSONObject data) {
        if(!trustedGamePage())return;
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent("+JSONObject.quote(name)+",{detail:"+data.toString()+"}));",null);
    }
    private void pushState(String requestId,boolean enable) {
        try {
            if(requestId.length()>100)return;
            boolean permission=PushNotifications.permission(this);
            if(enable&&permission) {
                PushNotifications.prefs(this).edit().putBoolean("enabled",true).apply();
                FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            }
            JSONObject event=new JSONObject().put("requestId",requestId).put("available",PushNotifications.configured())
                    .put("permission",permission).put("enabled",PushNotifications.enabled(this));
            if(!PushNotifications.configured()||!permission||!PushNotifications.enabled(this)) { nativeEvent("arcanum:push",event); return; }
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                try { if(task.isSuccessful())event.put("token",task.getResult());else event.put("error","push_token_unavailable"); }
                catch(Exception ignored) {}
                nativeEvent("arcanum:push",event);
            });
        } catch(Exception ignored) {}
    }
    @Override public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] grantResults) {
        super.onRequestPermissionsResult(requestCode,permissions,grantResults);
        if(requestCode==41) { pushState(permissionRequest,true);permissionRequest="";enableImmersiveMode(); }
        if(requestCode==MIC_PERMISSION_REQUEST&&pendingMicRequest!=null) {
            PermissionRequest request=pendingMicRequest;pendingMicRequest=null;
            if(grantResults.length>0&&grantResults[0]==PackageManager.PERMISSION_GRANTED)request.grant(request.getResources());
            else request.deny();
        }
    }
    private void acceptLaunchIntent(Intent intent) {
        if(intent==null)return;
        try {
            Uri uri=intent.getData();
            if(uri!=null&&"arcanumtcg".equals(uri.getScheme())&&"auth".equals(uri.getHost())&&"/callback".equals(uri.getPath())) {
                String code=uri.getQueryParameter("code"),flow=uri.getQueryParameter("flow");
                if(code!=null&&code.length()<=512&&flow!=null&&flow.matches("[A-Za-z0-9_-]{43}"))
                    pendingAuth=new JSONObject().put("code",code).put("flow",flow);
            }
            String route=intent.getStringExtra("notificationRoute"),account=intent.getStringExtra("notificationAccount");
            if(account!=null&&account.equals(PushNotifications.prefs(this).getString("account",""))&&
                    ("home".equals(route)||"friends".equals(route)||"shop".equals(route)||"messages".equals(route)))
                pendingNotification=new JSONObject().put("route",route).put("accountId",account);
        }catch(Exception ignored){}
    }
    private void dispatchPendingEvents() {
        if(!trustedGamePage())return;
        if(pendingAuth!=null) { nativeEvent("arcanum:auth",pendingAuth);pendingAuth=null; }
        if(pendingNotification!=null) { nativeEvent("arcanum:notification-open",pendingNotification);pendingNotification=null; }
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);setIntent(intent);acceptLaunchIntent(intent);dispatchPendingEvents();enableImmersiveMode();
    }

    private boolean trustedGamePage() {
        if (webView == null || webView.getUrl() == null) return false;
        Uri current = Uri.parse(webView.getUrl());
        return "https".equalsIgnoreCase(current.getScheme()) && GAME_HOST.equalsIgnoreCase(current.getHost());
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        PushNotifications.foreground=true;
        if (webView != null) webView.onResume();
        enableImmersiveMode();
    }

    @Override
    protected void onPause() {
        PushNotifications.foreground=false;
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enableImmersiveMode();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (billing != null) { billing.close(); billing = null; }
        if (webView != null) {
            root.removeView(webView);
            webView.stopLoading();
            webView.removeJavascriptInterface("ArcanumAndroid");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}

