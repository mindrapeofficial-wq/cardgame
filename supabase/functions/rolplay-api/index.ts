import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-rolplay-session, x-rolplay-server-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
let secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!secretKey) {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    secretKey = keys.default || "";
  } catch {}
}
if (!supabaseUrl || !secretKey) throw new Error("Missing Supabase admin credentials");
const db = createClient(supabaseUrl, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}
function fail(message: string, status = 400) {
  return json({ ok: false, error: message }, status);
}
// Settlements must come from the multiplayer server, never directly from a client.
// The server sends a shared key whose SHA-256 is stored in rolplay_server_keys.
async function isTrustedServer(req: Request) {
  const key = req.headers.get("x-rolplay-server-key") || "";
  if (key.length < 32) return false;
  const { data, error } = await db
    .from("rolplay_server_keys")
    .select("key_hash")
    .eq("key_hash", await sha256Text(key))
    .maybeSingle();
  return !error && !!data;
}
// Login/registration throttling. Failed logins are counted per username and per client IP
// (stored only as a hash); the check runs before PBKDF2 so floods cannot burn CPU either.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILS_PER_USER = 10;
const LOGIN_FAILS_PER_IP = 30;
const REGISTER_WINDOW_MS = 24 * 60 * 60 * 1000;
const REGISTRATIONS_PER_IP = 5;
function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || req.headers.get("cf-connecting-ip")
    || "unknown";
}
async function recentAttempts(kind: string, subject: string, windowMs: number) {
  const { count, error } = await db
    .from("rolplay_auth_attempts")
    .select("id", { count: "exact", head: true })
    .eq("kind", kind)
    .eq("subject", subject)
    .gte("created_at", new Date(Date.now() - windowMs).toISOString());
  if (error) throw error;
  return count || 0;
}
async function recordAttempts(rows: Array<{ kind: string; subject: string }>) {
  const { error } = await db.from("rolplay_auth_attempts").insert(rows);
  if (error) throw error;
  // Keep the table small: nothing older than the longest window is ever needed.
  await db.from("rolplay_auth_attempts")
    .delete()
    .lt("created_at", new Date(Date.now() - 2 * REGISTER_WINDOW_MS).toISOString());
}
function normalizeUsername(value: unknown) {
  return String(value || "").trim();
}
function usernameKey(value: string) {
  return value.toLowerCase();
}
function validateUsername(name: string) {
  return /^[A-Za-z0-9_-]{3,20}$/.test(name);
}
function validatePassword(password: string) {
  return password.length >= 8 && password.length <= 128;
}
function randomBytes(n: number) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function b64(bytes: Uint8Array) {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}
function unb64(s: string) {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function tokenString(bytes: Uint8Array) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256Text(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function derivePassword(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  // Deno 2's WebCrypto typings require a concrete ArrayBuffer here.
  // Copying preserves the exact salt bytes and does not change the PBKDF2 result.
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations: 180000 },
    material,
    256,
  );
  return b64(new Uint8Array(bits));
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function xpNeeded(level: number) {
  const l = Math.max(1, Math.min(50, Number(level) || 1));
  return l >= 50 ? 0 : 100 + 35 * (l - 1) + 5 * (l - 1) * (l - 1);
}
function publicProfile(a: any) {
  return {
    id: a.id,
    name: a.username,
    level: a.level,
    xp: a.xp,
    xpRequired: xpNeeded(a.level),
    totalXp: a.total_xp,
    coins: a.gold,
    wins: a.wins,
    losses: a.losses,
    draws: a.draws || 0,
    elo: Number(a.elo) || 1000,
    rankedMatches: Number(a.ranked_matches) || 0,
    eloEver2400: !!a.elo_ever_2400,
    collection: a.collection || {},
    deck: Array.isArray(a.deck) ? a.deck : [],
    packs: a.packs || 0,
    createdAt: a.created_at,
  };
}
async function createSession(accountId: string) {
  const raw = "rp_" + tokenString(randomBytes(32));
  const hash = await sha256Text(raw);
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from("rolplay_sessions").insert({
    token_hash: hash,
    account_id: accountId,
    expires_at: expires,
  });
  if (error) throw error;
  return raw;
}
async function authenticateToken(token: string) {
  if (!token.startsWith("rp_")) return null;
  const hash = await sha256Text(token);
  const now = new Date().toISOString();
  const { data: session, error: se } = await db
    .from("rolplay_sessions")
    .select("account_id,expires_at")
    .eq("token_hash", hash)
    .gt("expires_at", now)
    .maybeSingle();
  if (se || !session) return null;
  const { data: account, error } = await db
    .from("rolplay_accounts")
    .select("*")
    .eq("id", session.account_id)
    .single();
  if (error || !account) return null;
  return { token, hash, account };
}
async function authenticate(req: Request) {
  return authenticateToken(req.headers.get("x-rolplay-session") || "");
}
async function loadAccount(id: string) {
  const { data, error } = await db.from("rolplay_accounts").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}
const RARITY_WEIGHT: Record<string, number> = {
  common: 1.0,
  uncommon: 0.75,
  rare: 0.48,
  epic: 0.22,
  legendary: 1.0,
};
const LEGENDARY_MASS = 0.2;
// Ponderación privada de los Poderes avanzados. Está deliberadamente entre
// Poco común (0.75) y Rara (0.48) y no altera la rareza visible de la carta.
const ADVANCED_POWER_WEIGHT = 0.60;
function isAdvancedPower(c: any) {
  return !!c?.is_power && Number(c?.level || 1) > 1;
}

function packDistribution(cards: any[], packLevel: number) {
  if (!cards.length) throw new Error("No eligible cards");

  if (packLevel === 1) {
    const fixed = cards
      .map(c => ({ card: c, chance: Math.max(0, Number(c.level_one_drop_pct) || 0) }))
      .filter(x => x.chance > 0);
    const total = fixed.reduce((sum, x) => sum + x.chance, 0);
    if (fixed.length && total > 0) {
      return fixed.map(x => ({ card: x.card, chance: x.chance / total * 100 }));
    }
  }

  const scores = cards.map(c => Math.max(0.0001, Number(c.gameplay_score) || 1));
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const strengthModifier = (c: any) => {
    const score = Math.max(0.0001, Number(c.gameplay_score) || 1);
    const norm = maxScore === minScore ? 0.5 : (score - minScore) / (maxScore - minScore);
    return 1.12 - 0.24 * norm;
  };
  const levelAffinity = (c: any) =>
    Math.exp(-0.55 * Math.max(0, packLevel - Number(c.level || 1)));

  // Los Poderes avanzados no usan el bucket de rareza histórico para el loot.
  // Su rareza sigue siendo visible en catálogo, pero su peso de aparición es propio.
  const legendary = cards.filter(c =>
    !isAdvancedPower(c) && String(c.rarity_tier || "common") === "legendary"
  );
  const normal = cards.filter(c =>
    isAdvancedPower(c) || String(c.rarity_tier || "common") !== "legendary"
  );
  const legendaryMass = legendary.length ? LEGENDARY_MASS : 0;
  const normalMass = 100 - legendaryMass;
  const out: Array<{card:any,chance:number}> = [];

  const normalWeighted = normal.map(c => ({
    card: c,
    weight:
      levelAffinity(c) *
      (isAdvancedPower(c)
        ? ADVANCED_POWER_WEIGHT
        : (RARITY_WEIGHT[String(c.rarity_tier || "common")] || 1)) *
      strengthModifier(c),
  }));
  const normalTotal = normalWeighted.reduce((sum, x) => sum + x.weight, 0);
  if (normalWeighted.length && normalTotal > 0) {
    for (const entry of normalWeighted) {
      out.push({
        card: entry.card,
        chance: normalMass * entry.weight / normalTotal,
      });
    }
  }

  if (legendary.length) {
    const legendaryWeighted = legendary.map(c => ({
      card: c,
      weight: levelAffinity(c) * strengthModifier(c),
    }));
    const legendaryTotal = legendaryWeighted.reduce((sum, x) => sum + x.weight, 0);
    for (const entry of legendaryWeighted) {
      out.push({
        card: entry.card,
        chance: legendaryMass * entry.weight / legendaryTotal,
      });
    }
  }

  const total = out.reduce((sum, x) => sum + x.chance, 0);
  return out.map(x => ({ card: x.card, chance: total > 0 ? x.chance / total * 100 : 0 }));
}

function drawFromDistribution(dist: Array<{card:any,chance:number}>) {
  if (!dist.length) throw new Error("No eligible cards");
  let roll = Math.random() * 100;
  for (const entry of dist) {
    roll -= entry.chance;
    if (roll < 0) return entry.card;
  }
  return dist[dist.length - 1].card;
}

async function validateDeck(account: any, rawDeck: unknown) {
  if (!Array.isArray(rawDeck)) throw new Error("deck_invalid");
  const deck = rawDeck.map(Number);
  if (deck.length > 50) throw new Error("deck_too_large");
  if (deck.some(id => !Number.isInteger(id) || id < 1)) throw new Error("deck_invalid");

  const ids = [...new Set(deck)];
  if (!ids.length) return [];
  const { data: cards, error } = await db
    .from("rolplay_cards")
    .select("id,level,is_power")
    .in("id", ids);
  if (error) throw error;
  if ((cards || []).length !== ids.length) throw new Error("unknown_card");

  const byId = new Map((cards || []).map((c: any) => [Number(c.id), c]));
  const counts: Record<string, number> = {};
  for (const id of deck) {
    const c: any = byId.get(id);
    if (!c || c.level > account.level) throw new Error("card_above_player_level");
    if (c.is_power && c.level === 1) continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(counts)) {
    const have = Number((account.collection || {})[id] || 0);
    if (count > have) throw new Error("not_enough_copies");
  }
  return deck;
}


function cleanDeckName(value: unknown) {
  return String(value || "").replace(/[<>\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30);
}
async function savedDecksFor(accountId: string) {
  const { data, error } = await db
    .from("rolplay_decks")
    .select("id,name,cards,is_active,created_at,updated_at")
    .eq("account_id", accountId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []).map((d: any) => ({
    id: d.id,
    name: d.name,
    cards: Array.isArray(d.cards) ? d.cards.map(Number) : [],
    isActive: !!d.is_active,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("method_not_allowed", 405);

  let body: any = {};
  try { body = await req.json(); } catch { return fail("invalid_json"); }
  const action = String(body.action || "");

  try {
    if (action === "register") {
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      if (!validateUsername(username)) return fail("username_invalid");
      if (!validatePassword(password)) return fail("password_invalid");
      const ipKey = await sha256Text("ip:" + clientIp(req));
      if (await recentAttempts("register_ip", ipKey, REGISTER_WINDOW_MS) >= REGISTRATIONS_PER_IP) {
        return fail("too_many_registrations", 429);
      }

      const key = usernameKey(username);
      const { data: existing } = await db
        .from("rolplay_accounts")
        .select("id")
        .eq("username_key", key)
        .maybeSingle();
      if (existing) return fail("username_taken", 409);

      const salt = randomBytes(16);
      const hash = await derivePassword(password, salt);
      const { data: account, error } = await db
        .from("rolplay_accounts")
        .insert({
          username,
          username_key: key,
          password_hash: hash,
          password_salt: b64(salt),
          level: 1,
          xp: 0,
          total_xp: 0,
          gold: 100,
          wins: 0,
          losses: 0,
          elo: 1000,
          ranked_matches: 0,
          elo_ever_2400: false,
          collection: {},
          deck: [],
          packs: 0,
        })
        .select("*")
        .single();
      if (error) {
        if ((error as any).code === "23505") return fail("username_taken", 409);
        throw error;
      }
      await recordAttempts([{ kind: "register_ip", subject: ipKey }]);
      const token = await createSession(account.id);
      return json({ ok: true, token, profile: publicProfile(account) }, 201);
    }

    if (action === "login") {
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      const key = usernameKey(username).slice(0, 40);
      const ipKey = await sha256Text("ip:" + clientIp(req));
      const [userFails, ipFails] = await Promise.all([
        recentAttempts("login_fail_user", key, LOGIN_WINDOW_MS),
        recentAttempts("login_fail_ip", ipKey, LOGIN_WINDOW_MS),
      ]);
      if (userFails >= LOGIN_FAILS_PER_USER || ipFails >= LOGIN_FAILS_PER_IP) {
        return fail("too_many_attempts", 429);
      }
      const loginFailed = async () => {
        await recordAttempts([
          { kind: "login_fail_user", subject: key },
          { kind: "login_fail_ip", subject: ipKey },
        ]);
        return fail("invalid_credentials", 401);
      };

      const { data: account, error } = await db
        .from("rolplay_accounts")
        .select("*")
        .eq("username_key", key)
        .maybeSingle();
      if (error || !account) return await loginFailed();
      const derived = await derivePassword(password, unb64(account.password_salt));
      if (!safeEqual(derived, account.password_hash)) return await loginFailed();
      await db.from("rolplay_auth_attempts").delete().eq("kind", "login_fail_user").eq("subject", key);
      const token = await createSession(account.id);
      return json({ ok: true, token, profile: publicProfile(account) });
    }

    if (action === "synthetic_provision") {
      if (!(await isTrustedServer(req))) return fail("server_key_invalid", 403);
      const username = normalizeUsername(body.username);
      if (!validateUsername(username)) return fail("username_invalid");
      const key = usernameKey(username);

      const { data: existing, error: existingError } = await db
        .from("rolplay_accounts")
        .select("*")
        .eq("username_key", key)
        .maybeSingle();
      if (existingError) throw existingError;

      if (existing) {
        if (!existing.is_bot) return fail("username_reserved", 409);
        const token = await createSession(existing.id);
        return json({ ok: true, token, profile: publicProfile(existing), existing: true });
      }

      const salt = randomBytes(16);
      const generatedPassword = tokenString(randomBytes(48));
      const hash = await derivePassword(generatedPassword, salt);
      const { data: account, error } = await db
        .from("rolplay_accounts")
        .insert({
          username,
          username_key: key,
          password_hash: hash,
          password_salt: b64(salt),
          level: 1,
          xp: 0,
          total_xp: 0,
          gold: 100,
          wins: 0,
          losses: 0,
          draws: 0,
          elo: 1000,
          ranked_matches: 0,
          elo_ever_2400: false,
          collection: {},
          deck: [],
          packs: 0,
          is_bot: true,
        })
        .select("*")
        .single();
      if (error) {
        if ((error as any).code === "23505") return fail("username_taken", 409);
        throw error;
      }
      const token = await createSession(account.id);
      return json({ ok: true, token, profile: publicProfile(account), existing: false }, 201);
    }

    if (action === "settle_match") {
      if (!(await isTrustedServer(req))) return fail("server_key_invalid", 403);
      const matchKey = String(body.matchKey || "").slice(0, 120);
      if (!/^[A-Za-z0-9:_-]{8,120}$/.test(matchKey)) return fail("match_key_invalid");
      const aAuth = await authenticateToken(String(body.sessionA || ""));
      const bAuth = await authenticateToken(String(body.sessionB || ""));
      if (!aAuth || !bAuth || aAuth.account.id === bAuth.account.id) return fail("match_auth_invalid", 401);

      const outcome = body.outcome === "a" || body.outcome === "b" || body.outcome === "draw" ? body.outcome : "";
      if (!outcome) return fail("invalid_outcome");

      const levelA = Math.max(1, Math.min(50, Number(aAuth.account.level) || 1));
      const levelB = Math.max(1, Math.min(50, Number(bAuth.account.level) || 1));
      const clampInt = (n:number,min:number,max:number) => Math.max(min, Math.min(max, Math.round(n)));

      const rewardFor = (side:"a"|"b", ownLevel:number, oppLevel:number) => {
        if (outcome === "draw") {
          return {
            result: "draw",
            xp: clampInt(8 + 2 * (oppLevel - ownLevel), 3, 20),
            gold: 5,
          };
        }
        if (outcome === side) {
          return {
            result: "win",
            xp: clampInt(40 + 4 * (oppLevel - ownLevel), 20, 70),
            gold: 15,
          };
        }
        return {
          result: "loss",
          xp: -clampInt(15 + 3 * (ownLevel - oppLevel), 5, 30),
          gold: 0,
        };
      };

      const rewardA = rewardFor("a", levelA, levelB);
      const rewardB = rewardFor("b", levelB, levelA);

      const { data, error } = await db.rpc("rolplay_settle_match", {
        p_match_key: matchKey,
        p_account_a: aAuth.account.id,
        p_account_b: bAuth.account.id,
        p_outcome: outcome,
        p_xp_a: rewardA.xp,
        p_gold_a: rewardA.gold,
        p_xp_b: rewardB.xp,
        p_gold_b: rewardB.gold,
      });
      if (error) return fail(String((error as any).message || "match_settlement_failed"));

      return json({
        ok: true,
        duplicate: !!data.duplicate,
        profileA: publicProfile(data.a),
        profileB: publicProfile(data.b),
        rewardA: { ...rewardA, eloDelta: Number(data.eloDeltaA) || 0, eloBefore: Number(data.eloBeforeA) || 1000, eloAfter: Number(data.eloAfterA) || 1000 },
        rewardB: { ...rewardB, eloDelta: Number(data.eloDeltaB) || 0, eloBefore: Number(data.eloBeforeB) || 1000, eloAfter: Number(data.eloAfterB) || 1000 },
      });
    }

    if (action === "settle_trade") {
      if (!(await isTrustedServer(req))) return fail("server_key_invalid", 403);
      const tradeKey = String(body.tradeKey || "").slice(0, 120);
      if (!/^[A-Za-z0-9:_-]{8,120}$/.test(tradeKey)) return fail("trade_key_invalid");
      const aAuth = await authenticateToken(String(body.sessionA || ""));
      const bAuth = await authenticateToken(String(body.sessionB || ""));
      if (!aAuth || !bAuth || aAuth.account.id === bAuth.account.id) return fail("trade_auth_invalid", 401);
      const cardsA = Array.isArray(body.cardsA) ? body.cardsA.map(Number).slice(0, 20) : [];
      const cardsB = Array.isArray(body.cardsB) ? body.cardsB.map(Number).slice(0, 20) : [];
      const goldA = Math.max(0, Math.floor(Number(body.goldA) || 0));
      const goldB = Math.max(0, Math.floor(Number(body.goldB) || 0));
      const { data, error } = await db.rpc("rolplay_settle_trade", {
        p_trade_key: tradeKey,
        p_account_a: aAuth.account.id,
        p_account_b: bAuth.account.id,
        p_cards_a: cardsA,
        p_gold_a: goldA,
        p_cards_b: cardsB,
        p_gold_b: goldB,
      });
      if (error) return fail(String((error as any).message || "trade_failed"));
      return json({
        ok: true,
        profileA: publicProfile(data.a),
        profileB: publicProfile(data.b),
        duplicate: !!data.duplicate,
      });
    }

    // Simulated players (rolplay_accounts.is_bot) are driven by the multiplayer server. They have
    // no usable password; only the trusted server can list them and open a session for one.
    if (action === "bot_roster") {
      if (!(await isTrustedServer(req))) return fail("server_key_invalid", 403);
      const { data, error } = await db
        .from("rolplay_accounts")
        .select("username,level")
        .eq("is_bot", true)
        .order("username_key");
      if (error) throw error;
      return json({ ok: true, bots: (data || []).map((b: any) => ({ name: b.username, level: Number(b.level) || 1 })) });
    }
    if (action === "bot_session") {
      if (!(await isTrustedServer(req))) return fail("server_key_invalid", 403);
      const key = usernameKey(normalizeUsername(body.username)).slice(0, 40);
      const { data: account, error } = await db
        .from("rolplay_accounts")
        .select("*")
        .eq("username_key", key)
        .eq("is_bot", true)
        .maybeSingle();
      if (error) throw error;
      if (!account) return fail("bot_not_found", 404);
      // One live session per bot: drop the previous ones so they do not pile up.
      await db.from("rolplay_sessions").delete().eq("account_id", account.id);
      const token = await createSession(account.id);
      return json({ ok: true, token, profile: publicProfile(account) });
    }

    const auth = await authenticate(req);
    if (!auth) return fail("unauthorized", 401);

    if (action === "market_list") {
      const limit = Math.max(10, Math.min(200, Math.floor(Number(body.limit) || 100)));
      const { data: rows, error } = await db
        .from("rolplay_market_listings")
        .select("id,seller_id,card_id,kind,price_gold,wanted_card_id,created_at")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;

      const sellerIds = [...new Set((rows || []).map((x: any) => String(x.seller_id)))];
      const cardIds = [...new Set((rows || []).flatMap((x: any) => [Number(x.card_id), x.wanted_card_id == null ? null : Number(x.wanted_card_id)]).filter((x: any) => Number.isInteger(x)))];

      const [sellerResult, cardResult] = await Promise.all([
        sellerIds.length
          ? db.from("rolplay_accounts").select("id,username,level").in("id", sellerIds)
          : Promise.resolve({ data: [], error: null } as any),
        cardIds.length
          ? db.from("rolplay_cards").select("id,name,level,rarity,is_power,is_ability").in("id", cardIds)
          : Promise.resolve({ data: [], error: null } as any),
      ]);
      if (sellerResult.error) throw sellerResult.error;
      if (cardResult.error) throw cardResult.error;

      const sellers = new Map((sellerResult.data || []).map((x: any) => [String(x.id), x]));
      const cards = new Map((cardResult.data || []).map((x: any) => [Number(x.id), x]));

      const listings = (rows || []).map((x: any) => {
        const seller: any = sellers.get(String(x.seller_id));
        const offered: any = cards.get(Number(x.card_id));
        const wanted: any = x.wanted_card_id == null ? null : cards.get(Number(x.wanted_card_id));
        return {
          id: x.id,
          sellerId: x.seller_id,
          sellerName: seller?.username || "Jugador",
          sellerLevel: Number(seller?.level) || 1,
          cardId: Number(x.card_id),
          cardName: offered?.name || "Carta",
          cardLevel: Number(offered?.level) || 1,
          kind: x.kind,
          priceGold: x.price_gold == null ? null : Number(x.price_gold),
          wantedCardId: x.wanted_card_id == null ? null : Number(x.wanted_card_id),
          wantedCardName: wanted?.name || null,
          wantedCardLevel: wanted ? Number(wanted.level) || 1 : null,
          createdAt: x.created_at,
        };
      });

      return json({ ok: true, listings });
    }

    if (action === "market_publish") {
      const cardId = Number(body.cardId);
      const kind = body.kind === "gold" ? "gold" : body.kind === "trade" ? "trade" : "";
      if (!Number.isInteger(cardId) || !kind) return fail("market_listing_invalid");
      const priceGold = kind === "gold" ? Math.floor(Number(body.priceGold) || 0) : null;
      const wantedCardId = kind === "trade" ? Number(body.wantedCardId) : null;
      if (kind === "trade" && !Number.isInteger(wantedCardId)) return fail("wanted_card_required");

      const { data, error } = await db.rpc("rolplay_create_market_listing", {
        p_account: auth.account.id,
        p_card_id: cardId,
        p_kind: kind,
        p_price_gold: priceGold,
        p_wanted_card_id: wantedCardId,
      });
      if (error) return fail(String((error as any).message || "market_publish_failed"));
      const fresh = await loadAccount(auth.account.id);
      return json({ ok: true, listingId: data, profile: publicProfile(fresh) });
    }

    if (action === "market_cancel") {
      const listingId = String(body.listingId || "");
      if (!/^[0-9a-f-]{36}$/i.test(listingId)) return fail("market_listing_invalid");
      const { error } = await db.rpc("rolplay_cancel_market_listing", {
        p_account: auth.account.id,
        p_listing_id: listingId,
      });
      if (error) return fail(String((error as any).message || "market_cancel_failed"));
      const fresh = await loadAccount(auth.account.id);
      return json({ ok: true, profile: publicProfile(fresh) });
    }

    if (action === "market_accept") {
      const listingId = String(body.listingId || "");
      if (!/^[0-9a-f-]{36}$/i.test(listingId)) return fail("market_listing_invalid");
      const { data, error } = await db.rpc("rolplay_accept_market_listing", {
        p_buyer: auth.account.id,
        p_listing_id: listingId,
      });
      if (error) return fail(String((error as any).message || "market_accept_failed"));
      const fresh = await loadAccount(auth.account.id);
      return json({ ok: true, result: data, profile: publicProfile(fresh) });
    }

    if (action === "list_decks") {
      const decks = await savedDecksFor(auth.account.id);
      return json({ ok: true, decks });
    }

    if (action === "save_named_deck") {
      const name = cleanDeckName(body.name);
      if (!name) return fail("deck_name_invalid");
      let cards: number[];
      try { cards = await validateDeck(auth.account, body.cards); }
      catch (e) { return fail(String((e as Error).message || "deck_invalid")); }

      const deckId = String(body.deckId || "");
      const { count, error: countError } = await db
        .from("rolplay_decks")
        .select("id", { count: "exact", head: true })
        .eq("account_id", auth.account.id);
      if (countError) throw countError;

      if (!deckId && (count || 0) >= 12) return fail("deck_limit_reached");

      await db.from("rolplay_decks")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("account_id", auth.account.id);

      let saved: any = null;
      if (deckId) {
        const { data, error } = await db
          .from("rolplay_decks")
          .update({ name, cards, is_active: true, updated_at: new Date().toISOString() })
          .eq("id", deckId)
          .eq("account_id", auth.account.id)
          .select("*")
          .maybeSingle();
        if (error) {
          if ((error as any).code === "23505") return fail("deck_name_taken", 409);
          throw error;
        }
        if (!data) return fail("deck_not_found", 404);
        saved = data;
      } else {
        const { data, error } = await db
          .from("rolplay_decks")
          .insert({
            account_id: auth.account.id,
            name,
            cards,
            is_active: true,
          })
          .select("*")
          .single();
        if (error) {
          if ((error as any).code === "23505") return fail("deck_name_taken", 409);
          throw error;
        }
        saved = data;
      }

      const { data: account, error: accountError } = await db
        .from("rolplay_accounts")
        .update({ deck: cards, updated_at: new Date().toISOString() })
        .eq("id", auth.account.id)
        .select("*")
        .single();
      if (accountError) throw accountError;

      return json({
        ok: true,
        deck: {
          id: saved.id,
          name: saved.name,
          cards: Array.isArray(saved.cards) ? saved.cards.map(Number) : [],
          isActive: true,
          createdAt: saved.created_at,
          updatedAt: saved.updated_at,
        },
        profile: publicProfile(account),
        decks: await savedDecksFor(auth.account.id),
      });
    }

    if (action === "activate_deck") {
      const deckId = String(body.deckId || "");
      const { data: saved, error } = await db
        .from("rolplay_decks")
        .select("*")
        .eq("id", deckId)
        .eq("account_id", auth.account.id)
        .maybeSingle();
      if (error) throw error;
      if (!saved) return fail("deck_not_found", 404);

      let cards: number[];
      try { cards = await validateDeck(auth.account, saved.cards); }
      catch (e) { return fail(String((e as Error).message || "deck_invalid")); }

      await db.from("rolplay_decks")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("account_id", auth.account.id);
      await db.from("rolplay_decks")
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq("id", deckId)
        .eq("account_id", auth.account.id);

      const { data: account, error: accountError } = await db
        .from("rolplay_accounts")
        .update({ deck: cards, updated_at: new Date().toISOString() })
        .eq("id", auth.account.id)
        .select("*")
        .single();
      if (accountError) throw accountError;

      return json({ ok: true, profile: publicProfile(account), decks: await savedDecksFor(auth.account.id) });
    }

    if (action === "new_deck_draft") {
      const now = new Date().toISOString();
      await db.from("rolplay_decks")
        .update({ is_active: false, updated_at: now })
        .eq("account_id", auth.account.id);

      const { data: account, error } = await db
        .from("rolplay_accounts")
        .update({ deck: [], updated_at: now })
        .eq("id", auth.account.id)
        .select("*")
        .single();
      if (error) throw error;

      return json({ ok: true, profile: publicProfile(account), decks: await savedDecksFor(auth.account.id) });
    }

    if (action === "delete_deck") {
      const deckId = String(body.deckId || "");
      const { data: existing, error: readError } = await db
        .from("rolplay_decks")
        .select("id,is_active")
        .eq("id", deckId)
        .eq("account_id", auth.account.id)
        .maybeSingle();
      if (readError) throw readError;
      if (!existing) return fail("deck_not_found", 404);

      const { error } = await db
        .from("rolplay_decks")
        .delete()
        .eq("id", deckId)
        .eq("account_id", auth.account.id);
      if (error) throw error;

      // Si se borra el activo, conservamos el mazo de juego actual hasta que el usuario active otro.
      return json({ ok: true, decks: await savedDecksFor(auth.account.id) });
    }

    if (action === "me") {
      return json({ ok: true, profile: publicProfile(auth.account) });
    }

    if (action === "ranking") {
      const limit = Math.max(10, Math.min(100, Math.floor(Number(body.limit) || 50)));
      const { data: leaders, error } = await db
        .from("rolplay_accounts")
        .select("id,username,level,wins,draws,losses,elo,ranked_matches,elo_ever_2400,username_key")
        .order("elo", { ascending: false })
        .order("wins", { ascending: false })
        .order("username_key", { ascending: true })
        .limit(limit);
      if (error) throw error;

      const ranking = (leaders || []).map((p: any, i: number) => ({
        position: i + 1,
        id: p.id,
        name: p.username,
        level: Number(p.level) || 1,
        wins: Number(p.wins) || 0,
        draws: Number(p.draws) || 0,
        losses: Number(p.losses) || 0,
        elo: Number(p.elo) || 1000,
        rankedMatches: Number(p.ranked_matches) || 0,
        eloEver2400: !!p.elo_ever_2400,
      }));

      let myRank = ranking.find((p: any) => p.id === auth.account.id)?.position || null;
      if (!myRank) {
        const { count, error: countError } = await db
          .from("rolplay_accounts")
          .select("id", { count: "exact", head: true })
          .gt("elo", Number(auth.account.elo) || 1000);
        if (countError) throw countError;
        myRank = (count || 0) + 1;
      }
      return json({ ok: true, ranking, myRank });
    }

    if (action === "logout") {
      await db.from("rolplay_sessions").delete().eq("token_hash", auth.hash);
      return json({ ok: true });
    }

    if (action === "pack_odds") {
      const packLevel = Math.max(1, Math.floor(Number(body.packLevel) || auth.account.level));
      if (packLevel > auth.account.level) return fail("pack_level_locked");
      const { data: eligible, error } = await db
        .from("rolplay_cards")
        .select("id,name,level,rarity,rarity_tier,level_one_drop_pct,gameplay_score,is_power,is_ability")
        .lte("level", packLevel);
      if (error) throw error;
      const pool = (eligible || []).filter((c: any) => !(c.is_power && c.level === 1));
      if (!pool.length) return fail("no_cards_for_level");
      const dist = packDistribution(pool, packLevel)
        .sort((a,b) => b.chance - a.chance)
        .map(x => ({
          id: Number(x.card.id),
          name: x.card.name,
          level: Number(x.card.level),
          tier: String(x.card.rarity_tier || "common"),
          chance: Number(x.chance.toFixed(6)),
        }));
      return json({ ok: true, packLevel, odds: dist });
    }

    if (action === "buy_pack") {
      const packLevel = Math.max(1, Math.floor(Number(body.packLevel) || auth.account.level));
      if (packLevel > auth.account.level) return fail("pack_level_locked");
      if (auth.account.gold < 20) return fail("not_enough_gold");
      const { data: eligible, error } = await db
        .from("rolplay_cards")
        .select("id,name,level,rarity,rarity_tier,level_one_drop_pct,gameplay_score,is_power,is_ability")
        .lte("level", packLevel);
      if (error) throw error;
      const pool = (eligible || []).filter((c: any) => !(c.is_power && c.level === 1));
      if (!pool.length) return fail("no_cards_for_level");
      const dist = packDistribution(pool, packLevel);
      const pulled = Array.from({ length: 5 }, () => drawFromDistribution(dist));
      const ids = pulled.map((c: any) => Number(c.id));
      const { data, error: rpcError } = await db.rpc("rolplay_buy_pack", {
        p_account: auth.account.id,
        p_card_ids: ids,
        p_price: 20,
      });
      if (rpcError) throw rpcError;
      const fresh = await loadAccount(auth.account.id);
      return json({ ok: true, packLevel, cards: pulled, profile: publicProfile(fresh) });
    }

    if (action === "sell_card") {
      const cardId = Number(body.cardId);
      const { data: c, error: ce } = await db
        .from("rolplay_cards")
        .select("id,level,rarity,is_power")
        .eq("id", cardId)
        .single();
      if (ce || !c) return fail("card_not_found");
      if (c.is_power && c.level === 1) return fail("basic_power_is_infinite");
      const baseValue = Math.max(1, Math.round(c.level / 2) + Math.round(c.rarity / 20));
      const value = Math.max(1, Math.floor(baseValue / 2));
      const { data, error } = await db.rpc("rolplay_sell_card", {
        p_account: auth.account.id,
        p_card_id: cardId,
        p_value: value,
      });
      if (error) return fail(String((error as any).message || "sell_failed"));
      const fresh = await loadAccount(auth.account.id);
      return json({ ok: true, soldFor: value, profile: publicProfile(fresh) });
    }

    if (action === "save_deck") {
      let deck: number[];
      try { deck = await validateDeck(auth.account, body.deck); }
      catch (e) { return fail(String((e as Error).message || "deck_invalid")); }
      const now = new Date().toISOString();
      const { data, error } = await db
        .from("rolplay_accounts")
        .update({ deck, updated_at: now })
        .eq("id", auth.account.id)
        .select("*")
        .single();
      if (error) throw error;

      // Si hay un mazo guardado activo, los cambios del constructor se sincronizan con él.
      await db
        .from("rolplay_decks")
        .update({ cards: deck, updated_at: now })
        .eq("account_id", auth.account.id)
        .eq("is_active", true);

      return json({ ok: true, profile: publicProfile(data) });
    }

    if (action === "award_result") {
      const rewardKey = String(body.rewardKey || "").slice(0, 120);
      if (!/^[A-Za-z0-9:_-]{8,120}$/.test(rewardKey)) return fail("reward_key_invalid");
      const win = body.win === true;
      const result = win ? "training_win" : "training_loss";

      // Training is client-reported, so it never changes XP, level, ELO or PvP stats,
      // and its small gold reward is capped atomically in rolplay_award_training.
      const { data, error } = await db.rpc("rolplay_award_training", {
        p_account: auth.account.id,
        p_reward_key: rewardKey,
        p_win: win,
      });
      if (error) throw error;
      return json({
        ok: true,
        xpAwarded: 0,
        goldAwarded: Number(data.gold) || 0,
        limited: !!data.limited,
        result,
        profile: publicProfile(data.account),
      });
    }

    return fail("unknown_action", 404);
  } catch (e) {
    console.error("rolplay-api", e);
    return fail("server_error", 500);
  }
});
