# Rolplay Reborn

Modern web reconstruction of the historical **Rolplay.net** card game.

## Play

Production client:

- https://cardgame-l9ld.onrender.com

Replacement multiplayer server:

- https://cardgame-server-erng.onrender.com

## Current game loop

Rolplay Reborn now has a complete playable loop:

- modern responsive desktop/mobile UI
- installable PWA shell
- offline collection, deck building and AI training
- 285 recovered catalogue cards with 285/285 original artwork mapping
- persistent username/password accounts
- a new account starts at Level 1 with 0 collectible cards
- Level 1 basic Power is infinite and does not consume collection copies
- new accounts start with 100 gold, enough for five 20-gold packs
- pack contents are server-generated and capped to the player's current level
- persistent server-side collection, deck, gold, wins, losses, level and XP
- collection search and filtering
- 20–50 card deck builder with validation and automatic construction
- card shop and pack opening
- duplicate card selling and gold economy
- online lobby presence and general chat
- online match creation and joining
- authoritative Socket.IO PvP state
- six recovered historical turn phases
- one Power card per Power phase
- creature summoning and recovered ability subset
- attacker selection
- manual defender assignment in online PvP
- life and deck-exhaustion win conditions
- conceding and disconnect handling
- player-to-player card + gold exchanges with two-party locking
- local guild-merchant exchange fallback
- gradual Level 1–50 XP progression and visible XP bar
- profile statistics, settings and historical archive

## Architecture

### Frontend

Static vanilla web application:

- `index.html` — modern application shell
- `modern.css` — responsive design system
- `app.js` — game client, local economy, collection/decks, AI and multiplayer UI
- `manifest.webmanifest` — installable web app metadata
- `sw.js` — network-first core caching and offline asset cache

### Multiplayer server

Node.js + Express + Socket.IO:

- `server/server.js`
- `server/package.json`

The server owns online duel state so clients do not receive the opponent's private hand.

## Legacy source archive

The repository keeps the recovered original material for reference:

- `Rolplay.zip`
- `Manual 3.2.rtf`
- `version_leeme.txt`
- `legacy-assets/`
- `legacy-config/`
- `LEGACY_ANALYSIS.md`

## Historical accuracy

The original navigation, card catalogue, artwork, sounds, economy concepts, six turn phases, deck exhaustion, exchanges and other documented mechanics are being restored from the archived client/manual.

Some combat statistics and advanced card effects are still reconstructed from the available catalogue rather than fully decoded from the original executable. They are playable, but exact historical balance remains a separate reverse-engineering milestone.


## Canonical new-player progression

The current progression rules are authoritative:

- Level 1
- 0 collectible cards
- 100 starting gold
- 20 gold per five-card pack
- infinite Level 1 basic Power
- pack cards can never exceed the player's current level
- a deck may use unlimited copies of the basic Level 1 Power
- all non-basic cards require owned copies and must be at or below player level

XP required to advance from a level follows:

`100 + 35 × (level - 1) + 5 × (level - 1)²`

Examples: 100 XP from Level 1→2, 140 from 2→3, 190 from 3→4, 250 from 4→5, and 320 from 5→6.


## Level 1 pack balance

Level 1 pack slots use explicit server-side probabilities based on historical rarity plus current combat efficiency:

- Elfo Bardo — Common — 20%
- Duende — Common — 20%
- Guerrero Menor — Common — 20%
- Mel — Common — 20%
- Mimit — Uncommon — 15%
- Dophan — Rare — 3.5%
- Gorad Menor — Rare — 1.5%

This gives a per-slot category distribution of 80% Common, 15% Uncommon and 5% Rare. Basic Level 1 Power has a 0% pack drop rate because it is infinite by rule.

For Level 1, all collectible creatures currently cost 1 Power. The four common creatures are 1 ATK / 3 DEF, Mimit shares that stat line but preserves its higher historical rarity signal, Dophan is 2 ATK / 2 DEF, and Gorad Menor is 3 ATK / 2 DEF. Gorad therefore receives the lowest drop chance within the tier because it is the strongest offensive efficiency at this level.


## All-level pack system

- Players can select any pack level from 1 up to their current player level.
- A Level N pack never drops a card above Level N.
- Older cards remain possible, but their weight decays exponentially with distance from the selected pack level.
- Rarity modifies the raw weight: Common ×1.00, Uncommon ×0.75, Rare ×0.48, Epic ×0.22.
- Legendary cards are detected from historical rarity plus gameplay efficiency against nearby cards of the same role.
- Once legendary cards are unlocked, the entire legendary pool is capped at 0.2% per card draw, shared among all eligible legendary cards.
- Strength, defense, Power cost, role, and special-card multipliers make stronger cards slightly less likely within their rarity.
- The shop displays the exact server-calculated odds for the selected pack level.
