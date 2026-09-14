import type { IsoToMain } from '@shared/bridge-contract';
import { PackReveal } from './panels/PackReveal';
import { closeReveal, reveal } from './machine';

/** Binds the reveal signal to the overlay component. */
export function RevealHost({ send }: { send: (m: IsoToMain) => void }) {
  const r = reveal.value;
  if (!r) return null;
  return (
    <PackReveal
      ownerName={r.ownerName}
      isOwner={r.isOwner}
      set={r.pack.set}
      kind={r.pack.kind}
      packNumber={r.pack.n}
      cards={r.cards}
      foil={r.pack.foil}
      phase={r.phase}
      onShuffle={r.isOwner && r.phase === 'revealed' ? () => send({ type: 'cmd', cmd: 'shuffle-in' }) : undefined}
      onClose={!r.isOwner || r.phase === 'shuffling' ? () => closeReveal() : undefined}
    />
  );
}
