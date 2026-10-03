import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Stripe calls this endpoint after a Checkout payment (event checkout.session.completed).
// The Stripe-Signature header is verified with STRIPE_WEBHOOK_SECRET before anything is
// trusted; the payment is stored once per session id and the account keeps its highest tier.

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
let secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!secretKey) {
  try { secretKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch {}
}
const db = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

const TIER_RANK: Record<string, number> = { apoyador: 1, fundador: 2, mecenas: 3, leyenda: 4 };
const TOLERANCE_S = 5 * 60;

async function hmacHex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verify(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map(kv => kv.split("=")).filter(p => p.length === 2)) as Record<string, string>;
  const signatures = header.split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !signatures.length || Math.abs(Date.now() / 1000 - t) > TOLERANCE_S) return false;
  const expected = await hmacHex(secret, t + "." + raw);
  return signatures.some(s => safeEqual(s, expected));
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
  const raw = await req.text();
  if (!secret || !(await verify(raw, req.headers.get("stripe-signature") || "", secret))) {
    return new Response("invalid signature", { status: 400 });
  }
  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response("invalid json", { status: 400 }); }
  if (event.type !== "checkout.session.completed") return new Response("ignored", { status: 200 });

  const session = event.data && event.data.object || {};
  const accountId = String(session.metadata && session.metadata.account_id || session.client_reference_id || "");
  const tier = String(session.metadata && session.metadata.tier || "");
  if (session.payment_status !== "paid" || !TIER_RANK[tier] || !/^[0-9a-f-]{36}$/i.test(accountId)) {
    return new Response("not applicable", { status: 200 });
  }

  const { error: insertError } = await db.from("rolplay_support_payments").insert({
    session_id: String(session.id),
    account_id: accountId,
    tier,
    amount_cents: Number(session.amount_total) || 0,
    currency: String(session.currency || "eur"),
    livemode: !!event.livemode,
  });
  // Already processed (Stripe retries deliveries): nothing else to do.
  if (insertError && (insertError as any).code === "23505") return new Response("duplicate", { status: 200 });
  if (insertError) { console.error("stripe-webhook insert", insertError); return new Response("error", { status: 500 }); }

  const { data: account, error } = await db.from("rolplay_accounts").select("supporter_tier,supporter_since").eq("id", accountId).maybeSingle();
  if (error || !account) { console.error("stripe-webhook account", error); return new Response("account missing", { status: 200 }); }
  const current = TIER_RANK[account.supporter_tier || ""] || 0;
  if (TIER_RANK[tier] > current) {
    await db.from("rolplay_accounts").update({
      supporter_tier: tier,
      supporter_since: account.supporter_since || new Date().toISOString(),
    }).eq("id", accountId);
  }
  return new Response("ok", { status: 200 });
});
