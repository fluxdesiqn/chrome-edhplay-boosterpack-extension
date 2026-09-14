import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { OfferCard } from '@shared/bridge-contract';
import type { CardRef } from '@shared/packs/types';

export type PileZone = 'hand' | 'graveyard';

export interface PileViewProps {
  kind: 'peek' | 'search';
  /** peek: top N in order (index 0 = top); search: whole pile in order */
  cards: OfferCard[];
  /** pile size */
  total: number;
  /** search only */
  onTake?: (ref: CardRef, zone: PileZone) => void;
  onClose: () => void;
  title?: string;
}

/** Second-deck mode: peek at the top of the booster pile, or search the whole pile and take a card. */
export function PileView(props: PileViewProps): JSX.Element {
  const { kind, cards, total, onTake, onClose, title } = props;
  const isSearch = kind === 'search';
  const [filter, setFilter] = useState('');
  useEffect(() => setFilter(''), [kind]);

  const heading = title ?? (isSearch ? `Booster pile (${total} cards)` : `Top ${cards.length} of your booster pile`);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const indexed = cards.map((c, i) => ({ c, i }));
    if (!isSearch || !q) return indexed;
    return indexed.filter(({ c }) => c.identity.name.toLowerCase().includes(q) || c.identity.type_line.toLowerCase().includes(q));
  }, [cards, filter, isSearch]);

  return (
    <div class={`hok-section hok-pv hok-pv--${kind}`}>
      <div class="hok-pv-head">
        <p class="hok-h hok-pv-title">{heading}</p>
        <button type="button" class="hok-iconbtn hok-pv-x" title="Close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {isSearch && (
        <input
          class="hok-input hok-pv-filter"
          type="search"
          placeholder="Filter by name or type…"
          value={filter}
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setFilter(''); } }}
          onKeyUp={(e) => e.stopPropagation()}
        />
      )}
      {!isSearch && cards.length < total && <div class="hok-muted hok-pv-sub">{total - cards.length} more below</div>}
      <div class="hok-pv-scroll">
        <div class="hok-cards hok-pv-grid">
          {visible.map(({ c, i }) => (
            <div class="hok-pv-item" key={c.ref}>
              <div class="hok-card hok-pv-card" title={c.identity.type_line}>
                <img src={c.identity.front_image_uri} alt={c.identity.name} loading="lazy" />
                {!isSearch && <span class="hok-tag hok-pv-pos">#{i + 1}</span>}
                <div class="hok-cap">{c.identity.name}</div>
              </div>
              {isSearch && (
                <div class="hok-pv-actions">
                  <button type="button" class="hok-btn sm hok-pv-take" disabled={!onTake} onClick={() => onTake?.(c.ref, 'hand')}>To hand</button>
                  <button type="button" class="hok-btn secondary sm hok-pv-take" disabled={!onTake} onClick={() => onTake?.(c.ref, 'graveyard')}>To graveyard</button>
                </div>
              )}
            </div>
          ))}
        </div>
        {visible.length === 0 && (
          <div class="hok-muted hok-pv-empty">{cards.length === 0 ? 'The pile is empty.' : 'No cards match.'}</div>
        )}
      </div>
      <div class="hok-pv-foot">
        {isSearch && filter.trim() !== '' && <span class="hok-muted">{visible.length} of {cards.length}</span>}
        <button type="button" class="hok-btn secondary sm hok-pv-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
