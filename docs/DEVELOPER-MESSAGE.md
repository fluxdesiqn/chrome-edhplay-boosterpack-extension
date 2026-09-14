# Draft message to the EDHPlay developer

Send to support@edhplay.com or via discord.gg/edhplay before using the extension in public rooms.

---

Subject: Heads-up about a small client-side extension for a Heroes of the Realm card

Hi Andres,

I love EDHPlay and wanted to be upfront about something I built for my playgroup rather than have it show up in your logs unexplained.

I own the Heroes of the Realm card *Heroes of Kamigawa* (its +2 opens a sealed Kamigawa booster into a "booster pile"). EDHPlay obviously has no concept of packs, so I wrote a Chrome extension that our pod installs voluntarily. What it does:

- The deck carries 50 copies of a basic land as placeholders. At game start the extension parks them face-down in exile using the normal actions (view library, move cards, exile top X, draw, shuffle) and afterwards moves individual placeholders to hand or graveyard when the ability resolves.
- Which real card a placeholder "is" is shared between the players through ordinary chat messages prefixed `[HoK1]`, and each player's browser re-skins those cards locally. The server never receives anything but stock actions.
- Nothing is automated beyond the bookkeeping moves the player clicks for. There is a visible ledger of every action sent.

Your terms mention automation and state manipulation, and I want to respect the spirit of them. If you would prefer we did not use this, tell me and we will stop. If you are open to it, two small things on your side would make the hack unnecessary: a per-game "extra cards" pool that can be brought into hand (or a larger sideboard), or a Free Commander deck-size allowance for placeholder cards. I am happy to share the source.

Thanks for building the platform.
