"use strict";
// Channel chatter for the simulated players (server/bots.js), written by a language model on
// Groq (GROQ_API_KEY). One request writes a short exchange between two or three bots, so the
// free daily quota goes a long way; replies to real players take priority. Without a key, or
// when the quota or the API fails, the bots simply fall back to their canned lines.
//
// Ground rules baked into every prompt: talk about the game only, never ask for or share
// personal details, never move a conversation off the platform, never deny being an AI when a
// player sincerely asks, light banter only.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const rand = (min, max) => min + Math.random() * (max - min);
const pick = list => list[Math.floor(Math.random() * list.length)];

const REGIONS = [
  ["Madrid", "español de España, coloquial (tío, en plan, flipas, mazo)"],
  ["Andalucía", "español de Andalucía (illo, quillo, miarma, qué arte)"],
  ["Barcelona", "español de España con algún catalanismo suelto (home, collons, va)"],
  ["Valencia", "español de España (xe, nano, qué fuerte)"],
  ["Galicia", "español de Galicia (carallo, ho, meu)"],
  ["País Vasco", "español del País Vasco (aupa, ostia, motel)"],
  ["Canarias", "español de Canarias (mi niño, chacho, fuerte)"],
  ["México", "español de México (wey, no mames, chido, órale, neta)"],
  ["Argentina", "español rioplatense con voseo (che, boludo, re, posta)"],
  ["Chile", "español de Chile (weón, po, cachai, bacán)"],
  ["Colombia", "español de Colombia (parce, qué chimba, bacano)"],
  ["Perú", "español de Perú (causa, pata, chévere, bacán)"],
  ["Venezuela", "español de Venezuela (pana, chamo, burda, qué ladilla)"]
];
const STYLES = [
  "escribe todo en minúsculas y casi sin tildes",
  "usa abreviaturas (q, xq, tmb, k, xd)",
  "frases muy cortas, a veces solo una palabra",
  "algo picón y competitivo pero sin faltar",
  "tranquilo, pregunta mucho por las cartas",
  "exagerado, usa jajaja y mayúsculas para gritar"
];

function hash(name) {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
function persona(name) {
  const h = hash(name);
  const [region, dialect] = REGIONS[h % REGIONS.length];
  return { region, dialect, style: STYLES[(h >>> 8) % STYLES.length] };
}
// Stable friendships and rivalries between bots, derived from the pair of names.
function relation(a, b) {
  const h = hash([a, b].sort().join("|")) % 10;
  return h < 3 ? "son colegas de partidas" : h < 5 ? "tienen pique entre ellos" : "";
}

const RULES = [
  "Escribes mensajes del chat general de ARCANUM TCG, un juego de cartas online (antes Rolplay).",
  "Funciones del juego que puedes mencionar: el panel de jugadores conectados (contador abajo a la derecha), ver el perfil de alguien, agregar amigos, retar a alguien directamente a un duelo, la actividad del salón con los resultados y el ELO, la tienda de sobres, intercambios.",
  "Términos del juego: sobres (cuestan 20 de oro), Poder (cartas de maná), criaturas con ataque/defensa, amuletos, nivel, ELO, ranking, retos, mazo de 20 a 50 cartas, robar, atacar, defender.",
  "Habla SOLO del juego: partidas, cartas, sobres, mazos, retos, ranking, piques sanos.",
  "Nunca pidas ni des datos personales (edad, ciudad, redes, teléfono) ni propongas hablar fuera del juego. Si alguien lo pide, desvíalo al juego.",
  "Si alguien pregunta en serio si eres un bot o una IA, no lo niegues: di que sí sin darle importancia y vuelve al juego.",
  "Nada de insultos fuertes, odio, contenido sexual ni temas fuera del juego. Bromas y piques suaves sí.",
  "PROHIBIDO inventar: solo puedes nombrar cartas de la lista de cartas reales que te doy, y solo cosas que existen en el juego (sobres, oro, nivel, ELO, ranking, retos, mazo, colección, intercambios, Poder, criaturas, amuletos, manual). No existen torneos, clanes, eventos, gemas, pases ni otros modos de juego. Si no estás seguro de que algo existe, no lo menciones.",
  "Escribe como en un chat de verdad: casi todo en minúsculas, sin ¿ ni ¡, sin punto final, recortando palabras (q, xq, tmb, k, pa, ns, xd, jaja, bro, tio) y con alguna falta típica (a/ha, ola, aver, haci). Nada de frases redondas ni educadas de más.",
  "Ejemplos del tono (no los copies): alguien pa una? / ns q mazo hacer con lo q tengo / me a salido otro mimit xd / gg wp / q suerte con los sobres bro / ese dophan m reventó / toy nivel 2 ya / nah q va / jajaj ez",
  "Mensajes cortos (máx. 80 caracteres). Sin comillas. No empieces el texto con el nombre de usuario salvo para mencionar a alguien."
].join("\n");

// Make a line read like a real chat message: lowercase, no opening marks, clipped words and the
// odd missing accent, with some randomness so every bot does it a little differently.
function roughen(text, name) {
  const h = hash(name), r = () => Math.random();
  let t = text.replace(/[¿¡]/g, "").replace(/[“”«»"]/g, "").replace(/\.$/, "").trim();
  if (h % 5 !== 0) t = t.charAt(0).toLowerCase() + t.slice(1);
  if (h % 3 !== 0 && r() < 0.8) t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
  const swaps = [
    [/\bque\b/gi, "q", 0.6], [/\bpor qu[eé]\b|\bporque\b/gi, "xq", 0.7], [/\btambi[eé]n\b/gi, "tmb", 0.7],
    [/\bpara\b/gi, "pa", 0.5], [/\bno s[eé]\b/gi, "ns", 0.5], [/\bestoy\b/gi, "toy", 0.3], [/\bhola\b/gi, "ola", 0.3],
    [/\bde verdad\b/gi, "enserio", 0.4], [/\bpor favor\b/gi, "porfa", 0.8], [/\bme ha\b/gi, "me a", 0.4], [/\ba ver\b/gi, "aver", 0.5]
  ];
  for (const [re, to, p] of swaps) if (r() < p) t = t.replace(re, to);
  return t;
}

function createBotChat({ log = console.log, catalog = [] } = {}) {
  const cardNames = [...new Set(catalog.map(c => c.name))];
  const cardsUpTo = level => [...new Set(catalog.filter(c => c.level <= level).map(c => c.name))];
  // A line that names, in quotes or with capitals, a card that does not exist is thrown away.
  const knownCard = phrase => {
    const p = phrase.toLowerCase();
    return cardNames.some(n => n.toLowerCase() === p || n.toLowerCase().startsWith(p + " "));
  };
  function inventsCards(text) {
    for (const m of text.matchAll(/[“"«]([^”"»]{3,40})[”"»]/g)) if (!knownCard(m[1].trim())) return true;
    const named = /\b(?:carta|la|el|mi|un|una|tu|otro|otra)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+(?:de|del|x)?\s*[A-ZÁÉÍÓÚÑ0-9][\wáéíóúñ]*){0,3})/g;
    for (const m of text.matchAll(named)) if (!knownCard(m[1].trim()) && !/^(ELO|Poder|Nivel)$/i.test(m[1].trim())) return true;
    return false;
  }
  const key = process.env.GROQ_API_KEY || "";
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  const dailyTokens = Number(process.env.BOTS_LLM_DAILY_TOKENS) || 180000;
  const usage = { day: "", tokens: 0, requests: 0, failures: 0 };
  let pausedUntil = 0;
  let busy = false;
  const channel = [];          // recent lines: { from, text, bot, system, at }
  const seen = new Set();

  const today = () => new Date().toISOString().slice(0, 10);
  function budgetLeft() {
    if (usage.day !== today()) { usage.day = today(); usage.tokens = 0; usage.requests = 0; usage.failures = 0; }
    return dailyTokens - usage.tokens;
  }
  const enabled = () => !!key && Date.now() > pausedUntil && budgetLeft() > 1500;

  async function complete(system, user) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(GROQ_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0.9,
          max_completion_tokens: 600,
          reasoning_effort: "low",
          include_reasoning: false
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        usage.failures++;
        // Rate limited or quota gone: stay quiet for a while instead of hammering the API.
        pausedUntil = Date.now() + (response.status === 429 ? 15 : 5) * 60 * 1000;
        log("[bots] chat llm " + response.status + ": " + (data.error && data.error.message || "error"));
        return "";
      }
      usage.requests++;
      usage.tokens += Number(data.usage && data.usage.total_tokens) || 800;
      return String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "");
    } catch (e) {
      usage.failures++;
      pausedUntil = Date.now() + 2 * 60 * 1000;
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  function clean(text) {
    if (inventsCards(String(text || ""))) return "";
    let t = String(text || "").replace(/^["'«»\s]+|["'«»\s]+$/g, "").replace(/\s+/g, " ").trim();
    if (/https?:|www\.|\.com\b|@\w|discord|instagram|insta\b|whatsapp|telegram|tiktok|\d{6,}/i.test(t)) return "";
    if (t.length > 120) t = t.slice(0, 117).replace(/\s+\S*$/, "") + "...";
    return t;
  }
  function recentTranscript(limit = 10) {
    return channel.slice(-limit).map(m => m.system ? "[sistema] " + m.text : m.from + ": " + m.text).join("\n") || "(el chat está vacío)";
  }
  function describe(bot) {
    const p = persona(bot.name);
    const owned = Object.keys(bot.profile && bot.profile.collection || {}).map(id => catalog.find(c => c.id === Number(id))).filter(Boolean).map(c => c.name);
    const has = owned.length ? " Tiene en su colección: " + [...new Set(owned)].slice(0, 8).join(", ") + "." : " Aún casi no tiene cartas.";
    const record = bot.profile ? " · nivel " + (bot.profile.level || 1) + ", " + (bot.profile.wins || 0) + " victorias y " + (bot.profile.losses || 0) + " derrotas" : "";
    return "- " + bot.name + ": habla " + p.dialect + "; " + p.style + record + "." + has;
  }
  function parseLines(raw, names) {
    const out = [];
    for (const line of String(raw).split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]?\s*([A-Za-z0-9_-]{3,20})\s*:\s*(.+)$/);
      if (!m) continue;
      const name = names.find(n => n.toLowerCase() === m[1].toLowerCase());
      const text = clean(m[2]);
      if (name && text) out.push({ name, text: roughen(text, name) });
    }
    return out.slice(0, 4);
  }

  return {
    // Every channel line the bots see (deduplicated: all bot sockets receive the same event).
    observe(message, isBot) {
      const id = message.id || (message.system ? "sys:" + message.text : "");
      if (id && seen.has(id)) return null;
      if (id) { seen.add(id); if (seen.size > 500) seen.clear(); }
      const entry = { from: message.from || "", text: String(message.text || ""), system: !!message.system, bot: !!isBot, at: Date.now() };
      channel.push(entry);
      if (channel.length > 40) channel.shift();
      return entry;
    },
    enabled,
    stats: () => ({ ...usage, budgetLeft: budgetLeft(), paused: Date.now() < pausedUntil }),

    // A short exchange between two or three bots in the lobby.
    async scene(bots) {
      if (busy || !enabled() || bots.length < 2) return [];
      busy = true;
      try {
        const cast = bots.slice(0, 3);
        const pairs = [];
        for (let i = 0; i < cast.length; i++) for (let j = i + 1; j < cast.length; j++) {
          const r = relation(cast[i].name, cast[j].name);
          if (r) pairs.push(cast[i].name + " y " + cast[j].name + " " + r + ".");
        }
        const newcomer = cast.find(b => (Number(b.profile && b.profile.wins) || 0) + (Number(b.profile && b.profile.losses) || 0) < 5);
        const topic = newcomer && Math.random() < 0.45
          ? newcomer.name + " es nuevo y pregunta una duda real de cómo se juega (fases del turno, para qué sirve el Poder, cómo atacar o defender, qué pasa si se acaba el mazo, cuánto cuesta un sobre, cómo subir de nivel) y otro le contesta bien según las reglas"
          : pick([
          "buscar rival o retar a alguien", "comentar una partida reciente", "preguntar qué carta es mejor",
          "presumir o quejarse de lo que salió en un sobre", "pedir consejo para el mazo", "hablar del ranking o del ELO",
          "picarse por una derrota", "comentar algo de lo que se acaba de decir en el chat"
        ]);
        const rules = "Reglas reales por si salen: turno = enderezar, robar, poner 1 carta de Poder, invocar criaturas pagando Poder, amuletos, atacar. El defensor elige quién bloquea; el daño que sobra pasa al jugador. Vida inicial 20 + bonus por nivel. Si tu mazo está vacío pierdes 1 PV por cada robo. Sobre = 20 de oro, 5 cartas. Ganar da oro, experiencia y ELO.";
        const user = [
          "Cartas reales que existen ahora mismo (no hay otras): " + cardsUpTo(Math.max(1, ...cast.map(b => Number(b.profile && b.profile.level) || 1)) + 1).join(", ") + ".",
          "Personajes:", ...cast.map(describe), ...pairs,
          rules, "", "Últimos mensajes del chat:", recentTranscript(), "",
          "Escribe de 2 a 4 mensajes seguidos entre estos personajes (" + topic + "), que encajen con lo último del chat.",
          "Formato estricto, una línea por mensaje: Nombre: texto"
        ].join("\n");
        return parseLines(await complete(RULES, user), cast.map(b => b.name));
      } finally {
        busy = false;
      }
    },

    // One bot answers a real player's message.
    async reply(bot, playerName, text) {
      if (!enabled()) return "";
      const user = [
        "Cartas reales que existen ahora mismo (no hay otras): " + cardsUpTo((Number(bot.profile && bot.profile.level) || 1) + 1).join(", ") + ".",
        "Personaje:", describe(bot), "",
        "Últimos mensajes del chat:", recentTranscript(), "",
        "El jugador " + playerName + " acaba de escribir: \"" + String(text).slice(0, 200) + "\"",
        "Responde como " + bot.name + " con un solo mensaje corto. Formato: " + bot.name + ": texto"
      ].join("\n");
      const lines = parseLines(await complete(RULES, user), [bot.name]);
      return lines.length ? lines[0].text : "";
    }
  };
}

module.exports = { createBotChat, persona, relation };
