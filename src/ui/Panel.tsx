import { useEffect, useRef, useState } from 'preact/hooks';
import type { IsoToMain } from '@shared/bridge-contract';
import { SET_CODES, packLabel, setName, type PackKind, type SetCode } from '@shared/packs/types';
import { config, diags, ledger, mulliganChoose, needsReload, offer, peers, phase, pileView, readOnly, requestSetList, screen, seq, setList, setListError, setListLoader, socket, state, zones } from './machine';
import { SetPicker } from './panels/SetPicker';
import { PileView } from './panels/PileView';
import { MulliganChooser } from './panels/MulliganChooser';

export interface PanelProps {
  send: (msg: IsoToMain) => void;
  onConfig: (patch: Partial<typeof config.value>) => void;
  onExportRecord: () => void;
}

type Tab = 'game' | 'peers' | 'diag';

export function Panel({ send, onConfig, onExportRecord }: PanelProps) {
  const [tab, setTab] = useState<Tab>('game');
  const collapsed = config.value.panelCollapsed;
  const rootRef = useRef<HTMLDivElement>(null);
  useDrag(rootRef);

  if (collapsed) {
    return (
      <div class="hok-root collapsed" ref={rootRef}>
        <div class="hok-header hok-pill" onDblClick={() => onConfig({ panelCollapsed: false })}>
          <span class="hok-title">HoK</span>
          <StatusBadge />
          <button class="hok-iconbtn" title="Expand" onClick={() => onConfig({ panelCollapsed: false })}>▢</button>
        </div>
      </div>
    );
  }

  return (
    <div class="hok-root" ref={rootRef}>
      <div class="hok-header">
        <span class="hok-title">Heroes of Kamigawa</span>
        <StatusBadge />
        <button class="hok-iconbtn" title="Collapse" onClick={() => onConfig({ panelCollapsed: true })}>–</button>
      </div>
      <div class="hok-tabs">
        {(['game', 'peers', 'diag'] as Tab[]).map((t) => (
          <button class={`hok-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'game' ? 'Game' : t === 'peers' ? `Peers (${peers.value.length})` : 'Diagnostics'}
          </button>
        ))}
      </div>
      <div class="hok-body">
        {tab === 'game' && <GameTab send={send} onConfig={onConfig} />}
        {tab === 'peers' && <PeersTab send={send} />}
        {tab === 'diag' && <DiagTab send={send} onExportRecord={onExportRecord} />}
      </div>
    </div>
  );
}

function StatusBadge() {
  const sc = screen.value;
  const cls = sc === 'ready' || sc === 'activate' ? 'ok' : sc === 'disabled' ? 'err' : sc === 'waiting' ? '' : 'warn';
  const label =
    sc === 'ready' ? 'ready' : sc === 'activate' ? 'activating' : sc === 'sweep' ? 'sweep' : sc === 'deck-check' ? 'deck check' : sc === 'waiting' ? 'waiting' : 'off';
  return <span class={`hok-badge ${cls}`}>{label}</span>;
}

function PhaseLine() {
  const p = phase.value;
  if (p.isSpectator) return <div class="hok-muted">Spectating</div>;
  if (p.mulliganActive) return <div class="hok-muted">Mulligan phase · hand {p.handCount} · library {p.libraryCount}</div>;
  return (
    <div class="hok-muted">
      {p.isMyTurn ? 'Your turn' : 'Not your turn'}
      {p.phase ? ` · ${p.phase.replace('_', ' ')}` : ''} · hand {p.handCount} · library {p.libraryCount}
    </div>
  );
}

function GameTab({ send, onConfig }: { send: (m: IsoToMain) => void; onConfig: PanelProps['onConfig'] }) {
  const sc = screen.value;
  const st = state.value;
  const sk = socket.value;

  if (needsReload.value) {
    return (
      <div>
        <div class="hok-note err">The game connected before the extension loaded. Reload the page to enable it.</div>
        <button class="hok-btn block" onClick={() => location.reload()}>Reload page</button>
      </div>
    );
  }
  if (sc === 'waiting') return <div class="hok-muted">Waiting for a game connection…</div>;
  if (sc === 'disabled') {
    return (
      <div class="hok-note warn">
        {sk?.ev === 'unsupported'
          ? `This game uses protocol version ${sk.ctx.pv}; the extension supports version 4. Nothing will be sent or rewritten.`
          : sk?.ctx.spectator
            ? 'Spectating: mapped cards are shown, nothing is sent.'
            : readOnly.value
              ? 'Another tab is driving this room. This tab only displays.'
              : 'Disabled.'}
      </div>
    );
  }

  const pv = pileView.value;
  const mc = mulliganChoose.value;
  if (mc) {
    return (
      <div>
        <PhaseLine />
        <MulliganChooser
          hand={mc.hand}
          bottom={mc.bottom}
          mulligans={mc.mulligans}
          freeFirst={config.value.freeFirstMulligan}
          busy={seq.value?.seq === 'mulligan' && !seq.value.done && !seq.value.error}
          onConfirm={(ids) => {
            mulliganChoose.value = null;
            send({ type: 'cmd', cmd: 'mulligan-bottom', ids });
          }}
          onMulliganAgain={() => {
            mulliganChoose.value = null;
            send({ type: 'cmd', cmd: 'mulligan' });
          }}
        />
      </div>
    );
  }
  if (pv) {
    return (
      <PileView
        kind={pv.kind}
        cards={pv.cards}
        total={pv.total}
        onTake={pv.kind === 'search' ? (ref, zone) => { pileView.value = null; send({ type: 'cmd', cmd: 'pile-take', ref, zone }); } : undefined}
        onClose={() => { pileView.value = null; send({ type: 'cmd', cmd: 'pile-view-close' }); }}
      />
    );
  }

  return (
    <div>
      <PhaseLine />
      {sc === 'deck-check' && <DeckCheck send={send} onConfig={onConfig} />}
      {sc === 'sweep' && <Sweep send={send} onConfig={onConfig} />}
      {sc === 'ready' && st && <Ready send={send} st={st} />}
      {sc === 'activate' && st && <Activate send={send} />}
    </div>
  );
}

function DeckCheck({ send, onConfig }: { send: (m: IsoToMain) => void; onConfig: PanelProps['onConfig'] }) {
  const st = state.value;
  const p = phase.value;
  const reason = st?.sweep.reason ?? st?.sweep.error;
  const basics = countBasicsInHand();
  return (
    <div class="hok-section">
      <p class="hok-h">Deck check</p>
      {!p.deckSubmitted && <div class="hok-note">Submit your deck first. It must contain {config.value.minBlankCopies} copies of one basic land (Wastes by default) and the room must be Free Commander.</div>}
      {p.deckSubmitted && p.mulliganActive && !p.decisionMade && (
        <div class="hok-note">
          <b>Keep your opening hand in edhplay first</b> (do not mulligan there; edhplay blocks library actions until you decide). The sweep {config.value.autoSweep ? 'starts automatically' : 'can run'} right after your keep, and you can mulligan from this panel afterwards with Commander rules.
          {basics > 0 && <div>Blanks in your hand now: {basics}. They are swept away and replaced.</div>}
        </div>
      )}
      {p.deckSubmitted && (p.decisionMade || !p.mulliganActive) && (
        <div class="hok-note warn">
          {reason ?? 'Placeholder not detected yet. The sweep will scan your library when you start it.'}
        </div>
      )}
      <div class="hok-row">
        <span class="hok-muted">Placeholder</span>
        <span>{st?.placeholderName ?? config.value.preferredPlaceholderName}</span>
      </div>
      <button class="hok-btn block" disabled={!p.deckSubmitted || (p.mulliganActive && !p.decisionMade)} onClick={() => send({ type: 'cmd', cmd: 'sweep' })}>
        Scan library and sweep blanks
      </button>
      <label class="hok-check">
        <input type="checkbox" checked={config.value.autoSweep} onChange={(e) => onConfig({ autoSweep: (e.target as HTMLInputElement).checked })} />
        Sweep automatically after I keep my hand
      </label>
    </div>
  );
}

function countBasicsInHand(): number {
  const z = zones.value;
  if (!z || !z.localPlayerId) return 0;
  return z.cards.filter((c) => c.ownerId === z.localPlayerId && c.zone === 'hand' && c.type_line.startsWith('Basic Land')).length;
}

function Sweep({ send, onConfig }: { send: (m: IsoToMain) => void; onConfig: PanelProps['onConfig'] }) {
  const st = state.value!;
  const s = seq.value;
  const p = phase.value;
  const running = st.sweep.phase === 'running';
  return (
    <div class="hok-section">
      <p class="hok-h">Sweep blanks</p>
      <div class="hok-note">
        Moves every {st.placeholderName ?? 'placeholder'} out of your library and hand into a face-down exile pile, then refills your hand. Runs after you keep in edhplay; mulligan from this panel afterwards.
      </div>
      {p.mulliganActive && !p.decisionMade && <div class="hok-note warn">Keep your hand in edhplay first. edhplay blocks library actions until your mulligan decision is made.</div>}
      {running && s?.seq === 'sweep' && (
        <div>
          <div class="hok-muted">{s.step}</div>
          <div class="hok-progress"><div style={{ width: `${Math.round(s.pct * 100)}%` }} /></div>
        </div>
      )}
      {st.sweep.error && <div class="hok-note err">{st.sweep.error}</div>}
      <div class="hok-row">
        <button class="hok-btn" disabled={running || (p.mulliganActive && !p.decisionMade)} onClick={() => send({ type: 'cmd', cmd: 'sweep' })}>
          {st.sweep.phase === 'failed' ? 'Retry sweep' : 'Sweep now'}
        </button>
        {running && <button class="hok-btn secondary sm" onClick={() => send({ type: 'cmd', cmd: 'cancel' })}>Cancel</button>}
      </div>
      <label class="hok-check">
        <input type="checkbox" checked={config.value.autoSweep} onChange={(e) => onConfig({ autoSweep: (e.target as HTMLInputElement).checked })} />
        Sweep automatically after I keep my hand
      </label>
    </div>
  );
}

function Ready({ send, st }: { send: (m: IsoToMain) => void; st: NonNullable<typeof state.value> }) {
  const p = phase.value;
  const deck = st.mode === 'deck';
  const [peek, setPeek] = useState(3);
  const kamiInGy = (zones.value?.cards ?? []).filter(
    (c) => c.ownerId === st.playerId && c.zone === 'graveyard' && st.mappings[c.id] && /Creature/.test(c.type_line),
  );
  return (
    <div>
      <div class="hok-section">
        <div class="hok-row">
          <span class="hok-muted">Mode</span>
          <span>
            <button class={`hok-pillbtn ${st.mode === 'heroes' ? 'selected' : ''}`} title="Heroes of Kamigawa: +2 looks at four, keeps two" onClick={() => send({ type: 'cmd', cmd: 'set-mode', mode: st.modeForced && st.mode === 'heroes' ? 'auto' : 'heroes' })}>Heroes</button>{' '}
            <button class={`hok-pillbtn ${st.mode === 'deck' ? 'selected' : ''}`} title="Booster pile as a hidden second deck" onClick={() => send({ type: 'cmd', cmd: 'set-mode', mode: st.modeForced && st.mode === 'deck' ? 'auto' : 'deck' })}>Second deck</button>
          </span>
        </div>
        <div class="hok-row"><span class="hok-muted">Booster pile</span><b>{st.pile.length} cards</b></div>
        <div class="hok-row"><span class="hok-muted">Blanks left</span><b>{st.reservoir.length}</b></div>
        <div class="hok-row"><span class="hok-muted">Packs opened</span><b>{st.packs.length}</b></div>
        {!deck && <div class="hok-row"><span class="hok-muted">+2 activations</span><b>{st.activationCount}</b></div>}
      </div>

      <MulliganSection send={send} st={st} />

      {!deck && (
        <div class="hok-section">
          {!p.isMyTurn && !p.mulliganActive && <div class="hok-note warn">Not your turn. Planeswalker abilities are sorcery speed; activate during your main phase.</div>}
          <button class="hok-btn block" disabled={st.reservoir.length === 0 && st.pile.length === 0} onClick={() => send({ type: 'cmd', cmd: 'begin' })}>
            +2: Choose a pack to open
          </button>
          <div style={{ height: 6 }} />
          <button class="hok-btn secondary block sm" disabled={st.pile.length === 0} onClick={() => send({ type: 'cmd', cmd: 'activate', set: null })}>
            +2 without opening a pack (look at four)
          </button>
        </div>
      )}

      {deck && (
        <div class="hok-section">
          <p class="hok-h">Second deck</p>
          <button class="hok-btn block" onClick={() => send({ type: 'cmd', cmd: 'begin' })}>Open a pack into the pile</button>
          <div style={{ height: 6 }} />
          <div class="hok-row">
            <button class="hok-btn secondary sm" disabled={st.pile.length === 0 || st.reservoir.length === 0} onClick={() => send({ type: 'cmd', cmd: 'pile-draw', count: 1 })}>Draw top card</button>
            <button class="hok-btn secondary sm" disabled={st.pile.length === 0 || st.reservoir.length === 0} onClick={() => send({ type: 'cmd', cmd: 'pile-mill', count: 1 })}>Mill top card</button>
          </div>
          <div style={{ height: 6 }} />
          <div class="hok-row">
            <span>
              <button class="hok-btn secondary sm" disabled={st.pile.length === 0} onClick={() => send({ type: 'cmd', cmd: 'pile-peek', count: peek })}>Look at top</button>{' '}
              <input class="hok-input" style={{ width: 44 }} type="number" min={1} max={Math.max(1, st.pile.length)} value={peek} onInput={(e) => setPeek(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
            </span>
            <button class="hok-btn secondary sm" disabled={st.pile.length === 0} onClick={() => send({ type: 'cmd', cmd: 'pile-search' })}>Search pile</button>
          </div>
          <div style={{ height: 6 }} />
          <button class="hok-btn secondary block sm" disabled={st.pile.length < 2} onClick={() => send({ type: 'cmd', cmd: 'pile-shuffle' })}>Shuffle pile</button>
          <div class="hok-muted" style={{ marginTop: 6 }}>Other players see the pile size, and each card the moment it becomes public.</div>
        </div>
      )}

      {kamiInGy.length > 0 && (
        <div class="hok-section">
          <p class="hok-h">{deck ? 'Pile creatures in graveyard' : '−3 targets in graveyard'}</p>
          <ul class="hok-list">
            {kamiInGy.map((c) => (
              <li><span>{c.name}</span><span class="hok-muted">drag to battlefield</span></li>
            ))}
          </ul>
        </div>
      )}
      <div class="hok-section">
        <div class="hok-row">
          <button class="hok-btn secondary sm" onClick={() => send({ type: 'cmd', cmd: 'rebroadcast' })}>Re-send mappings</button>
          <button class="hok-btn secondary sm" onClick={() => send({ type: 'cmd', cmd: 'sweep' })}>Sweep stragglers</button>
        </div>
      </div>
    </div>
  );
}

function MulliganSection({ send, st }: { send: (m: IsoToMain) => void; st: NonNullable<typeof state.value> }) {
  const s = seq.value;
  const p = phase.value;
  const running = s?.seq === 'mulligan' && !s.done && !s.error;
  const next = st.mulligans + 1;
  const bottom = config.value.freeFirstMulligan ? Math.max(0, next - 1) : next;
  if (p.turnSeq > 1 && st.mulligans === 0 && !p.mulliganActive) return null; // game underway, no point offering
  return (
    <div class="hok-section">
      <p class="hok-h">Mulligan (Commander rules)</p>
      <div class="hok-muted">
        {st.mulligans === 0 ? 'Not happy with your hand? ' : `Mulligans taken: ${st.mulligans}. `}
        Next mulligan: draw {config.value.handSize}{bottom > 0 ? `, then put ${bottom} on the bottom` : ' (free)'}.
      </div>
      {running && <div class="hok-muted">{s?.step}</div>}
      {s?.seq === 'mulligan' && s.error && <div class="hok-note err">{s.error}</div>}
      <button class="hok-btn secondary block sm" disabled={running} onClick={() => send({ type: 'cmd', cmd: 'mulligan' })}>
        Mulligan {next}
      </button>
    </div>
  );
}

function Activate({ send }: { send: (m: IsoToMain) => void }) {
  const st = state.value!;
  const a = st.activation!;
  const o = offer.value;
  const s = seq.value;
  const [picked, setPicked] = useState<number[]>([]);
  useEffect(() => setPicked([]), [a.phase, a.look.join(',')]);

  if (a.phase === 'choose-pack') {
    return <ChoosePack send={send} />;
  }

  if (a.phase === 'rolled' && a.pack) {
    return (
      <div class="hok-section">
        <p class="hok-h">Pack {a.pack.n} opened: {packLabel(a.pack.set, a.pack.kind)}</p>
        <div class="hok-note">Everyone with the extension is looking at the {a.pack.cards.length} cards. When you are ready, shuffle them into your booster pile.</div>
        <button class="hok-btn block" onClick={() => send({ type: 'cmd', cmd: 'shuffle-in' })}>Shuffle into booster pile</button>
        <div style={{ height: 6 }} />
        <button class="hok-btn danger block sm" onClick={() => send({ type: 'cmd', cmd: 'cancel' })}>Cancel (put the pack back)</button>
      </div>
    );
  }

  if (a.phase === 'viewing') {
    const need = Math.min(2, a.look.length);
    const short = st.reservoir.length < a.look.length;
    const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : p.length < need ? [...p, i] : p));
    return (
      <div class="hok-section">
        <p class="hok-h">
          {a.pack ? `Pack ${a.pack.n} (${setName(a.pack.set)}) shuffled in. ` : ''}Top {a.look.length} of your booster pile — pick {need} for your hand
        </p>
        {short && (
          <div class="hok-note err">
            Only {st.reservoir.length} blanks left but {a.look.length} cards to place.
            <div class="hok-row" style={{ marginTop: 6 }}>
              <button class="hok-btn sm" onClick={() => send({ type: 'cmd', cmd: 'look-fewer' })}>Look at {st.reservoir.length} instead</button>
              <button class="hok-btn danger sm" onClick={() => send({ type: 'cmd', cmd: 'cancel' })}>Cancel</button>
            </div>
          </div>
        )}
        <div class="hok-cards">
          {(o?.offer ?? []).map((c, i) => (
            <div class={`hok-card ${picked.includes(i) ? 'picked' : ''}`} onClick={() => toggle(i)} title={c.identity.type_line}>
              <img src={c.identity.front_image_uri} alt={c.identity.name} loading="eager" />
              <span class="hok-tag">{picked.includes(i) ? 'hand' : 'graveyard'}</span>
              <div class="hok-cap">{c.identity.name}</div>
            </div>
          ))}
        </div>
        <div style={{ height: 8 }} />
        <button class="hok-btn block" disabled={picked.length !== need || short} onClick={() => send({ type: 'cmd', cmd: 'pick', toHand: picked })}>
          Put {need} in hand, {a.look.length - need} in graveyard
        </button>
        <div style={{ height: 6 }} />
        <button class="hok-btn danger block sm" onClick={() => send({ type: 'cmd', cmd: 'cancel' })}>Cancel activation</button>
      </div>
    );
  }

  if (a.phase === 'resolving') {
    const done = a.moves.filter((m) => m.done).length;
    return (
      <div class="hok-section">
        <p class="hok-h">{a.op === 'draw' ? 'Drawing from the booster pile' : a.op === 'mill' ? 'Milling from the booster pile' : a.op === 'search' ? 'Taking from the booster pile' : 'Resolving'}</p>
        <div class="hok-muted">{s?.step ?? 'Moving cards…'}</div>
        <div class="hok-progress"><div style={{ width: `${a.moves.length ? Math.round((done / a.moves.length) * 100) : 10}%` }} /></div>
        {s?.error && (
          <div class="hok-note err">
            {s.error}
            <div class="hok-row" style={{ marginTop: 6 }}>
              <button class="hok-btn sm" onClick={() => send({ type: 'cmd', cmd: 'pick', toHand: a.toHand })}>Retry moves</button>
              <button class="hok-btn secondary sm" onClick={() => send({ type: 'cmd', cmd: 'resync' })}>Resync</button>
            </div>
          </div>
        )}
        <ul class="hok-list hok-mono">
          {a.moves.map((m) => (
            <li><span>{m.ref} → {m.zone}</span><span>{m.done ? '✓' : m.sent ? '…' : '·'}</span></li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

function ChoosePack({ send }: { send: (m: IsoToMain) => void }) {
  const st = state.value!;
  const [set, setSet] = useState<SetCode>(config.value.defaultSet);
  const [kind, setKind] = useState<PackKind>('draft');
  useEffect(() => requestSetList(), []);
  const loading = seq.value?.seq === 'activate' && /Loading/.test(seq.value.step) && !seq.value.error;
  return (
    <div class="hok-section">
      <p class="hok-h">{st.mode === 'deck' ? 'Open a booster into your second deck' : 'Open up to one sealed booster'}</p>
      <SetPicker
        sets={setList.value}
        recent={config.value.recentSets}
        value={set}
        kind={kind}
        onChange={(s2, k) => { setSet(s2); setKind(k); }}
        onRefresh={() => { setList.value = null; setListLoader.load?.(); }}
        error={setListError.value}
      />
      {st.mode === 'heroes' && !SET_CODES.includes(set as never) && (
        <div class="hok-note warn">Heroes of Kamigawa says "Kamigawa booster pack". Opening {setName(set)} is a house rule; make sure your pod agrees.</div>
      )}
      {seq.value?.seq === 'activate' && seq.value.error && <div class="hok-note err">{seq.value.error}</div>}
      <div style={{ height: 8 }} />
      <button class="hok-btn block" disabled={loading} onClick={() => send({ type: 'cmd', cmd: 'activate', set, kind })}>
        {loading ? 'Loading card list…' : `Open ${packLabel(set, kind)}`}
      </button>
      {st.mode === 'heroes' && (
        <div>
          <div style={{ height: 6 }} />
          <button class="hok-btn secondary block sm" onClick={() => send({ type: 'cmd', cmd: 'activate', set: null })}>No pack, just look at the pile</button>
        </div>
      )}
      <div style={{ height: 6 }} />
      <button class="hok-btn danger block sm" onClick={() => send({ type: 'cmd', cmd: 'cancel' })}>Cancel</button>
    </div>
  );
}

function PeersTab({ send }: { send: (m: IsoToMain) => void }) {
  const z = zones.value;
  const known = new Map(peers.value.map((p) => [p.ownerId, p]));
  const players = z?.players ?? [];
  return (
    <div>
      <p class="hok-h">Players in room</p>
      <ul class="hok-list">
        {players.map((pl) => {
          const pv = known.get(pl.id);
          return (
            <li>
              <span>{pl.name || pl.id.slice(0, 8)}{pl.id === z?.localPlayerId ? ' (you)' : ''}</span>
              <span class={`hok-badge ${pv?.extVersion ? 'ok' : 'warn'}`}>
                {pv?.extVersion ? `ext ${pv.extVersion}${pv.dataVersionMismatch ? ' · data differs' : ''}` : 'no extension seen'}
              </span>
            </li>
          );
        })}
      </ul>
      <div style={{ height: 8 }} />
      <p class="hok-h">Known mappings</p>
      <ul class="hok-list hok-mono">
        {peers.value.map((p) => (
          <li><span>{(z?.players.find((x) => x.id === p.ownerId)?.name) ?? p.ownerId.slice(0, 8)}</span><span>{Object.keys(p.mappings).length} public · {p.packs.length} packs · pile {p.pileCount ?? '?'}</span></li>
        ))}
      </ul>
      <div style={{ height: 8 }} />
      <button class="hok-btn secondary sm" onClick={() => send({ type: 'cmd', cmd: 'rebroadcast' })}>Ask everyone to re-send</button>
    </div>
  );
}

function DiagTab({ send, onExportRecord }: { send: (m: IsoToMain) => void; onExportRecord: () => void }) {
  const sk = socket.value;
  const [rec, setRec] = useState(false);
  return (
    <div>
      <p class="hok-h">Connection</p>
      <div class="hok-mono">
        {sk ? `${sk.ev} · room ${sk.ctx.roomId.slice(0, 8)} · pv ${sk.ctx.pv} · ${sk.ctx.binaryOut ? 'binary' : 'text'}${sk.ctx.spectator ? ' · spectator' : ''}` : 'no socket'}
      </div>
      <div style={{ height: 8 }} />
      <p class="hok-h">Actions sent ({ledger.value.length})</p>
      <div class="hok-diag hok-mono">
        {ledger.value.slice(-40).reverse().map((e) => (
          <div>{new Date(e.at).toLocaleTimeString()} {e.action}: {e.summary}</div>
        ))}
      </div>
      <div style={{ height: 8 }} />
      <p class="hok-h">Log</p>
      <div class="hok-diag hok-mono">
        {diags.value.slice(-60).reverse().map((d) => (
          <div class={d.level}>{new Date(d.at).toLocaleTimeString()} {d.msg}</div>
        ))}
      </div>
      <div style={{ height: 8 }} />
      <div class="hok-row">
        <button class="hok-btn secondary sm" onClick={() => { setRec(!rec); send({ type: 'record', on: !rec }); }}>{rec ? 'Stop recording' : 'Record frames'}</button>
        <button class="hok-btn secondary sm" onClick={onExportRecord}>Export recording</button>
      </div>
      <div style={{ height: 6 }} />
      <div class="hok-row">
        <button class="hok-btn secondary sm" onClick={() => send({ type: 'cmd', cmd: 'resync' })}>Resync</button>
        <button class="hok-btn danger sm" onClick={() => { if (confirm('Forget this room\'s booster state?')) send({ type: 'cmd', cmd: 'reset' }); }}>Reset room state</button>
      </div>
    </div>
  );
}

/** Drag the panel by its header. */
function useDrag(ref: { current: HTMLDivElement | null }) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const header = el.querySelector('.hok-header') as HTMLElement | null;
    if (!header) return;
    let start: { x: number; y: number; right: number; bottom: number } | null = null;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom };
      header.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      el.style.right = `${Math.max(0, start.right - (e.clientX - start.x))}px`;
      el.style.bottom = `${Math.max(0, start.bottom - (e.clientY - start.y))}px`;
    };
    const up = () => { start = null; };
    header.addEventListener('pointerdown', down);
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
    return () => {
      header.removeEventListener('pointerdown', down);
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
    };
  });
}
