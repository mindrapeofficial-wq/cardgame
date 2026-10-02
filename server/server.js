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

const LEVEL1_COMBAT_STATS = Object.freeze({
  "Duende": { atk: 1, def: 1 },
  "Elfo Bardo": { atk: 0, def: 2 },
  "Guerrero Menor": { atk: 1, def: 1 },
  "Dophan": { atk: 2, def: 1 },
  "Gorad Menor": { atk: 1, def: 2 },
  "Mimit": { atk: 0, def: 3 },
  "Mel": { atk: 1, def: 1 }
});

const LEVEL1_POWER_COSTS = Object.freeze({
  "Duende": 1,
  "Elfo Bardo": 2,
  "Guerrero Menor": 2,
  "Mel": 2,
  "Dophan": 3,
  "Gorad Menor": 3,
  "Mimit": 3
});
function summonCost(name, level, powerCard) {
  if (powerCard) return 0;
  const fixed = Number(level) === 1 ? LEVEL1_POWER_COSTS[name] : undefined;
  return Number.isFinite(fixed) ? fixed : Math.max(1, Math.min(10, Math.ceil((Number(level) || 1) / 5)));
}

function parseCatalog() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "cards.csv"), "utf8");
  return raw.trim().split(/\r?\n/).slice(1).map((line, index) => {
    const [name, rarity, quantity, level] = line.split(";");
    const lv = Number(level) || 1;
    const rar = Number(rarity) || 1;
    const powerCard = /^Poder(?:\s+x\s+\d+|\s*$)/i.test(name);
    const abilityCard = /^(Veneno|Fuente de vida|Drenador|Escudal|Barrera Mistica|Poder Mental|Poderador|Rueda)/i.test(name);
    const fixedStats = lv === 1 ? LEVEL1_COMBAT_STATS[name] : undefined;
    return {
      id: index + 1,
      name,
      rarity: rar,
      quantity: Number(quantity) || 1,
      level: lv,
      powerCard,
      abilityCard,
      cost: summonCost(name, lv, powerCard),
      atk: (powerCard || abilityCard) ? 0 : (fixedStats ? fixedStats.atk : Math.max(1, Math.ceil(lv * 0.52) + Math.floor(rar / 30))),
      def: (powerCard || abilityCard) ? 0 : (fixedStats ? fixedStats.def : Math.max(1, Math.ceil(lv * 0.40) + Math.floor((101 - rar) / 40)))
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

const DECK_MIN = 20;
const DECK_MAX = 50;
const MIN_POWER_CARDS = 7;
const MAX_POWER_CARDS = 40;
const MAX_POWER_POINTS = 200;
const INITIAL_HAND = 7;
const SECOND_PLAYER_BONUS = 1;
const MATCH_LIMIT_MS = 40 * 60 * 1000;
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
async function settleTradeProfiles(trade) {
  const ua = users.get(trade.a);
  const ub = users.get(trade.b);
  if (!ua || !ub || !ua.sessionToken || !ub.sessionToken) return { ok: false, error: "player_offline" };
  try {
    const response = await fetch(ROLPLAY_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "settle_trade",
        tradeKey: "trade:" + trade.id,
        sessionA: ua.sessionToken,
        sessionB: ub.sessionToken,
        cardsA: trade.offers.a.cards,
        goldA: trade.offers.a.gold,
        cardsB: trade.offers.b.cards,
        goldB: trade.offers.b.gold
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) return { ok: false, error: data.error || "trade_failed" };
    return data;
  } catch {
    return { ok: false, error: "trade_network_error" };
  }
}
async function settleMatchProfiles(match) {
  const game = match.duel;
  if (!game || !game.gameOver || game.rewardSettled) return null;
  game.rewardSettled = true;
  try {
    const response = await fetch(ROLPLAY_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "settle_match",
        matchKey: match.id,
        sessionA: match.hostSessionToken,
        sessionB: match.guestSessionToken,
        outcome: game.winner
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      game.rewardSettled = false;
      return null;
    }
    return data;
  } catch {
    game.rewardSettled = false;
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
  return { socketId, name: user.name, level: user.level, elo: Number(user.elo) || 1000, status: user.status, wins: user.wins };
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
    hostSocketId: match.hostSocketId,
    elo: Number(match.elo) || 1000
  };
}
function emitMatches() {
  io.emit("matches:list", [...matches.values()].map(publicMatch));
}
function cardInstance(cardId) {
  return {
    uid: id("c"),
    cardId: Number(cardId),
    exhausted: false,
    selected: false,
    damage: 0,
    summonedTurn: null,
    attacksThisTurn: 0,
    defensesThisTurn: 0
  };
}
function playDeckError(input, level) {
  if (!Array.isArray(input)) return "Tu mazo no es válido.";
  const ids = input.map(Number);
  if (ids.length < DECK_MIN || ids.length > DECK_MAX) return "El mazo debe tener entre 20 y 50 cartas.";
  let powers = 0;
  for (const cardId of ids) {
    const card = BY_ID.get(cardId);
    if (!card || card.level > level) return "El mazo contiene cartas no válidas para tu nivel.";
    if (card.powerCard) powers += 1;
  }
  if (powers < MIN_POWER_CARDS) return "El mazo necesita al menos 7 cartas de Poder.";
  if (powers > MAX_POWER_CARDS) return "El mazo no puede contener más de 40 cartas de Poder.";
  return "";
}
function sanitizeDeck(input, level) {
  return playDeckError(input, level) ? [] : shuffle(input.map(Number));
}
function sideOther(side) { return side === "a" ? "b" : "a"; }
function sideFor(match, socketId) {
  if (match.hostSocketId === socketId) return "a";
  if (match.guestSocketId === socketId) return "b";
  return null;
}
function totalPower(game, side) {
  return Math.min(MAX_POWER_POINTS, game.powers[side].reduce((sum, inst) => sum + powerValue(BY_ID.get(inst.cardId)), 0));
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
    if (!game.deck[side].length) {
      game.deckOut[side] = true;
      break;
    }
  }
}
function beginTurn(game, side) {
  game.active = side;
  game.phase = 0;
  game.pendingAttack = null;
  game.powerPlayed[side] = false;
  game.board[side].forEach(c => {
    c.exhausted = false;
    c.selected = false;
    c.attacksThisTurn = 0;
    c.defensesThisTurn = 0;
  });
  game.powers[side].forEach(c => { c.exhausted = false; });
  game.availablePower[side] = 0;
}
function attackLimit(card) {
  return Math.max(1, Number(card?.multiAttack) || 1);
}
function defenseLimit(card) {
  return Math.max(1, Number(card?.multiDefense) || 1);
}
function canAttack(game, side, inst) {
  const card = BY_ID.get(inst.cardId);
  if (!card || (Number(card.atk) || 0) <= 0) return false;
  if (inst.exhausted && (Number(inst.attacksThisTurn) || 0) >= attackLimit(card)) return false;
  if (inst.summonedTurn === game.turn && !card.berserker) return false;
  return (Number(inst.attacksThisTurn) || 0) < attackLimit(card);
}
function canDefend(game, side, inst) {
  const card = BY_ID.get(inst.cardId);
  if (!card) return false;
  const used = Number(inst.defensesThisTurn) || 0;
  if (used >= defenseLimit(card)) return false;
  return !inst.exhausted || !!card.defender;
}
function phaseHasAction(game, side) {
  if (!game || game.gameOver || game.pendingAttack) return false;
  if (game.phase === 2) {
    return !game.powerPlayed[side] && game.hand[side].some(inst => BY_ID.get(inst.cardId)?.powerCard);
  }
  if (game.phase === 3) {
    return game.hand[side].some(inst => {
      const card = BY_ID.get(inst.cardId);
      return card && !card.powerCard && !card.abilityCard && card.cost <= game.availablePower[side];
    });
  }
  if (game.phase === 4) {
    return game.hand[side].some(inst => {
      const card = BY_ID.get(inst.cardId);
      return card && card.abilityCard && card.cost <= game.availablePower[side];
    });
  }
  if (game.phase === 5) return game.board[side].some(inst => canAttack(game, side, inst));
  return false;
}
function advanceAutomaticPhases(game) {
  let guard = 0;
  while (game && !game.gameOver && !game.pendingAttack && guard++ < 128) {
    const side = game.active;
    if (phaseHasAction(game, side)) return;

    if (game.phase >= 5) {
      game.turn += 1;
      beginTurn(game, sideOther(side));
      continue;
    }

    game.phase += 1;
    if (game.phase === 1) {
      draw(game, side, 1);
      if (checkEnd(game)) return;
    }
    if (game.phase === 2) game.availablePower[side] = totalPower(game, side);
  }
}
function highestLevelBaseAttack(game, side) {
  const inPlay = [...game.board[side], ...game.powers[side]]
    .map(inst => BY_ID.get(inst.cardId))
    .filter(Boolean);
  if (!inPlay.length) return 0;
  const highestLevel = Math.max(...inPlay.map(card => Number(card.level) || 0));
  return Math.max(0, ...inPlay.filter(card => (Number(card.level) || 0) === highestLevel).map(card => Number(card.atk) || 0));
}
function gameScore(game, side) {
  return Math.max(0, Number(game.hp[side]) || 0)
    + game.board[side].length
    + game.powers[side].length
    + game.deck[side].length
    + highestLevelBaseAttack(game, side);
}
function resolveByScore(game, reason) {
  if (game.gameOver) return true;
  const a = gameScore(game, "a");
  const b = gameScore(game, "b");
  game.gameOver = true;
  game.winner = a === b ? "draw" : a > b ? "a" : "b";
  gameLog(game, reason + " Puntuación final: A " + a + " · B " + b + ".");
  if (game.winner === "draw") gameLog(game, "La partida termina en empate por puntuación.");
  else gameLog(game, game.winner === "a" ? "El jugador A gana por puntuación." : "El jugador B gana por puntuación.");
  return true;
}
function checkEnd(game) {
  if (game.gameOver) return true;
  if (game.deadlineAt && Date.now() >= game.deadlineAt) {
    return resolveByScore(game, "Se alcanza el límite de 40 minutos.");
  }
  const aLost = game.hp.a <= 0 || game.deckOut.a;
  const bLost = game.hp.b <= 0 || game.deckOut.b;
  if (!aLost && !bLost) return false;

  if (aLost && bLost) return resolveByScore(game, "Ambos jugadores alcanzan una condición de derrota al mismo tiempo.");
  game.gameOver = true;
  game.winner = aLost ? "b" : "a";
  gameLog(game, game.winner === "a" ? "El jugador A gana el duelo." : "El jugador B gana el duelo.");
  return true;
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
  return Math.max(0, (card?.def || 0) + (inst.defBonus || 0) - (inst.damage || 0));
}
function resolvePendingAttack(game, defenderSide, defenderUid) {
  const pending = game.pendingAttack;
  if (!pending) return false;
  const side = pending.side;
  const foe = sideOther(side);
  if (defenderSide && defenderSide !== foe) return false;

  const attacker = game.board[side].find(c => c.uid === pending.attackerUid);
  if (!attacker) {
    game.pendingAttack = null;
    return false;
  }

  const ac = BY_ID.get(attacker.cardId);
  const defenders = game.board[foe].filter(inst => canDefend(game, foe, inst));
  let defender = null;

  if (defenders.length) {
    const wanted = cleanText(defenderUid, 100);
    defender = wanted ? defenders.find(inst => inst.uid === wanted) : null;
    if (!defender) return false;
  }

  game.pendingAttack = null;

  if (!defender) {
    const dealt = Math.max(0, Number(ac?.atk) || 0);
    game.hp[foe] -= dealt;
    game.damage[side] += dealt;
    gameLog(game, ac.name + " ataca directamente y causa " + dealt + " PV.");
    return true;
  }

  const bc = BY_ID.get(defender.cardId);
  const attackerAttack = Math.max(0, Number(ac?.atk) || 0);
  const defenderAttack = Math.max(0, Number(bc?.atk) || 0);
  const defenderDefBefore = effectiveDef(defender);

  defender.defensesThisTurn = (Number(defender.defensesThisTurn) || 0) + 1;
  defender.exhausted = true;
  defender.damage = (Number(defender.damage) || 0) + attackerAttack;
  attacker.damage = (Number(attacker.damage) || 0) + defenderAttack;

  const overflow = Math.max(0, attackerAttack - defenderDefBefore);
  if (overflow > 0) {
    game.hp[foe] -= overflow;
    game.damage[side] += overflow;
  }

  gameLog(
    game,
    ac.name + " (" + attackerAttack + " ATQ) combate con " + bc.name + " (" + defenderAttack + " ATQ / " + defenderDefBefore + " DEF)."
    + (overflow ? " " + overflow + " de daño atraviesa al jugador defensor." : "")
  );

  if (effectiveDef(defender) <= 0) {
    game.board[foe] = game.board[foe].filter(c => c.uid !== defender.uid);
    gameLog(game, bc.name + " es destruida.");
  }
  if (effectiveDef(attacker) <= 0) {
    game.board[side] = game.board[side].filter(c => c.uid !== attacker.uid);
    gameLog(game, ac.name + " es destruida por el contraataque.");
  }
  return true;
}
function declareAttack(game, side, uid) {
  if (!game || game.gameOver || game.phase !== 5 || game.pendingAttack) return false;
  const attacker = game.board[side].find(c => c.uid === uid);
  if (!attacker || !canAttack(game, side, attacker)) return false;

  const ac = BY_ID.get(attacker.cardId);
  attacker.attacksThisTurn = (Number(attacker.attacksThisTurn) || 0) + 1;
  attacker.exhausted = true;
  attacker.selected = false;
  game.pendingAttack = { side, attackerUid: attacker.uid };
  gameLog(game, ac.name + " declara un ataque.");

  const foe = sideOther(side);
  const defenders = game.board[foe].filter(inst => canDefend(game, foe, inst));
  if (!defenders.length) return resolvePendingAttack(game, null, "");
  return true;
}

function initDuel(match) {
  const startedAt = Date.now();
  const game = {
    turn: 1,
    active: Math.random() < 0.5 ? "b" : "a",
    phase: 0,
    hp: { a: 30, b: 30 },
    deck: {
      a: sanitizeDeck(match.hostDeck, match.hostLevel),
      b: sanitizeDeck(match.guestDeck, match.guestLevel)
    },
    hand: { a: [], b: [] },
    board: { a: [], b: [] },
    powers: { a: [], b: [] },
    availablePower: { a: 0, b: 0 },
    powerPlayed: { a: false, b: false },
    pendingAttack: null,
    drawOfferBy: null,
    damage: { a: 0, b: 0 },
    rewardSettled: false,
    deckOut: { a: false, b: false },
    gameOver: false,
    winner: null,
    startedAt,
    deadlineAt: startedAt + MATCH_LIMIT_MS,
    log: []
  };
  draw(game, "a", INITIAL_HAND);
  draw(game, "b", INITIAL_HAND);
  draw(game, sideOther(game.active), SECOND_PLAYER_BONUS);
  beginTurn(game, game.active);
  match.duel = game;
  gameLog(game, "Duelo iniciado. El jugador inicial fue elegido al azar; el segundo recibió una carta adicional.");
  advanceAutomaticPhases(game);

  setTimeout(() => {
    const live = matches.get(match.id);
    if (!live || live.duel !== game || game.gameOver) return;
    resolveByScore(game, "Se alcanza el límite de 40 minutos.");
    emitDuel(match);
  }, MATCH_LIMIT_MS + 50);
}
function snapshotFor(match, socketId) {
  const game = match.duel;
  const side = sideFor(match, socketId);
  if (!game || !side) return null;
  const foe = sideOther(side);
  const opponentSocket = side === "a" ? match.guestSocketId : match.hostSocketId;
  const opponent = users.get(opponentSocket);
  const pending = game.pendingAttack;
  const pendingAttacker = pending ? game.board[pending.side].find(c => c.uid === pending.attackerUid) : null;
  const pendingCard = pendingAttacker ? BY_ID.get(pendingAttacker.cardId) : null;
  return {
    matchId: match.id,
    side,
    myTurn: game.active === side,
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
    result: game.gameOver ? (game.winner === "draw" ? "draw" : game.winner === side ? "win" : "loss") : null,
    won: game.gameOver ? (game.winner === "draw" ? null : game.winner === side) : null,
    defending: !!pending && pending.side === foe,
    attackDeclared: !!pending && pending.side === side,
    pendingAttack: pending ? { attackerUid: pending.attackerUid, attackerName: pendingCard?.name || "Criatura" } : null,
    drawOfferIncoming: !!(game.drawOfferBy && game.drawOfferBy !== side),
    drawOfferOutgoing: game.drawOfferBy === side,
    blockAssignments: {},
    damageDealt: game.damage[side],
    opponent: opponent ? publicUser(opponentSocket, opponent) : { name: match.player },
    log: game.log.slice(-35)
  };
}
async function settleMatchReward(match) {
  const game = match.duel;
  if (!game || !game.gameOver || game.rewardSettled) return;
  const result = await settleMatchProfiles(match);
  if (!result) return;

  const aUser = users.get(match.hostSocketId);
  const bUser = users.get(match.guestSocketId);
  if (aUser && result.profileA) {
    aUser.level = result.profileA.level;
    aUser.wins = result.profileA.wins;
    aUser.draws = result.profileA.draws || 0;
    aUser.elo = Number(result.profileA.elo) || 1000;
    io.to(match.hostSocketId).emit("profile:update", {
      profile: result.profileA,
      xpAwarded: result.rewardA?.xp || 0,
      goldAwarded: result.rewardA?.gold || 0,
      eloDelta: result.rewardA?.eloDelta || 0,
      matchResult: result.rewardA?.result || null
    });
  }
  if (bUser && result.profileB) {
    bUser.level = result.profileB.level;
    bUser.wins = result.profileB.wins;
    bUser.draws = result.profileB.draws || 0;
    bUser.elo = Number(result.profileB.elo) || 1000;
    io.to(match.guestSocketId).emit("profile:update", {
      profile: result.profileB,
      xpAwarded: result.rewardB?.xp || 0,
      goldAwarded: result.rewardB?.gold || 0,
      eloDelta: result.rewardB?.eloDelta || 0,
      matchResult: result.rewardB?.result || null
    });
  }
  emitUsers();
}
function emitDuel(match) {
  if (!match.duel) return;
  if (match.hostSocketId) io.to(match.hostSocketId).emit("duel:snapshot", snapshotFor(match, match.hostSocketId));
  if (match.guestSocketId) io.to(match.guestSocketId).emit("duel:snapshot", snapshotFor(match, match.guestSocketId));
  if (match.duel.gameOver) void settleMatchReward(match);
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
    inst.exhausted = false;
    game.powers[side].push(inst);
    game.availablePower[side] = totalPower(game, side);
    gameLog(game, (users.get(side === "a" ? match.hostSocketId : match.guestSocketId)?.name || "Jugador") + " pone " + card.name + " en su zona de Poder. Poder disponible: " + game.availablePower[side] + ".");
    return;
  }
  if (game.phase === 3 && !card.powerCard && !card.abilityCard && card.cost <= game.availablePower[side]) {
    game.availablePower[side] -= card.cost;
    game.hand[side].splice(index, 1);
    inst.summonedTurn = game.turn;
    inst.damage = 0;
    inst.attacksThisTurn = 0;
    inst.defensesThisTurn = 0;
    game.board[side].push(inst);
    gameLog(game, card.name + " entra en juego y no puede atacar este turno salvo que tenga Berserker.");
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
    game.drawOfferBy = null;
    gameLog(game, "Un jugador se ha rendido. Su rival gana la partida.");
    emitDuel(match);
    return;
  }

  if (type === "offerDraw") {
    if (!game.drawOfferBy) {
      game.drawOfferBy = side;
      gameLog(game, "Se ha ofrecido un empate por tablas.");
      emitDuel(match);
    }
    return;
  }

  if (type === "respondDraw") {
    if (!game.drawOfferBy || game.drawOfferBy === side) return;
    const accepted = payload && payload.accept === true;
    if (accepted) {
      game.gameOver = true;
      game.winner = "draw";
      game.drawOfferBy = null;
      gameLog(game, "La oferta de tablas ha sido aceptada. La partida termina en empate.");
    } else {
      game.drawOfferBy = null;
      gameLog(game, "La oferta de tablas ha sido rechazada. La partida continúa.");
    }
    emitDuel(match);
    return;
  }

  if (type === "defend") {
    if (game.phase !== 5 || !game.pendingAttack || side !== sideOther(game.pendingAttack.side)) return;
    const resolved = resolvePendingAttack(game, side, cleanText(payload && payload.uid, 100));
    if (!resolved) return;
    if (!checkEnd(game)) advanceAutomaticPhases(game);
    checkEnd(game);
    emitDuel(match);
    return;
  }

  if (game.active !== side) return;

  if (type === "play") {
    playCard(match, side, cleanText(payload && payload.uid, 100));
    advanceAutomaticPhases(game);
  } else if (type === "attack" && game.phase === 5) {
    const declared = declareAttack(game, side, cleanText(payload && payload.uid, 100));
    if (declared && !game.pendingAttack && !checkEnd(game)) advanceAutomaticPhases(game);
  } else if (type === "nextPhase") {
    if (game.phase === 5) {
      if (game.pendingAttack) return;
      game.turn += 1;
      beginTurn(game, sideOther(side));
      advanceAutomaticPhases(game);
    } else {
      game.phase += 1;
      if (game.phase === 1) {
        draw(game, side, 1);
        checkEnd(game);
      }
      if (game.phase === 2) game.availablePower[side] = totalPower(game, side);
      advanceAutomaticPhases(game);
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
    version: "0.6.0"
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
      elo: Number(profile.elo) || 1000,
      deck: Array.isArray(profile.deck) ? profile.deck.map(Number) : [],
      status: "Disponible"
    };
    users.set(socket.id, user);
    socket.emit("server:ready", { socketId: socket.id, version: "0.6.0", cards: CATALOG.length });
    emitUsers();
    emitMatches();
    socket.broadcast.emit("chat:system", { text: user.name + " se ha unido al canal." });
  });

  socket.on("profile:refresh", async () => {
    const user = users.get(socket.id);
    if (!user || !user.sessionToken) return;
    const profile = await profileFromSession(user.sessionToken);
    if (!profile) return;
    user.name = cleanName(profile.name);
    user.level = Math.max(1, Math.min(50, Number(profile.level) || 1));
    user.wins = Math.max(0, Number(profile.wins) || 0);
    user.elo = Number(profile.elo) || 1000;
    user.deck = Array.isArray(profile.deck) ? profile.deck.map(Number) : [];
    emitUsers();
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

  socket.on("match:create", async payload => {
    const user = users.get(socket.id);
    if (!user) return;
    const fresh = await profileFromSession(user.sessionToken);
    if (!fresh) {
      socket.emit("match:error", { message: "No se pudo validar tu cuenta." });
      return;
    }
    user.level = Math.max(1, Math.min(50, Number(fresh.level) || 1));
    user.wins = Math.max(0, Number(fresh.wins) || 0);
    user.elo = Number(fresh.elo) || 1000;
    user.deck = Array.isArray(fresh.deck) ? fresh.deck.map(Number) : [];
    removeSocketMatches(socket.id);
    const deckError = playDeckError(user.deck, user.level);
    if (deckError) {
      socket.emit("match:error", { message: deckError });
      return;
    }
    const deckSize = user.deck.length;
    const match = {
      id: id("match"),
      player: user.name,
      level: user.level,
      elo: user.elo,
      deckSize,
      start: "random",
      status: "waiting",
      hostSocketId: socket.id,
      guestSocketId: null,
      hostDeck: user.deck.slice(),
      guestDeck: [],
      hostLevel: user.level,
      guestLevel: 1,
      hostSessionToken: user.sessionToken,
      guestSessionToken: "",
      hostAccountId: user.accountId,
      guestAccountId: "",
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

  socket.on("match:join", async payload => {
    const mid = cleanText(payload && payload.id, 80);
    const match = matches.get(mid);
    const user = users.get(socket.id);
    if (!match || !user || match.status !== "waiting" || match.hostSocketId === socket.id) {
      socket.emit("match:error", { message: "La partida ya no está disponible." });
      return;
    }
    const fresh = await profileFromSession(user.sessionToken);
    if (!fresh) {
      socket.emit("match:error", { message: "No se pudo validar tu cuenta." });
      return;
    }
    user.level = Math.max(1, Math.min(50, Number(fresh.level) || 1));
    user.wins = Math.max(0, Number(fresh.wins) || 0);
    user.elo = Number(fresh.elo) || 1000;
    user.deck = Array.isArray(fresh.deck) ? fresh.deck.map(Number) : [];
    const deckError = playDeckError(user.deck, user.level);
    if (deckError) {
      socket.emit("match:error", { message: deckError });
      return;
    }
    match.status = "playing";
    match.guestSocketId = socket.id;
    match.guestDeck = user.deck.slice();
    match.guestLevel = user.level;
    match.guestSessionToken = user.sessionToken;
    match.guestAccountId = user.accountId;
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
    trades.set(tradeId, { id: tradeId, a: socket.id, b: to, acceptedA: false, acceptedB: false, offers: { a: { cards: [], gold: 0 }, b: { cards: [], gold: 0 } } });
    io.to(to).emit("trade:invited", { tradeId, from: publicUser(socket.id, user) });
    socket.emit("trade:waiting", { tradeId, to });
  });

  socket.on("trade:offer", payload => {
    const trade = trades.get(cleanText(payload && payload.tradeId, 100));
    if (!trade || (trade.a !== socket.id && trade.b !== socket.id)) return;
    const other = trade.a === socket.id ? trade.b : trade.a;
    const side = trade.a === socket.id ? "a" : "b";
    const cards = Array.isArray(payload && payload.cards) ? payload.cards.map(Number).filter(id => BY_ID.has(id)).slice(0, 20) : [];
    const gold = Math.max(0, Math.floor(Number(payload && payload.gold) || 0));
    trade.offers[side] = { cards, gold };
    trade.acceptedA = false; trade.acceptedB = false;
    io.to(other).emit("trade:offer", {
      tradeId: trade.id,
      from: socket.id,
      cards,
      gold
    });
  });

  socket.on("trade:accept", async payload => {
    const trade = trades.get(cleanText(payload && payload.tradeId, 100));
    if (!trade || (trade.a !== socket.id && trade.b !== socket.id)) return;
    if (trade.a === socket.id) trade.acceptedA = true;
    if (trade.b === socket.id) trade.acceptedB = true;
    const other = trade.a === socket.id ? trade.b : trade.a;
    io.to(other).emit("trade:accepted", { tradeId: trade.id, by: socket.id });
    if (trade.acceptedA && trade.acceptedB) {
      const result = await settleTradeProfiles(trade);
      if (!result.ok) {
        trade.acceptedA = false; trade.acceptedB = false;
        io.to(trade.a).emit("trade:error", { tradeId: trade.id, message: result.error || "No se pudo completar el intercambio." });
        io.to(trade.b).emit("trade:error", { tradeId: trade.id, message: result.error || "No se pudo completar el intercambio." });
        return;
      }
      const ua = users.get(trade.a), ub = users.get(trade.b);
      if (ua && result.profileA) { ua.level = result.profileA.level; ua.wins = result.profileA.wins; ua.deck = result.profileA.deck || ua.deck; }
      if (ub && result.profileB) { ub.level = result.profileB.level; ub.wins = result.profileB.wins; ub.deck = result.profileB.deck || ub.deck; }
      io.to(trade.a).emit("trade:settled", { tradeId: trade.id, profile: result.profileA });
      io.to(trade.b).emit("trade:settled", { tradeId: trade.id, profile: result.profileB });
      trades.delete(trade.id);
      emitUsers();
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
