/** A small CubeForge response and carrier pool for the cube tests. */
import type { CubeApiResponse } from '@shared/cube/parse';
import type { Carrier } from '@shared/cube/types';

export function raw(name: string, type: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    type,
    oracleText: text,
    manaCost: '{1}{U}',
    cmc: 2,
    colors: ['U'],
    imageUrl: `https://media.cubeforge.app/${encodeURIComponent(name)}.webp`,
    rarity: 'rare',
    source: 'custom',
    oracleId: `custom-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    addedAt: '2026-10-13T00:00:00Z',
    ...extra,
  };
}

export function cubeResponse(): CubeApiResponse {
  return {
    cube: { id: 'cube-1', name: 'Test Cube', revision: 7 },
    cards: [
      raw('Yamato, Pursuer', 'Legendary Creature — Ninja', 'Double Strike'),
      raw('Silver, Drunkard', 'Legendary Creature — Werewolf', 'First strike\nWhenever a creature blocking this creature dies, transform this creature.'),
      raw('Calico, Contract Killer', 'Legendary Creature — Human Assassin', 'First strike\nAt end of combat, transform it.\n\nAva, Just a Cat\nLegendary Creature — Cat\nThis creature can’t be blocked.\n1/1'),
      raw('Times Square', 'Battle', '(Defeat it.)\n//\nThe Soul Urn\nLegendary Artifact — Equipment\nEquip {2}'),
      raw('Fairfax Factories', 'Legendary Battle Artifact', 'Make a Turret.\n//\nLegendary Artifact\nAt the beginning of your end step, create a Treasure token.'),
      raw('The Stock Exchange // The Closing Bell', 'Legendary Battle Enchantment', 'Scry 2.\n//\nAt the beginning of your end step, draw.'),
      raw('Welcome to the Baroness // Enjoy Your Stay', 'Legendary Enchantment — Room', 'Welcome door\n\n//\n\nEnjoy door'),
      raw('The Doorman', 'Legendary Creature', 'Destroy all Hallway Doors.\n2/4'),
      raw('Puddle Punch', 'Instant', 'Deal 2.'),
      raw('The Thing Under Bow Bridge', 'Legendary Creature — Dryad', 'At the beginning of your upkeep, you may exile them. If you do, meld them into The Rootbound Guardian.'),
      raw('The Great Elm', 'Legendary Land', '{T}: Add {G}.\n(Melds with The Thing Under Bow Bridge.)'),
      // A doubled-up custom card: second entry with the same oracle id.
      raw('Puddle Punch', 'Instant', 'Deal 2.', { oracleId: 'custom-puddle-punch' }),
      // A real Magic card in the cube: not ours to paint.
      { name: 'Aggravated Assault', type: 'Enchantment', source: 'scryfall', oracleId: 'real-1', imageUrl: 'https://cards.scryfall.io/x.jpg' },
    ],
    consideringCards: [
      raw('Silver, Beast Inside', 'Legendary Creature — Werewolf', 'Haste'),
      raw('Ava, Just a Cat', 'Legendary Creature — Cat', 'This creature can’t be blocked. Whenever it deals combat damage, transform it.'),
      raw('The Soul Urn', 'Legendary Artifact — Equipment', 'Equip {2}'),
      raw('The Assembly Line', 'Legendary Artifact', 'At the beginning of your end step, create a Treasure token.\nTreasures are Turrets.'),
      raw('The Closing Bell', 'Legendary Enchantment Battle', 'Whenever you sacrifice a Treasure, loot.'),
      raw('The Rootbound Guardian', 'Legendary Creature — Dryad', 'Vigilance, reach, trample\n10/10'),
      raw('Barrel', 'Artifact', '{2}, {T}, Sacrifice this artifact: It deals 2 damage.'),
    ],
  };
}

export function carrier(i: number, legendary: boolean, extra: Partial<Carrier> = {}): Carrier {
  return {
    card_id: `cid-${i}`,
    card_print_id: `pid-${i}`,
    print_ids: [`pid-${i}-alt`],
    name: `Carrier ${i}`,
    type_line: legendary ? 'Legendary Creature — Human' : 'Creature — Elf',
    image_id: `000000${String(i).padStart(2, '0')}-0000-0000-0000-000000000000`,
    legendary,
    ...extra,
  };
}

/** 10 legendary then 12 plain carriers. */
export function pool(): Carrier[] {
  return [...Array.from({ length: 10 }, (_, i) => carrier(i, true)), ...Array.from({ length: 12 }, (_, i) => carrier(10 + i, false))];
}
