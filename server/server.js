"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 10000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://cardgame-l9ld.onrender.com";
const ROLPLAY_API_URL = process.env.ROLPLAY_API_URL || "https://mrmvmoyysxuopqexbxfk.supabase.co/functions/v1/rolplay-api";

function parseCatalog() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "cards.csv"), "utf8");
  return raw.trim().split(/\r?\n/).slice(1).map((line, index) => {
    const [name, rarity, quantity, level] = line.split(";");
    const lv = Number(level) || 1;
    const rar = Number(rarity) || 1;
    const powerCard = /^Poder(?:\s+x\s+\d+|\s*$)/i.test(name);
    const abilityCard = /^(Veneno|Fuente de vida|Drenador|Escudal|Barrera Mistica|Poder Mental|Poderador|Rueda)/i.test(name);
    return {
      id: index + 1,
      name,
      rarity: rar,
      quantity: Number(quantity) || 1,
      level: lv,
      powerCard,
      abilityCard,
      cost: powerCard ? 0 : Math.max(1, Math.min(10, Math.ceil(lv / 5))),
      atk: (powerCard || abilityCard) ? 0 : Math.max(1, Math.ceil(lv * 0.52) + Math.floor(rar / 30)),
      def: (powerCard || abilityCard) ? 0 : Math.max(1, Math.ceil(lv * 0.40) + Math.floor((101 - rar) / 40))
    };
  });
}

const CATALOG = parseCatalog();
const BY_ID = new Map(CATALOG.map(c => [c.id, c]));

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "64kb" }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [FRONTEND_ORIGIN, "http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const users = new Map();
const matches = new Map();
const trades = new Map();

function cleanName(value) {
  return String(value || "Jugador").replace(/[<>]/g, "").trim().slice(0, 24) || "Jugador";
}
async function profileFromSession(sessionToken) {
  if (!sessionToken || typeof sessionToken !== "string") return null;
  try {
    const response = await fetch(ROLPLAY_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rolplay-session": sessionToken },
      body: JSON.stringify({ action: "me" })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.ok && data.profile ? data.profile : null;
  } catch {
    return null;
  }
}
async function awardProfile(sessionToken, payload) {
  if (!sessionToken) return null;
  try {
    const response = await fetch(ROLPLAY_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rolplay-session": sessionToken },
      body: JSON.stringify({ action: "award_result", ...payload })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
}
function cleanText(value, max = 300) {
  return String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}
function id(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function powerValue(card) {
  const m = card && card.name.match(/^Poder\s+x\s+(\d+)/i);
  return m ? Math.max(1, Number(m[1]) || 1) : 1;
}
function publicUser(socketId, user) {
  return { socketId, name: user.name, level: user.level, status: user.status, wins: user.wins };
}
function emitUsers() {
  io.emit("lobby:users", [...users.entries()].map(([sid, u]) => publicUser(sid, u)));
}
function publicMatch(match) {
  return {
    id: match.id,
    player: match.player,
    level: match.level,
    deckSize: match.deckSize,
    start: match.start,
    status: match.status,
    hostSocketId: match.hostSocketId
  };
}
function emitMatches() {
  io.emit("matches:list", [...matches.values()].map(publicMatch));
}
function cardInstance(cardId) {
  return { uid: id("c"), cardId: Number(cardId), exhausted: false, selected: false };
}
function sanitizeDeck(input, size, level) {
  const ids = Array.isArray(input)
    ? input.map(Number).filter(x => {
        const c = BY_ID.get(x);
        return c && c.level <= level;
      }).slice(0, size)
    : [];
  return ids.length === size ? shuffle(ids.slice()) : [];
}
function sideOther(side) { return side === "a" ? "b" : "a"; }
function sideFor(match, socketId) {
  if (match.hostSocketId === socketId) return "a";
  if (match.guestSocketId === socketId) return "b";
  return null;
}
function totalPower(game, side) {
  return game.powers[side].reduce((sum, inst) => sum + powerValue(BY_ID.get(inst.cardId)), 0);
}
function gameLog(game, text) {
  game.log.push(text);
  if (game.log.length > 60) game.log.shift();
}
function draw(game, side, n = 1) {
  for (let i = 0; i < n; i++) {
    if (!game.deck[side].length) {
      game.deckOut[side] = true;
      break;
    }
    game.hand[side].push(cardInstance(game.deck[side].pop()));
  }
}
function beginTurn(game, side) {
  game.active = side;
  game.phase = 0;
  game.pendingAttack = null;
  game.powerPlayed[side] = false;
  game.board[side].forEach(c => { c.exhausted = false; c.selected = false; });
  game.availablePower[side] = totalPower(game, side);
}
function checkEnd(game) {
  if (game.gameOver) return true;
  let winner = null;
  if (game.hp.a <= 0 || game.deckOut.a) winner = "b";
  if (game.hp.b <= 0 || game.deckOut.b) winner = "a";
  if (winner) {
    game.gameOver = true;
    game.winner = winner;
    gameLog(game, winner === "a" ? "El jugador A gana el duelo." : "El jugador B gana el duelo.");
    return true;
  }
  return false;
}
function resolveAbility(game, side, inst) {
  const card = BY_ID.get(inst.cardId);
  const foe = sideOther(side);
  const n = card.name.toLowerCase();
  if (n.startsWith("fuente de vida")) {
    game.hp[side] += 3; gameLog(game, card.name + ": +3 PV.");
  } else if (n.startsWith("veneno")) {
    game.hp[foe] -= 3; game.damage[side] += 3; gameLog(game, card.name + ": 3 PV al adversario.");
  } else if (n.startsWith("drenador")) {
    game.hp[foe] -= 2; game.damage[side] += 2; game.hp[side] += 2; gameLog(game, card.name + ": drena 2 PV.");
  } else if (n.startsWith("poder mental")) {
    draw(game, side, 1); gameLog(game, card.name + ": carta adicional.");
  } else if (n.startsWith("poderador")) {
    game.availablePower[side] = Math.min(totalPower(game, side), game.availablePower[side] + 2);
    gameLog(game, card.name + ": recupera poder.");
  } else if (n.startsWith("escudal") || n.startsWith("barrera mistica")) {
    const target = game.board[side][0];
    if (target) target.defBonus = (target.defBonus || 0) + 3;
    gameLog(game, card.name + ": refuerza una criatura.");
  } else {
    draw(game, side, 1); gameLog(game, card.name + " se resuelve.");
  }
}
function effectiveDef(inst) {
  const card = BY_ID.get(inst.cardId);
  return (card?.def || 0) + (inst.defBonus || 0);
}
function declareAttack(game, side) {
  const foe = sideOther(side);
  const attackers = game.board[side].filter(c => c.selected && !c.exhausted);
  if (!attackers.length) return false;
  game.pendingAttack = {
    attackerSide: side,
    defenderSide: foe,
    attackers: attackers.map(c => c.uid),
    blocks: {}
  };
  gameLog(game, "Ataque declarado con " + attackers.length + " criatura(s). Esperando defensores.");
  return true;
}

function assignBlock(game, side, attackerUid, defenderUid) {
  const pending = game.pendingAttack;
  if (!pending || pending.defenderSide !== side || !pending.attackers.includes(attackerUid)) return;
  for (const [a, d] of Object.entries(pending.blocks)) {
    if (d === defenderUid && a !== attackerUid) delete pending.blocks[a];
  }
  if (!defenderUid) {
    delete pending.blocks[attackerUid];
    return;
  }
  const defender = game.board[side].find(c => c.uid === defenderUid && !c.exhausted);
  if (!defender) return;
  pending.blocks[attackerUid] = defenderUid;
}

function resolveDeclaredAttack(game) {
  const pending = game.pendingAttack;
  if (!pending) return;
  const side = pending.attackerSide;
  const foe = pending.defenderSide;

  for (const attackerUid of pending.attackers) {
    const attacker = game.board[side].find(c => c.uid === attackerUid);
    if (!attacker || attacker.exhausted) continue;
    const ac = BY_ID.get(attacker.cardId);
    const blockerUid = pending.blocks[attackerUid];
    const blocker = blockerUid ? game.board[foe].find(c => c.uid === blockerUid && !c.exhausted) : null;

    if (blocker) {
      const bc = BY_ID.get(blocker.cardId);
      const attackerDies = (bc?.atk || 0) >= effectiveDef(attacker);
      const blockerDies = (ac?.atk || 0) >= effectiveDef(blocker);
      gameLog(game, ac.name + " combate contra " + bc.name + ".");
      if (blockerDies) game.board[foe] = game.board[foe].filter(c => c.uid !== blocker.uid);
      if (attackerDies) game.board[side] = game.board[side].filter(c => c.uid !== attacker.uid);
    } else {
      const dealt = ac?.atk || 0;
      game.hp[foe] -= dealt;
      game.damage[side] += dealt;
      gameLog(game, ac.name + " causa " + dealt + " PV.");
    }
    const survivor = game.board[side].find(c => c.uid === attacker.uid);
    if (survivor) {
      survivor.exhausted = true;
      survivor.selected = false;
    }
  }
  game.pendingAttack = null;
}

function initDuel(match) {
  const size = match.deckSize;
  const game = {
    turn: 1,
    active: match.start === "random" && Math.random() < 0.5 ? "b" : "a",
    phase: 0,
    hp: { a: 30, b: 30 },
    deck: {
      a: sanitizeDeck(match.hostDeck, size, match.hostLevel),
      b: sanitizeDeck(match.guestDeck, size, match.guestLevel)
    },
    hand: { a: [], b: [] },
    board: { a: [], b: [] },
    powers: { a: [], b: [] },
    availablePower: { a: 0, b: 0 },
    powerPlayed: { a: false, b: false },
    pendingAttack: null,
    damage: { a: 0, b: 0 },
    rewardRequested: { a: false, b: false },
    deckOut: { a: false, b: false },
    gameOver: false,
    winner: null,
    log: []
  };
  draw(game, "a", 7);
  draw(game, "b", 7);
  beginTurn(game, game.active);
  gameLog(game, "Duelo online iniciado con 7 cartas por jugador.");
  match.duel = game;
}
function snapshotFor(match, socketId) {
  const game = match.duel;
  const side = sideFor(match, socketId);
  if (!game || !side) return null;
  const foe = sideOther(side);
  const opponentSocket = side === "a" ? match.guestSocketId : match.hostSocketId;
  const opponent = users.get(opponentSocket);
  return {
    matchId: match.id,
    side,
    myTurn: game.pendingAttack ? game.pendingAttack.defenderSide === side : game.active === side,
    phase: game.phase,
    turn: game.turn,
    playerHp: game.hp[side],
    enemyHp: game.hp[foe],
    power: game.availablePower[side],
    maxPower: totalPower(game, side),
    powerPlayed: !!game.powerPlayed[side],
    enemyPower: game.availablePower[foe],
    enemyMaxPower: totalPower(game, foe),
    playerDeckCount: game.deck[side].length,
    enemyDeckCount: game.deck[foe].length,
    playerHand: game.hand[side],
    enemyHandCount: game.hand[foe].length,
    playerBoard: game.board[side],
    enemyBoard: game.board[foe],
    playerPowers: game.powers[side],
    enemyPowers: game.powers[foe],
    gameOver: game.gameOver,
    won: game.gameOver ? game.winner === side : null,
    defending: !!(game.pendingAttack && game.pendingAttack.defenderSide === side),
    attackDeclared: !!(game.pendingAttack && game.pendingAttack.attackerSide === side),
    blockAssignments: game.pendingAttack ? { ...game.pendingAttack.blocks } : {},
    damageDealt: game.damage[side],
    opponent: opponent ? publicUser(opponentSocket, opponent) : { name: match.player },
    log: game.log.slice(-35)
  };
}
async function rewardSide(match, side) {
  const game = match.duel;
  if (!game || !game.gameOver || game.rewardRequested[side]) return;
  game.rewardRequested[side] = true;
  const socketId = side === "a" ? match.hostSocketId : match.guestSocketId;
  const user = users.get(socketId);
  if (!user || !user.sessionToken) return;
  const result = await awardProfile(user.sessionToken, {
    rewardKey: "online:" + match.id + ":" + user.accountId,
    win: game.winner === side,
    damage: Math.min(30, Math.max(0, game.damage[side] || 0)),
    mode: "online"
  });
  if (result && result.profile) {
    user.level = result.profile.level;
    user.wins = result.profile.wins;
    io.to(socketId).emit("profile:update", {
      profile: result.profile,
      xpAwarded: result.xpAwarded || 0,
      goldAwarded: result.goldAwarded || 0
    });
    emitUsers();
  }
}
function emitDuel(match) {
  if (!match.duel) return;
  if (match.hostSocketId) io.to(match.hostSocketId).emit("duel:snapshot", snapshotFor(match, match.hostSocketId));
  if (match.guestSocketId) io.to(match.guestSocketId).emit("duel:snapshot", snapshotFor(match, match.guestSocketId));
  if (match.duel.gameOver) {
    void rewardSide(match, "a");
    void rewardSide(match, "b");
  }
}
function playCard(match, side, uid) {
  const game = match.duel;
  const index = game.hand[side].findIndex(c => c.uid === uid);
  if (index < 0) return;
  const inst = game.hand[side][index];
  const card = BY_ID.get(inst.cardId);
  if (!card) return;

  if (game.phase === 2 && card.powerCard && !game.powerPlayed[side]) {
    game.hand[side].splice(index, 1);
    game.powerPlayed[side] = true;
    game.powers[side].push(inst);
    game.availablePower[side] = totalPower(game, side);
    gameLog(game, (users.get(side === "a" ? match.hostSocketId : match.guestSocketId)?.name || "Jugador") + " conjura " + card.name + ".");
    return;
  }
  if (game.phase === 3 && !card.powerCard && !card.abilityCard && card.cost <= game.availablePower[side]) {
    game.availablePower[side] -= card.cost;
    game.hand[side].splice(index, 1);
    game.board[side].push(inst);
    gameLog(game, card.name + " entra en juego.");
    return;
  }
  if (game.phase === 4 && card.abilityCard && card.cost <= game.availablePower[side]) {
    game.availablePower[side] -= card.cost;
    game.hand[side].splice(index, 1);
    resolveAbility(game, side, inst);
  }
}
function handleDuelAction(match, socketId, payload) {
  const game = match.duel;
  const side = sideFor(match, socketId);
  if (!game || !side || game.gameOver) return;

  const type = cleanText(payload && payload.type, 40);

  if (type === "concede") {
    game.gameOver = true;
    game.winner = sideOther(side);
    gameLog(game, "Un jugador se ha retirado.");
    emitDuel(match);
    return;
  }

  if (game.pendingAttack) {
    if (game.pendingAttack.defenderSide !== side) return;
    if (type === "assignBlock") {
      assignBlock(
        game,
        side,
        cleanText(payload && payload.attackerUid, 100),
        cleanText(payload && payload.defenderUid, 100)
      );
      emitDuel(match);
      return;
    }
    if (type === "resolveDefense") {
      resolveDeclaredAttack(game);
      if (!checkEnd(game)) {
        game.turn += 1;
        beginTurn(game, sideOther(game.active));
      }
      emitDuel(match);
      return;
    }
    return;
  }

  if (game.active !== side) return;

  if (type === "play") {
    playCard(match, side, cleanText(payload && payload.uid, 100));
  } else if (type === "toggleAttack" && game.phase === 5) {
    const unit = game.board[side].find(c => c.uid === cleanText(payload && payload.uid, 100));
    if (unit && !unit.exhausted) unit.selected = !unit.selected;
  } else if (type === "nextPhase") {
    if (game.phase === 5) {
      const declared = declareAttack(game, side);
      if (!declared) {
        game.turn += 1;
        beginTurn(game, sideOther(side));
      } else {
        const foe = sideOther(side);
        const defenders = game.board[foe].filter(c => !c.exhausted);
        if (!defenders.length) {
          resolveDeclaredAttack(game);
          if (!checkEnd(game)) {
            game.turn += 1;
            beginTurn(game, foe);
          }
        }
      }
    } else {
      game.phase += 1;
      if (game.phase === 1) {
        draw(game, side, 1);
        checkEnd(game);
      }
      if (game.phase === 2) game.availablePower[side] = totalPower(game, side);
    }
  }
  checkEnd(game);
  emitDuel(match);
}

function removeSocketMatches(socketId) {
  let changed = false;
  for (const [mid, match] of matches.entries()) {
    if (match.hostSocketId === socketId || match.guestSocketId === socketId) {
      const otherId = match.hostSocketId === socketId ? match.guestSocketId : match.hostSocketId;
      if (otherId && match.duel && !match.duel.gameOver) {
        match.duel.gameOver = true;
        match.duel.winner = sideFor(match, otherId);
        gameLog(match.duel, "El adversario se ha desconectado.");
        emitDuel(match);
      }
      matches.delete(mid);
      changed = true;
    }
  }
  if (changed) emitMatches();
}

app.get("/", (_req, res) => {
  res.json({
    service: "rolplay-restoration-server",
    online: users.size,
    openMatches: [...matches.values()].filter(m => m.status === "waiting").length,
    version: "0.3.0"
  });
});
app.get("/health", (_req, res) => res.json({ ok: true, online: users.size, matches: matches.size, cards: CATALOG.length }));
app.get("/state", (_req, res) => res.json({
  users: [...users.entries()].map(([sid, u]) => publicUser(sid, u)),
  matches: [...matches.values()].map(publicMatch)
}));

io.on("connection", socket => {
  socket.on("hello", async payload => {
    const sessionToken = String(payload && payload.sessionToken || "");
    const profile = await profileFromSession(sessionToken);
    if (!profile) {
      socket.emit("auth:error", { message: "Sesión inválida o caducada." });
      socket.disconnect(true);
      return;
    }
    const user = {
      accountId: profile.id,
      sessionToken,
      name: cleanName(profile.name),
      level: Math.max(1, Math.min(50, Number(profile.level) || 1)),
      wins: Math.max(0, Number(profile.wins) || 0),
      deck: Array.isArray(profile.deck) ? profile.deck.map(Number) : [],
      status: "Disponible"
    };
    users.set(socket.id, user);
    socket.emit("server:ready", { socketId: socket.id, version: "0.3.0", cards: CATALOG.length });
    emitUsers();
    emitMatches();
    socket.broadcast.emit("chat:system", { text: user.name + " se ha unido al canal." });
  });

  socket.on("presence:set", payload => {
    const user = users.get(socket.id);
    if (!user) return;
    user.status = payload && payload.away ? "No disponible" : "Disponible";
    emitUsers();
  });

  socket.on("chat:send", payload => {
    const user = users.get(socket.id);
    if (!user) return;
    const text = cleanText(payload && payload.text);
    if (!text) return;
    io.emit("chat:message", { id: id("msg"), from: user.name, socketId: socket.id, text, at: Date.now() });
  });

  socket.on("match:create", payload => {
    const user = users.get(socket.id);
    if (!user) return;
    removeSocketMatches(socket.id);
    const deckSize = [20, 30, 40, 50].includes(Number(payload && payload.deckSize)) ? Number(payload.deckSize) : 30;
    if (!Array.isArray(user.deck) || user.deck.length < deckSize) {
      socket.emit("match:error", { message: "Tu mazo guardado no tiene suficientes cartas." });
      return;
    }
    const match = {
      id: id("match"),
      player: user.name,
      level: user.level,
      deckSize,
      start: payload && payload.start === "random" ? "random" : "normal",
      status: "waiting",
      hostSocketId: socket.id,
      guestSocketId: null,
      hostDeck: user.deck.slice(0, deckSize),
      guestDeck: [],
      hostLevel: user.level,
      guestLevel: 1,
      duel: null,
      createdAt: Date.now()
    };
    matches.set(match.id, match);
    socket.join(match.id);
    socket.emit("match:created", publicMatch(match));
    emitMatches();
  });

  socket.on("match:cancel", payload => {
    const mid = cleanText(payload && payload.id, 80);
    const match = matches.get(mid);
    if (!match || match.hostSocketId !== socket.id) return;
    matches.delete(mid);
    emitMatches();
  });

  socket.on("match:join", payload => {
    const mid = cleanText(payload && payload.id, 80);
    const match = matches.get(mid);
    const user = users.get(socket.id);
    if (!match || !user || match.status !== "waiting" || match.hostSocketId === socket.id) {
      socket.emit("match:error", { message: "La partida ya no está disponible." });
      return;
    }
    match.status = "playing";
    if (!Array.isArray(user.deck) || user.deck.length < match.deckSize) {
      socket.emit("match:error", { message: "Tu mazo guardado no tiene suficientes cartas." });
      return;
    }
    match.guestSocketId = socket.id;
    match.guestDeck = user.deck.slice(0, match.deckSize);
    match.guestLevel = user.level;
    socket.join(mid);
    initDuel(match);

    const host = users.get(match.hostSocketId);
    io.to(match.hostSocketId).emit("match:ready", {
      id: mid, side: "host", deckSize: match.deckSize, start: match.start,
      opponent: publicUser(socket.id, user)
    });
    io.to(socket.id).emit("match:ready", {
      id: mid, side: "guest", deckSize: match.deckSize, start: match.start,
      opponent: host ? publicUser(match.hostSocketId, host) : { name: match.player }
    });
    emitMatches();
    emitDuel(match);
  });

  socket.on("duel:action", payload => {
    const mid = cleanText(payload && payload.matchId, 80);
    const match = matches.get(mid);
    if (!match) return;
    handleDuelAction(match, socket.id, payload);
  });

  socket.on("game:event", payload => {
    const mid = cleanText(payload && payload.matchId, 80);
    const match = matches.get(mid);
    if (!match) return;
    if (match.hostSocketId !== socket.id && match.guestSocketId !== socket.id) return;
    socket.to(mid).emit("game:event", {
      matchId: mid,
      from: socket.id,
      type: cleanText(payload && payload.type, 60),
      data: payload && payload.data || null
    });
  });

  socket.on("trade:invite", payload => {
    const user = users.get(socket.id);
    const to = cleanText(payload && payload.to, 100);
    if (!user || !users.has(to) || to === socket.id) return;
    const tradeId = id("trade");
    trades.set(tradeId, { id: tradeId, a: socket.id, b: to, acceptedA: false, acceptedB: false });
    io.to(to).emit("trade:invited", { tradeId, from: publicUser(socket.id, user) });
    socket.emit("trade:waiting", { tradeId, to });
  });

  socket.on("trade:offer", payload => {
    const trade = trades.get(cleanText(payload && payload.tradeId, 100));
    if (!trade || (trade.a !== socket.id && trade.b !== socket.id)) return;
    const other = trade.a === socket.id ? trade.b : trade.a;
    trade.acceptedA = false; trade.acceptedB = false;
    io.to(other).emit("trade:offer", {
      tradeId: trade.id,
      from: socket.id,
      cards: Array.isArray(payload && payload.cards) ? payload.cards.slice(0, 20) : [],
      gold: Math.max(0, Math.floor(Number(payload && payload.gold) || 0))
    });
  });

  socket.on("trade:accept", payload => {
    const trade = trades.get(cleanText(payload && payload.tradeId, 100));
    if (!trade || (trade.a !== socket.id && trade.b !== socket.id)) return;
    if (trade.a === socket.id) trade.acceptedA = true;
    if (trade.b === socket.id) trade.acceptedB = true;
    const other = trade.a === socket.id ? trade.b : trade.a;
    io.to(other).emit("trade:accepted", { tradeId: trade.id, by: socket.id });
    if (trade.acceptedA && trade.acceptedB) {
      io.to(trade.a).emit("trade:locked", { tradeId: trade.id });
      io.to(trade.b).emit("trade:locked", { tradeId: trade.id });
      trades.delete(trade.id);
    }
  });

  socket.on("trade:cancel", payload => {
    const tradeId = cleanText(payload && payload.tradeId, 100);
    const trade = trades.get(tradeId);
    if (!trade || (trade.a !== socket.id && trade.b !== socket.id)) return;
    const other = trade.a === socket.id ? trade.b : trade.a;
    io.to(other).emit("trade:cancelled", { tradeId });
    trades.delete(tradeId);
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    removeSocketMatches(socket.id);
    users.delete(socket.id);
    for (const [tid, trade] of trades.entries()) {
      if (trade.a === socket.id || trade.b === socket.id) {
        const other = trade.a === socket.id ? trade.b : trade.a;
        io.to(other).emit("trade:cancelled", { tradeId: tid, reason: "opponent_left" });
        trades.delete(tid);
      }
    }
    emitUsers();
    if (user) socket.broadcast.emit("chat:system", { text: user.name + " ha salido del canal." });
  });
});

httpServer.listen(PORT, () => {
  console.log("Rolplay restoration server v0.2.0 listening on port", PORT, "with", CATALOG.length, "cards");
});
