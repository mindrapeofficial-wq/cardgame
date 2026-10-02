"use strict";

const { io: createClient } = require("socket.io-client");

const DEFAULT_ACCOUNT_COUNT = 200;
const DEFAULT_CONCURRENT = 40;
const MIN_SESSION_MS = 12 * 60 * 1000;
const MAX_SESSION_MS = 75 * 60 * 1000;
const ACTION_TICK_MIN_MS = 3500;
const ACTION_TICK_MAX_MS = 11000;
const PACK_PRICE = 20;

const BASE_HANDLES = [
  "Kael", "Morkai", "NereaX", "Drax", "Iker7", "Riven", "Aldren", "Nyx", "ZeroK", "Darian",
  "LoboGris", "Sombra", "Kiro", "Varek", "Mara", "Talon", "Lynx", "Orion", "Kaiser", "Ares",
  "Nox", "Eiden", "Ragnar", "Vega", "Mika", "Tyr", "Kain", "Sirius", "Noctis", "Axel",
  "Milo", "Rook", "Nero", "Valk", "Eliot", "Rex", "Draven", "Lia", "Hades", "Eris",
  "Mauro", "Xavi", "LeoM", "Saul", "Adri", "Biel", "Gabi", "Hugo", "Joel", "AlexR",
  "MisterX", "Jota", "Darko", "Kron", "Rai", "Mace", "Nova", "Zen", "Koda", "Ryu"
];

const LOBBY_LINES = [
  "alguien para una?", "voy a probar mazo", "que tal va el lobby", "una rapida?", "ando testeando cartas",
  "me falta una buena mano ya", "hoy no sale nada jaja", "alguno lvl parecido?", "voy cola", "una y me voy",
  "ese gorad renta bastante", "mimit aguanta demasiado xd", "me estoy quedando sin oro", "a ver si saco dophan",
  "buenas", "gg al de antes", "otra?", "alguien activo?", "voy con mazo nuevo", "creo que este deck ya tira"
];

const REPLY_GROUPS = [
  { test: /hola|buenas|hey|wenas/i, lines: ["buenas", "hey", "que tal", "todo bien", "wena"] },
  { test: /partida|duelo|jugar|una\?/i, lines: ["voy", "te entro", "dame un sec", "si estoy", "va"] },
  { test: /mazo|deck/i, lines: ["ando cambiandolo", "todavia lo estoy probando", "me falta pulirlo", "el mio es bastante simple"] },
  { test: /gg|buena|bien jugado/i, lines: ["gg", "buena", "bien jugado", "esa estuvo cerca", "jaja gg"] },
  { test: /sobre|pack|carta/i, lines: ["no me sale nada raro", "estoy gastando todo en sobres xd", "me salio una decente antes", "yo sigo ahorrando"] }
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? clamp(Math.floor(n), min, max) : fallback;
}

function hash32(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(text).length; i++) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFor(seedText) {
  let a = hash32(seedText) || 1;
  return function random() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)] || items[0];
}

function handleFor(index) {
  const base = BASE_HANDLES[index % BASE_HANDLES.length];
  if (index < BASE_HANDLES.length) return base;
  const cycle = Math.floor(index / BASE_HANDLES.length);
  const suffix = cycle < 2 ? String(10 + ((index * 17) % 89)) : String(100 + ((index * 37) % 899));
  return (base + suffix).slice(0, 20);
}

function personaFor(index) {
  const random = rngFor("persona:" + index);
  const styles = ["seco", "casual", "competitivo", "charlatan", "tranquilo", "impulsivo"];
  return {
    skill: 0.35 + random() * 0.6,
    aggression: 0.18 + random() * 0.76,
    patience: 0.2 + random() * 0.75,
    sociability: 0.08 + random() * 0.55,
    thrift: 0.05 + random() * 0.8,
    risk: 0.12 + random() * 0.8,
    typoRate: random() * 0.12,
    style: pick(random, styles),
    preferredStartHour: Math.floor(8 + random() * 14),
    sessionBias: random()
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class SyntheticAgent {
  constructor(manager, index) {
    this.manager = manager;
    this.index = index;
    this.name = handleFor(index);
    this.persona = personaFor(index);
    this.random = rngFor("agent:" + index);
    this.sessionToken = "";
    this.profile = null;
    this.socket = null;
    this.online = false;
    this.starting = false;
    this.stopping = false;
    this.currentMatchId = "";
    this.waitingMatchId = "";
    this.inMatch = false;
    this.lastMatches = [];
    this.lastUsers = [];
    this.lastDecisionKey = "";
    this.decisionTimer = null;
    this.actionTimer = null;
    this.sessionTimer = null;
    this.chatCooldownUntil = 0;
    this.lastEconomyAt = 0;
    this.lastError = "";
  }

  metric(name, amount = 1) {
    this.manager.metrics[name] = (this.manager.metrics[name] || 0) + amount;
  }

  delay(min, max, complexity = 0.5) {
    const r = (this.random() + this.random() + this.random()) / 3;
    const thinking = 0.72 + complexity * 0.75 + (1 - this.persona.skill) * 0.35;
    return Math.floor(clamp((min + (max - min) * r) * thinking, min, max * 1.7));
  }

  async api(action, payload = {}) {
    const headers = { "content-type": "application/json" };
    if (this.sessionToken) headers["x-rolplay-session"] = this.sessionToken;
    const response = await fetch(this.manager.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(data.error || action + "_failed");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async provision() {
    const response = await fetch(this.manager.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rolplay-server-key": this.manager.serverKey
      },
      body: JSON.stringify({ action: "synthetic_provision", username: this.name })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.token) throw new Error(data.error || "synthetic_provision_failed");
    this.sessionToken = data.token;
    this.profile = data.profile;
    this.metric("provisioned");
  }

  collectionCount(profile = this.profile) {
    return Object.values(profile?.collection || {}).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
  }

  basicPowerId() {
    return this.manager.basicPowerId;
  }

  cardScore(card) {
    const p = this.persona;
    const atk = Math.max(0, Number(card.atk) || 0);
    const def = Math.max(0, Number(card.def) || 0);
    const cost = Math.max(1, Number(card.cost) || 1);
    const tempo = (atk * (0.75 + p.aggression) + def * (1.35 - p.aggression)) / cost;
    const special = card.abilityCard ? 0.7 + p.risk : 0;
    const jitter = (this.random() - 0.5) * (1.5 - p.skill);
    return tempo + special + jitter;
  }

  buildDeck(profile = this.profile) {
    const level = Math.max(1, Number(profile?.level) || 1);
    const collection = profile?.collection || {};
    const powerCount = clamp(7 + Math.round((1 - this.persona.aggression) * 3 + this.random() * 2), 7, 11);
    const targetSize = 20;
    const deck = Array.from({ length: powerCount }, () => this.basicPowerId());
    const pool = [];

    for (const card of this.manager.catalog) {
      if (card.id === this.basicPowerId() || card.powerCard || card.level > level) continue;
      const copies = Math.max(0, Number(collection[String(card.id)] || collection[card.id]) || 0);
      for (let i = 0; i < copies; i++) pool.push(card);
    }

    pool.sort((a, b) => this.cardScore(b) - this.cardScore(a));
    const needed = targetSize - deck.length;
    const topWindow = Math.max(needed, Math.ceil(pool.length * (0.45 + (1 - this.persona.skill) * 0.45)));
    const candidates = pool.slice(0, topWindow);

    while (deck.length < targetSize && candidates.length) {
      const weightedIndex = Math.floor(Math.pow(this.random(), 1.4 + this.persona.skill) * candidates.length);
      const card = candidates.splice(clamp(weightedIndex, 0, candidates.length - 1), 1)[0];
      if (card) deck.push(card.id);
    }
    while (deck.length < targetSize && pool.length) deck.push(pool.shift().id);

    return deck.slice(0, targetSize);
  }

  async prepareEconomy(force = false) {
    if (!this.sessionToken) return;
    if (!force && Date.now() - this.lastEconomyAt < 45_000) return;
    this.lastEconomyAt = Date.now();

    let fresh = await this.api("me");
    this.profile = fresh.profile;

    let deck = this.buildDeck(this.profile);
    let tries = 0;
    while (deck.length < 20 && Number(this.profile.coins) >= PACK_PRICE && tries++ < 5) {
      const packLevel = Math.max(1, Math.min(Number(this.profile.level) || 1, Math.ceil((Number(this.profile.level) || 1) * (0.55 + this.random() * 0.45))));
      const pack = await this.api("buy_pack", { packLevel });
      this.profile = pack.profile;
      this.metric("packsBought");
      deck = this.buildDeck(this.profile);
      await sleep(120 + Math.floor(this.random() * 320));
    }

    if (deck.length >= 20) {
      const current = Array.isArray(this.profile.deck) ? this.profile.deck.map(Number) : [];
      const changed = current.length !== deck.length || current.some((id, i) => Number(id) !== Number(deck[i]));
      if (changed || force) {
        const saved = await this.api("save_deck", { deck });
        this.profile = saved.profile;
        this.metric("decksBuilt");
      }
    }
  }

  async maybeBuyAfterMatch() {
    if (!this.profile) return;
    const coins = Number(this.profile.coins) || 0;
    if (coins < PACK_PRICE) return;
    const spendChance = 0.12 + (1 - this.persona.thrift) * 0.48;
    if (this.random() > spendChance) return;
    try {
      const packLevel = Math.max(1, Math.min(Number(this.profile.level) || 1, Math.round(1 + this.random() * ((Number(this.profile.level) || 1) - 1))));
      const pack = await this.api("buy_pack", { packLevel });
      this.profile = pack.profile;
      this.metric("packsBought");
      if (this.random() < 0.55) await this.prepareEconomy(true);
    } catch (error) {
      this.lastError = String(error.message || error);
      this.metric("apiErrors");
    }
  }

  async start() {
    if (this.online || this.starting) return;
    this.starting = true;
    this.stopping = false;
    try {
      if (!this.sessionToken) await this.provision();
      await this.prepareEconomy(true);
      if (!Array.isArray(this.profile?.deck) || this.profile.deck.length < 20) {
        throw new Error("synthetic_deck_not_ready");
      }
      await this.connectSocket();
      const sessionLength = MIN_SESSION_MS + this.random() * (MAX_SESSION_MS - MIN_SESSION_MS) * (0.55 + this.persona.sessionBias * 0.9);
      clearTimeout(this.sessionTimer);
      this.sessionTimer = setTimeout(() => {
        if (!this.inMatch && !this.waitingMatchId) this.stop("session_complete");
      }, sessionLength);
    } catch (error) {
      this.lastError = String(error.message || error);
      this.metric("startErrors");
      this.manager.noteError(this.name + ": " + this.lastError);
      await this.stop("start_failed");
    } finally {
      this.starting = false;
    }
  }

  async connectSocket() {
    await new Promise((resolve, reject) => {
      const socket = createClient(this.manager.serverUrl, {
        transports: ["websocket"],
        reconnection: false,
        timeout: 12000,
        forceNew: true
      });
      this.socket = socket;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        try { socket.disconnect(); } catch {}
        reject(error instanceof Error ? error : new Error(String(error || "socket_failed")));
      };
      socket.once("connect_error", fail);
      socket.once("auth:error", payload => fail(new Error(payload?.message || "auth_error")));
      socket.once("server:ready", () => {
        if (settled) return;
        settled = true;
        this.online = true;
        this.metric("sessionsStarted");
        this.bindSocket();
        this.scheduleActionLoop();
        resolve();
      });
      socket.on("connect", () => socket.emit("hello", { sessionToken: this.sessionToken }));
    });
  }

  bindSocket() {
    const socket = this.socket;
    if (!socket) return;

    socket.on("lobby:users", list => { this.lastUsers = Array.isArray(list) ? list : []; });
    socket.on("matches:list", list => {
      this.lastMatches = Array.isArray(list) ? list : [];
      if (this.waitingMatchId && !this.lastMatches.some(m => m.id === this.waitingMatchId)) this.waitingMatchId = "";
    });
    socket.on("match:created", match => {
      this.waitingMatchId = match?.id || "";
      this.currentMatchId = this.waitingMatchId;
    });
    socket.on("match:ready", payload => {
      this.currentMatchId = payload?.id || this.currentMatchId;
      this.waitingMatchId = "";
      this.inMatch = true;
      this.metric("matchesEntered");
    });
    socket.on("match:error", payload => {
      this.waitingMatchId = "";
      this.currentMatchId = "";
      this.lastError = String(payload?.message || "match_error");
      this.metric("matchErrors");
    });
    socket.on("profile:update", payload => {
      if (payload?.profile) this.profile = payload.profile;
    });
    socket.on("duel:snapshot", snapshot => this.onSnapshot(snapshot));
    socket.on("chat:message", message => this.onChat(message));
    socket.on("disconnect", () => {
      this.online = false;
      this.inMatch = false;
      this.waitingMatchId = "";
      this.currentMatchId = "";
      clearTimeout(this.decisionTimer);
      clearTimeout(this.actionTimer);
    });

    if (this.random() < this.persona.sociability * 0.35) {
      setTimeout(() => this.say(pick(this.random, ["buenas", "hey", "que tal"]), true), this.delay(2500, 12000));
    }
  }

  stylize(text) {
    let out = String(text || "");
    if (this.persona.style === "seco") out = out.replace(/[.!?]+$/g, "");
    if (this.persona.style === "casual" || this.persona.style === "impulsivo") out = out.toLowerCase();
    if (this.persona.typoRate > 0.06 && this.random() < this.persona.typoRate && out.length > 5) {
      const i = 2 + Math.floor(this.random() * (out.length - 3));
      out = out.slice(0, i) + out.slice(i + 1);
    }
    if (this.persona.style === "charlatan" && this.random() < 0.18) out += pick(this.random, [" jaja", " xd", " creo", " eh"]);
    return out.slice(0, 180);
  }

  say(text, spontaneous = false) {
    if (!this.socket?.connected || this.inMatch) return false;
    const now = Date.now();
    if (now < this.chatCooldownUntil) return false;
    if (!this.manager.allowChat(this.index, spontaneous)) return false;
    this.chatCooldownUntil = now + 18_000 + this.random() * 70_000;
    this.socket.emit("chat:send", { text: this.stylize(text) });
    this.metric("chatMessages");
    return true;
  }

  onChat(message) {
    if (!message || message.socketId === this.socket?.id || this.inMatch) return;
    if (this.random() > this.persona.sociability * 0.18) return;
    const text = String(message.text || "");
    const group = REPLY_GROUPS.find(g => g.test.test(text));
    if (!group) return;
    setTimeout(() => this.say(pick(this.random, group.lines)), this.delay(2500, 18000, 0.25));
  }

  scheduleActionLoop() {
    clearTimeout(this.actionTimer);
    if (!this.online || this.stopping) return;
    const delay = ACTION_TICK_MIN_MS + this.random() * (ACTION_TICK_MAX_MS - ACTION_TICK_MIN_MS);
    this.actionTimer = setTimeout(() => {
      this.idleAction().catch(error => {
        this.lastError = String(error.message || error);
        this.metric("actionErrors");
      }).finally(() => this.scheduleActionLoop());
    }, delay);
  }

  async idleAction() {
    if (!this.socket?.connected || this.inMatch || this.waitingMatchId) return;

    if (this.random() < this.persona.sociability * 0.055) {
      this.say(pick(this.random, LOBBY_LINES), true);
    }

    if (this.random() < 0.035) {
      await this.prepareEconomy(false).catch(() => {});
    }

    const waiting = this.lastMatches.filter(m =>
      m && m.status === "waiting" && m.hostSocketId !== this.socket.id
    );
    if (waiting.length && this.random() < 0.62 + this.persona.aggression * 0.22) {
      const humanPreferred = waiting.filter(m => !this.manager.syntheticSocketIds().has(m.hostSocketId));
      const source = humanPreferred.length && this.random() < 0.72 ? humanPreferred : waiting;
      const match = pick(this.random, source);
      if (match) {
        await sleep(this.delay(900, 6500, 0.25));
        this.socket.emit("match:join", { id: match.id });
        return;
      }
    }

    if (this.random() < 0.28 + this.persona.aggression * 0.18) {
      await sleep(this.delay(700, 4500, 0.2));
      this.socket.emit("match:create", {});
    }
  }

  snapshotDecisionKey(s) {
    return [
      s.matchId, s.turn, s.phase, s.myTurn ? 1 : 0, s.defending ? 1 : 0,
      s.playerHand?.length || 0, s.playerBoard?.length || 0, s.enemyBoard?.length || 0,
      s.playerHp, s.enemyHp, s.power, s.pendingAttack?.attackerUid || ""
    ].join("|");
  }

  onSnapshot(snapshot) {
    if (!snapshot || !snapshot.matchId) return;
    this.currentMatchId = snapshot.matchId;
    this.inMatch = !snapshot.gameOver;

    if (snapshot.gameOver) {
      clearTimeout(this.decisionTimer);
      this.lastDecisionKey = "";
      this.metric("matchesFinished");
      if (snapshot.result === "win") this.metric("wins");
      else if (snapshot.result === "loss") this.metric("losses");
      else this.metric("draws");

      if (this.random() < this.persona.sociability * 0.42) {
        const line = snapshot.result === "win"
          ? pick(this.random, ["gg", "buena", "estuvo cerca"])
          : snapshot.result === "loss"
            ? pick(this.random, ["gg", "buena esa", "me destrozaste jaja"])
            : pick(this.random, ["gg", "tablas jaja", "buena"]);
        setTimeout(() => this.say(line), this.delay(3500, 13000, 0.2));
      }

      setTimeout(() => {
        this.inMatch = false;
        this.currentMatchId = "";
        this.maybeBuyAfterMatch().catch(() => {});
      }, this.delay(2500, 9000, 0.2));
      return;
    }

    if (!snapshot.myTurn && !snapshot.defending && !snapshot.drawOfferIncoming) return;
    const key = this.snapshotDecisionKey(snapshot);
    if (key === this.lastDecisionKey) return;
    this.lastDecisionKey = key;
    clearTimeout(this.decisionTimer);

    const complexity = snapshot.defending ? 0.75
      : snapshot.phase === 5 ? 0.7
        : snapshot.phase === 3 ? 0.55
          : 0.35;
    const min = intEnv("SYNTHETIC_MIN_DECISION_MS", 1600, 250, 30000);
    const max = intEnv("SYNTHETIC_MAX_DECISION_MS", 14000, min, 60000);
    this.decisionTimer = setTimeout(() => {
      this.makeDecision(snapshot).catch(error => {
        this.lastError = String(error.message || error);
        this.metric("decisionErrors");
      });
    }, this.delay(min, max, complexity));
  }

  card(id) {
    return this.manager.byId.get(Number(id));
  }

  validDefenders(snapshot) {
    return (snapshot.playerBoard || []).filter(inst => {
      const card = this.card(inst.cardId);
      if (!card) return false;
      const limit = Math.max(1, Number(card.multiDefense) || 1);
      const used = Number(inst.defensesThisTurn) || 0;
      return used < limit && (!inst.exhausted || card.defender);
    });
  }

  chooseDefender(snapshot) {
    const pendingUid = snapshot.pendingAttack?.attackerUid;
    const attackerInst = (snapshot.enemyBoard || []).find(x => x.uid === pendingUid);
    const attacker = attackerInst ? this.card(attackerInst.cardId) : null;
    const atk = Math.max(0, Number(attacker?.atk) || 0);
    const defenders = this.validDefenders(snapshot);
    if (!defenders.length) return null;

    const scored = defenders.map(inst => {
      const c = this.card(inst.cardId);
      const def = Math.max(0, Number(c?.def) || 0) + Math.max(0, Number(inst.defBonus) || 0);
      const counter = Math.max(0, Number(c?.atk) || 0);
      const survives = def > atk ? 2.2 : 0;
      const trade = counter >= Math.max(1, Number(attacker?.def) || 0) ? 1.5 : 0;
      const waste = Math.max(0, def - atk) * (0.15 + this.persona.skill * 0.25);
      return { inst, score: survives + trade + def * 0.35 - waste + (this.random() - 0.5) * (1.2 - this.persona.skill) };
    }).sort((a, b) => b.score - a.score);

    if (this.random() < (1 - this.persona.skill) * 0.16) return pick(this.random, defenders);
    return scored[0]?.inst || defenders[0];
  }

  choosePlayable(snapshot, abilityOnly) {
    const pool = (snapshot.playerHand || []).filter(inst => {
      const c = this.card(inst.cardId);
      if (!c || c.powerCard) return false;
      return !!c.abilityCard === !!abilityOnly && Number(c.cost) <= Number(snapshot.power);
    });
    if (!pool.length) return null;
    const scored = pool.map(inst => ({ inst, score: this.cardScore(this.card(inst.cardId)) }))
      .sort((a, b) => b.score - a.score);
    const window = Math.max(1, Math.ceil(scored.length * (1.05 - this.persona.skill * 0.72)));
    return pick(this.random, scored.slice(0, window))?.inst || scored[0].inst;
  }

  chooseAttacker(snapshot) {
    const pool = (snapshot.playerBoard || []).filter(inst => {
      const c = this.card(inst.cardId);
      if (!c || Number(c.atk) <= 0) return false;
      const limit = Math.max(1, Number(c.multiAttack) || 1);
      const used = Number(inst.attacksThisTurn) || 0;
      if (used >= limit) return false;
      if (inst.exhausted && used >= limit) return false;
      if (inst.summonedTurn === snapshot.turn) return false;
      return true;
    });
    if (!pool.length) return null;
    pool.sort((a, b) => {
      const ca = this.card(a.cardId), cb = this.card(b.cardId);
      return (Number(cb?.atk) || 0) - (Number(ca?.atk) || 0);
    });
    if (this.random() < (1 - this.persona.skill) * 0.22) return pick(this.random, pool);
    return pool[0];
  }

  emitDuel(type, extra = {}) {
    if (!this.socket?.connected || !this.currentMatchId) return;
    this.socket.emit("duel:action", { matchId: this.currentMatchId, type, ...extra });
    this.metric("decisions");
  }

  async makeDecision(snapshot) {
    if (!this.socket?.connected || snapshot.gameOver) return;

    if (snapshot.drawOfferIncoming) {
      const behind = Number(snapshot.playerHp) + (snapshot.playerBoard?.length || 0)
        < Number(snapshot.enemyHp) + (snapshot.enemyBoard?.length || 0);
      const accept = behind
        ? this.random() < 0.28 + (1 - this.persona.risk) * 0.32
        : this.random() < 0.04;
      this.emitDuel("respondDraw", { accept });
      return;
    }

    if (snapshot.defending) {
      const defenders = this.validDefenders(snapshot);
      const passChance = defenders.length
        ? 0.015 + (1 - this.persona.skill) * 0.09 + this.persona.risk * 0.035
        : 1;
      if (this.random() < passChance) {
        this.emitDuel("passDefense");
      } else {
        const defender = this.chooseDefender(snapshot);
        if (defender) this.emitDuel("defend", { uid: defender.uid });
        else this.emitDuel("passDefense");
      }
      return;
    }

    if (!snapshot.myTurn) return;

    const hpRatio = Number(snapshot.playerHp) / Math.max(1, Number(snapshot.playerMaxHp) || 20);
    const boardGap = (snapshot.enemyBoard?.length || 0) - (snapshot.playerBoard?.length || 0);
    if (snapshot.turn > 10 && hpRatio < 0.16 && boardGap >= 2 && this.random() < 0.025 + (1 - this.persona.patience) * 0.05) {
      this.emitDuel("concede");
      return;
    }
    if (snapshot.turn > 12 && Math.abs(Number(snapshot.playerHp) - Number(snapshot.enemyHp)) <= 2 && this.random() < 0.005) {
      this.emitDuel("offerDraw");
      return;
    }

    if (snapshot.phase === 2 && !snapshot.powerPlayed) {
      const power = (snapshot.playerHand || []).find(inst => this.card(inst.cardId)?.powerCard);
      if (power) {
        this.emitDuel("play", { uid: power.uid });
        return;
      }
    }

    if (snapshot.phase === 3) {
      if (this.random() < (1 - this.persona.skill) * 0.055) {
        this.emitDuel("nextPhase");
        return;
      }
      const card = this.choosePlayable(snapshot, false);
      if (card) {
        this.emitDuel("play", { uid: card.uid });
        return;
      }
    }

    if (snapshot.phase === 4) {
      const ability = this.choosePlayable(snapshot, true);
      if (ability && this.random() < 0.55 + this.persona.skill * 0.35) {
        this.emitDuel("play", { uid: ability.uid });
        return;
      }
    }

    if (snapshot.phase === 5) {
      if (this.random() < (1 - this.persona.aggression) * 0.045 && (snapshot.playerBoard?.length || 0) > 0) {
        this.emitDuel("nextPhase");
        return;
      }
      const attacker = this.chooseAttacker(snapshot);
      if (attacker) {
        this.emitDuel("attack", { uid: attacker.uid });
        return;
      }
    }

    this.emitDuel("nextPhase");
  }

  async stop(reason = "manager") {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.sessionTimer);
    clearTimeout(this.actionTimer);
    clearTimeout(this.decisionTimer);
    if (this.socket) {
      try {
        if (this.waitingMatchId) this.socket.emit("match:cancel", { id: this.waitingMatchId });
        this.socket.disconnect();
      } catch {}
    }
    this.socket = null;
    this.online = false;
    this.inMatch = false;
    this.waitingMatchId = "";
    this.currentMatchId = "";
    this.lastDecisionKey = "";
    this.metric("sessionsStopped");
    this.stopping = false;
    return reason;
  }
}

class SyntheticPopulation {
  constructor({ apiUrl, serverKey, serverUrl, catalog }) {
    this.apiUrl = apiUrl;
    this.serverKey = serverKey;
    this.serverUrl = serverUrl;
    this.catalog = Array.isArray(catalog) ? catalog : [];
    this.byId = new Map(this.catalog.map(c => [Number(c.id), c]));
    this.basicPowerId = this.catalog.find(c => c.powerCard && Number(c.level) === 1)?.id || 1;
    this.accountCount = intEnv("SYNTHETIC_ACCOUNT_COUNT", DEFAULT_ACCOUNT_COUNT, 1, 5000);
    this.concurrentTarget = intEnv("SYNTHETIC_CONCURRENT_TARGET", DEFAULT_CONCURRENT, 1, 1000);
    this.timezoneOffset = intEnv("SYNTHETIC_TIMEZONE_OFFSET_HOURS", 2, -12, 14);
    this.agents = Array.from({ length: this.accountCount }, (_, i) => new SyntheticAgent(this, i));
    this.running = false;
    this.tickTimer = null;
    this.chatTimes = [];
    this.metrics = {
      provisioned: 0, sessionsStarted: 0, sessionsStopped: 0,
      packsBought: 0, decksBuilt: 0, matchesEntered: 0, matchesFinished: 0,
      wins: 0, losses: 0, draws: 0, decisions: 0, chatMessages: 0,
      startErrors: 0, apiErrors: 0, actionErrors: 0, decisionErrors: 0, matchErrors: 0
    };
    this.errors = [];
  }

  noteError(message) {
    this.errors.push({ at: Date.now(), message: String(message).slice(0, 300) });
    if (this.errors.length > 40) this.errors.shift();
  }

  localHour() {
    const d = new Date(Date.now() + this.timezoneOffset * 60 * 60 * 1000);
    return d.getUTCHours();
  }

  activityFactor() {
    const h = this.localHour();
    if (h < 6) return 0.28;
    if (h < 9) return 0.48;
    if (h < 14) return 0.68;
    if (h < 18) return 0.82;
    if (h < 23) return 1.0;
    return 0.58;
  }

  desiredOnline() {
    const base = Math.max(1, Math.round(this.concurrentTarget * this.activityFactor()));
    const wobble = Math.round(Math.sin(Date.now() / 900000) * Math.max(1, this.concurrentTarget * 0.06));
    return clamp(base + wobble, 1, this.concurrentTarget);
  }

  syntheticSocketIds() {
    return new Set(this.agents.filter(a => a.online && a.socket?.id).map(a => a.socket.id));
  }

  allowChat(_index, spontaneous) {
    const now = Date.now();
    this.chatTimes = this.chatTimes.filter(t => now - t < 60_000);
    if (this.chatTimes.length >= 10) return false;
    const last = this.chatTimes[this.chatTimes.length - 1] || 0;
    if (now - last < (spontaneous ? 6500 : 3500)) return false;
    this.chatTimes.push(now);
    return true;
  }

  async start() {
    if (this.running) return;
    if (!this.serverKey) throw new Error("ROLPLAY_SERVER_KEY is required for synthetic population");
    if (!this.catalog.length) throw new Error("card catalog is empty");
    this.running = true;
    this.scheduleTick(100);
  }

  scheduleTick(delay = 30_000) {
    clearTimeout(this.tickTimer);
    if (!this.running) return;
    this.tickTimer = setTimeout(() => {
      this.tick().catch(error => this.noteError(error.message || error)).finally(() => this.scheduleTick());
    }, delay);
  }

  async tick() {
    const desired = this.desiredOnline();
    const online = this.agents.filter(a => a.online || a.starting);
    if (online.length < desired) {
      const candidates = this.agents.filter(a => !a.online && !a.starting && !a.stopping);
      candidates.sort((a, b) => {
        const hour = this.localHour();
        const da = Math.abs(a.persona.preferredStartHour - hour);
        const db = Math.abs(b.persona.preferredStartHour - hour);
        return da - db + (a.random() - 0.5) * 2;
      });
      const count = Math.min(desired - online.length, 4, candidates.length);
      for (let i = 0; i < count; i++) {
        candidates[i].start().catch(error => this.noteError(candidates[i].name + ": " + error.message));
        await sleep(350 + Math.random() * 900);
      }
    } else if (online.length > desired) {
      const canStop = this.agents.filter(a => a.online && !a.inMatch && !a.waitingMatchId);
      const count = Math.min(online.length - desired, 3, canStop.length);
      for (let i = 0; i < count; i++) await canStop[i].stop("population_curve");
    }
  }

  state() {
    const agents = this.agents;
    return {
      enabled: this.running,
      configuredAccounts: this.accountCount,
      concurrentTarget: this.concurrentTarget,
      desiredOnline: this.desiredOnline(),
      online: agents.filter(a => a.online).length,
      starting: agents.filter(a => a.starting).length,
      inMatches: agents.filter(a => a.inMatch).length,
      waitingMatches: agents.filter(a => a.waitingMatchId).length,
      localHour: this.localHour(),
      metrics: { ...this.metrics },
      recentErrors: this.errors.slice(-12),
      sample: agents.filter(a => a.online).slice(0, 20).map(a => ({
        name: a.name,
        level: Number(a.profile?.level) || 1,
        coins: Number(a.profile?.coins) || 0,
        inMatch: a.inMatch,
        waiting: !!a.waitingMatchId,
        style: a.persona.style,
        skill: Number(a.persona.skill.toFixed(2)),
        aggression: Number(a.persona.aggression.toFixed(2))
      }))
    };
  }

  async stop() {
    this.running = false;
    clearTimeout(this.tickTimer);
    await Promise.all(this.agents.map(a => a.stop("manager_stop")));
  }
}

module.exports = { SyntheticPopulation };
