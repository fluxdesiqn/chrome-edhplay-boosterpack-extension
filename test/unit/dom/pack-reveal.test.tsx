// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { OfferCard } from '@shared/bridge-contract';
import { PackReveal, type PackRevealProps } from '@ui/panels/PackReveal';

function card(i: number, rarity?: string): OfferCard {
  return {
    ref: `neo:${i + 1}`,
    identity: {
      card_id: `card-${i}`,
      card_print_id: `print-${i}`,
      name: `Card ${i}`,
      type_line: 'Creature — Test',
      front_image_uri: `https://img.test/${i}.jpg`,
      back_image_uri: null,
      can_rotate: false,
      power: null,
      toughness: null,
      rarity,
    },
  };
}

const RARITIES = ['common', 'uncommon', 'rare', 'mythic'];
const CARDS = Array.from({ length: 15 }, (_, i) => card(i, RARITIES[i % 4]));

let container: HTMLElement | null = null;

function mount(over: Partial<PackRevealProps> = {}): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const props: PackRevealProps = {
    ownerName: 'Alice',
    isOwner: false,
    set: 'neo',
    kind: 'draft',
    packNumber: 2,
    cards: CARDS,
    foil: [0, 7],
    phase: 'revealed',
    ...over,
  };
  const el = container;
  act(() => render(h(PackReveal, props), el));
  return el;
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

afterEach(() => {
  if (container) {
    const el = container;
    act(() => render(null, el));
    el.remove();
    container = null;
  }
});

describe('PackReveal', () => {
  it('renders the header with owner name, pack label and pack number', () => {
    const el = mount();
    const title = el.querySelector('.hok-reveal-title')!;
    expect(title.textContent).toBe('Alice opened a Kamigawa: Neon Dynasty Play Booster');
    expect(el.querySelector('.hok-reveal-pill')!.textContent).toBe('Pack #2');
    expect(el.querySelector('.hok-reveal')!.className).toContain('hok-reveal--neo');
    expect(el.querySelector('.hok-reveal')!.className).toContain('hok-reveal--draft');
  });

  it('renders every card with an eager image and a caption', () => {
    const el = mount();
    const cards = el.querySelectorAll('.hok-reveal-card');
    expect(cards.length).toBe(15);
    const imgs = el.querySelectorAll<HTMLImageElement>('.hok-reveal-face img');
    expect(imgs.length).toBe(15);
    expect(imgs[3]!.getAttribute('src')).toBe('https://img.test/3.jpg');
    expect(imgs[3]!.getAttribute('alt')).toBe('Card 3');
    expect(imgs[3]!.getAttribute('loading')).toBe('eager');
    const caps = Array.from(el.querySelectorAll('.hok-reveal-cap')).map((c) => c.textContent);
    expect(caps).toEqual(CARDS.map((c) => c.identity.name));
    // Rarity dots: common has no modifier, others get u/r/m.
    expect(el.querySelectorAll('.hok-reveal-dot--u').length).toBe(4);
    expect(el.querySelectorAll('.hok-reveal-dot--r').length).toBe(4);
    expect(el.querySelectorAll('.hok-reveal-dot--m').length).toBe(3);
  });

  it('marks exactly the foil indices with a FOIL tag', () => {
    const el = mount({ foil: [2, 9, 14] });
    const cards = Array.from(el.querySelectorAll('.hok-reveal-card'));
    const foilIdx = cards.flatMap((c, i) => (c.classList.contains('hok-reveal-card--foil') ? [i] : []));
    expect(foilIdx).toEqual([2, 9, 14]);
    const tags = el.querySelectorAll('.hok-reveal-tag');
    expect(tags.length).toBe(3);
    tags.forEach((t) => expect(t.textContent).toBe('FOIL'));
    expect(cards[2]!.querySelector('.hok-reveal-sheen')).not.toBeNull();
    expect(cards[3]!.querySelector('.hok-reveal-sheen')).toBeNull();
  });

  it('shows the owner a shuffle button that calls onShuffle, and a subline', () => {
    const onShuffle = vi.fn();
    const onClose = vi.fn();
    const el = mount({ isOwner: true, ownerName: 'you', onShuffle, onClose });
    const btn = el.querySelector<HTMLButtonElement>('.hok-reveal-btn')!;
    expect(btn.textContent).toBe('Shuffle into booster pile');
    expect(el.textContent).toContain('These cards are shuffled into your booster pile.');
    expect(el.textContent).not.toContain('Close');
    act(() => btn.click());
    expect(onShuffle).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows peers a Close button that calls onClose and a waiting note', () => {
    const onClose = vi.fn();
    const el = mount({ onClose });
    const btn = el.querySelector<HTMLButtonElement>('.hok-reveal-btn')!;
    expect(btn.textContent).toBe('Close');
    expect(el.textContent).toContain('Waiting for Alice to shuffle…');
    expect(el.textContent).not.toContain('Shuffle into booster pile');
    act(() => btn.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onClose for peers but not for the owner while revealed', () => {
    const peerClose = vi.fn();
    mount({ onClose: peerClose });
    pressEscape();
    expect(peerClose).toHaveBeenCalledTimes(1);

    // Unmount the peer overlay before mounting the owner one.
    const el = container!;
    act(() => render(null, el));
    el.remove();
    container = null;

    const ownerClose = vi.fn();
    mount({ isOwner: true, onClose: ownerClose, onShuffle: vi.fn() });
    pressEscape();
    expect(ownerClose).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    const el = mount({ phase: 'closed', onClose: vi.fn() });
    expect(el.querySelector('.hok-reveal')).toBeNull();
    expect(el.innerHTML).toBe('');
  });

  it('shows the wrapper while opening and the shuffling status while shuffling', () => {
    const el = mount({ phase: 'opening' });
    expect(el.querySelector('.hok-reveal-wrapper')).not.toBeNull();
    expect(el.querySelector('.hok-reveal-grid')).toBeNull();

    const el2 = container!;
    act(() =>
      render(
        h(PackReveal, { ownerName: 'Alice', isOwner: true, set: 'neo', kind: 'collector', packNumber: 1, cards: CARDS, foil: [], phase: 'shuffling' }),
        el2,
      ),
    );
    expect(el2.querySelector('.hok-reveal-status')!.textContent).toBe('Shuffling into the booster pile…');
    expect(el2.querySelector('.hok-reveal')!.className).toContain('hok-reveal--shuffling');
    expect(el2.querySelector('.hok-reveal')!.className).toContain('hok-reveal--collector');
    expect(el2.querySelectorAll('.hok-reveal-card').length).toBe(15);
  });

  it('adds the static class when reducedMotion is set', () => {
    const el = mount({ reducedMotion: true });
    expect(el.querySelector('.hok-reveal')!.className).toContain('hok-reveal--static');
  });

  it('does not add the static class by default', () => {
    const el = mount();
    expect(el.querySelector('.hok-reveal')!.className).not.toContain('hok-reveal--static');
  });

  it('does not throw with an empty card list', () => {
    expect(() => mount({ cards: [], foil: [] })).not.toThrow();
    const el = container!;
    expect(el.querySelector('.hok-reveal-title')!.textContent).toContain('Alice opened a');
    expect(el.querySelectorAll('.hok-reveal-card').length).toBe(0);
    expect(el.querySelector('.hok-reveal-grid')).not.toBeNull();
  });
});
