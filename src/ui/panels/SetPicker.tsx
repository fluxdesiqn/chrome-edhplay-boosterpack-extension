import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { SetSummary } from '@shared/packs/runtime';
import { KAMIGAWA_PRODUCTS, KIND_SHORT_NAMES, NEC_CODE, SELECTABLE_KINDS, availablePacks, isKamigawaProduct, kindName, setName, type PackKind } from '@shared/packs/types';

export interface SetPickerProps {
  /** null = still loading */
  sets: SetSummary[] | null;
  /** recently used runtime set codes */
  recent: string[];
  /** selected set code */
  value: string;
  kind: PackKind;
  onChange: (set: string, kind: PackKind) => void;
  /** reload the set list */
  onRefresh?: () => void;
  error?: string;
}

const MAX_RESULTS = 12;

/** Case-insensitive match: prefix of the code or substring of the name. */
export function matchSets(sets: SetSummary[], query: string, limit = MAX_RESULTS): SetSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SetSummary[] = [];
  for (const s of sets) {
    if (s.code.toLowerCase().startsWith(q) || s.name.toLowerCase().includes(q)) {
      out.push(s);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function yearOf(released: string): string {
  return released.slice(0, 4);
}

/** Kamigawa products, recent chips and a searchable list of every Scryfall set, plus the booster-kind pills. */
export function SetPicker(props: SetPickerProps): JSX.Element {
  const { sets, recent, value, kind, onChange, onRefresh, error } = props;
  const summaryOf = (code: string): SetSummary | undefined => sets?.find((s) => s.code === code);
  const releasedOf = (code: string): string | undefined => summaryOf(code)?.released;
  /** Kinds sold for a set: from its Scryfall summary until the set is registered. */
  const kindsOf = (code: string): readonly PackKind[] => availablePacks(code, summaryOf(code));
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const results = useMemo(() => (sets ? matchSets(sets, query) : []), [sets, query]);
  useEffect(() => setHighlight(0), [query, sets]);

  const kinds = kindsOf(value);
  const effectiveKind: PackKind = kinds.includes(kind) ? kind : 'draft';

  const nameOf = (code: string): string => KAMIGAWA_PRODUCTS.find((p) => p.code === code)?.name ?? summaryOf(code)?.name ?? setName(code);

  /** Selecting a set keeps the kind when it is sold for that set, otherwise falls back to draft. */
  const select = (set: string) => {
    const next: PackKind = kindsOf(set).includes(kind) ? kind : 'draft';
    onChange(set, next);
  };

  const pick = (s: SetSummary) => {
    select(s.code);
    setQuery('');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The game binds global single-key shortcuts; typing here must not reach them.
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, Math.max(0, results.length - 1)));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const s = results[highlight];
        if (s) pick(s);
        break;
      }
      case 'Escape':
        e.preventDefault();
        setQuery('');
        break;
    }
  };

  const showRecent = recent.length > 0;
  const runtimeSelected = !isKamigawaProduct(value);

  return (
    <div class="hok-sp">
      <div class="hok-sp-block">
        <p class="hok-h">Kamigawa</p>
        <div class="hok-sets">
          {KAMIGAWA_PRODUCTS.map(({ code, name }) => (
            <button
              type="button"
              class={`hok-btn secondary ${value === code ? 'selected' : ''} ${code === NEC_CODE ? 'wide' : ''}`}
              aria-pressed={value === code}
              title={code === NEC_CODE ? 'The two Neon Dynasty Commander decks; a pack is 15 random cards of the set' : ''}
              onClick={() => select(code)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {showRecent && (
        <div class="hok-sp-block">
          <p class="hok-h">Recent</p>
          <div class="hok-sp-chips">
            {recent.map((code) => (
              <button
                type="button"
                class={`hok-sp-chip ${value === code ? 'selected' : ''}`}
                aria-pressed={value === code}
                title={nameOf(code)}
                onClick={() => select(code)}
              >
                <span class="hok-sp-code">{code.toUpperCase()}</span>
                <span class="hok-sp-chipname">{nameOf(code)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="hok-sp-block">
        <p class="hok-h">Any set</p>
        {error && (
          <div class="hok-note err hok-sp-error">
            <span>{error}</span>
            {onRefresh && (
              <button type="button" class="hok-btn sm" onClick={onRefresh}>Retry</button>
            )}
          </div>
        )}
        {sets === null && !error && <div class="hok-muted hok-sp-loading">Loading sets…</div>}
        {sets !== null && (
          <div class="hok-sp-search">
            <input
              class="hok-input hok-sp-input"
              type="search"
              placeholder="Search by code or name…"
              value={query}
              autocomplete="off"
              spellcheck={false}
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls="hok-sp-results"
              aria-autocomplete="list"
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={onKeyDown}
              onKeyUp={(e) => e.stopPropagation()}
            />
            {results.length > 0 && (
              <ul class="hok-sp-results" id="hok-sp-results" role="listbox">
                {results.map((s, i) => (
                  <li
                    class={`hok-sp-result ${i === highlight ? 'active' : ''} ${s.code === value ? 'selected' : ''}`}
                    role="option"
                    aria-selected={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                  >
                    <span class="hok-sp-code">{s.code.toUpperCase()}</span>
                    <span class="hok-sp-name">{s.name}</span>
                    <span class="hok-sp-year hok-muted">{yearOf(s.released)}</span>
                  </li>
                ))}
              </ul>
            )}
            {query.trim() !== '' && results.length === 0 && <div class="hok-muted hok-sp-empty">No sets match “{query.trim()}”</div>}
          </div>
        )}
        {runtimeSelected && (
          <div class="hok-row hok-sp-current">
            <span class="hok-muted">Selected</span>
            <span><span class="hok-sp-code">{value.toUpperCase()}</span> {nameOf(value)}</span>
          </div>
        )}
      </div>

      <div class="hok-sp-block">
        <p class="hok-h">Booster</p>
        <div class="hok-kinds hok-sp-kinds">
          {SELECTABLE_KINDS.map((k) => {
            const ok = kinds.includes(k);
            return (
              <button
                type="button"
                class={`hok-pillbtn ${effectiveKind === k ? 'selected' : ''}`}
                disabled={!ok}
                aria-pressed={effectiveKind === k}
                title={ok ? '' : `${nameOf(value)} was not sold as ${kindName(value, k, releasedOf(value))}s`}
                onClick={() => onChange(value, k)}
              >
                {KIND_SHORT_NAMES[k]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
