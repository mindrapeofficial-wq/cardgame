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
- one Power card per Power phase, with automatic Power generation up to 200
- 20–50 card decks with 7–40 Power cards
- random starting player and an extra opening card for the second player
- creature summoning and recovered ability subset
- sequential one-at-a-time attacks with defender-chosen blocks; tapping an attacker or defender exhausts that card immediately, each combat resolves before another attack can be declared, damage is simultaneous, card stats do not wear down between combats and overflow damage hits life
- life, deck-exhaustion, concession/disconnect and 40-minute score win conditions; an empty deck never loses the game by itself: every draw from an empty deck costs 1 life (`EMPTY_DECK_DAMAGE` in rules.js). Base life is 20 plus the original level bonus; offline simulations showed that 30 life with deck-out defeat ended 98% of level-1 games by deck exhaustion, with the starting player winning 99%, while 20 life with this rule brings that to 56%
- per-decision time limits online: 2 minutes for the active player and 60 seconds to choose a blocker; when time runs out the turn passes or the attack resolves unblocked
- conceding and disconnect handling
- player-to-player card + gold exchanges with two-party locking
- local guild-merchant exchange fallback
- gradual Level 1–50 XP progression and visible XP bar
- profile statistics, settings and historical archive
- ELO competitivo persistente y clasificación global Top 50

## Architecture

### Frontend

Static vanilla web application:

- `index.html` — modern application shell
- `modern.css` — responsive design system
- `rules.js` — card stats, Power costs and deck limits shared with the server (edit them only here)
- `app.js` — game client, local economy, collection/decks, AI and multiplayer UI
- `manifest.webmanifest` — installable web app metadata
- `sw.js` — network-first core caching and offline asset cache

### Multiplayer server

Node.js + Express + Socket.IO:

- `server/server.js` (loads `../rules.js` and `../cards.csv`)
- `server/package.json` — also the single source of the server version

The server needs the `ROLPLAY_SERVER_KEY` environment variable. Its SHA-256 must exist in the `rolplay_server_keys` table; without it, match and trade settlements are rejected.

### Accounts API

Supabase Edge Function plus Postgres functions, versioned under `supabase/`:

- `supabase/functions/rolplay-api/index.ts` — accounts, packs, decks, market, rewards and settlements
- `supabase/migrations/` — database changes applied to the project

Failed logins are limited to 10 per username and 30 per IP every 15 minutes, and account creation to 5 per IP per day. Training gold is capped at 10 paid wins per day.

The server owns online duel state so clients do not receive the opponent's private hand.

## Legacy source archive

The repository keeps the recovered original material for reference. The two large binaries (`Rolplay.zip` and `rolplay-3.9.0-installer.exe`) live in the [`legacy-archive` release](https://github.com/mindrapeofficial-wq/cardgame/releases/tag/legacy-archive) so the website does not serve them; the legacy workflows download them from there.

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

Level 1 creature stats and Power costs (defined in `rules.js`):

| Card | ATK / DEF | Power cost |
|---|---|---|
| Duende | 1 / 1 | 1 |
| Elfo Bardo | 0 / 2 | 2 |
| Guerrero Menor | 1 / 1 | 2 |
| Mel | 1 / 1 | 2 |
| Dophan | 2 / 1 | 3 |
| Gorad Menor | 1 / 2 | 3 |
| Mimit | 0 / 3 | 3 |


## All-level pack system

- Players can select any pack level from 1 up to their current player level.
- A Level N pack never drops a card above Level N.
- Older cards remain possible, but their weight decays exponentially with distance from the selected pack level.
- Rarity modifies the raw weight: Common ×1.00, Uncommon ×0.75, Rare ×0.48, Epic ×0.22.
- Legendary cards are detected from historical rarity plus gameplay efficiency against nearby cards of the same role.
- Once legendary cards are unlocked, the entire legendary pool is capped at 0.2% per card draw, shared among all eligible legendary cards.
- Strength, defense, Power cost, role, and special-card multipliers make stronger cards slightly less likely within their rarity.
- The shop displays the exact server-calculated odds for the selected pack level.


## PvP rewards and XP changes

Competitive match rewards are server-authoritative and settled atomically for both accounts.

### Gold

- Win: +15 gold
- Draw: +5 gold
- Loss: +0 gold

### XP

Against an opponent of the same level:

- Win: +40 XP
- Draw: +8 XP
- Loss: -15 XP

Level difference modifies XP:

- Win: `40 + 4 × (opponent level - player level)`, clamped to +20..+70
- Draw: `8 + 2 × (opponent level - player level)`, clamped to +3..+20
- Loss: `-(15 + 3 × (player level - opponent level))`, with penalty clamped to -5..-30

A PvP loss can reduce the XP bar of the current level, but never causes de-leveling. XP cannot fall below 0 inside the current level.

Draws are persisted as a separate statistic. If both players reach a defeat condition simultaneously, or the 40-minute limit is reached, the winner is determined by the canonical score: remaining life + cards on the battlefield + cards left in deck + base attack of the highest-level card in play. An exact score tie is a draw.

Training rewards are intentionally much smaller and never remove XP.


## ELO competitivo y Ranking

Las partidas PvP online actualizan una puntuación ELO persistente además de las recompensas de oro y XP.

- ELO inicial: 1000
- Cálculo de expectativa mediante la tabla oficial FIDE.
- Victoria: puntuación real 1
- Empate: puntuación real 0,5
- Derrota: puntuación real 0
- Cambio: `K × (resultado real - resultado esperado)`, redondeado al entero más cercano.
- K = 40 durante las primeras 30 partidas puntuadas.
- K = 20 después de las primeras 30 partidas mientras el jugador no haya alcanzado 2400.
- K = 10 una vez que el jugador ha alcanzado 2400, aunque posteriormente baje de rating.
- Para jugadores con rating inferior a 2650, las diferencias superiores a 400 puntos se computan como 400.
- La excepción FIDE para menores de 18 años no se usa porque ARCANUM no almacena la edad del jugador.
- Cada duelo online se trata como un periodo de rating individual para actualizar el ranking en tiempo real.
- El cálculo y el asentamiento son atómicos en servidor, por lo que un reintento de red no duplica puntos.
- Solo el PvP online modifica el ELO; el entrenamiento contra IA no altera el ranking.
- La sección Ranking muestra el Top 50 con posición, jugador, nivel, ELO, balance V-E-D y partidas puntuadas.
