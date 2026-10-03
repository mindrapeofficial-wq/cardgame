import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Admin panel API. The caller's game session (x-rolplay-session) must belong to an account in
// rolplay_admins; every change runs through the rolplay_admin_action SQL function, which checks
// the admin again, applies it atomically and records it in rolplay_admin_log.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-rolplay-session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
let secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!secretKey) {
  try { secretKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch {}
}
const db = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);
async function sha256Text(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function adminFor(req: Request) {
  const token = req.headers.get("x-rolplay-session") || "";
  if (!token.startsWith("rp_")) return null;
  const { data: session } = await db.from("rolplay_sessions").select("account_id")
    .eq("token_hash", await sha256Text(token)).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!session) return null;
  const { data: admin } = await db.from("rolplay_admins").select("account_id").eq("account_id", session.account_id).maybeSingle();
  if (!admin) return null;
  const { data: account } = await db.from("rolplay_accounts").select("id,username,suspended_at").eq("id", session.account_id).single();
  return account && !account.suspended_at ? account : null;
}
const LIST_FIELDS = "id,username,level,elo,gold,wins,losses,draws,supporter_tier,is_bot,created_at,suspended_at,suspended_until,suspension_reason,discord_username,discord_member,age_group";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ["gold", "elo", "level", "card", "supporter", "suspend", "unsuspend", "kick", "daily_pack"];
const player = (p: any) => ({
  id: p.id, name: p.username, level: p.level, elo: Number(p.elo) || 1000, gold: p.gold,
  wins: p.wins || 0, losses: p.losses || 0, draws: p.draws || 0, tier: p.supporter_tier || null,
  bot: !!p.is_bot, createdAt: p.created_at, suspendedAt: p.suspended_at || null,
  suspendedUntil: p.suspended_until || null, suspensionReason: p.suspension_reason || null,
  discord: p.discord_username || null, discordMember: !!p.discord_member, ageGroup: p.age_group || null,
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("method_not_allowed", 405);
  let body: any = {};
  try { body = await req.json(); } catch { return fail("invalid_json"); }
  try {
    const admin = await adminFor(req);
    if (!admin) return fail("forbidden", 403);
    const action = String(body.action || "");

    if (action === "whoami") return json({ ok: true, admin: { id: admin.id, name: admin.username } });

    if (action === "players") {
      const q = String(body.q || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);
      const sort = ["elo", "level", "gold", "created_at", "username_key"].includes(body.sort) ? body.sort : "created_at";
      let query = db.from("rolplay_accounts").select(LIST_FIELDS, { count: "exact" })
        .order(sort, { ascending: sort === "username_key" }).limit(Math.max(10, Math.min(200, Number(body.limit) || 100)));
      if (!body.bots) query = query.eq("is_bot", false);
      if (q) query = query.like("username_key", "%" + q + "%");
      if (body.filter === "suspended") query = query.not("suspended_at", "is", null);
      if (body.filter === "supporters") query = query.not("supporter_tier", "is", null);
      const { data, error, count } = await query;
      if (error) throw error;
      const [{ count: humans }, { count: suspended }, { count: supporters }] = await Promise.all([
        db.from("rolplay_accounts").select("id", { count: "exact", head: true }).eq("is_bot", false),
        db.from("rolplay_accounts").select("id", { count: "exact", head: true }).not("suspended_at", "is", null),
        db.from("rolplay_accounts").select("id", { count: "exact", head: true }).not("supporter_tier", "is", null),
      ]);
      return json({ ok: true, total: count || 0, stats: { humans: humans || 0, suspended: suspended || 0, supporters: supporters || 0 }, players: (data || []).map(player) });
    }

    if (action === "player") {
      const id = String(body.id || "");
      if (!UUID.test(id)) return fail("player_not_found", 404);
      const { data: p, error } = await db.from("rolplay_accounts").select(LIST_FIELDS + ",collection,deck,last_daily_pack").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!p) return fail("player_not_found", 404);
      const { data: log } = await db.from("rolplay_admin_log").select("action,details,created_at,admin:rolplay_accounts!rolplay_admin_log_admin_id_fkey(username)")
        .eq("target_id", id).order("created_at", { ascending: false }).limit(30);
      return json({ ok: true, player: { ...player(p), collection: p.collection || {}, deckSize: Array.isArray(p.deck) ? p.deck.length : 0, lastDailyPack: p.last_daily_pack },
        log: (log || []).map((l: any) => ({ action: l.action, details: l.details, at: l.created_at, by: l.admin?.username || "?" })) });
    }

    if (action === "act") {
      const target = String(body.target || ""), kind = String(body.kind || "");
      if (!UUID.test(target)) return fail("player_not_found", 404);
      if (!ACTIONS.includes(kind)) return fail("action_invalid");
      const data = body.data && typeof body.data === "object" ? body.data : {};
      const { data: updated, error } = await db.rpc("rolplay_admin_action", { p_admin: admin.id, p_target: target, p_action: kind, p_data: data });
      if (error) {
        const msg = String(error.message || "");
        for (const code of ["forbidden", "player_not_found", "amount_invalid", "level_invalid", "card_not_found", "tier_invalid", "days_invalid", "cannot_target_self", "action_invalid"]) {
          if (msg.includes(code)) return fail(code, code === "forbidden" ? 403 : 400);
        }
        throw error;
      }
      return json({ ok: true, player: player(updated) });
    }

    if (action === "log") {
      const { data, error } = await db.from("rolplay_admin_log").select("action,details,created_at,target_name,admin:rolplay_accounts!rolplay_admin_log_admin_id_fkey(username)")
        .order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return json({ ok: true, log: (data || []).map((l: any) => ({ action: l.action, details: l.details, at: l.created_at, target: l.target_name, by: l.admin?.username || "?" })) });
    }

    return fail("unknown_action", 404);
  } catch (e) {
    console.error("rolplay-admin", e);
    return fail("server_error", 500);
  }
});
