"use strict";

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 10000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://cardgame-l9ld.onrender.com";

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
  return String(value || "Invitado").replace(/[<>]/g, "").trim().slice(0, 24) || "Invitado";
}

function cleanText(value, max = 300) {
  return String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function id(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

function publicUser(socketId, user) {
  return {
    socketId,
    name: user.name,
    level: user.level,
    status: user.status,
    wins: user.wins
  };
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

function removeSocketMatches(socketId) {
  let changed = false;
  for (const [mid, match] of matches.entries()) {
    if (match.hostSocketId === socketId || match.guestSocketId === socketId) {
      const otherId = match.hostSocketId === socketId ? match.guestSocketId : match.hostSocketId;
      if (otherId) io.to(otherId).emit("match:closed", { id: mid, reason: "opponent_left" });
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
    version: "0.1.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, online: users.size, matches: matches.size });
});

app.get("/state", (_req, res) => {
  res.json({
    users: [...users.entries()].map(([sid, u]) => publicUser(sid, u)),
    matches: [...matches.values()].map(publicMatch)
  });
});

io.on("connection", socket => {
  socket.on("hello", payload => {
    const user = {
      name: cleanName(payload && payload.name),
      level: Math.max(1, Math.min(50, Number(payload && payload.level) || 1)),
      wins: Math.max(0, Number(payload && payload.wins) || 0),
      status: "Disponible"
    };
    users.set(socket.id, user);
    socket.emit("server:ready", { socketId: socket.id, version: "0.1.0" });
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
    io.emit("chat:message", {
      id: id("msg"),
      from: user.name,
      socketId: socket.id,
      text,
      at: Date.now()
    });
  });

  socket.on("match:create", payload => {
    const user = users.get(socket.id);
    if (!user) return;
    removeSocketMatches(socket.id);
    const deckSize = [20, 30, 40, 50].includes(Number(payload && payload.deckSize)) ? Number(payload.deckSize) : 30;
    const match = {
      id: id("match"),
      player: user.name,
      level: user.level,
      deckSize,
      start: payload && payload.start === "random" ? "random" : "normal",
      status: "waiting",
      hostSocketId: socket.id,
      guestSocketId: null,
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
    match.guestSocketId = socket.id;
    socket.join(mid);

    const host = users.get(match.hostSocketId);
    io.to(match.hostSocketId).emit("match:ready", {
      id: mid,
      side: "host",
      deckSize: match.deckSize,
      start: match.start,
      opponent: publicUser(socket.id, user)
    });
    io.to(socket.id).emit("match:ready", {
      id: mid,
      side: "guest",
      deckSize: match.deckSize,
      start: match.start,
      opponent: host ? publicUser(match.hostSocketId, host) : { name: match.player }
    });
    emitMatches();
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
    trade.acceptedA = false;
    trade.acceptedB = false;
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
    users.delete(socket.id);
    removeSocketMatches(socket.id);
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
  console.log("Rolplay restoration server listening on port", PORT);
});
