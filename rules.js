"use strict";
// Game rules shared by the browser client (app.js, via window.ROLPLAY_RULES) and the
// multiplayer server (server/server.js, via require). Change card stats, costs and deck
// limits here only, so both sides always agree on the same card catalogue.
(function (root, factory) {
  const rules = factory();
  if (typeof module === "object" && module.exports) module.exports = rules;
  else root.ROLPLAY_RULES = rules;
})(typeof self !== "undefined" ? self : this, function () {
  const DECK_MIN = 20;
  const DECK_MAX = 50;
  const MIN_POWER_CARDS = 7;
  const MAX_POWER_CARDS = 40;
  const MAX_POWER_POINTS = 200;
  const MATCH_LIMIT_MS = 40 * 60 * 1000;
  const COMBAT_LEAVE_GRACE_MS = 2 * 60 * 1000;

  // Original level table (manual 3.2, "Tabla de niveles"). "Plus/PV" is the extra life a
  // player starts every duel with at that level; it is the total bonus, not cumulative.
  const BASE_HP = 30;
  const LEVEL_HP_BONUS = Object.freeze([[46, 13], [40, 12], [36, 11], [25, 10], [20, 9], [16, 8], [10, 4], [2, 2]]);
  // "Plus/Poder": reaching these levels grants 2 copies of the Power card (granted server-side
  // by rolplay_apply_xp_gold_result; listed here so the client can announce it).
  const LEVEL_POWER_REWARDS = Object.freeze({ 5: "Poder x 3", 7: "Poder x 4", 10: "Poder x 5", 13: "Poder x 6", 15: "Poder x 7", 20: "Poder x 10", 25: "Poder x 15", 50: "Poder x 20" });
  function levelHpBonus(level) {
    const l = Number(level) || 1;
    for (const [minLevel, bonus] of LEVEL_HP_BONUS) if (l >= minLevel) return bonus;
    return 0;
  }
  function startingHp(level) {
    return BASE_HP + levelHpBonus(level);
  }

  // Card data comes from cards.csv, transcribed from the original 2013 card art:
  //   name;rarity;quantity;level;type;atk;def;cost;activation;power;abilities;effect
  // type is creature | power | amulet; abilities are tags from the card icons
  // (defensora, mistica, defensa_multiple=N, ataque_defensa_multiple=N, berserker, defensa_negativa);
  // effect is the printed effect text (e.g. "+3PV", "-2PV.Opp", "12⚡ +2D").
  // Rows without those columns fall back to name detection and the old provisional formula.
  function isPowerName(name) {
    return /^Poder(?:\s+x\s+\d+|\s*$)/i.test(name);
  }
  function isAbilityName(name) {
    return /^(Veneno|Fuente de vida|Drenador|Escudal|Barrera Mistica|Poder Mental|Poderador|Rueda)/i.test(name);
  }
  function powerValue(card) {
    if (card && Number(card.power) > 0) return Number(card.power);
    const m = card && card.name.match(/^Poder\s+x\s+(\d+)/i);
    return m ? Math.max(1, Number(m[1]) || 1) : 1;
  }
  function summonCost(name, level, powerCard) {
    if (powerCard) return 0;
    return Math.max(1, Math.min(10, Math.ceil((Number(level) || 1) / 5)));
  }
  function parseTags(text) {
    const tags = {};
    for (const raw of String(text || "").split(",")) {
      const [key, value] = raw.trim().split("=");
      if (key) tags[key] = value === undefined ? true : Number(value);
    }
    return tags;
  }
  const num = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));
  // Card ids are the 1-based row numbers of cards.csv (after the header); the database uses the same ids.
  function parseCatalog(csvText) {
    return String(csvText).trim().split(/\r?\n/).slice(1).map((line, index) => {
      const [name, rarity, quantity, level, type, atk, def, cost, activation, power, abilities, effect] = line.split(";");
      const lv = Number(level) || 1;
      const rar = Number(rarity) || 1;
      const powerCard = type ? type === "power" : isPowerName(name);
      const abilityCard = type ? type === "amulet" : isAbilityName(name);
      const tags = parseTags(abilities);
      const fallbackAtk = Math.max(1, Math.ceil(lv * 0.52) + Math.floor(rar / 30));
      const fallbackDef = Math.max(1, Math.ceil(lv * 0.40) + Math.floor((101 - rar) / 40));
      const multi = Number(tags.ataque_defensa_multiple) || 0;
      return {
        id: index + 1,
        name,
        rarity: rar,
        quantity: Number(quantity) || 1,
        level: lv,
        type: type || (powerCard ? "power" : abilityCard ? "amulet" : "creature"),
        powerCard,
        abilityCard,
        // Amulets were summoned and then activated with extra Power; the engine plays and resolves
        // them in one step, so their playable cost is both amounts together.
        cost: num(cost, summonCost(name, lv, powerCard)) + (abilityCard ? num(activation, 0) : 0),
        summonCost: num(cost, summonCost(name, lv, powerCard)),
        activation: num(activation, 0),
        power: num(power, 0),
        atk: (powerCard || abilityCard) ? 0 : num(atk, fallbackAtk),
        def: (powerCard || abilityCard) ? 0 : num(def, fallbackDef),
        tags,
        effect: effect || "",
        // Engine flags already supported by the combat code.
        defender: !!tags.defensora,
        multiDefense: Number(tags.defensa_multiple) || multi || 0,
        multiAttack: multi
      };
    });
  }

  return Object.freeze({
    DECK_MIN, DECK_MAX, MIN_POWER_CARDS, MAX_POWER_CARDS, MAX_POWER_POINTS,
    MATCH_LIMIT_MS, COMBAT_LEAVE_GRACE_MS,
    BASE_HP, LEVEL_POWER_REWARDS, levelHpBonus, startingHp,
    isPowerName, isAbilityName, powerValue, summonCost, parseCatalog
  });
});
