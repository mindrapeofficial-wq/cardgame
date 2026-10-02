package com.arcanum.classic;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
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

public class MainActivity extends Activity {
    private static final String GAME_URL = "https://cardgame-l9ld.onrender.com/";
    private static final String GAME_HOST = "cardgame-l9ld.onrender.com";

    private FrameLayout root;
    private WebView webView;
    private View loadingView;
    private boolean combatMode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        showLoading();
        createWebView(savedInstanceState);
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
            s.setUserAgentString(s.getUserAgentString() + " ArcanumTCGAndroid/1.2.2");

            CookieManager cookies = CookieManager.getInstance();
            cookies.setAcceptCookie(true);
            cookies.setAcceptThirdPartyCookies(webView, true);

            webView.addJavascriptInterface(new AndroidBridge(), "ArcanumAndroid");
            webView.setWebChromeClient(new WebChromeClient());
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    String scheme = uri.getScheme();
                    String host = uri.getHost();

                    if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                        if (host != null &&
                                (GAME_HOST.equalsIgnoreCase(host) || host.endsWith(".onrender.com"))) {
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

                    return false;
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
        if (webView == null) return;

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
                "button,input,select,textarea{touch-action:manipulation;}.duel-mode .duel-top-actions{display:none!important;}" +
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
            exitImmersiveMode();
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
        @JavascriptInterface
        public void setCombatMode(final boolean active) {
            runOnUiThread(() -> MainActivity.this.setCombatMode(active));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        if (combatMode) enableImmersiveMode();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && combatMode) enableImmersiveMode();
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
