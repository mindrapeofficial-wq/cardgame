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

  // Level 1 creatures have hand-balanced stats and costs; every other card uses the formulas below.
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

  function isPowerName(name) {
    return /^Poder(?:\s+x\s+\d+|\s*$)/i.test(name);
  }
  function isAbilityName(name) {
    return /^(Veneno|Fuente de vida|Drenador|Escudal|Barrera Mistica|Poder Mental|Poderador|Rueda)/i.test(name);
  }
  function powerValue(card) {
    const m = card && card.name.match(/^Poder\s+x\s+(\d+)/i);
    return m ? Math.max(1, Number(m[1]) || 1) : 1;
  }
  function summonCost(name, level, powerCard) {
    if (powerCard) return 0;
    const fixed = Number(level) === 1 ? LEVEL1_POWER_COSTS[name] : undefined;
    return Number.isFinite(fixed) ? fixed : Math.max(1, Math.min(10, Math.ceil((Number(level) || 1) / 5)));
  }
  // Card ids are the 1-based row numbers of cards.csv (after the header); the database uses the same ids.
  function parseCatalog(csvText) {
    return String(csvText).trim().split(/\r?\n/).slice(1).map((line, index) => {
      const [name, rarity, quantity, level] = line.split(";");
      const lv = Number(level) || 1;
      const rar = Number(rarity) || 1;
      const powerCard = isPowerName(name);
      const abilityCard = isAbilityName(name);
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

  return Object.freeze({
    DECK_MIN, DECK_MAX, MIN_POWER_CARDS, MAX_POWER_CARDS, MAX_POWER_POINTS,
    MATCH_LIMIT_MS, COMBAT_LEAVE_GRACE_MS,
    BASE_HP, LEVEL_POWER_REWARDS, levelHpBonus, startingHp,
    LEVEL1_COMBAT_STATS, LEVEL1_POWER_COSTS,
    isPowerName, isAbilityName, powerValue, summonCost, parseCatalog
  });
});
