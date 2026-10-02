# Rolplay Web Restoration Status

## Confirmed legacy architecture

- Original client: Visual Basic 6.
- Main executable: RPcliente.exe.
- Networking: MSWINSCK.OCX / Winsock.
- Historical login endpoint found in winsock_host.dat: 80.26.94.33:10002.
- The old backend is treated as unavailable and is being replaced.

## Recovered structured game data

The archive contains 285 catalogued cards and the original artwork set.

- 202 creatures
- 24 power cards
- 54 spells
- 5 amulets
- Levels 1 through 50
- Creature families include normal, mystical and berserker
- Recovered effects include creature/power tapping, destruction, life gain/drain, extra cards, attack/defense modifiers, defenders and mystical shield interactions

The original image directory has been extracted from Rolplay.zip into `legacy-assets/imagenes`.

## Rules recovered from the original manual / changelog

- Mature 3.x client uses a minimum deck size of 20 cards.
- Game creation supports a configurable number of cards.
- Starting hand was changed to 7 cards in version 3.0.0.
- The six turn phases are:
  1. Untap cards.
  2. Draw a card.
  3. Cast power.
  4. Summon creatures.
  5. Use creature abilities and amulets.
  6. Attack.
- A creature that attacks cannot defend afterwards while tapped.
- Combat compares attack against defense; equality is lethal (for example 2/1 vs 1/1 destroys both).
- A duel can end by life reaching zero, a player retiring, or a player running out of cards.
- The client supported creating and joining waiting matches.
- Card management supported buying packs, adding cards to the reserve/deck, and selling cards.
- Card exchanges existed from version 2.0.0 onward.
- Later versions added card value display, card locking after trade acceptance, and gold exchange.
- Double click enlarged cards and cards could be moved around the board.
- The historical client included channels, private messages, away/no-away state, statistics, clans and tournaments.

## Current browser restoration

Implemented:

- Historical-style login and main salon.
- Original 2013 visual assets used directly where available.
- Original card artwork mapping.
- Local chat facade and classic salon layout.
- Pack purchases, persistent collection and deck builder.
- Minimum 20-card deck rules.
- Waiting-match browser plus local match creation/joining.
- Configurable 20/30/40/50-card local matches.
- Functional local card + gold exchange prototype.
- Seven-card opening hand.
- Six historical turn phases.
- Tapped attackers cannot defend.
- Lethal combat on attack >= defense.
- Deck exhaustion defeat.
- Double-click card zoom.
- Browser-local persistence for player economy and collection.

## Next restoration milestones

1. Replace provisional card statistics/effects with exact decoded legacy values.
2. Add authoritative online lobby presence, chat and challenges.
3. Synchronize multiplayer matches through a replacement server.
4. Synchronize exchanges and lock offers after acceptance.
5. Restore card selling, clans, private messages, statistics and tournaments.
