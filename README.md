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
- starter deck for new local profiles
- persistent browser profiles
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
