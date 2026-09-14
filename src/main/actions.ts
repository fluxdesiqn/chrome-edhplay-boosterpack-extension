/**
 * Paced sender for the extension's own raw actions. Every action is logged to
 * a ledger so the user can audit what was sent on their behalf.
 */
import type { OutboundAction } from '@shared/protocol';
import type { LedgerEntry } from '@shared/state';

export interface RawSender {
  sendRaw(msg: Record<string, unknown>): Promise<void>;
}

const GAP_DEFAULT = 150;
const GAP_BY_TYPE: Record<string, number> = {
  exile_x_cards: 850,
  draw_x_cards: 850,
  view_library: 550,
  shuffle_library: 2100,
  send_chat_message: 550,
  resync: 3100,
};

export class ActionSender {
  private lastAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly entries: LedgerEntry[] = [];
  onLedger: ((entries: LedgerEntry[]) => void) | null = null;

  constructor(
    private readonly tap: RawSender,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  send(action: OutboundAction, summary?: string): Promise<void> {
    const type = action.type;
    const gap = GAP_BY_TYPE[type] ?? GAP_DEFAULT;
    const run = async () => {
      const wait = this.lastAt + gap - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now();
      this.log(type, summary ?? describe(action));
      await this.tap.sendRaw(action as unknown as Record<string, unknown>);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Record an action that was written to the socket by another path (e.g. an outbound replace). */
  note(action: string, summary: string): void {
    this.log(action, summary);
  }

  ledger(): LedgerEntry[] {
    return [...this.entries];
  }

  private log(action: string, summary: string): void {
    this.entries.push({ at: this.now(), action, summary });
    if (this.entries.length > 200) this.entries.splice(0, this.entries.length - 200);
    this.onLedger?.(this.ledger());
  }
}

function describe(a: OutboundAction): string {
  switch (a.type) {
    case 'move_card':
      return `move ${a.id.slice(0, 8)} → ${a.zone}`;
    case 'batch_move_cards':
      return `move ${a.items.length} cards → ${a.items[0]?.zone ?? '?'}`;
    case 'view_library':
      return `view library (${a.location})`;
    case 'reorder_viewed_cards':
      return `reorder ${a.card_ids.length} viewed cards`;
    case 'exile_x_cards':
      return `exile top ${a.count}${a.face_down ? ' face down' : ''}`;
    case 'draw_x_cards':
      return `draw ${a.count}`;
    case 'send_chat_message':
      return `chat ${a.message.slice(0, 40)}`;
    default:
      return a.type;
  }
}
