import { describe, expect, it } from 'vitest';
import { cubeIdFromUrl, frontText, normName, parseCube, parsePowerToughness } from '@shared/cube/parse';
import { cubeResponse } from './fixture';

describe('parseCube', () => {
  const snap = parseCube(cubeResponse(), 123);
  const by = (name: string) => snap.cards.find((c) => c.name === name)!;
  const backOf = (name: string) => snap.cards.find((c) => c.key === by(name).back)?.name ?? null;

  it('keeps only custom cards, once per oracle id', () => {
    expect(snap.id).toBe('cube-1');
    expect(snap.name).toBe('Test Cube');
    expect(snap.revision).toBe(7);
    expect(snap.fetchedAt).toBe(123);
    expect(snap.cards.filter((c) => c.name === 'Puddle Punch')).toHaveLength(1);
    expect(snap.cards.some((c) => c.name === 'Aggravated Assault')).toBe(false);
    expect(snap.cards.filter((c) => c.considering)).toHaveLength(7);
  });

  it('pairs printed back faces from the rules text', () => {
    expect(backOf('Silver, Drunkard')).toBe('Silver, Beast Inside'); // transforms, shares a first name
    expect(backOf('Calico, Contract Killer')).toBe('Ava, Just a Cat'); // back named on its own line
    expect(backOf('Times Square')).toBe('The Soul Urn'); // named after `//`
    expect(backOf('Fairfax Factories')).toBe('The Assembly Line'); // unnamed `//` section, text matches
    expect(backOf('The Stock Exchange // The Closing Bell')).toBe('The Closing Bell'); // Front // Back name
    expect(backOf('Welcome to the Baroness // Enjoy Your Stay')).toBeNull(); // a Room, not a DFC
    expect(backOf('The Thing Under Bow Bridge')).toBe('The Rootbound Guardian'); // meld result
    expect(backOf('The Great Elm')).toBeNull(); // the other half does not name it
    expect(backOf('Yamato, Pursuer')).toBeNull();
    expect(backOf('The Doorman')).toBeNull(); // mentions Hallway Door but does not transform
  });

  it('cuts the back face off the front text but keeps both Room doors', () => {
    expect(by('Calico, Contract Killer').oracleText).toBe('First strike\nAt end of combat, transform it.');
    expect(by('Times Square').oracleText).toBe('(Defeat it.)');
    expect(by('Welcome to the Baroness // Enjoy Your Stay').oracleText).toContain('Enjoy door');
  });

  it('reads P/T from a trailing rules line of creatures only', () => {
    expect([by('The Doorman').power, by('The Doorman').toughness]).toEqual(['2', '4']);
    // Calico's "1/1" belonged to the back face and was cut off.
    expect(by('Calico, Contract Killer').power).toBeNull();
    expect(parsePowerToughness('Deal 2.\n2/2', 'Instant')).toEqual({ power: null, toughness: null });
    expect(parsePowerToughness('Flying\n*/3', 'Creature — Spirit')).toEqual({ power: '*', toughness: '3' });
  });

  it('honours manual back-face overrides', () => {
    const s = parseCube(cubeResponse(), 0, { 'Yamato, Pursuer': 'Barrel' });
    const y = s.cards.find((c) => c.name === 'Yamato, Pursuer')!;
    expect(s.cards.find((c) => c.key === y.back)?.name).toBe('Barrel');
  });

  it('rejects responses that are not a cube', () => {
    expect(() => parseCube({} as never)).toThrow();
  });
});

describe('helpers', () => {
  it('extracts a cube id from a URL or bare id', () => {
    expect(cubeIdFromUrl('https://cubeforge.app/cubes/0F00D960-d538-4a53-a7eb-5ca3105d0802')).toBe('0f00d960-d538-4a53-a7eb-5ca3105d0802');
    expect(cubeIdFromUrl('nope')).toBeNull();
  });

  it('normalises names the way people type them', () => {
    expect(normName('Wallflower’s  Revenge')).toBe("wallflower's revenge");
    expect(normName('Stock Exchange/The Closing Bell')).toBe('stock exchange // the closing bell');
  });

  it('frontText stops at a // line', () => {
    expect(frontText('a\nb\n//\nc', null)).toBe('a\nb');
  });
});
