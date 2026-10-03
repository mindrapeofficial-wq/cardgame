"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { SyntheticPopulation } = require("./synthetic-population");
const { version: SERVER_VERSION } = require("./package.json");

const PORT = process.env.PORT || 10000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://cardgame-l9ld.onrender.com";
const ROLPLAY_API_URL = process.env.ROLPLAY_API_URL || "https://mrmvmoyysxuopqexbxfk.supabase.co/functions/v1/rolplay-api";
// Shared secret proving to rolplay-api that match/trade settlements come from this server.
const ROLPLAY_SERVER_KEY = process.env.ROLPLAY_SERVER_KEY || "";
if (!ROLPLAY_SERVER_KEY) console.warn("ROLPLAY_SERVER_KEY is not set: match and trade settlements will be rejected.");
const SETTLEMENT_HEADERS = Object.freeze({ "content-type": "application/json", "x-rolplay-server-key": ROLPLAY_SERVER_KEY });

const rules = require("../rules.js");
const {
  DECK_MIN, DECK_MAX, MIN_POWER_CARDS, MAX_POWER_CARDS, MAX_POWER_POINTS,
  MATCH_LIMIT_MS, COMBAT_LEAVE_GRACE_MS, EMPTY_DECK_DAMAGE, powerValue, startingHp
} = rules;

const CATALOG = rules.parseCatalog(fs.readFileSync(path.join(__dirname, "..", "cards.csv"), "utf8"));
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

const INITIAL_HAND = 7;
const SECOND_PLAYER_BONUS = 1;
const DECISION_LIMIT_MS = Number(process.env.DECISION_LIMIT_MS) || 2 * 60 * 1000;
const DEFENSE_DECISION_LIMIT_MS = Number(process.env.DEFENSE_DECISION_LIMIT_MS) || 60 * 1000;
const FINISHED_MATCH_TTL_MS = 10 * 60 * 1000;
const COMBAT_IDLE_BASE_MS = 3 * 60 * 1000;
const COMBAT_IDLE_MAX_MS = 5 * 60 * 1000;
const COMBAT_IDLE_ACTION_BONUS_MS = 10 * 1000;
const users = new Map();
const matches = new Map();
const trades = new Map();
const combatIdleTimers = new Map();
let syntheticPopulation = null;

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
      headers: SETTLEMENT_HEADERS,
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
      headers: SETTLEMENT_HEADERS,
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
function publicUser(socketId, user) {
  return { socketId, name: user.name, level: user.level, elo: Number(user.elo) || 1000, status: user.status, wins: user.wins, supporterTier: user.supporterTier || null };
}
function uniqueUserEntries() {
  const byAccount = new Map();
  for (const [sid, user] of users.entries()) {
    const accountKey = String(user && user.accountId || "").trim() || ("socket:" + sid);
    byAccount.set(accountKey, [sid, user]);
  }
  return [...byAccount.values()];
}
function emitUsers() {
  io.emit("lobby:users", uniqueUserEntries().map(([sid, u]) => publicUser(sid, u)));
}
function onlineUserCount() {
  return uniqueUserEntries().length;
}
function disconnectDuplicateAccountSockets(socket, user) {
  const accountId = String(user && user.accountId || "");
  if (!accountId) return;
  for (const [sid, other] of [...users.entries()]) {
    if (sid === socket.id || String(other && other.accountId || "") !== accountId) continue;
    users.delete(sid);
    const oldSocket = io.sockets.sockets.get(sid);
    if (oldSocket) oldSocket.disconnect(true);
  }
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
  // Private duels (direct challenges) never show up in the public list while they wait.
  io.emit("matches:list", [...matches.values()].filter(m => !m.privateFor || m.status !== "waiting").map(publicMatch));
}

// Direct challenges: A invites B; when B accepts, A's client creates a private match that only
// B can join (match:create with inviteId), and B is told to join it.
const DUEL_INVITE_TTL_MS = 45 * 1000;
const duelInvites = new Map();
function dropInvite(invite, event, payload) {
  if (!duelInvites.has(invite.id)) return;
  duelInvites.delete(invite.id);
  clearTimeout(invite.timer);
  if (event) for (const sid of [invite.from, invite.to]) io.to(sid).emit(event, { inviteId: invite.id, ...payload });
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
function sideForAccount(match, accountId) {
  const value = String(accountId || "");
  if (!value) return null;
  if (String(match.hostAccountId || "") === value) return "a";
  if (String(match.guestAccountId || "") === value) return "b";
  return null;
}
function socketForSide(match, side) {
  return side === "a" ? match.hostSocketId : match.guestSocketId;
}
function setSocketForSide(match, side, socketId) {
  if (side === "a") match.hostSocketId = socketId;
  else match.guestSocketId = socketId;
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
      // An empty deck costs life on every failed draw instead of losing the game outright.
      game.hp[side] -= EMPTY_DECK_DAMAGE;
      gameLog(game, "Mazo vacío: -" + EMPTY_DECK_DAMAGE + " PV.");
      continue;
    }
    game.hand[side].push(cardInstance(game.deck[side].pop()));
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
  return Math.max(0, (card?.def || 0) + (inst.defBonus || 0));
}
function resolvePendingAttack(game, defenderSide, defenderUid, passDefense = false) {
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

  if (defenders.length && !passDefense) {
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
  const attackerDefBefore = effectiveDef(attacker);

  defender.defensesThisTurn = (Number(defender.defensesThisTurn) || 0) + 1;
  defender.exhausted = true;
  const defenderDestroyed = attackerAttack >= defenderDefBefore;
  const attackerDestroyed = defenderAttack >= attackerDefBefore;

  const overflow = Math.max(0, attackerAttack - defenderDefBefore);
  if (overflow > 0) {
    game.hp[foe] -= overflow;
    game.damage[side] += overflow;
  }

  gameLog(
    game,
    ac.name + " (" + attackerAttack + " ATQ / " + attackerDefBefore + " DEF) combate con " + bc.name + " (" + defenderAttack + " ATQ / " + defenderDefBefore + " DEF). Las estadísticas no se desgastan."
    + (overflow ? " " + overflow + " de daño atraviesa al jugador defensor." : "")
  );

  if (defenderDestroyed) {
    game.board[foe] = game.board[foe].filter(c => c.uid !== defender.uid);
    gameLog(game, bc.name + " es destruida.");
  }
  if (attackerDestroyed) {
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
    // Each player starts with the base life plus the original per-level bonus.
    hp: { a: startingHp(match.hostLevel), b: startingHp(match.guestLevel) },
    maxHp: { a: startingHp(match.hostLevel), b: startingHp(match.guestLevel) },
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
  const opponentName = side === "a" ? (match.guestName || "Rival") : (match.player || "Rival");
  const playerLeaveDeadlineAt = Number(match.disconnectDeadlineAt && match.disconnectDeadlineAt[side]) || 0;
  const opponentDisconnectDeadlineAt = Number(match.disconnectDeadlineAt && match.disconnectDeadlineAt[foe]) || 0;
  const playerIdleAllowanceMs = Math.max(COMBAT_IDLE_BASE_MS, Math.min(COMBAT_IDLE_MAX_MS, Number(match.idleAllowanceMs && match.idleAllowanceMs[side]) || COMBAT_IDLE_BASE_MS));
  const playerIdleDeadlineAt = (Number(match.lastActivityAt && match.lastActivityAt[side]) || Date.now()) + playerIdleAllowanceMs;
  const playerLeaveReason = String(match.disconnectReason && match.disconnectReason[side] || "");
  const opponentLeaveReason = String(match.disconnectReason && match.disconnectReason[foe] || "");
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
    playerMaxHp: game.maxHp ? game.maxHp[side] : 30,
    enemyMaxHp: game.maxHp ? game.maxHp[foe] : 30,
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
    opponent: opponent ? publicUser(opponentSocket, opponent) : { name: opponentName },
    playerIdleAllowanceMs,
    playerIdleDeadlineAt,
    playerLeaveDeadlineAt,
    playerLeaveReason,
    opponentDisconnectDeadlineAt,
    opponentLeaveDeadlineAt: opponentDisconnectDeadlineAt,
    opponentLeaveReason,
    decisionDeadlineAt: match.decision ? match.decision.deadlineAt : 0,
    decisionIsMine: !!match.decision && match.decision.owner === side,
    serverNow: Date.now(),
    log: game.log.slice(-35)
  };
}
async function settleMatchReward(match) {
  const game = match.duel;
  if (!game || !game.gameOver || game.rewardSettled) return;
  const result = await settleMatchProfiles(match);
  if (!result) return;
  if (!result.duplicate) announceMatchResult(match, result);

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
// Public channel line for every settled PvP match, e.g.
// "Galante ha ganado a Kraven92 · ELO: Galante 1016 (+16) · Kraven92 984 (−16)".
function announceMatchResult(match, result) {
  const winner = match.duel && match.duel.winner;
  const nameA = sideName(match, "a"), nameB = sideName(match, "b");
  const elo = (name, profile, reward) => {
    const delta = Number(reward && reward.eloDelta) || 0;
    return name + " " + (Number(profile && profile.elo) || 1000) + " (" + (delta >= 0 ? "+" : "−") + Math.abs(delta) + ")";
  };
  const eloA = elo(nameA, result.profileA, result.rewardA), eloB = elo(nameB, result.profileB, result.rewardB);
  const text = winner === "draw"
    ? nameA + " y " + nameB + " han empatado · ELO: " + eloA + " · " + eloB
    : winner === "a"
      ? nameA + " ha ganado a " + nameB + " · ELO: " + eloA + " · " + eloB
      : nameB + " ha ganado a " + nameA + " · ELO: " + eloB + " · " + eloA;
  io.emit("chat:system", { text });
}
function sideName(match, side) {
  const user = users.get(socketForSide(match, side));
  return user ? user.name : (side === "a" ? match.player : (match.guestName || "El rival")) || "Jugador";
}

// Whoever must act (the active player, or the defender of a pending attack) gets a limited
// time per decision. When it runs out the server makes the default move instead of letting
// the duel stall until the 40-minute limit.
function decisionOwner(game) {
  return game.pendingAttack ? sideOther(game.pendingAttack.side) : game.active;
}
function decisionSignature(game) {
  const n = zone => zone.a.length + "/" + zone.b.length;
  return [
    decisionOwner(game), game.turn, game.phase, game.pendingAttack ? game.pendingAttack.attackerUid : "",
    n(game.hand), n(game.board), n(game.powers), game.hp.a + "/" + game.hp.b,
    game.availablePower.a + "/" + game.availablePower.b
  ].join("|");
}
function clearDecisionTimer(match) {
  if (match.decision && match.decision.timer) clearTimeout(match.decision.timer);
  match.decision = null;
}
function refreshDecisionTimer(match) {
  const game = match.duel;
  if (!game || game.gameOver) {
    clearDecisionTimer(match);
    return;
  }
  const signature = decisionSignature(game);
  if (match.decision && match.decision.signature === signature) return;
  clearDecisionTimer(match);
  const limit = game.pendingAttack ? DEFENSE_DECISION_LIMIT_MS : DECISION_LIMIT_MS;
  const timer = setTimeout(() => enforceDecisionTimeout(match, signature), limit + 50);
  match.decision = { signature, owner: decisionOwner(game), deadlineAt: Date.now() + limit, timer };
}
function enforceDecisionTimeout(match, signature) {
  const game = match.duel;
  if (!game || game.gameOver || matches.get(match.id) !== match) return;
  if (!match.decision || match.decision.signature !== signature) return;
  match.decision = null;
  const owner = decisionOwner(game);
  if (game.pendingAttack) {
    gameLog(game, sideName(match, owner) + " no eligió defensor a tiempo: el ataque se resuelve sin bloqueo.");
    resolvePendingAttack(game, owner, "", true);
  } else {
    gameLog(game, sideName(match, owner) + " agotó su tiempo de decisión y pasa el turno.");
    game.turn += 1;
    beginTurn(game, sideOther(game.active));
  }
  if (!checkEnd(game)) advanceAutomaticPhases(game);
  checkEnd(game);
  emitDuel(match);
}

// Every way a duel can end passes through emitDuel. Finished matches stay for a while so a
// player who missed the ending (closed tab, lost connection) can reconnect and see the result.
function setMatchPresence(match, status) {
  for (const sid of [match.hostSocketId, match.guestSocketId]) {
    const u = sid && users.get(sid);
    if (u) u.status = status;
  }
  emitUsers();
}
function finalizeMatch(match) {
  if (match.status === "finished") return;
  match.status = "finished";
  match.finishedAt = Date.now();
  setMatchPresence(match, "Disponible");
  clearDecisionTimer(match);
  clearCombatIdleWatch(match.id, "a");
  clearCombatIdleWatch(match.id, "b");
  const finishedAt = match.finishedAt;
  setTimeout(() => {
    if (matches.get(match.id) === match && match.finishedAt === finishedAt) {
      matches.delete(match.id);
      emitMatches();
    }
  }, FINISHED_MATCH_TTL_MS);
  emitMatches();
}
function emitDuel(match) {
  if (!match.duel) return;
  refreshDecisionTimer(match);
  for (const side of ["a", "b"]) {
    const socketId = socketForSide(match, side);
    if (!socketId) continue;
    io.to(socketId).emit("duel:snapshot", snapshotFor(match, socketId));
    if (match.duel.gameOver && io.sockets.sockets.get(socketId)?.connected) {
      match.resultDelivered = match.resultDelivered || { a: false, b: false };
      match.resultDelivered[side] = true;
    }
  }
  if (match.duel.gameOver) {
    finalizeMatch(match);
    void settleMatchReward(match);
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

  if (type === "defend" || type === "passDefense") {
    if (game.phase !== 5 || !game.pendingAttack || side !== sideOther(game.pendingAttack.side)) return;
    const passDefense = type === "passDefense";
    const resolved = resolvePendingAttack(game, side, passDefense ? "" : cleanText(payload && payload.uid, 100), passDefense);
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


function combatIdleKey(matchId, side) {
  return matchId + ":" + side;
}

function clearCombatIdleWatch(matchId, side) {
  const key = combatIdleKey(matchId, side);
  const timer = combatIdleTimers.get(key);
  if (timer) clearTimeout(timer);
  combatIdleTimers.delete(key);
}

function startCombatLeaveGrace(match, side, reason = "disconnect") {
  if (!match || !match.duel || match.duel.gameOver || !side) return 0;
  match.disconnectDeadlineAt = match.disconnectDeadlineAt || { a: 0, b: 0 };
  match.disconnectReason = match.disconnectReason || { a: "", b: "" };
  clearCombatIdleWatch(match.id, side);

  const current = Number(match.disconnectDeadlineAt[side]) || 0;
  if (current && current > Date.now()) {
    if (reason === "disconnect") match.disconnectReason[side] = "disconnect";
    emitDuel(match);
    return current;
  }

  const deadline = Date.now() + COMBAT_LEAVE_GRACE_MS;
  match.disconnectDeadlineAt[side] = deadline;
  match.disconnectReason[side] = reason;

  const socketId = socketForSide(match, side);
  const connectedUser = users.get(socketId);
  const name = connectedUser ? connectedUser.name : (side === "a" ? match.player : (match.guestName || "El rival"));
  if (reason === "inactive") {
    gameLog(match.duel, name + " ha agotado su periodo de inactividad. Tiene 2 minutos para volver a actuar.");
  } else if (reason === "fullscreen") {
    gameLog(match.duel, name + " ha salido de la pantalla completa. Tiene 2 minutos para volver.");
  } else {
    gameLog(match.duel, name + " se ha desconectado. Tiene 2 minutos para regresar.");
  }

  setTimeout(() => finishDisconnectGrace(match.id, side, deadline), COMBAT_LEAVE_GRACE_MS + 75);
  emitDuel(match);
  return deadline;
}

function combatIdleAllowance(match, side) {
  match.idleAllowanceMs = match.idleAllowanceMs || { a: COMBAT_IDLE_BASE_MS, b: COMBAT_IDLE_BASE_MS };
  return Math.max(COMBAT_IDLE_BASE_MS, Math.min(COMBAT_IDLE_MAX_MS, Number(match.idleAllowanceMs[side]) || COMBAT_IDLE_BASE_MS));
}

function scheduleCombatIdleWatch(match, side) {
  if (!match || !side) return;
  clearCombatIdleWatch(match.id, side);
  if (match.status !== "playing" || !match.duel || match.duel.gameOver) return;

  match.lastActivityAt = match.lastActivityAt || { a: Date.now(), b: Date.now() };
  const last = Number(match.lastActivityAt[side]) || Date.now();
  const allowance = combatIdleAllowance(match, side);
  const delay = Math.max(0, allowance - (Date.now() - last));
  const key = combatIdleKey(match.id, side);
  const timer = setTimeout(() => {
    combatIdleTimers.delete(key);
    const live = matches.get(match.id);
    if (!live || live.status !== "playing" || !live.duel || live.duel.gameOver) return;
    const liveLast = Number(live.lastActivityAt && live.lastActivityAt[side]) || 0;
    const liveAllowance = combatIdleAllowance(live, side);
    const elapsed = Date.now() - liveLast;
    if (elapsed < liveAllowance) {
      scheduleCombatIdleWatch(live, side);
      return;
    }
    startCombatLeaveGrace(live, side, "inactive");
  }, delay + 50);
  combatIdleTimers.set(key, timer);
}

function markCombatActivity(match, side, growAllowance = false) {
  if (!match || !side || match.status !== "playing" || !match.duel || match.duel.gameOver) return;
  match.lastActivityAt = match.lastActivityAt || { a: Date.now(), b: Date.now() };
  match.disconnectDeadlineAt = match.disconnectDeadlineAt || { a: 0, b: 0 };
  match.disconnectReason = match.disconnectReason || { a: "", b: "" };
  match.idleAllowanceMs = match.idleAllowanceMs || { a: COMBAT_IDLE_BASE_MS, b: COMBAT_IDLE_BASE_MS };
  const hadGrace = Number(match.disconnectDeadlineAt[side]) > 0;
  if (growAllowance) {
    match.idleAllowanceMs[side] = Math.min(COMBAT_IDLE_MAX_MS, combatIdleAllowance(match, side) + COMBAT_IDLE_ACTION_BONUS_MS);
  }
  match.lastActivityAt[side] = Date.now();
  match.disconnectDeadlineAt[side] = 0;
  match.disconnectReason[side] = "";
  scheduleCombatIdleWatch(match, side);
  if (hadGrace || growAllowance) emitDuel(match);
}

function finishDisconnectGrace(matchId, side, deadline) {
  const match = matches.get(matchId);
  if (!match || !match.duel || match.duel.gameOver) return;
  const activeDeadline = Number(match.disconnectDeadlineAt && match.disconnectDeadlineAt[side]) || 0;
  if (!activeDeadline || activeDeadline !== deadline || Date.now() < activeDeadline) return;
  const leaveReason = String(match.disconnectReason && match.disconnectReason[side] || "disconnect");
  match.disconnectDeadlineAt[side] = 0;
  if (match.disconnectReason) match.disconnectReason[side] = "";
  match.duel.gameOver = true;
  match.duel.winner = sideOther(side);
  const lossMessage = leaveReason === "inactive"
    ? "El jugador no volvió a actuar durante los 2 minutos de gracia y pierde la partida."
    : leaveReason === "fullscreen"
      ? "El jugador no regresó a la pantalla de combate durante los 2 minutos de gracia y pierde la partida."
      : "El jugador desconectado no regresó en 2 minutos y pierde la partida.";
  gameLog(match.duel, lossMessage);
  emitDuel(match);
}

function removeSocketMatches(socketId, useGrace = false) {
  let changed = false;
  for (const [mid, match] of matches.entries()) {
    if (match.hostSocketId !== socketId && match.guestSocketId !== socketId) continue;
    // Finished matches expire on their own timer so the result can still be recovered.
    if (match.status === "finished") continue;

    if (useGrace && match.status === "playing" && match.duel && !match.duel.gameOver) {
      const side = sideFor(match, socketId);
      if (!side) continue;
      clearCombatIdleWatch(mid, side);
      startCombatLeaveGrace(match, side, "disconnect");
      changed = true;
      continue;
    }

    const otherId = match.hostSocketId === socketId ? match.guestSocketId : match.hostSocketId;
    if (otherId && match.duel && !match.duel.gameOver) {
      match.duel.gameOver = true;
      match.duel.winner = sideFor(match, otherId);
      gameLog(match.duel, "El adversario ha abandonado la partida.");
      emitDuel(match);
    }
    matches.delete(mid);
    changed = true;
  }
  if (changed) emitMatches();
}

function resumeCombatForUser(socket, user) {
  for (const match of matches.values()) {
    if (!match.duel) continue;
    const side = sideForAccount(match, user.accountId);
    if (!side) continue;

    if (match.duel.gameOver) {
      if (match.status !== "finished" || !match.finishedAt || Date.now() - match.finishedAt > FINISHED_MATCH_TTL_MS) continue;
      // Only bring back players who never received the final result.
      if (match.resultDelivered && match.resultDelivered[side]) continue;
      const oldSocketId = socketForSide(match, side);
      setSocketForSide(match, side, socket.id);
      socket.join(match.id);
      if (oldSocketId && oldSocketId !== socket.id) {
        users.delete(oldSocketId);
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) oldSocket.disconnect(true);
      }
      return match;
    }

    if (match.status !== "playing") continue;
    match.disconnectDeadlineAt = match.disconnectDeadlineAt || { a: 0, b: 0 };
    match.disconnectReason = match.disconnectReason || { a: "", b: "" };
    match.lastActivityAt = match.lastActivityAt || { a: Date.now(), b: Date.now() };
    match.idleAllowanceMs = match.idleAllowanceMs || { a: COMBAT_IDLE_BASE_MS, b: COMBAT_IDLE_BASE_MS };
    const deadline = Number(match.disconnectDeadlineAt[side]) || 0;
    if (deadline && deadline <= Date.now()) {
      finishDisconnectGrace(match.id, side, deadline);
      return match.duel.gameOver ? match : null;
    }

    const oldSocketId = socketForSide(match, side);
    setSocketForSide(match, side, socket.id);
    match.disconnectDeadlineAt[side] = 0;
    match.disconnectReason[side] = "";
    match.lastActivityAt[side] = Date.now();
    scheduleCombatIdleWatch(match, side);
    if (side === "a") match.player = user.name;
    else match.guestName = user.name;
    user.status = "En combate";
    socket.join(match.id);

    if (oldSocketId && oldSocketId !== socket.id) {
      users.delete(oldSocketId);
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) oldSocket.disconnect(true);
    }

    gameLog(match.duel, user.name + " ha regresado al combate.");
    return match;
  }
  return null;
}

app.get("/", (_req, res) => {
  res.json({
    service: "rolplay-restoration-server",
    online: onlineUserCount(),
    openMatches: [...matches.values()].filter(m => m.status === "waiting").length,
    version: SERVER_VERSION
  });
});
app.get("/health", (_req, res) => res.json({ ok: true, online: onlineUserCount(), matches: matches.size, cards: CATALOG.length }));
app.get("/state", (_req, res) => res.json({
  users: [...users.entries()].map(([sid, u]) => publicUser(sid, u)),
  matches: [...matches.values()].map(publicMatch)
}));

app.get("/synthetic/state", (req, res) => {
  const adminToken = String(process.env.SYNTHETIC_ADMIN_TOKEN || "");
  if (!adminToken || String(req.get("x-synthetic-admin-token") || "") !== adminToken) {
    return res.status(404).json({ ok: false });
  }
  if (!syntheticPopulation) {
    return res.json({ ok: true, enabled: false });
  }
  return res.json({ ok: true, ...syntheticPopulation.state() });
});

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
      supporterTier: profile.supporterTier || null,
      status: "Disponible"
    };
    users.set(socket.id, user);
    const resumedMatch = resumeCombatForUser(socket, user);
    disconnectDuplicateAccountSockets(socket, user);
    socket.emit("server:ready", { socketId: socket.id, version: SERVER_VERSION, cards: CATALOG.length });
    emitUsers();
    emitMatches();
    if (resumedMatch) {
      socket.emit("match:ready", { id: resumedMatch.id, resumed: true });
      emitDuel(resumedMatch);
    }
    socket.broadcast.emit("chat:system", { text: user.supporterTier === "leyenda" ? "◆ La leyenda " + user.name + " ha entrado al salón." : user.supporterTier === "mecenas" ? "◆ El mecenas " + user.name + " ha entrado al salón." : user.name + " se ha unido al canal." });
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
    user.supporterTier = profile.supporterTier || null;
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
    io.emit("chat:message", { id: id("msg"), from: user.name, socketId: socket.id, tier: user.supporterTier || null, text, at: Date.now() });
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
    user.supporterTier = fresh.supporterTier || null;
    removeSocketMatches(socket.id);
    const deckError = playDeckError(user.deck, user.level);
    if (deckError) {
      socket.emit("match:error", { message: deckError });
      return;
    }
    const invite = payload && payload.inviteId ? duelInvites.get(cleanText(payload.inviteId, 80)) : null;
    if (payload && payload.inviteId && (!invite || !invite.accepted || invite.from !== socket.id || !users.has(invite.to))) {
      socket.emit("match:error", { message: "El reto ya no está disponible." });
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
      guestName: "",
      disconnectDeadlineAt: { a: 0, b: 0 },
      disconnectReason: { a: "", b: "" },
      lastActivityAt: { a: 0, b: 0 },
      idleAllowanceMs: { a: COMBAT_IDLE_BASE_MS, b: COMBAT_IDLE_BASE_MS },
      duel: null,
      privateFor: invite ? invite.to : "",
      createdAt: Date.now()
    };
    matches.set(match.id, match);
    socket.join(match.id);
    socket.emit("match:created", publicMatch(match));
    emitMatches();
    if (invite) {
      io.to(invite.to).emit("duel:inviteReady", { inviteId: invite.id, matchId: match.id });
      dropInvite(invite);
      return;
    }
    // The channel line carries the match id so other players can accept it from the chat.
    io.emit("chat:system", { text: user.name + " (Nivel " + user.level + ") está esperando duelo.", matchId: match.id });
  });

  socket.on("duel:invite", payload => {
    const user = users.get(socket.id);
    const to = cleanText(payload && payload.to, 100);
    const target = users.get(to);
    if (!user || !target || to === socket.id || String(target.accountId) === String(user.accountId)) return;
    if (target.status === "En combate") {
      socket.emit("duel:inviteDeclined", { name: target.name, reason: "busy" });
      return;
    }
    for (const inv of duelInvites.values()) {
      if ((inv.from === socket.id && inv.to === to) || (inv.from === to && inv.to === socket.id)) return;
    }
    const invite = { id: id("inv"), from: socket.id, to, accepted: false };
    invite.timer = setTimeout(() => dropInvite(invite, "duel:inviteExpired", { name: target.name }), DUEL_INVITE_TTL_MS);
    duelInvites.set(invite.id, invite);
    io.to(to).emit("duel:invited", { inviteId: invite.id, from: publicUser(socket.id, user), expiresInMs: DUEL_INVITE_TTL_MS });
    socket.emit("duel:inviteSent", { inviteId: invite.id, name: target.name });
  });

  // Voice chat: WebRTC signalling and microphone state are relayed to the other player of the
  // same running duel only.
  const voiceRelay = (event, build) => payload => {
    const match = matches.get(cleanText(payload && payload.matchId, 80));
    const side = match && sideFor(match, socket.id);
    if (!side || !match.duel || match.duel.gameOver) return;
    const other = socketForSide(match, sideOther(side));
    const body = build(payload);
    if (other && body) io.to(other).emit(event, { matchId: match.id, ...body });
  };
  socket.on("voice:signal", voiceRelay("voice:signal", p => {
    const data = p && p.data;
    if (!data || typeof data !== "object" || JSON.stringify(data).length > 20000) return null;
    return { data };
  }));
  socket.on("voice:state", voiceRelay("voice:state", p => ({ on: !!(p && p.on) })));

  // Friend requests are stored by the API; this only tells the other player right away.
  socket.on("friend:notify", payload => {
    const user = users.get(socket.id);
    const name = cleanName(payload && payload.name);
    const kind = payload && payload.kind === "accepted" ? "accepted" : "request";
    if (!user || !name) return;
    for (const [sid, other] of users.entries()) {
      if (other.name === name && sid !== socket.id) io.to(sid).emit("friend:changed", { from: user.name, kind });
    }
  });

  socket.on("duel:inviteRespond", payload => {
    const invite = duelInvites.get(cleanText(payload && payload.inviteId, 80));
    if (!invite || invite.to !== socket.id || invite.accepted) return;
    const user = users.get(socket.id);
    if (payload && payload.accept === true && users.has(invite.from)) {
      invite.accepted = true;
      io.to(invite.from).emit("duel:inviteAccepted", { inviteId: invite.id, name: user ? user.name : "" });
    } else {
      io.to(invite.from).emit("duel:inviteDeclined", { inviteId: invite.id, name: user ? user.name : "" });
      dropInvite(invite);
    }
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
    const joinable = () => !!match && !!user && matches.get(mid) === match && match.status === "waiting" && match.hostSocketId !== socket.id;
    if (!joinable()) {
      socket.emit("match:error", { message: "La partida ya no está disponible." });
      return;
    }
    if (String(match.hostAccountId) === String(user.accountId)) {
      socket.emit("match:error", { message: "No puedes unirte a tu propia partida." });
      return;
    }
    if (match.privateFor && match.privateFor !== socket.id) {
      socket.emit("match:error", { message: "Ese duelo es privado." });
      return;
    }
    const fresh = await profileFromSession(user.sessionToken);
    if (!fresh) {
      socket.emit("match:error", { message: "No se pudo validar tu cuenta." });
      return;
    }
    // The host may have cancelled, or another player joined, while the profile was loading.
    if (!joinable()) {
      socket.emit("match:error", { message: "La partida ya no está disponible." });
      return;
    }
    user.level = Math.max(1, Math.min(50, Number(fresh.level) || 1));
    user.wins = Math.max(0, Number(fresh.wins) || 0);
    user.elo = Number(fresh.elo) || 1000;
    user.deck = Array.isArray(fresh.deck) ? fresh.deck.map(Number) : [];
    user.supporterTier = fresh.supporterTier || null;
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
    match.guestName = user.name;
    match.disconnectDeadlineAt = { a: 0, b: 0 };
    match.disconnectReason = { a: "", b: "" };
    const combatStartedAt = Date.now();
    match.lastActivityAt = { a: combatStartedAt, b: combatStartedAt };
    match.idleAllowanceMs = { a: COMBAT_IDLE_BASE_MS, b: COMBAT_IDLE_BASE_MS };
    socket.join(mid);
    initDuel(match);
    setMatchPresence(match, "En combate");
    scheduleCombatIdleWatch(match, "a");
    scheduleCombatIdleWatch(match, "b");

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
    io.emit("chat:system", { text: (host ? host.name : match.player) + " ha empezado una partida contra " + user.name + "." });
  });

  socket.on("duel:action", payload => {
    const mid = cleanText(payload && payload.matchId, 80);
    const match = matches.get(mid);
    if (!match) return;
    const side = sideFor(match, socket.id);
    if (side) markCombatActivity(match, side, true);
    handleDuelAction(match, socket.id, payload);
  });

  socket.on("duel:activity", payload => {
    const mid = cleanText(payload && payload.matchId, 80);
    const match = matches.get(mid);
    if (!match) return;
    const side = sideFor(match, socket.id);
    if (side) markCombatActivity(match, side);
  });

  socket.on("duel:presence", payload => {
    const mid = cleanText(payload && payload.matchId, 80);
    const match = matches.get(mid);
    if (!match) return;
    const side = sideFor(match, socket.id);
    if (!side) return;
    const presence = cleanText(payload && payload.state, 16);
    if (presence === "away") {
      const rawReason = cleanText(payload && payload.reason, 24);
      const reason = rawReason === "fullscreen" || rawReason === "inactive" || rawReason === "lobby" ? rawReason : "fullscreen";
      startCombatLeaveGrace(match, side, reason);
    } else if (presence === "active") {
      markCombatActivity(match, side);
    }
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
    if (users.get(to).accountId === user.accountId) return;
    const involves = sid => [...trades.values()].filter(t => t.a === sid || t.b === sid);
    if (involves(to).length) {
      socket.emit("trade:busy", { to, message: "Ese jugador ya está en otro intercambio." });
      return;
    }
    // Starting a new trade abandons any trade this player still had open.
    for (const old of involves(socket.id)) {
      if (old.settling) {
        socket.emit("trade:busy", { to, message: "Tu intercambio anterior todavía se está completando." });
        return;
      }
    }
    for (const old of involves(socket.id)) {
      io.to(old.a === socket.id ? old.b : old.a).emit("trade:cancelled", { tradeId: old.id });
      trades.delete(old.id);
    }
    const tradeId = id("trade");
    trades.set(tradeId, { id: tradeId, a: socket.id, b: to, acceptedA: false, acceptedB: false, revision: 0, settling: false, offers: { a: { cards: [], gold: 0 }, b: { cards: [], gold: 0 } } });
    io.to(to).emit("trade:invited", { tradeId, from: publicUser(socket.id, user) });
    socket.emit("trade:waiting", { tradeId, to });
  });

  socket.on("trade:offer", payload => {
    const trade = trades.get(cleanText(payload && payload.tradeId, 100));
    if (!trade || (trade.a !== socket.id && trade.b !== socket.id) || trade.settling) return;
    const other = trade.a === socket.id ? trade.b : trade.a;
    const side = trade.a === socket.id ? "a" : "b";
    const cards = Array.isArray(payload && payload.cards) ? payload.cards.map(Number).filter(id => BY_ID.has(id)).slice(0, 20) : [];
    const gold = Math.max(0, Math.floor(Number(payload && payload.gold) || 0));
    trade.offers[side] = { cards, gold };
    trade.acceptedA = false; trade.acceptedB = false;
    trade.revision += 1;
    io.to(other).emit("trade:offer", {
      tradeId: trade.id,
      from: socket.id,
      cards,
      gold,
      revision: trade.revision
    });
    socket.emit("trade:offerAck", { tradeId: trade.id, revision: trade.revision });
  });

  socket.on("trade:accept", async payload => {
    const trade = trades.get(cleanText(payload && payload.tradeId, 100));
    if (!trade || (trade.a !== socket.id && trade.b !== socket.id) || trade.settling) return;
    // An acceptance only counts for the exact offers the player was looking at.
    if (Number(payload && payload.revision) !== trade.revision) {
      socket.emit("trade:stale", { tradeId: trade.id, message: "La oferta ha cambiado. Revísala antes de aceptar." });
      return;
    }
    if (trade.a === socket.id) trade.acceptedA = true;
    if (trade.b === socket.id) trade.acceptedB = true;
    const other = trade.a === socket.id ? trade.b : trade.a;
    io.to(other).emit("trade:accepted", { tradeId: trade.id, by: socket.id });
    if (trade.acceptedA && trade.acceptedB) {
      trade.settling = true;
      const result = await settleTradeProfiles(trade);
      trade.settling = false;
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
    if (!trade || (trade.a !== socket.id && trade.b !== socket.id) || trade.settling) return;
    const other = trade.a === socket.id ? trade.b : trade.a;
    io.to(other).emit("trade:cancelled", { tradeId });
    trades.delete(tradeId);
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    for (const invite of [...duelInvites.values()]) {
      if (invite.from === socket.id || invite.to === socket.id) dropInvite(invite, "duel:inviteExpired", { name: user ? user.name : "" });
    }
    removeSocketMatches(socket.id, true);
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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("Rolplay restoration server v" + SERVER_VERSION + " listening on 0.0.0.0:" + PORT + " with " + CATALOG.length + " cards");

  const syntheticEnabled = /^(1|true|yes)$/i.test(String(process.env.SYNTHETIC_POPULATION_ENABLED || ""));
  if (syntheticEnabled) {
    syntheticPopulation = new SyntheticPopulation({
      apiUrl: ROLPLAY_API_URL,
      serverKey: ROLPLAY_SERVER_KEY,
      serverUrl: process.env.SYNTHETIC_SERVER_URL || ("http://127.0.0.1:" + PORT),
      catalog: CATALOG
    });
    syntheticPopulation.start().then(() => {
      console.log(
        "Synthetic population enabled: "
        + syntheticPopulation.accountCount + " accounts, target "
        + syntheticPopulation.concurrentTarget + " concurrent."
      );
    }).catch(error => {
      console.error("Synthetic population failed to start:", error);
      syntheticPopulation = null;
    });
  }
  // Simulated players for the live balance test (server/bots.js); off unless BOTS_ENABLED=1.
  if (process.env.BOTS_ENABLED === "1" && ROLPLAY_SERVER_KEY) {
    require("./bots.js").startBots({
      port: PORT,
      apiUrl: ROLPLAY_API_URL,
      serverKey: ROLPLAY_SERVER_KEY,
      byId: BY_ID,
      publicUrl: process.env.RENDER_EXTERNAL_URL || ""
    });
  }
});
