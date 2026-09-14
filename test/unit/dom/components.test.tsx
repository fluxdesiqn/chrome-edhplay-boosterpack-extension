// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, render, type ComponentChild } from 'preact';
import { act } from 'preact/test-utils';
import type { OfferCard } from '@shared/bridge-contract';
import type { CardSummary } from '@shared/state';
import type { SetSummary } from '@shared/packs/runtime';
import { SetPicker, type SetPickerProps } from '@ui/panels/SetPicker';
import { PileView, type PileViewProps } from '@ui/panels/PileView';
import { MulliganChooser, type MulliganChooserProps } from '@ui/panels/MulliganChooser';

let container: HTMLElement | null = null;

function mount(vnode: ComponentChild): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const el = container;
  act(() => render(vnode, el));
  return el;
}

function rerender(vnode: ComponentChild): HTMLElement {
  const el = container!;
  act(() => render(vnode, el));
  return el;
}

afterEach(() => {
  if (container) {
    const el = container;
    act(() => render(null, el));
    el.remove();
    container = null;
  }
});

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(el: Element, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

function click(el: Element | null | undefined) {
  act(() => (el as HTMLElement).click());
}

function texts(el: ParentNode, sel: string): string[] {
  return Array.from(el.querySelectorAll(sel)).map((n) => n.textContent ?? '');
}

// ---------------------------------------------------------------- SetPicker

const SETS: SetSummary[] = [
  { code: 'mh3', name: 'Modern Horizons 3', released: '2024-06-14', cardCount: 303, type: 'draft_innovation' },
  { code: 'dsk', name: 'Duskmourn: House of Horror', released: '2024-09-27', cardCount: 286, type: 'expansion' },
  { code: 'khm', name: 'Kaldheim', released: '2021-02-05', cardCount: 285, type: 'expansion' },
  { code: 'neo', name: 'Kamigawa: Neon Dynasty', released: '2022-02-18', cardCount: 302, type: 'expansion' },
];

function mountPicker(over: Partial<SetPickerProps> = {}) {
  const props: SetPickerProps = { sets: SETS, recent: [], value: 'neo', kind: 'draft', onChange: vi.fn(), ...over };
  return { el: mount(h(SetPicker, props)), props };
}

describe('SetPicker', () => {
  it('shows a loading line and no search input while sets are null', () => {
    const { el } = mountPicker({ sets: null });
    expect(el.textContent).toContain('Loading sets…');
    expect(el.querySelector('.hok-sp-input')).toBeNull();
    // Bundled sets and kind pills still render.
    expect(el.querySelectorAll('.hok-sets .hok-btn').length).toBe(4);
    expect(el.querySelectorAll('.hok-pillbtn').length).toBe(3);
  });

  it('shows an error note with a Retry button that calls onRefresh', () => {
    const onRefresh = vi.fn();
    const { el } = mountPicker({ sets: null, error: 'Scryfall is unreachable', onRefresh });
    expect(el.querySelector('.hok-note.err')!.textContent).toContain('Scryfall is unreachable');
    expect(el.textContent).not.toContain('Loading sets…');
    click(el.querySelector('.hok-note.err .hok-btn'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('highlights the selected Kamigawa set and selecting one keeps an available kind', () => {
    const onChange = vi.fn();
    const { el } = mountPicker({ value: 'neo', kind: 'set', onChange });
    const btns = Array.from(el.querySelectorAll<HTMLButtonElement>('.hok-sets .hok-btn'));
    expect(btns.map((b) => b.textContent)).toEqual(['Champions of Kamigawa', 'Betrayers of Kamigawa', 'Saviors of Kamigawa', 'Kamigawa: Neon Dynasty']);
    expect(btns[3]!.classList.contains('selected')).toBe(true);
    // chk has no Set boosters: the kind falls back to draft.
    click(btns[0]);
    expect(onChange).toHaveBeenLastCalledWith('chk', 'draft');
    // neo -> neo keeps 'set'.
    click(btns[3]);
    expect(onChange).toHaveBeenLastCalledWith('neo', 'set');
  });

  it('filters by code prefix', () => {
    const { el } = mountPicker();
    typeInto(el.querySelector<HTMLInputElement>('.hok-sp-input')!, 'KH');
    expect(texts(el, '.hok-sp-result .hok-sp-name')).toEqual(['Kaldheim']);
    expect(texts(el, '.hok-sp-result .hok-sp-code')).toEqual(['KHM']);
    expect(texts(el, '.hok-sp-result .hok-sp-year')).toEqual(['2021']);
  });

  it('filters by name substring, not by code substring', () => {
    const { el } = mountPicker();
    const input = el.querySelector<HTMLInputElement>('.hok-sp-input')!;
    typeInto(input, 'horizons');
    expect(texts(el, '.hok-sp-result .hok-sp-name')).toEqual(['Modern Horizons 3']);
    // "h3" is not a prefix of any code and not in any name.
    typeInto(input, 'h3');
    expect(el.querySelectorAll('.hok-sp-result').length).toBe(0);
    expect(el.querySelector('.hok-sp-empty')!.textContent).toContain('No sets match');
  });

  it('caps results at 12', () => {
    const many: SetSummary[] = Array.from({ length: 20 }, (_, i) => ({ code: `s${i}`, name: `Set ${i}`, released: '2020-01-01', cardCount: 1, type: 'expansion' }));
    const { el } = mountPicker({ sets: many });
    typeInto(el.querySelector<HTMLInputElement>('.hok-sp-input')!, 'set');
    expect(el.querySelectorAll('.hok-sp-result').length).toBe(12);
  });

  it('ArrowDown moves the highlight and Enter selects it, then clears the query', () => {
    const onChange = vi.fn();
    const { el } = mountPicker({ onChange });
    const input = el.querySelector<HTMLInputElement>('.hok-sp-input')!;
    typeInto(input, 'h'); // mh3 (Horizons), dsk (House of Horror), khm (Kaldheim)
    expect(texts(el, '.hok-sp-result .hok-sp-code')).toEqual(['MH3', 'DSK', 'KHM']);
    expect(el.querySelector('.hok-sp-result.active .hok-sp-code')!.textContent).toBe('MH3');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(el.querySelector('.hok-sp-result.active .hok-sp-code')!.textContent).toBe('KHM');
    key(input, 'ArrowUp');
    expect(el.querySelector('.hok-sp-result.active .hok-sp-code')!.textContent).toBe('DSK');
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('dsk', 'draft');
    expect(input.value).toBe('');
    expect(el.querySelectorAll('.hok-sp-result').length).toBe(0);
  });

  it('Enter on a runtime set resets a collector kind to draft', () => {
    const onChange = vi.fn();
    const { el } = mountPicker({ kind: 'collector', onChange });
    const input = el.querySelector<HTMLInputElement>('.hok-sp-input')!;
    typeInto(input, 'kald');
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('khm', 'draft');
  });

  it('Escape clears the query and the input stops keydown propagation', () => {
    const { el } = mountPicker();
    const input = el.querySelector<HTMLInputElement>('.hok-sp-input')!;
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      typeInto(input, 'kal');
      expect(el.querySelectorAll('.hok-sp-result').length).toBe(1);
      key(input, 'Escape');
      expect(input.value).toBe('');
      expect(el.querySelectorAll('.hok-sp-result').length).toBe(0);
      key(input, 'f');
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('disables Set and Collector for a runtime set with a tooltip, and enables all three for neo', () => {
    const { el } = mountPicker({ value: 'khm' });
    const pills = Array.from(el.querySelectorAll<HTMLButtonElement>('.hok-pillbtn'));
    expect(pills.map((p) => p.textContent)).toEqual(['Draft Booster', 'Set Booster', 'Collector Booster']);
    expect(pills.map((p) => p.disabled)).toEqual([false, true, true]);
    expect(pills[1]!.getAttribute('title')).toBe('Kaldheim was not sold as Set Boosters');
    expect(pills[2]!.getAttribute('title')).toBe('Kaldheim was not sold as Collector Boosters');
    expect(pills[0]!.classList.contains('selected')).toBe(true);
    // The current selection is shown for a runtime set.
    expect(el.querySelector('.hok-sp-current')!.textContent).toContain('Kaldheim');

    const el2 = rerender(h(SetPicker, { sets: SETS, recent: [], value: 'neo', kind: 'collector', onChange: vi.fn() }));
    const pills2 = Array.from(el2.querySelectorAll<HTMLButtonElement>('.hok-pillbtn'));
    expect(pills2.map((p) => p.disabled)).toEqual([false, false, false]);
    expect(pills2[2]!.classList.contains('selected')).toBe(true);
    expect(el2.querySelector('.hok-sp-current')).toBeNull();
  });

  it('shows an unavailable kind as draft and clicking a pill reports the current set', () => {
    const onChange = vi.fn();
    const { el } = mountPicker({ value: 'chk', kind: 'collector', onChange });
    const pills = Array.from(el.querySelectorAll<HTMLButtonElement>('.hok-pillbtn'));
    expect(pills[0]!.classList.contains('selected')).toBe(true);
    expect(pills[2]!.classList.contains('selected')).toBe(false);

    const el2 = rerender(h(SetPicker, { sets: SETS, recent: [], value: 'neo', kind: 'draft', onChange }));
    click(el2.querySelectorAll('.hok-pillbtn')[1]);
    expect(onChange).toHaveBeenCalledWith('neo', 'set');
  });

  it('renders recent chips only when given, and clicking one selects it', () => {
    const onChange = vi.fn();
    const { el } = mountPicker({ onChange });
    expect(el.querySelector('.hok-sp-chips')).toBeNull();

    const el2 = rerender(h(SetPicker, { sets: SETS, recent: ['khm', 'mh3'], value: 'khm', kind: 'draft', onChange }));
    const chips = Array.from(el2.querySelectorAll<HTMLButtonElement>('.hok-sp-chip'));
    expect(chips.length).toBe(2);
    expect(texts(el2, '.hok-sp-chip .hok-sp-code')).toEqual(['KHM', 'MH3']);
    expect(texts(el2, '.hok-sp-chip .hok-sp-chipname')).toEqual(['Kaldheim', 'Modern Horizons 3']);
    expect(chips[0]!.classList.contains('selected')).toBe(true);
    click(chips[1]);
    expect(onChange).toHaveBeenCalledWith('mh3', 'draft');
  });
});

// ---------------------------------------------------------------- PileView

function offer(i: number, name = `Card ${i}`): OfferCard {
  return {
    ref: `neo:${i + 1}`,
    identity: {
      card_id: `card-${i}`,
      card_print_id: `print-${i}`,
      name,
      type_line: i % 2 ? 'Instant' : 'Creature — Test',
      front_image_uri: `https://img.test/${i}.jpg`,
      back_image_uri: null,
      can_rotate: false,
      power: null,
      toughness: null,
    },
  };
}
const PILE = [offer(0), offer(1), offer(2), offer(3)];

function mountPile(over: Partial<PileViewProps> = {}) {
  const props: PileViewProps = { kind: 'peek', cards: PILE.slice(0, 3), total: 10, onClose: vi.fn(), ...over };
  return { el: mount(h(PileView, props)), props };
}

describe('PileView', () => {
  it('peek: header, position badges in order, images, no take buttons or filter', () => {
    const { el } = mountPile();
    expect(el.querySelector('.hok-pv-title')!.textContent).toBe('Top 3 of your booster pile');
    expect(texts(el, '.hok-pv-pos')).toEqual(['#1', '#2', '#3']);
    expect(texts(el, '.hok-cap')).toEqual(['Card 0', 'Card 1', 'Card 2']);
    const imgs = el.querySelectorAll<HTMLImageElement>('.hok-pv-card img');
    expect(imgs[1]!.getAttribute('src')).toBe('https://img.test/1.jpg');
    expect(imgs[1]!.getAttribute('alt')).toBe('Card 1');
    expect(el.querySelector('.hok-pv-take')).toBeNull();
    expect(el.querySelector('.hok-pv-filter')).toBeNull();
    expect(el.textContent).toContain('7 more below');
  });

  it('uses a custom title when given', () => {
    const { el } = mountPile({ title: 'Peeking' });
    expect(el.querySelector('.hok-pv-title')!.textContent).toBe('Peeking');
  });

  it('search: header with total, take buttons call onTake with the ref and zone', () => {
    const onTake = vi.fn();
    const { el } = mountPile({ kind: 'search', cards: PILE, total: 4, onTake });
    expect(el.querySelector('.hok-pv-title')!.textContent).toBe('Booster pile (4 cards)');
    expect(el.querySelector('.hok-pv-pos')).toBeNull();
    const items = el.querySelectorAll('.hok-pv-item');
    expect(items.length).toBe(4);
    const btns = items[1]!.querySelectorAll<HTMLButtonElement>('.hok-pv-take');
    expect(Array.from(btns).map((b) => b.textContent)).toEqual(['To hand', 'To graveyard']);
    click(btns[0]);
    expect(onTake).toHaveBeenLastCalledWith('neo:2', 'hand');
    click(btns[1]);
    expect(onTake).toHaveBeenLastCalledWith('neo:2', 'graveyard');
    click(items[3]!.querySelectorAll('.hok-pv-take')[0]);
    expect(onTake).toHaveBeenLastCalledWith('neo:4', 'hand');
    expect(onTake).toHaveBeenCalledTimes(3);
  });

  it('search: take buttons are disabled without onTake', () => {
    const { el } = mountPile({ kind: 'search', cards: PILE, total: 4 });
    const btns = Array.from(el.querySelectorAll<HTMLButtonElement>('.hok-pv-take'));
    expect(btns.length).toBe(8);
    expect(btns.every((b) => b.disabled)).toBe(true);
  });

  it('search: the filter narrows by name (case-insensitive) and by type, and stops keydown', () => {
    const { el } = mountPile({ kind: 'search', cards: PILE, total: 4, onTake: vi.fn() });
    const input = el.querySelector<HTMLInputElement>('.hok-pv-filter')!;
    typeInto(input, 'card 1');
    expect(texts(el, '.hok-cap')).toEqual(['Card 1']);
    expect(el.textContent).toContain('1 of 4');
    typeInto(input, 'instant');
    expect(texts(el, '.hok-cap')).toEqual(['Card 1', 'Card 3']);
    typeInto(input, 'zzz');
    expect(el.querySelectorAll('.hok-pv-item').length).toBe(0);
    expect(el.querySelector('.hok-pv-empty')!.textContent).toBe('No cards match.');

    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      key(input, 'a');
      expect(outer).not.toHaveBeenCalled();
      key(input, 'Escape');
      expect(input.value).toBe('');
      expect(el.querySelectorAll('.hok-pv-item').length).toBe(4);
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('Close button and header × both call onClose', () => {
    const onClose = vi.fn();
    const { el } = mountPile({ onClose });
    click(el.querySelector('.hok-pv-close'));
    click(el.querySelector('.hok-pv-x'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows an empty message for an empty pile', () => {
    const { el } = mountPile({ kind: 'search', cards: [], total: 0 });
    expect(el.querySelector('.hok-pv-empty')!.textContent).toBe('The pile is empty.');
  });
});

// ---------------------------------------------------------------- MulliganChooser

function summary(id: string): CardSummary {
  return { id, card_print_id: `p-${id}`, name: `Card ${id.toUpperCase()}`, type_line: 'Creature', zone: 'hand', ownerId: 'me', faceDown: false, front_image_uri: `https://img.test/${id}.jpg` };
}
const HAND = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(summary);

function mountMull(over: Partial<MulliganChooserProps> = {}) {
  const props: MulliganChooserProps = { hand: HAND, bottom: 2, mulligans: 2, freeFirst: true, onConfirm: vi.fn(), ...over };
  return { el: mount(h(MulliganChooser, props)), props };
}

describe('MulliganChooser', () => {
  it('free first mulligan: message, Confirm enabled and labelled "Keep this hand", confirms with []', () => {
    const onConfirm = vi.fn();
    const { el } = mountMull({ bottom: 0, mulligans: 1, onConfirm });
    expect(el.querySelector('.hok-mc-rule')!.textContent).toBe('Mulligan 1 is free in Commander: keep all 7');
    const confirm = el.querySelector<HTMLButtonElement>('.hok-mc-confirm')!;
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toBe('Keep this hand');
    expect(el.querySelectorAll('.hok-mc-card').length).toBe(7);
    // Clicking a card does nothing when there is nothing to bottom.
    click(el.querySelectorAll('.hok-mc-card')[0]);
    expect(el.querySelector('.hok-mc-order')).toBeNull();
    click(confirm);
    expect(onConfirm).toHaveBeenCalledWith([]);
  });

  it('explains the rule with singular/plural cards', () => {
    const { el } = mountMull({ bottom: 1, mulligans: 2 });
    expect(el.querySelector('.hok-mc-rule')!.textContent).toBe('Mulligan 2: put 1 card on the bottom');
    const el2 = rerender(h(MulliganChooser, { hand: HAND, bottom: 3, mulligans: 4, freeFirst: true, onConfirm: vi.fn() }));
    expect(el2.querySelector('.hok-mc-rule')!.textContent).toBe('Mulligan 4: put 3 cards on the bottom');
  });

  it('selecting exactly `bottom` cards enables Confirm and passes ids in click order', () => {
    const onConfirm = vi.fn();
    const { el } = mountMull({ bottom: 2, onConfirm });
    const cards = el.querySelectorAll<HTMLElement>('.hok-mc-card');
    const confirm = el.querySelector<HTMLButtonElement>('.hok-mc-confirm')!;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe('Put 2 on the bottom');
    expect(el.textContent).toContain('0 of 2 selected');

    click(cards[2]); // c
    expect(confirm.disabled).toBe(true);
    expect(cards[2]!.classList.contains('picked')).toBe(true);
    expect(cards[2]!.querySelector('.hok-mc-order')!.textContent).toBe('1');

    click(cards[0]); // a
    expect(confirm.disabled).toBe(false);
    expect(cards[0]!.querySelector('.hok-mc-order')!.textContent).toBe('2');
    expect(el.textContent).toContain('2 of 2 selected');

    click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(['c', 'a']);
  });

  it('cannot select more than `bottom`; deselecting renumbers the rest', () => {
    const { el } = mountMull({ bottom: 2 });
    const cards = el.querySelectorAll<HTMLElement>('.hok-mc-card');
    click(cards[0]);
    click(cards[1]);
    click(cards[2]); // ignored
    expect(el.querySelectorAll('.hok-mc-card.picked').length).toBe(2);
    expect(cards[2]!.classList.contains('picked')).toBe(false);
    expect(el.querySelector('.hok-mc-grid')!.classList.contains('hok-mc-grid--full')).toBe(true);

    click(cards[0]); // deselect a -> b becomes #1
    expect(el.querySelectorAll('.hok-mc-card.picked').length).toBe(1);
    expect(cards[1]!.querySelector('.hok-mc-order')!.textContent).toBe('1');
    expect(el.querySelector<HTMLButtonElement>('.hok-mc-confirm')!.disabled).toBe(true);

    click(cards[2]); // now allowed
    expect(texts(el, '.hok-mc-order')).toEqual(['1', '2']);
  });

  it('resets the selection when a new hand arrives', () => {
    const onConfirm = vi.fn();
    const { el } = mountMull({ bottom: 1, onConfirm });
    click(el.querySelectorAll('.hok-mc-card')[0]);
    expect(el.querySelectorAll('.hok-mc-card.picked').length).toBe(1);
    const el2 = rerender(h(MulliganChooser, { hand: ['x', 'y', 'z'].map(summary), bottom: 1, mulligans: 3, freeFirst: true, onConfirm }));
    expect(el2.querySelectorAll('.hok-mc-card').length).toBe(3);
    expect(el2.querySelectorAll('.hok-mc-card.picked').length).toBe(0);
    expect(el2.querySelector<HTMLButtonElement>('.hok-mc-confirm')!.disabled).toBe(true);
  });

  it('shows "Mulligan again" only when given and calls it', () => {
    const { el } = mountMull();
    expect(el.querySelector('.hok-mc-again')).toBeNull();
    const onMulliganAgain = vi.fn();
    const el2 = rerender(h(MulliganChooser, { hand: HAND, bottom: 2, mulligans: 2, freeFirst: true, onConfirm: vi.fn(), onMulliganAgain }));
    click(el2.querySelector('.hok-mc-again'));
    expect(onMulliganAgain).toHaveBeenCalledTimes(1);
  });

  it('busy disables Confirm, Mulligan again and card selection', () => {
    const onConfirm = vi.fn();
    const onMulliganAgain = vi.fn();
    const { el } = mountMull({ bottom: 0, mulligans: 1, onConfirm, onMulliganAgain, busy: true });
    const confirm = el.querySelector<HTMLButtonElement>('.hok-mc-confirm')!;
    const again = el.querySelector<HTMLButtonElement>('.hok-mc-again')!;
    expect(confirm.disabled).toBe(true);
    expect(again.disabled).toBe(true);

    const el2 = rerender(h(MulliganChooser, { hand: HAND, bottom: 2, mulligans: 2, freeFirst: true, onConfirm, onMulliganAgain, busy: true }));
    click(el2.querySelectorAll('.hok-mc-card')[0]);
    expect(el2.querySelectorAll('.hok-mc-card.picked').length).toBe(0);
    expect(el2.querySelector<HTMLButtonElement>('.hok-mc-confirm')!.disabled).toBe(true);
  });
});
