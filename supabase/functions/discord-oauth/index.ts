import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Discord OAuth2 callback for "Vincular Discord". rolplay-api (discord_link_start) creates a
// one-time state tied to the game account and sends the player to Discord; Discord comes back
// here with ?code&state. We exchange the code, read the Discord user and whether they are a
// member of the ARCANUM server, store it on the account, give them their supporter role with
// the bot, and send them back to the game.

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
let secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!secretKey) {
  try { secretKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch {}
}
const db = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

const CLIENT_ID = Deno.env.get("DISCORD_CLIENT_ID") || "1555291864415080628";
const GUILD_ID = Deno.env.get("DISCORD_GUILD_ID") || "1555246692599599185";
const SITE_URL = Deno.env.get("ROLPLAY_SITE_URL") || "https://cardgame-l9ld.onrender.com";
const REDIRECT_URI = supabaseUrl + "/functions/v1/discord-oauth";
const API = "https://discord.com/api/v10";
const STATE_TTL_MS = 10 * 60 * 1000;

const SUPPORT_ROLES: Record<string, { name: string; color: number }> = {
  apoyador: { name: "Apoyador", color: 0xc98a52 },
  fundador: { name: "Fundador", color: 0xf2cf73 },
  mecenas: { name: "Mecenas", color: 0xc49bff },
  leyenda: { name: "Leyenda", color: 0x9b6bff },
};

const back = (result: string) => Response.redirect(SITE_URL + "/?discord=" + result, 302);

// Gives the member the role of their supporter tier, creating the role the first time.
async function syncSupporterRole(discordUserId: string, tier: string | null) {
  const token = Deno.env.get("DISCORD_BOT_TOKEN") || "";
  const role = tier && SUPPORT_ROLES[tier];
  if (!token || !role) return;
  const headers = { authorization: "Bot " + token, "content-type": "application/json" };
  const roles = await fetch(`${API}/guilds/${GUILD_ID}/roles`, { headers }).then(r => r.ok ? r.json() : []);
  let found = (roles as any[]).find(r => r.name === role.name);
  if (!found) {
    const res = await fetch(`${API}/guilds/${GUILD_ID}/roles`, { method: "POST", headers, body: JSON.stringify({ name: role.name, color: role.color, hoist: true }) });
    if (!res.ok) { console.error("discord create role", res.status, await res.text()); return; }
    found = await res.json();
  }
  const res = await fetch(`${API}/guilds/${GUILD_ID}/members/${discordUserId}/roles/${found.id}`, { method: "PUT", headers });
  if (!res.ok && res.status !== 204) console.error("discord add role", res.status, await res.text());
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (url.searchParams.get("error")) return back("cancelled");
  if (!code || !/^[A-Za-z0-9_-]{20,80}$/.test(state)) return back("error");

  // One-time state: consume it whatever happens next.
  const { data: row } = await db.from("rolplay_discord_states").delete().eq("state", state).select("account_id,created_at").maybeSingle();
  if (!row || Date.now() - new Date(row.created_at).getTime() > STATE_TTL_MS) return back("expired");

  const secret = Deno.env.get("DISCORD_CLIENT_SECRET") || "";
  if (!secret) return back("not_configured");
  const tokenRes = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: secret, grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) { console.error("discord token", tokenRes.status, tokenData); return back("error"); }
  const auth = { authorization: "Bearer " + tokenData.access_token };

  const me = await fetch(`${API}/users/@me`, { headers: auth }).then(r => r.ok ? r.json() : null);
  if (!me || !me.id) return back("error");
  const memberRes = await fetch(`${API}/users/@me/guilds/${GUILD_ID}/member`, { headers: auth });
  const member = memberRes.ok;

  const { data: owner } = await db.from("rolplay_accounts").select("id").eq("discord_user_id", String(me.id)).maybeSingle();
  if (owner && owner.id !== row.account_id) return back("taken");

  const { data: account, error } = await db.from("rolplay_accounts").update({
    discord_user_id: String(me.id),
    discord_username: String(me.global_name || me.username || "").slice(0, 40),
    discord_member: member,
    discord_linked_at: new Date().toISOString(),
  }).eq("id", row.account_id).select("supporter_tier").single();
  if (error) { console.error("discord link", error); return back("error"); }

  if (member) {
    try { await syncSupporterRole(String(me.id), account.supporter_tier); } catch (e) { console.error("discord role", e); }
  }
  return back(member ? "linked" : "not_member");
});
