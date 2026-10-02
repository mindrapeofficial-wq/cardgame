# Rolplay Reborn — Pack & Rarity Balance

## Canonical rarity bands

- Common / Común: historical rarity 1–9
- Uncommon / Poco común: 10–34
- Rare / Rara: 35–69
- Epic / Épica: 70–99
- Legendary / Legendaria: exactly 100

The historical rarity signal defines the base tier. Within the same tier, final loot probability is adjusted using current gameplay efficiency.

## Gameplay efficiency inputs

The pack engine accounts for:

- attack
- defense
- current Power/mana cost
- card role
- special-card utility
- multiplier/version in cards such as `x 5`, `x 10`, etc.
- distance between card level and selected pack level

Stronger/more efficient cards inside the same rarity tier receive a modest probability penalty rather than being moved automatically to a higher tier.

## Pack levels

A player can buy any pack level from 1 up to their current player level.

A Level N pack:
- can never contain cards above Level N;
- can contain older cards;
- strongly favors cards close to Level N;
- excludes the infinite basic Level 1 Power.

Level affinity uses an exponential decay:

`level affinity = exp(-0.55 × (pack level - card level))`

So a card at the exact pack level has weight 1.0, one level below ~0.58, two below ~0.33, three below ~0.19, and older cards continue falling rapidly.

## Rarity budget per card slot

For pack levels that have unlocked all rarity groups, the target budget is:

- Common: 55%
- Uncommon: 25%
- Rare: 14%
- Epic: 5.8%
- Legendary: 0.2%

Legendary therefore has only a 0.2% share per individual draw before that share is split among all eligible legendary cards. A five-card pack with legendary cards unlocked has roughly a 1% chance to contain at least one legendary.

If a pack level has not yet unlocked a rarity tier, that tier's probability is redistributed toward the nearest available lower rarity so unavailable tiers do not create phantom drops.

## Level 1 special onboarding balance

Level 1 keeps its manually tuned opening distribution:

- Elfo Bardo: 20%
- Duende: 20%
- Guerrero Menor: 20%
- Mel: 20%
- Mimit: 15%
- Dophan: 3.5%
- Gorad Menor: 1.5%
- Basic Power: 0% from packs because it is infinite

## Legendary cards detected

Legendary status currently requires the maximum historical rarity value of 100. There are 50 legendary catalogue cards:

- Nivel 9: Mujer Aguila
- Nivel 14: Korth
- Nivel 15: Poder x 7 Poderal, Poder x 7 Natural, Poder x 7 Ametal, Poder x 7 Domica
- Nivel 17: Poder x 8 Mayor
- Nivel 20: Argnathor Poderal, Urgul Mayor, Angel Caido, Poder x 10 Poderal, Poder x 10 Natural, Poder x 10 Ametal, Poder x 10 Domica
- Nivel 21: Acrum
- Nivel 22: Poder x 12 Mayor
- Nivel 25: Enher, Argnathor Ametal, Poder x 15 Domica, Poder x 15 Ametal, Poder x 15 Natural, Poder x 15 Poderal
- Nivel 26: Acrum x 2, Draconia
- Nivel 27: Hermanos Elfo
- Nivel 29: Flora
- Nivel 30: Argnathor Natural, Hombre Angel, Poder x 15 Mayor
- Nivel 31: Solemn
- Nivel 34: Acrum x 3, Ardala
- Nivel 35: Sanal, Argnathor Domic, Elfo Brujo
- Nivel 39: Hijo de Keathan
- Nivel 40: Bestia del Caos
- Nivel 41: Ruinthz x 3
- Nivel 42: Rueda x 3, Kurth Arth x 4
- Nivel 43: Angrath
- Nivel 45: Gigante, Acrum x 4, Insignia Solamnica
- Nivel 46: Imnazthril, Genios
- Nivel 48: Pesadilla
- Nivel 49: Tentaculo
- Nivel 50: Keatahn, Poder x 20

## Notes

The probabilities shown in the shop are calculated by the same server-side system used to draw the cards. The UI does not decide the result of a pack.
