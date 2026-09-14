import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { OfferCard } from '@shared/bridge-contract';
import { PACK_KIND_NAMES, type PackKind, type SetCode, packLabel, setName } from '@shared/packs/types';

export interface PackRevealProps {
  /** "you" when isOwner */
  ownerName: string;
  isOwner: boolean;
  set: SetCode;
  kind: PackKind;
  /** 1-based ordinal for this owner */
  packNumber: number;
  /** 12 or 15, in slot order */
  cards: OfferCard[];
  /** indices of foil cards */
  foil: number[];
  phase: 'opening' | 'revealed' | 'shuffling' | 'closed';
  /** owner only: "Shuffle into booster pile" */
  onShuffle?: () => void;
  /** peers (and owner after shuffling) can dismiss */
  onClose?: () => void;
  /** skip animations (prefers-reduced-motion is honoured as well) */
  reducedMotion?: boolean;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Accepts Scryfall-style ("mythic") and short ("m") rarities; common has no modifier. */
function rarityClass(rarity: string | undefined): string {
  const k = (rarity ?? '').charAt(0).toLowerCase();
  return k === 'u' || k === 'r' || k === 'm' ? ` hok-reveal-dot--${k}` : '';
}

/**
 * Full-screen pack-opening overlay. The parent drives `phase`; this component only
 * animates the transitions (wrapper tear, staggered flips, gather + shuffle cuts).
 */
export function PackReveal(props: PackRevealProps): JSX.Element | null {
  const { ownerName, isOwner, set, kind, packNumber, cards, foil, phase, onShuffle, onClose, reducedMotion } = props;
  const isStatic = !!reducedMotion || prefersReducedMotion();
  const canClose = !!onClose && (!isOwner || phase === 'shuffling');
  const gridRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const prevPhase = useRef(phase);
  const [flipIn, setFlipIn] = useState(false);

  // Flip the cards in only when we actually watched the wrapper tear open.
  useEffect(() => {
    if (prevPhase.current === 'opening' && phase === 'revealed') setFlipIn(true);
    prevPhase.current = phase;
  }, [phase]);

  // Gather: measure each card's offset to the grid centre so the CSS keyframes can translate it there.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (phase !== 'shuffling' || isStatic || !grid) return;
    const g = grid.getBoundingClientRect();
    const cx = g.left + g.width / 2;
    const cy = g.top + g.height / 2;
    grid.querySelectorAll<HTMLElement>('.hok-reveal-card').forEach((el) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--hok-dx', `${cx - (r.left + r.width / 2)}px`);
      el.style.setProperty('--hok-dy', `${cy - (r.top + r.height / 2)}px`);
    });
  }, [phase, isStatic]);

  // Keyboard: focus the primary button when it appears.
  useEffect(() => {
    btnRef.current?.focus();
  }, [phase, isOwner]);

  useEffect(() => {
    if (!canClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canClose, onClose]);

  if (phase === 'closed') return null;

  const label = packLabel(set, kind);
  const title = `${ownerName} opened a ${label}`;
  const foilSet = new Set(foil);
  const cls = ['hok-reveal', `hok-reveal--${phase}`, `hok-reveal--${set}`, `hok-reveal--${kind}`, isStatic ? 'hok-reveal--static' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div class={cls} role="dialog" aria-modal="true" aria-label={title}>
      <div class="hok-reveal-head">
        <h2 class="hok-reveal-title">{title}</h2>
        <span class="hok-reveal-pill">Pack #{packNumber}</span>
        {isOwner && phase === 'revealed' && (
          <p class="hok-reveal-sub">These cards are shuffled into your booster pile. Everyone with the extension sees this reveal.</p>
        )}
      </div>

      {phase === 'opening' ? (
        <div class="hok-reveal-wrapper" aria-hidden="true">
          <div class="hok-reveal-tear" />
          <div class="hok-reveal-wrapper-body">
            <span>{setName(set)}</span>
            <span class="hok-reveal-kind">{PACK_KIND_NAMES[kind]}</span>
          </div>
        </div>
      ) : (
        <div class="hok-reveal-grid" ref={gridRef}>
          {cards.length === 0 && <div class="hok-reveal-empty">No cards in this pack.</div>}
          {cards.map((c, i) => (
            <RevealCard key={`${c.ref}#${i}`} card={c} index={i} foil={foilSet.has(i)} flip={flipIn && !isStatic} />
          ))}
        </div>
      )}

      <div class="hok-reveal-foot">
        {phase === 'shuffling' && <div class="hok-reveal-status" role="status">Shuffling into the booster pile…</div>}
        {phase === 'revealed' && isOwner && (
          <button ref={btnRef} class="hok-reveal-btn" onClick={() => onShuffle?.()}>
            Shuffle into booster pile
          </button>
        )}
        {phase === 'revealed' && !isOwner && (
          <>
            <button ref={btnRef} class="hok-reveal-btn hok-reveal-btn--secondary" onClick={() => onClose?.()}>
              Close
            </button>
            <div class="hok-reveal-muted">Waiting for {ownerName} to shuffle…</div>
          </>
        )}
      </div>
    </div>
  );
}

function RevealCard({ card, index, foil, flip }: { card: OfferCard; index: number; foil: boolean; flip: boolean }) {
  const id = card.identity;
  // Deterministic rotation jitter (-5..5 deg) used by the gather animation.
  const rot = ((index * 37) % 11) - 5;
  const cls = `hok-reveal-card${foil ? ' hok-reveal-card--foil' : ''}${flip ? ' hok-reveal-card--flip' : ''}`;
  return (
    <div class={cls} style={{ '--hok-i': index, '--hok-rot': `${rot}deg` }} title={id.type_line}>
      <div class="hok-reveal-flip">
        <div class="hok-reveal-back" aria-hidden="true" />
        <div class="hok-reveal-face">
          <img src={id.front_image_uri} alt={id.name} loading="eager" />
          {foil && <span class="hok-reveal-sheen" aria-hidden="true" />}
          {foil && <span class="hok-reveal-tag">FOIL</span>}
        </div>
      </div>
      <div class="hok-reveal-cap">
        <i class={`hok-reveal-dot${rarityClass(id.rarity)}`} aria-hidden="true" />
        <span>{id.name}</span>
      </div>
    </div>
  );
}
