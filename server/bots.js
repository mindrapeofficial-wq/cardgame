"use strict";
// Simulated players. Each bot is a real account (rolplay_accounts.is_bot) that starts like any
// new player: level 1, 100 gold, no cards. The runner connects them to this same server through
// socket.io exactly like a browser, so they go through the normal lobby, duel, settlement,
// shop and ranking code. They come and go during the day, open packs, rebuild their deck and
// play with human-like reaction times.
//
// Enabled with BOTS_ENABLED=1. Optional: BOTS_MIN / BOTS_MAX (online population range).

const { io: connect } = require("socket.io-client");
const { createBotChat } = require("./bot-chat.js");

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const chance = p => Math.random() < p;
const pick = list => list[Math.floor(Math.random() * list.length)];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Stable personality per name, so a bot keeps its style across server restarts.
function seeded(name) {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
function personality(name) {
  const r = seeded(name);
  return {
    skill: 0.55 + r() * 0.42,          // chance of taking the best decision
    speed: 0.7 + r() * 0.9,            // multiplier on reaction times
    aggression: r(),                   // willingness to attack into even trades
    spender: r(),                      // > 0.5 opens packs as soon as possible
    deckSize: 20 + Math.floor(r() * 8),
    sessionMinutes: 25 + r() * 80,
    chatty: r() * 0.35,
    host: r()                          // tendency to create challenges rather than join
  };
}

const CHAT = {
  hello: ["hola", "buenas", "hola a todos", "buenas tardes", "ey", "holaa"],
  lookingForGame: ["alguien juega?", "busco partida", "reto abierto, alguien?", "alguien para una partida?"],
  ggWin: ["gg", "gg wp", "buena partida", "gg!"],
  ggLoss: ["gg", "gg, bien jugado", "uff casi", "gg wp", "bien jugado"],
  bye: ["me voy, hasta luego", "bye", "me piro, gg a todos", "hasta mañana"]
};

function startBots({ port, apiUrl, serverKey, byId, publicUrl, log = console.log }) {
  const minOnline = Number(process.env.BOTS_MIN) || 10;
  const maxOnline = Number(process.env.BOTS_MAX) || 20;
  const serverUrl = "http://127.0.0.1:" + port;
  const bots = new Map();          // name -> Bot
  const claimed = new Set();       // match ids a bot is already joining
  let lastChatAt = 0;
  let lobbyMatches = [];
  let botSockets = new Set();
  const chat = createBotChat({ log, catalog: [...byId.values()] });
  const replyCooldown = new Map(); // player name -> last time a bot answered them

  async function api(action, body = {}, session = "") {
    const headers = { "content-type": "application/json" };
    if (session) headers["x-rolplay-session"] = session;
    else headers["x-rolplay-server-key"] = serverKey;
    const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify({ action, ...body }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "api_" + response.status);
    return data;
  }
  function chatAllowed() {
    // One bot message every couple of minutes at most, across all bots.
    return Date.now() - lastChatAt > rand(90, 240) * 1000;
  }

  const card = inst => inst && byId.get(Number(inst.cardId ?? inst));
  const atk = c => Math.max(0, Number(c?.atk) || 0);
  const def = c => Number(c?.def) || 0;
  function creatureValue(c) {
    if (!c) return 0;
    return atk(c) * 1.3 + Math.max(0, def(c)) + (c.defender ? 1.5 : 0) + (c.tags?.mistica ? 0.8 : 0)
      + (Number(c.multiDefense) > 1 ? 1 : 0) + (Number(c.multiAttack) > 1 ? 1.2 : 0);
  }
  function amuletUseful(c, s) {
    const n = String(c.name).toLowerCase();
    if (n.startsWith("fuente de vida")) return s.playerHp <= (s.playerMaxHp || 20) - 3;
    if (n.startsWith("veneno") || n.startsWith("drenador")) return true;
    if (n.startsWith("escudal") || n.startsWith("barrera mistica")) return (s.playerBoard || []).length > 0;
    if (n.startsWith("poderador")) return false;
    return s.playerDeckCount > 4; // other amulets resolve as an extra card
  }

  class Bot {
    constructor(name) {
      this.name = name;
      this.p = personality(name);
      this.state = "offline";
      this.offlineSince = Date.now() - rand(10, 60) * 60 * 1000;
      this.session = "";
      this.profile = null;
      this.socket = null;
      this.matchId = "";
      this.ownChallenge = null;
      this.snapshot = null;
      this.actTimer = null;
      this.actSignature = "";
      this.attempts = new Map();
      this.finished = new Set();
      this.leaveAt = 0;
      this.lobbyTimer = null;
      this.activityTimer = null;
    }

    get level() { return Number(this.profile?.level) || 1; }

    async goOnline() {
      if (this.state !== "offline") return;
      this.state = "connecting";
      try {
        const data = await api("bot_session", { username: this.name });
        this.session = data.token;
        this.profile = data.profile;
      } catch (e) {
        log("[bots] " + this.name + " could not log in: " + e.message);
        this.state = "offline";
        this.offlineSince = Date.now();
        return;
      }
      this.leaveAt = Date.now() + this.p.sessionMinutes * rand(0.6, 1.4) * 60 * 1000;
      const socket = connect(serverUrl, { transports: ["websocket"], forceNew: true, reconnection: true, reconnectionDelay: 4000 });
      this.socket = socket;
      socket.on("connect", () => {
        botSockets.add(socket.id);
        socket.emit("hello", { sessionToken: this.session });
      });
      socket.on("disconnect", () => { botSockets.delete(socket.id); });
      socket.on("auth:error", () => this.goOffline(true));
      socket.on("server:ready", () => {
        if (this.state === "connecting") {
          this.state = "lobby";
          if (chance(this.p.chatty) && chatAllowed()) this.say(pick(CHAT.hello), rand(4, 20));
          this.scheduleLobby(rand(15, 60));
        }
      });
      socket.on("matches:list", list => { lobbyMatches = Array.isArray(list) ? list : []; });
      socket.on("match:created", m => { this.ownChallenge = { id: m.id, at: Date.now() }; this.state = "waiting"; });
      socket.on("match:error", () => { if (this.state !== "playing") this.state = "lobby"; this.ownChallenge = null; });
      socket.on("match:ready", m => {
        this.matchId = m.id;
        this.ownChallenge = null;
        this.state = "playing";
        this.startActivityPings();
      });
      socket.on("duel:snapshot", s => this.onSnapshot(s));
      socket.on("profile:update", u => { if (u && u.profile) this.profile = u.profile; });
      socket.on("chat:message", m => onChannel(m, false));
      socket.on("chat:system", m => onChannel(m, true));
      socket.on("trade:invited", t => {
        // Bots do not trade; decline after a short, human-looking pause.
        setTimeout(() => socket.emit("trade:cancel", { tradeId: t.tradeId }), rand(3, 9) * 1000 * this.p.speed);
      });
    }

    goOffline(force = false) {
      if (this.state === "offline") return;
      if (!force && this.state === "playing") return;
      clearTimeout(this.lobbyTimer);
      clearTimeout(this.actTimer);
      clearInterval(this.activityTimer);
      if (this.ownChallenge && this.socket) this.socket.emit("match:cancel", { id: this.ownChallenge.id });
      const socket = this.socket;
      this.socket = null;
      this.state = "offline";
      this.offlineSince = Date.now();
      this.matchId = "";
      this.ownChallenge = null;
      if (socket) setTimeout(() => socket.disconnect(), 500);
    }

    say(text, delaySeconds = 2) {
      lastChatAt = Date.now();
      setTimeout(() => { if (this.socket) this.socket.emit("chat:send", { text }); }, delaySeconds * 1000);
    }

    scheduleLobby(seconds) {
      clearTimeout(this.lobbyTimer);
      this.lobbyTimer = setTimeout(() => this.lobbyTick().catch(e => log("[bots] " + this.name + ": " + e.message)), seconds * 1000);
    }

    async lobbyTick() {
      if (!this.socket || this.state === "offline" || this.state === "connecting") return;
      if (this.state === "playing") return this.scheduleLobby(rand(20, 40));

      if (Date.now() > this.leaveAt) {
        if (chance(this.p.chatty) && chatAllowed()) this.say(pick(CHAT.bye), 1);
        setTimeout(() => this.goOffline(), 3000);
        return;
      }

      // Shopping and deck building between games, like a player checking the shop.
      if (await this.maybeShop()) return this.scheduleLobby(rand(10, 30));

      const deck = Array.isArray(this.profile?.deck) ? this.profile.deck : [];
      if (deck.length < 20) {
        await this.rebuildDeck();
        return this.scheduleLobby(rand(10, 25));
      }

      const open = lobbyMatches.filter(m => m.status === "waiting" && !claimed.has(m.id) && m.id !== this.ownChallenge?.id);
      const humanOpen = open.filter(m => !botSockets.has(m.hostSocketId));
      const botOpen = open.filter(m => botSockets.has(m.hostSocketId));

      // Real players come first: someone close in level answers their challenge.
      const human = humanOpen.find(m => this.level <= (Number(m.level) || 1) + 2 && this.isBestResponderFor(m));
      if (human) return this.join(human, rand(6, 25));

      // Someone else's challenge at a similar level is usually taken, even with our own one open
      // (the join cancels it), the way players browse the list instead of waiting forever.
      const sameLevel = botOpen.filter(m => Math.abs((Number(m.level) || 1) - this.level) <= 2);
      if (sameLevel.length && chance(0.85 - this.p.host * 0.25)) return this.join(pick(sameLevel), rand(5, 25));

      if (this.state === "waiting" && this.ownChallenge) {
        if (Date.now() - this.ownChallenge.at > rand(3, 7) * 60 * 1000) {
          this.socket.emit("match:cancel", { id: this.ownChallenge.id });
          this.ownChallenge = null;
          this.state = "lobby";
        }
        return this.scheduleLobby(rand(15, 35));
      }

      if (botOpen.length < 2 && chance(0.3 + this.p.host * 0.4)) {
        this.socket.emit("match:create", {});
        this.state = "waiting";
        this.ownChallenge = { id: "", at: Date.now() };
        if (chance(this.p.chatty * 0.6) && chatAllowed()) this.say(pick(CHAT.lookingForGame), rand(3, 12));
      }
      this.scheduleLobby(rand(12, 45));
    }

    // Among the idle bots, the one whose level is closest to the human answers.
    isBestResponderFor(match) {
      const lvl = Number(match.level) || 1;
      const idle = [...bots.values()].filter(b => b.socket && (b.state === "lobby" || b.state === "waiting") && b.level <= lvl + 2);
      idle.sort((a, b) => Math.abs(a.level - lvl) - Math.abs(b.level - lvl) || a.name.localeCompare(b.name));
      return idle[0] === this;
    }

    join(match, delaySeconds) {
      claimed.add(match.id);
      setTimeout(() => claimed.delete(match.id), 60 * 1000);
      if (this.ownChallenge && this.ownChallenge.id) this.socket.emit("match:cancel", { id: this.ownChallenge.id });
      this.ownChallenge = null;
      this.state = "lobby";
      setTimeout(() => {
        if (!this.socket || this.state === "playing") return;
        if (!lobbyMatches.some(m => m.id === match.id && m.status === "waiting")) return this.scheduleLobby(rand(5, 15));
        this.socket.emit("match:join", { id: match.id });
        this.scheduleLobby(rand(20, 40));
      }, delaySeconds * 1000 * this.p.speed);
    }

    async maybeShop() {
      const gold = Number(this.profile?.coins) || 0;
      const keep = this.p.spender > 0.5 ? 0 : 20 * randInt(0, 2);
      if (gold - keep < 20 || !chance(this.p.spender > 0.5 ? 0.8 : 0.35)) return false;
      const packs = Math.min(Math.floor((gold - keep) / 20), randInt(1, 5));
      let bought = 0;
      for (let i = 0; i < packs; i++) {
        try {
          const data = await api("buy_pack", { packLevel: this.level }, this.session);
          this.profile = data.profile;
          bought++;
        } catch { break; }
        await sleep(rand(4, 12) * 1000 * this.p.speed);
      }
      if (bought) await this.rebuildDeck();
      return bought > 0;
    }

    buildDeck() {
      const level = this.level;
      const owned = this.profile?.collection || {};
      const size = Math.max(20, Math.min(50, this.p.deckSize));
      const pool = [];
      for (const [id, count] of Object.entries(owned)) {
        const c = byId.get(Number(id));
        if (!c || c.level > level || !(Number(count) > 0)) continue;
        for (let i = 0; i < Number(count); i++) pool.push(c);
      }
      const advancedPowers = pool.filter(c => c.powerCard).sort((a, b) => (b.power || 0) - (a.power || 0));
      const playable = pool.filter(c => !c.powerCard);
      const score = c => c.abilityCard ? 2.2 + c.level * 0.4 : creatureValue(c) / Math.sqrt(Math.max(1, c.cost)) + c.level * 0.15;
      playable.sort((a, b) => score(b) - score(a));
      const powerTarget = Math.max(7, Math.round(size * rand(0.36, 0.44)));
      const deck = advancedPowers.slice(0, powerTarget).map(c => c.id);
      const basic = [...byId.values()].find(c => c.powerCard && c.level === 1);
      while (deck.length < powerTarget) deck.push(basic.id);
      for (const c of playable) {
        if (deck.length >= size) break;
        deck.push(c.id);
      }
      while (deck.length < 20) deck.push(basic.id);
      return deck;
    }

    async rebuildDeck() {
      try {
        const data = await api("save_deck", { deck: this.buildDeck() }, this.session);
        this.profile = data.profile;
        if (this.socket) this.socket.emit("profile:refresh");
      } catch (e) {
        log("[bots] " + this.name + " deck: " + e.message);
      }
    }

    startActivityPings() {
      clearInterval(this.activityTimer);
      this.activityTimer = setInterval(() => {
        if (this.socket && this.matchId && this.state === "playing") this.socket.emit("duel:activity", { matchId: this.matchId });
      }, rand(35, 70) * 1000);
    }

    // ---- Duel ----------------------------------------------------------------------------
    onSnapshot(s) {
      if (!s || !s.matchId) return;
      this.snapshot = s;
      this.matchId = s.matchId;
      if (s.gameOver) return this.onGameOver(s);
      this.state = "playing";
      if (s.drawOfferIncoming) return this.schedule("draw:" + s.turn, rand(4, 12), () => this.answerDraw());
      const mustAct = s.defending || (s.myTurn && !s.pendingAttack);
      if (!mustAct) return;
      const sig = [s.turn, s.phase, s.defending ? "d" + (s.pendingAttack?.attackerUid || "") : "", (s.playerHand || []).length,
        (s.playerBoard || []).length, (s.enemyBoard || []).length, s.power, s.playerHp, s.enemyHp,
        (s.playerBoard || []).map(c => c.attacksThisTurn || 0).join("")].join("|");
      this.schedule(sig, this.thinkSeconds(s), () => this.act());
    }

    thinkSeconds(s) {
      let base;
      if (s.defending) base = rand(3, 10);
      else if (s.phase === 2) base = rand(1.5, 5);
      else if (s.phase === 3) base = rand(2.5, 8);
      else if (s.phase === 4) base = rand(2, 6);
      else base = rand(2, 7);
      if (chance(0.06)) base += rand(8, 20); // sometimes a player stops to think
      return Math.min(s.defending ? 45 : 90, base * this.p.speed);
    }

    schedule(signature, seconds, fn) {
      if (signature === this.actSignature && this.actTimer) return;
      clearTimeout(this.actTimer);
      this.actSignature = signature;
      const tries = (this.attempts.get(signature) || 0) + 1;
      this.attempts.set(signature, tries);
      if (this.attempts.size > 300) this.attempts.clear();
      this.actTimer = setTimeout(() => {
        this.actTimer = null;
        this.actSignature = "";
        try { fn(tries); } catch (e) { log("[bots] " + this.name + " act: " + e.message); }
      }, (tries > 2 ? 1.5 : seconds) * 1000);
    }

    send(type, extra = {}) {
      if (this.socket && this.matchId) this.socket.emit("duel:action", { matchId: this.matchId, type, ...extra });
    }

    act() {
      const s = this.snapshot;
      if (!s || s.gameOver) return;
      const sig = this.actSignature;
      const stuck = (this.attempts.get(sig) || 0) > 2;
      if (s.defending) return this.defend(s, stuck);
      if (!s.myTurn || s.pendingAttack) return;
      if (stuck) return this.send("nextPhase");
      if (this.shouldConcede(s)) return this.send("concede");
      const smart = chance(this.p.skill);
      if (s.phase === 2) {
        const powers = (s.playerHand || []).filter(i => card(i)?.powerCard);
        if (powers.length && !s.powerPlayed) {
          powers.sort((a, b) => (card(b).power || 1) - (card(a).power || 1));
          return this.send("play", { uid: powers[0].uid });
        }
        return this.send("nextPhase");
      }
      if (s.phase === 3) {
        const options = (s.playerHand || []).filter(i => { const c = card(i); return c && !c.powerCard && !c.abilityCard && c.cost <= s.power; });
        if (!options.length) return this.send("nextPhase");
        options.sort((a, b) => creatureValue(card(b)) - creatureValue(card(a)) || card(b).cost - card(a).cost);
        return this.send("play", { uid: (smart ? options[0] : pick(options)).uid });
      }
      if (s.phase === 4) {
        const options = (s.playerHand || []).filter(i => { const c = card(i); return c && c.abilityCard && c.cost <= s.power && (!smart || amuletUseful(c, s)); });
        if (!options.length) return this.send("nextPhase");
        return this.send("play", { uid: pick(options).uid });
      }
      if (s.phase === 5) {
        const target = this.chooseAttacker(s, smart);
        if (target) return this.send("attack", { uid: target.uid });
        return this.send("nextPhase");
      }
      this.send("nextPhase");
    }

    canAttack(inst, s) {
      const c = card(inst);
      if (!c || atk(c) <= 0) return false;
      const limit = Math.max(1, Number(c.multiAttack) || 1);
      if ((Number(inst.attacksThisTurn) || 0) >= limit) return false;
      if (inst.exhausted && (Number(inst.attacksThisTurn) || 0) === 0) return false;
      return inst.summonedTurn !== s.turn;
    }
    canBlock(inst) {
      const c = card(inst);
      if (!c) return false;
      if ((Number(inst.defensesThisTurn) || 0) >= Math.max(1, Number(c.multiDefense) || 1)) return false;
      return !inst.exhausted || !!c.defender;
    }

    chooseAttacker(s, smart) {
      const attackers = (s.playerBoard || []).filter(i => this.canAttack(i, s));
      if (!attackers.length) return null;
      if (!smart) return chance(0.5) ? pick(attackers) : null;
      const blockers = (s.enemyBoard || []).filter(i => this.canBlock(i)).map(card);
      const totalAtk = attackers.reduce((sum, i) => sum + atk(card(i)), 0);
      if (!blockers.length || totalAtk >= s.enemyHp + blockers.length * 2) {
        return attackers.sort((a, b) => atk(card(b)) - atk(card(a)))[0];
      }
      const enemyThreat = (s.enemyBoard || []).reduce((sum, i) => sum + atk(card(i)), 0);
      const underPressure = s.playerHp <= enemyThreat * 2;
      const ranked = attackers.map(i => {
        const a = card(i);
        const killedBy = blockers.filter(b => atk(b) >= def(a) && atk(a) < def(b)).length;
        const trades = blockers.filter(b => atk(b) >= def(a) && atk(a) >= def(b)).length;
        let score = atk(a);
        if (killedBy) score -= 10;
        if (trades) score -= 2 - this.p.aggression * 3;
        if (underPressure && !a.defender && def(a) >= 2) score -= 3; // keep a good blocker home
        return { i, score };
      }).sort((x, y) => y.score - x.score);
      return ranked[0].score > 0 ? ranked[0].i : null;
    }

    defend(s, stuck) {
      const attackerInst = (s.enemyBoard || []).find(c => c.uid === s.pendingAttack?.attackerUid);
      const a = card(attackerInst);
      const blockers = (s.playerBoard || []).filter(i => this.canBlock(i));
      if (stuck || !a || !blockers.length) return this.send("passDefense");
      if (!chance(this.p.skill)) {
        return chance(0.5) ? this.send("passDefense") : this.send("defend", { uid: pick(blockers).uid });
      }
      const value = i => creatureValue(card(i));
      const byValue = [...blockers].sort((x, y) => value(x) - value(y));
      const killsAndLives = byValue.find(i => atk(card(i)) >= def(a) && atk(a) < def(card(i)));
      if (killsAndLives) return this.send("defend", { uid: killsAndLives.uid });
      const lives = byValue.find(i => atk(a) < def(card(i)));
      if (lives) return this.send("defend", { uid: lives.uid });
      const trade = byValue.find(i => atk(card(i)) >= def(a) && value(i) <= creatureValue(a) * (1 + this.p.aggression * 0.3));
      if (trade) return this.send("defend", { uid: trade.uid });
      if (atk(a) >= s.playerHp || s.playerHp - atk(a) <= 3) return this.send("defend", { uid: byValue[0].uid });
      this.send("passDefense");
    }

    answerDraw() {
      const s = this.snapshot;
      if (!s || !s.drawOfferIncoming) return;
      const losing = s.playerHp < s.enemyHp / 2 && (s.playerBoard || []).length <= (s.enemyBoard || []).length;
      this.send("respondDraw", { accept: losing && chance(0.7) });
    }

    shouldConcede(s) {
      if ((s.playerBoard || []).length) return false;
      const threat = (s.enemyBoard || []).reduce((sum, i) => sum + atk(card(i)), 0);
      return s.playerHp <= 3 && threat >= s.playerHp * 2 && chance(0.15);
    }

    onGameOver(s) {
      if (this.finished.has(s.matchId)) return;
      this.finished.add(s.matchId);
      clearTimeout(this.actTimer);
      this.actTimer = null;
      this.actSignature = "";
      clearInterval(this.activityTimer);
      if (chance(0.25 + this.p.chatty) && chatAllowed()) this.say(pick(s.result === "win" ? CHAT.ggWin : CHAT.ggLoss), rand(2, 6));
      setTimeout(async () => {
        this.matchId = "";
        this.snapshot = null;
        if (this.state === "playing") this.state = "lobby";
        try { this.profile = (await api("me", {}, this.session)).profile; } catch {}
        this.scheduleLobby(rand(5, 25));
      }, rand(6, 20) * 1000);
    }
  }

  // ---- Channel chatter ---------------------------------------------------------------------
  const lobbyBots = () => [...bots.values()].filter(b => b.socket && (b.state === "lobby" || b.state === "waiting"));
  function onChannel(message, system) {
    if (!message) return;
    const fromBot = !system && bots.has(String(message.from || ""));
    const entry = chat.observe({ ...message, system }, fromBot);
    if (!entry || system || fromBot) return;
    maybeAnswer(entry).catch(e => log("[bots] reply: " + e.message));
  }
  // A real player wrote in the channel: sometimes a bot answers, always when one is named.
  async function maybeAnswer(entry) {
    if (!chat.enabled()) return;
    const text = entry.text.toLowerCase();
    const online = lobbyBots();
    if (!online.length) return;
    const named = online.find(b => text.includes(b.name.toLowerCase()));
    const inviting = /\?|hola|buenas|alguien|juega|reto|duelo|carta|sobre|mazo|nivel|elo|bot|\bia\b/.test(text);
    if (!named) {
      if (Date.now() - (replyCooldown.get(entry.from) || 0) < 45 * 1000) return;
      if (!chance(inviting ? 0.65 : 0.2)) return;
    }
    const bot = named || pick(online);
    replyCooldown.set(entry.from, Date.now());
    const answer = await chat.reply(bot, entry.from, entry.text);
    if (answer && bot.socket) bot.say(answer, rand(3, 7) + Math.min(8, answer.length * 0.06));
  }
  // Every few minutes two or three bots in the lobby talk among themselves.
  async function sceneTick() {
    try {
      const online = lobbyBots();
      if (chat.enabled() && online.length >= 2 && Date.now() - lastChatAt > 60 * 1000) {
        const cast = online.sort(() => Math.random() - 0.5).slice(0, chance(0.35) ? 3 : 2);
        const lines = await chat.scene(cast);
        let at = rand(1, 4);
        for (const line of lines) {
          const bot = bots.get(line.name);
          if (bot && bot.socket) bot.say(line.text, at);
          at += rand(5, 16) + line.text.length * 0.05;
        }
      }
    } catch (e) {
      log("[bots] scene: " + e.message);
    }
    setTimeout(sceneTick, rand(3, 8) * 60 * 1000);
  }

  // ---- Population ------------------------------------------------------------------------
  function madridHour() {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date());
    return Number(parts.find(p => p.type === "hour")?.value) || 12;
  }
  function targetOnline() {
    const h = madridHour();
    const curve = h < 2 ? 0.45 : h < 8 ? 0.05 : h < 14 ? 0.4 : h < 17 ? 0.55 : h < 23 ? 1 : 0.7;
    return Math.round(minOnline + (maxOnline - minOnline) * curve + rand(-1, 1));
  }
  async function refreshRoster() {
    try {
      const data = await api("bot_roster");
      for (const b of data.bots || []) if (!bots.has(b.name)) bots.set(b.name, new Bot(b.name));
    } catch (e) {
      log("[bots] roster: " + e.message);
    }
  }
  function populationTick() {
    const all = [...bots.values()];
    const online = all.filter(b => b.state !== "offline");
    const target = Math.min(all.length, targetOnline());
    if (online.length < target) {
      const candidates = all.filter(b => b.state === "offline" && Date.now() - b.offlineSince > 8 * 60 * 1000);
      if (candidates.length) pick(candidates).goOnline();
    } else if (online.length > target + 1) {
      const idle = online.filter(b => b.state === "lobby" || b.state === "waiting");
      if (idle.length) pick(idle).leaveAt = Date.now();
    }
    setTimeout(populationTick, rand(25, 90) * 1000);
  }

  (async () => {
    await refreshRoster();
    log("[bots] " + bots.size + " simulated players, " + minOnline + "-" + maxOnline + " online");
    setInterval(refreshRoster, 30 * 60 * 1000);
    setTimeout(populationTick, rand(10, 30) * 1000);
    setTimeout(sceneTick, rand(2, 4) * 60 * 1000);
    setInterval(() => { const st = chat.stats(); log("[bots] chat llm today: " + st.requests + " requests, " + st.tokens + " tokens, " + st.failures + " failures" + (st.paused ? ", paused" : "")); }, 60 * 60 * 1000);
    log("[bots] channel chatter " + (chat.enabled() ? "on (Groq)" : "off (no GROQ_API_KEY)"));
    // Free Render instances sleep after 15 idle minutes; the simulated players must stay up.
    if (publicUrl) setInterval(() => { fetch(publicUrl + "/health").catch(() => {}); }, 10 * 60 * 1000);
  })();
}

module.exports = { startBots };
