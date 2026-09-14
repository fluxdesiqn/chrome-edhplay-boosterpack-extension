import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { CardSummary } from '@shared/state';

export interface MulliganChooserProps {
  /** the freshly drawn hand */
  hand: CardSummary[];
  /** how many must go to the bottom (0..hand.length) */
  bottom: number;
  /** this mulligan's ordinal (1-based) */
  mulligans: number;
  freeFirst: boolean;
  /** exactly `bottom` ids, in the order they will be placed (first = placed first) */
  onConfirm: (ids: string[]) => void;
  /** take another mulligan instead of keeping this hand */
  onMulliganAgain?: () => void;
  busy?: boolean;
}

function ruleLine(p: MulliganChooserProps): string {
  const { bottom, mulligans, freeFirst, hand } = p;
  if (bottom === 0) {
    return freeFirst && mulligans === 1 ? `Mulligan 1 is free in Commander: keep all ${hand.length}` : `Mulligan ${mulligans}: keep all ${hand.length}`;
  }
  return `Mulligan ${mulligans}: put ${bottom} card${bottom === 1 ? '' : 's'} on the bottom`;
}

/** London mulligan: pick which cards go to the bottom of the library, in order. */
export function MulliganChooser(props: MulliganChooserProps): JSX.Element {
  const { hand, bottom, mulligans, onConfirm, onMulliganAgain, busy } = props;
  const [order, setOrder] = useState<string[]>([]);
  const handKey = hand.map((c) => c.id).join(',');
  useEffect(() => setOrder([]), [handKey, bottom, mulligans]);

  const full = order.length >= bottom;
  const ready = order.length === bottom;

  const toggle = (id: string) => {
    if (busy) return;
    setOrder((o) => (o.includes(id) ? o.filter((x) => x !== id) : o.length < bottom ? [...o, id] : o));
  };

  return (
    <div class="hok-section hok-mc">
      <p class="hok-h">Mulligan</p>
      <div class="hok-note hok-mc-rule">{ruleLine(props)}</div>
      {bottom > 0 && (
        <div class="hok-muted hok-mc-count">
          {order.length} of {bottom} selected{order.length > 0 ? ' · numbers show bottom order' : ''}
        </div>
      )}
      <div class={`hok-cards hok-mc-grid ${full && bottom > 0 ? 'hok-mc-grid--full' : ''}`}>
        {hand.map((c) => {
          const pos = order.indexOf(c.id);
          const picked = pos >= 0;
          return (
            <div
              class={`hok-card hok-mc-card ${picked ? 'picked' : ''} ${bottom === 0 ? 'hok-mc-card--static' : ''}`}
              key={c.id}
              role={bottom > 0 ? 'button' : undefined}
              aria-pressed={bottom > 0 ? picked : undefined}
              aria-disabled={busy || undefined}
              title={c.type_line}
              onClick={bottom > 0 ? () => toggle(c.id) : undefined}
            >
              <img src={c.front_image_uri} alt={c.name} loading="eager" />
              {picked && <span class="hok-tag hok-mc-order">{pos + 1}</span>}
              <div class="hok-cap">{c.name}</div>
            </div>
          );
        })}
      </div>
      <div class="hok-mc-actions">
        <button type="button" class="hok-btn block hok-mc-confirm" disabled={!!busy || !ready} onClick={() => onConfirm(order.slice(0, bottom))}>
          {bottom === 0 ? 'Keep this hand' : `Put ${bottom} on the bottom`}
        </button>
        {onMulliganAgain && (
          <button type="button" class="hok-btn secondary block sm hok-mc-again" disabled={!!busy} onClick={onMulliganAgain}>
            Mulligan again
          </button>
        )}
      </div>
    </div>
  );
}
