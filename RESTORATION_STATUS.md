# Rolplay Web Restoration Status

## Confirmed legacy architecture

- Original client: Visual Basic 6.
- Main executable: RPcliente.exe.
- Networking: MSWINSCK.OCX / Winsock.
- Historical login endpoint found in winsock_host.dat: 80.26.94.33:10002.
- The old backend should be treated as unavailable and replaced.

## Recovered structured game data

RolPlus contains a structured database of 285 cards:

- 202 creatures
- 24 power cards
- 54 spells
- 5 amulets

Rarities:

- 70 normal
- 52 rare
- 50 epic
- 113 legendary

Levels run from 1 through 50.

Supported creature types include normal, mystical and berserker.

Recovered ability families include power generation, attack and defense modification, life gain and drain, card draw, field alteration, creature and power tapping, and multiple attacks or defenses.

## Original turn structure

1. Untap cards.
2. Draw a card.
3. Cast power.
4. Summon creatures.
5. Use creature abilities and amulets.
6. Attack.

## Restoration direction

The browser remake should keep the historical archive intact while replacing the dead Visual Basic networking layer with a modern web client and server.

The next implementation milestone is a playable training duel driven directly by the recovered cards.json dataset.
