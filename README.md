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
3. **Game start**: after decks are submitted, **keep your opening hand in edhplay's own dialog** (do not mulligan there: edhplay blocks library actions until your decision is made). The extension then sweeps automatically: all 50 blanks move face-down into your exile zone and your hand is refilled to seven. If you want a different hand, use the panel's **Mulligan** button, which follows Commander rules: shuffle the hand in, draw seven, and put cards on the bottom, with the first mulligan free.
4. **Activating +2**: press **+2: Choose a pack**, pick a Kamigawa set (Champions, Betrayers, Saviors, Neon Dynasty) and a booster type, **Play** or **Collector** (Collector exists for Neon Dynasty only), or hit **Random pack** for one of the five Kamigawa products at random. Behind the scenes a Play booster is rolled as the era-correct product: 15-card Draft boosters for these sets. The pack is rolled and its contents are published in chat before you look, so everyone with the extension sees the same pack-opening reveal on their screen and can verify the roll. Press **Shuffle into booster pile** when everyone has seen it, then pick two of the top four for your hand; the other two go to your graveyard.
5. **Casting** a pack card from hand: just drag it to the battlefield as usual. The extension announces its identity first, so everyone sees the real card.
6. **−3** is manual: drag the creature from graveyard to battlefield. The panel lists eligible cards.
7. The static cost reduction is bookkeeping you do yourself, as in paper.

Each +2 consumes four blanks, so 50 blanks cover twelve full activations.

### Second-deck mode

If your commander is not Heroes of Kamigawa, the panel switches to **second deck** mode (you can also force either mode). The booster pile then behaves like a hidden extra library: open packs into it, **draw** the top card to hand, **look at** the top X, **search** it and take a card to hand or graveyard, **mill** from it, or **shuffle** it. Each card taken consumes one blank.

### Any set

In second-deck mode the Kamigawa-specific controls disappear and any Magic set can be opened: pick it from the searchable set list or press **Random pack** for a random set. The card list is fetched from Scryfall once and cached, and card identities are matched to edhplay prints as they are needed. A "Play" booster is rolled with the era-correct size, 14 cards for sets from 2024 on and 15 before, without asking. Sets Scryfall has not yet flagged for boosters fall back to their regular printings. In Heroes mode the panel reminds you that non-Kamigawa packs are a house rule.

## Install without developer tools

Download the newest `heroes-of-kamigawa-edhplay-vX.Y.Z.zip` from the GitHub **Releases** page, unzip it into a folder you will keep, then in Chrome open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked* and pick that folder. Step-by-step instructions are in [`docs/INSTALL.md`](docs/INSTALL.md). Every tagged release is built and zipped automatically by GitHub Actions.

## Install from source

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
- Pack collation is an approximation of the printed sheets: Draft boosters ignore foils; Neon Dynasty land slot is 50/50 dual vs ukiyo-e basic, flex slot is 1/3 uncommon, mythic 10/74. Set and Collector boosters follow the official slot structure (showcase, borderless, extended art, foil-etched printings, 21% foil land in Set boosters) with fixed odds where Wizards only published ranges. Foils are cosmetic in the reveal.
