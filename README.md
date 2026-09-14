# Heroes of Kamigawa for EDHPlay

A Chrome extension that lets a pod play the Heroes of the Realm card **Heroes of Kamigawa** on [edhplay.com](https://edhplay.com):

> +2: Open up to one sealed Kamigawa booster pack and shuffle those cards into your booster pile. Look at the top four cards of your booster pile. Put two of those cards into your hand and the rest into your graveyard.

edhplay has no packs or booster piles, and cards created as tokens vanish when they leave the battlefield. This extension works around that without touching the server: your deck carries 50 placeholder basics ("blanks"), the extension parks them face-down in exile at the start of the game, and every +2 rolls a real sealed pack, then re-skins blanks into the pack's cards on every player's screen.

## How it works in one paragraph

Each player's copy of the extension wraps the page's WebSocket. When the owner of Heroes assigns a blank to a real card, that mapping is broadcast as a tagged chat line (`[HoK1] {...}`) which the other extensions read and hide. From then on every client rewrites inbound game frames so the blank renders as the real card (image, name, type line, P/T, even the card info dialog). Cards in your hand stay secret: their mapping is only broadcast when the card becomes public (cast, discarded, revealed). Every message the extension sends is a stock action the edhplay UI can perform: view library, move cards, exile top X, draw, shuffle, chat.

## Pod setup

Every player in the pod installs the extension. Anyone without it sees Wastes and some chat lines.

1. **Deck**: add Heroes of Kamigawa as your commander (it is in edhplay's database) and put **50 copies of Wastes** in the main deck. If your deck genuinely plays Wastes, use 50 copies of another basic instead; the extension picks whichever basic land has 50 or more copies.
2. **Room**: create the game as **Free Commander** (40–200 card decks). Standard Commander rooms enforce exactly 100 cards.
3. **Game start**: after decks are submitted and before you keep or mulligan, open the panel (bottom-right, or `Alt+K`) and press **Sweep**. It moves all 50 blanks face-down into your exile zone and refills your hand. Optionally enable auto-sweep.
4. **Activating +2**: press **+2: Open a pack**, choose a set (Champions, Betrayers, Saviors, Neon Dynasty). The pack seed is published in chat before you look, so anyone with the extension can verify the roll. Pick two of the top four for your hand; the other two go to your graveyard.
5. **Casting** a pack card from hand: just drag it to the battlefield as usual. The extension announces its identity first, so everyone sees the real card.
6. **−3** is manual: drag the creature from graveyard to battlefield. The panel lists eligible cards.
7. The static cost reduction is bookkeeping you do yourself, as in paper.

Each +2 consumes four blanks, so 50 blanks cover twelve full activations.

## Install (developer mode)

```bash
npm install
npm run build          # writes dist/
```

Chrome → `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select `dist/`. After the extension is loaded, **reload any open edhplay tab**: the WebSocket tap can only attach before the game connects.

Development loop: `npm run watch` rebuilds on change; click *Reload* on the extension card and reload the page.

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | Unit and scenario tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Three bundles: MAIN-world tap, content script, background worker |
| `npm run data` | Regenerate the bundled Kamigawa set data from Scryfall and edhplay (writes `src/shared/packs/data/`) |

## Project layout

```
src/main/        MAIN-world code: WebSocket tap, frame rewrite, zone index, engine, sweep/activation sequences
src/content/     ISOLATED content script: panel host, storage, tab lock, bridge to MAIN
src/ui/          Preact panel
src/background/  Service worker: identity lookups, per-room tab lock, storage.session access
src/shared/      Pure logic shared by all three: protocol types, pack roller, sync codec, sweep planner, state machine
test/            Unit tests, fake pv4 server harness, end-to-end scenarios
docs/            Developer message, verification checklist
```

## What still needs a live check

Everything is verified against edhplay's minified client and its local-play simulator plus a fake server in tests, but not yet in a live room. See `docs/VERIFICATION.md` for the manual matrix. The main unknowns are server-side: whether zone actions are accepted during the mulligan phase, the exact echo shapes of `exile_x_cards`/`draw_x_cards`, and whether spectators receive chat relays. The Diagnostics tab can record frames to a JSONL file for this.

## Terms of service note

edhplay's terms forbid manipulating game state through means the interface does not offer and automation that plays on your behalf. This extension only sends actions the interface offers, only when you click, and keeps a visible ledger of every action sent (Diagnostics tab). It is still automation of bookkeeping moves. Consider telling the developer (`docs/DEVELOPER-MESSAGE.md`) and get your pod's agreement before using it.

## Limitations

- One booster mechanic only; no other Heroes of the Realm cards.
- Token copies of a re-skinned card are created as a real-card token via the sideboard path, without copied counters.
- Chat lines starting with `[HoK1]` are visible to players without the extension.
- Pack collation is an approximation: foils are ignored; Neon Dynasty land slot is 50/50 dual vs ukiyo-e basic, flex slot is 1/3 uncommon, mythic 10/74.
