package com.arcanum.classic;

import android.app.Activity;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Native Play UI only. Entitlements and acknowledgement are handled by the server. */
final class PlayBilling {
    interface Events { void send(JSONObject event); }
    private final Activity activity;
    private final Events events;
    private final BillingClient client;
    private final Map<String, ProductDetails> details = new HashMap<>();
    private boolean connecting;
    private Runnable pendingAction;
    private static final List<String> PRODUCTS = Arrays.asList(
            "arcanum_apoyador", "arcanum_fundador", "arcanum_mecenas");

    PlayBilling(Activity activity, Events events) {
        this.activity = activity;
        this.events = events;
        client = BillingClient.newBuilder(activity)
                .setListener((result, purchases) -> {
                    if (result.getResponseCode() == BillingClient.BillingResponseCode.OK && purchases != null) emitPurchases(purchases);
                    else if (result.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) error("cancelled");
                    else if (result.getResponseCode() == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) restore();
                    else error("billing_unavailable");
                })
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                .enableAutoServiceReconnection()
                .build();
    }
    private void ready(Runnable action) {
        if (client.isReady()) { action.run(); return; }
        pendingAction = action;
        if (connecting) return;
        connecting = true;
        client.startConnection(new BillingClientStateListener() {
            @Override public void onBillingSetupFinished(BillingResult result) {
                connecting = false;
                Runnable queued = pendingAction; pendingAction = null;
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK && queued != null) queued.run();
                else error("billing_unavailable");
            }
            @Override public void onBillingServiceDisconnected() { connecting = false; }
        });
    }
    void loadProducts() {
        ready(() -> {
            List<QueryProductDetailsParams.Product> products = new ArrayList<>();
            for (String product : PRODUCTS) products.add(QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(product).setProductType(BillingClient.ProductType.INAPP).build());
            client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(products).build(),
                    (result, queryResult) -> {
                        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) { error("products_unavailable"); return; }
                        details.clear(); JSONArray items = new JSONArray();
                        for (ProductDetails product : queryResult.getProductDetailsList()) {
                            ProductDetails.OneTimePurchaseOfferDetails offer = offer(product);
                            if (offer == null) continue;
                            details.put(product.getProductId(), product);
                            try { items.put(new JSONObject().put("productId", product.getProductId()).put("price", offer.getFormattedPrice())); }
                            catch (org.json.JSONException ignored) {}
                        }
                        try { events.send(new JSONObject().put("type", "products").put("products", items)); }
                        catch (org.json.JSONException ignored) {}
                    });
        });
    }
    private ProductDetails.OneTimePurchaseOfferDetails offer(ProductDetails product) {
        List<ProductDetails.OneTimePurchaseOfferDetails> offers = product.getOneTimePurchaseOfferDetailsList();
        return offers == null || offers.isEmpty() ? null : offers.get(0);
    }
    void purchase(String productId, String accountHash) {
        if (!PRODUCTS.contains(productId) || accountHash == null || !accountHash.matches("[0-9a-f]{64}")) { error("product_invalid"); return; }
        ready(() -> {
            // Query current details for every launch; offer tokens can change over time.
            QueryProductDetailsParams.Product product = QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(productId).setProductType(BillingClient.ProductType.INAPP).build();
            client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(Arrays.asList(product)).build(),
                    (result, queryResult) -> {
                        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || queryResult.getProductDetailsList().isEmpty()) { error("products_unavailable"); return; }
                        ProductDetails current = queryResult.getProductDetailsList().get(0);
                        ProductDetails.OneTimePurchaseOfferDetails offer = offer(current);
                        if (offer == null) { error("products_unavailable"); return; }
                        BillingFlowParams.ProductDetailsParams item = BillingFlowParams.ProductDetailsParams.newBuilder()
                                .setProductDetails(current).setOfferToken(offer.getOfferToken()).build();
                        activity.runOnUiThread(() -> {
                            BillingResult launched = client.launchBillingFlow(activity, BillingFlowParams.newBuilder()
                                    .setProductDetailsParamsList(Arrays.asList(item)).setObfuscatedAccountId(accountHash).build());
                            if (launched.getResponseCode() != BillingClient.BillingResponseCode.OK) error("billing_unavailable");
                        });
                    });
        });
    }
    void restore() {
        ready(() -> client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(),
                (result, purchases) -> {
                    if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) emitPurchases(purchases);
                    else error("billing_unavailable");
                }));
    }
    private void emitPurchases(List<Purchase> purchases) {
        for (Purchase purchase : purchases) {
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) { error("purchase_pending"); continue; }
            if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
            if (purchase.getProducts().size() != 1 || !PRODUCTS.contains(purchase.getProducts().get(0))) continue;
            try { events.send(new JSONObject().put("type", "purchase").put("productId", purchase.getProducts().get(0)).put("purchaseToken", purchase.getPurchaseToken())); }
            catch (org.json.JSONException ignored) {}
        }
    }
    private void error(String code) {
        try { events.send(new JSONObject().put("type", "error").put("error", code)); }
        catch (org.json.JSONException ignored) {}
    }
    void close() { pendingAction = null; client.endConnection(); }
}

