export const PLAY_PACKAGE = "com.arcanum.classic";
export const PLAY_PRODUCTS: Record<string,string> = {
  arcanum_apoyador:"apoyador", arcanum_fundador:"fundador", arcanum_mecenas:"mecenas", arcanum_leyenda:"leyenda",
};
export async function playAccountId(id: string) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode("arcanum-account:"+id));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
export function validatePlayPurchase(purchase: any, product: string, accountHash: string) {
  if (!PLAY_PRODUCTS[product]) return "product_invalid";
  const state=purchase.purchaseStateContext?.purchaseState;
  if (state === "PENDING") return "purchase_pending";
  if (state !== "PURCHASED") return "purchase_not_purchased";
  if (purchase.obfuscatedExternalAccountId !== accountHash) return "purchase_account_mismatch";
  const lines=purchase.productLineItem || [];
  if (lines.length !== 1 || lines[0].productId !== product) return "purchase_product_mismatch";
  if (Number(lines[0].productOfferDetails?.quantity || 1) !== 1) return "purchase_quantity_invalid";
  if (!purchase.purchaseCompletionTime || !Number.isFinite(Date.parse(purchase.purchaseCompletionTime))) return "purchase_date_invalid";
  return null;
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
let cachedToken="",tokenExpires=0;
export function playBillingConfigured(){return Deno.env.get("PLAY_BILLING_ENABLED")==="true"&&!!Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")}
async function googleAccessToken() {
  if(cachedToken&&Date.now()<tokenExpires)return cachedToken;
  const service=JSON.parse(Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON") || "{}");
  if(!service.client_email||!service.private_key)throw new Error("play_not_configured");
  const encoder=new TextEncoder(),now=Math.floor(Date.now()/1000);
  const head=base64url(encoder.encode(JSON.stringify({alg:"RS256",typ:"JWT"})));
  const body=base64url(encoder.encode(JSON.stringify({iss:service.client_email,scope:"https://www.googleapis.com/auth/androidpublisher",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})));
  const pem=service.private_key.replace(/-----[^-]+-----/g,"").replace(/\s/g,"");
  const binary=Uint8Array.from(atob(pem),(c:string)=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey("pkcs8",binary,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,encoder.encode(head+"."+body));
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:head+"."+body+"."+base64url(new Uint8Array(sig))})});
  const data=await response.json();
  if(!response.ok||!data.access_token)throw new Error("play_auth_failed");
  cachedToken=data.access_token;tokenExpires=Date.now()+(Math.min(Number(data.expires_in)||3600,3600)-60)*1000;
  return cachedToken;
}
export async function fetchPlayPurchase(token:string){
  const response=await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}/purchases/productsv2/tokens/${encodeURIComponent(token)}`,{headers:{authorization:"Bearer "+await googleAccessToken()}});
  if(!response.ok)throw new Error(response.status===404?"purchase_not_found":"play_verification_unavailable");
  return response.json();
}
async function acknowledge(token:string,product:string){
  const response=await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}/purchases/products/${encodeURIComponent(product)}/tokens/${encodeURIComponent(token)}:acknowledge`,{method:"POST",headers:{authorization:"Bearer "+await googleAccessToken(),"content-type":"application/json"},body:"{}"});
  if(!response.ok)throw new Error("play_acknowledgement_unavailable");
}
export async function playBillingAction(action:string,body:any,ctx:any){
  const {auth,db,json,fail,loadAccount,publicProfile,founderOpen}=ctx;
  if(!["play_billing_info","play_verify_purchase","play_prepare_purchase"].includes(action))return null;
  if(auth.account.suspended_at)return fail("account_suspended",403);
  if(auth.account.terms_version!=="2026-10-03")return fail("legal_acceptance_required",403);
  if(action==="play_billing_info")return json({ok:true,configured:playBillingConfigured(),accountHash:await playAccountId(auth.account.id),products:PLAY_PRODUCTS});
  if(!playBillingConfigured())return fail("play_not_configured",503);
  const product=String(body.productId||"");
  if(!PLAY_PRODUCTS[product])return fail("product_invalid");
  if(action==="play_prepare_purchase"){
    // Leyenda has scarce handmade rewards shared with web sales. It remains unavailable
    // on Play until stock reservation and guaranteed delivery are configured.
    if(product==="arcanum_leyenda")return fail("product_unavailable",409);
    if(product==="arcanum_fundador"&&!founderOpen())return fail("tier_closed",409);
    return json({ok:true,accountHash:await playAccountId(auth.account.id)});
  }
  const token=String(body.purchaseToken||"");
  if(token.length<20||token.length>4096)return fail("purchase_token_invalid");
  const purchase=await fetchPlayPurchase(token);
  const error=validatePlayPurchase(purchase,product,await playAccountId(auth.account.id));
  if(error)return fail(error,error==="purchase_pending"?409:403);
  const {error:rpcError}=await db.rpc("rolplay_apply_play_purchase",{
    p_account_id:auth.account.id,p_token:token,p_product:product,p_order:purchase.orderId||null,
    p_test:!!purchase.testPurchaseContext,p_purchased_at:purchase.purchaseCompletionTime,
  });
  if(rpcError){if(String(rpcError.message).includes("purchase_account_mismatch"))return fail("purchase_account_mismatch",403);throw rpcError}
  if(purchase.acknowledgementState!=="ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED")await acknowledge(token,product);
  const {error:ackError}=await db.from("rolplay_play_purchases").update({acknowledged:true}).eq("purchase_token",token);
  if(ackError)throw ackError;
  return json({ok:true,profile:publicProfile(await loadAccount(auth.account.id))});
}

// Invoked only by the authenticated multiplayer server. Retry acknowledgements and revoke
// refunded/cancelled purchases without waiting for the purchaser to open the application.
export async function reconcilePlayPurchases(db:any){
  if(!playBillingConfigured())return {checked:0,skipped:true};
  const cutoff=new Date(Date.now()-60*60*1000).toISOString();
  const {data:rows,error}=await db.from("rolplay_play_purchases").select("purchase_token,product_id")
    .eq("status","purchased").or(`checked_at.lt.${cutoff},acknowledged.eq.false`).order("checked_at").limit(30);
  if(error)throw error;
  let checked=0;
  for(const row of rows||[]){
    try{
      const purchase=await fetchPlayPurchase(row.purchase_token);
      const state=purchase.purchaseStateContext?.purchaseState;
      if(state==="CANCELLED"){
        const result=await db.rpc("rolplay_revoke_play_purchase",{p_token:row.purchase_token});
        if(result.error)throw result.error;
      }else if(state==="PURCHASED"){
        if(purchase.acknowledgementState!=="ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED")await acknowledge(row.purchase_token,row.product_id);
        const result=await db.from("rolplay_play_purchases").update({acknowledged:true,checked_at:new Date().toISOString()}).eq("purchase_token",row.purchase_token);
        if(result.error)throw result.error;
      }
      checked++;
    }catch{ /* An unavailable provider must not revoke a valid entitlement. Retry later. */ }
  }
  return{checked,attempted:(rows||[]).length};
}

