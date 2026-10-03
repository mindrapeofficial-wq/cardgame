"use strict";
// Vocabulary filter for the public chat. Words are compared after normalizing (lowercase, no
// accents, ñ as "ny", leetspeak, repeated letters collapsed), so "PuUuT4" or "p.u.t.a" match.
// "censor" words are masked with asterisks; "block" words (hate slurs, self-harm incitement)
// stop the message. Phone numbers and e-mails are hidden to protect younger players.
const WORDS = require("./moderation-words.json");
const CENSOR = new Set(WORDS.censor);
const BLOCK = new Set(WORDS.block);
const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i" };

function normalizeWord(raw) {
  return String(raw).toLowerCase()
    .replace(/ñ/g, "ny")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[01345789@$!]/g, ch => LEET[ch] || ch)
    .replace(/[^a-z]/g, "")
    .replace(/(.)\1+/g, "$1");
}
// Exact match, or a stem of 5+ letters at the start of a longer word (gilipola -> gilipolas).
function classify(word) {
  const w = normalizeWord(word);
  if (w.length < 2) return "";
  const hit = (set) => set.has(w) || [...set].some(s => s.length >= 5 && w.startsWith(s) && w.length - s.length <= 3);
  if (hit(BLOCK)) return "block";
  if (hit(CENSOR)) return "censor";
  return "";
}
const mask = word => word[0] + "*".repeat(Math.max(2, word.length - 1));

function filterMessage(text) {
  let out = String(text || "");
  let blocked = false, censored = 0;
  // Letters split by dots, dashes or spaces ("p.u.t.a", "p u t a") are checked as one word.
  out = out.replace(/(?:^|(?<=\s))((?:[\p{L}0-9@$](?:[\s.\-_*]+)){2,}[\p{L}0-9@$])(?=\s|$)/gu, run => {
    const kind = classify(run);
    if (kind === "block") blocked = true;
    if (kind) { censored++; return mask(run.replace(/[\s.\-_*]/g, "")); }
    return run;
  });
  out = out.replace(/[\p{L}0-9@$!]+/gu, token => {
    const kind = classify(token);
    if (kind === "block") blocked = true;
    if (kind) { censored++; return mask(token); }
    return token;
  });
  // Personal data in the public channel.
  let hiddenData = false;
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => { hiddenData = true; return "[dato privado]"; });
  out = out.replace(/(?:\+?\d[\s.-]?){9,}/g, m => (m.replace(/\D/g, "").length >= 9 ? (hiddenData = true, "[dato privado] ") : m));
  return { text: out.trim(), blocked, censored, hiddenData };
}

module.exports = { filterMessage, normalizeWord, classify };
