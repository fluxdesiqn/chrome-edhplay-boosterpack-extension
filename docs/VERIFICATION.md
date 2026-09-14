# Live verification matrix

Run with three accounts (two with the extension, one without) in a **Free Commander** room. Turn on *Record frames* in the Diagnostics tab of one client before starting, export the JSONL at the end and keep it (redact tokens; usernames and ids are fine to pseudonymise) as `test/fixtures/recorded/`.

## Milestone 1 checks (protocol assumptions)

| # | Check | Expected | Notes |
|---|---|---|---|
| 1 | `game_state` for the owner | does it include the own `library` array or only `library_count`? | The sweep views the library either way. |
| 2 | Zone actions during the mulligan phase | `view_library`, `batch_move_cards`, `exile_x_cards`, `draw_x_cards` echo normally | If refused, sweep after *Keep* and use *Sweep stragglers* for blanks drawn later. |
| 3 | `exile_x_cards {count:50}` | one `cards_moved` echo with 50 cards, `face_down:true` | If the server caps `count`, the sweep loops in chunks of 150; lower the chunk in `sequences/sweep.ts` if needed. |
| 4 | `reorder_viewed_cards` | `viewed_cards_reordered` echo | Fallback to `batch_move_cards` is automatic. |
| 5 | `draw_x_cards {count:3}` echo shape | `cards_moved {to_zone:'hand', count:3, cards:[…]}` | |
| 6 | Own `library_viewed` suppression | no library dialog flashes during the sweep | |
| 7 | Spectators | do they receive `chat_message_received`? | If not, spectators cannot re-skin. |

## Gameplay checks

- Sweep before keep: hand back to 7, no Wastes in hand, 50 face-down cards in exile, library count = deck − 50 − 7.
- Mulligan after the sweep: exile pile untouched, new hand has no Wastes.
- +2 twice: pack line and map line in chat (hidden for extension users, visible to the third account), two cards in hand render as pack cards for the owner only, two in graveyard render for everyone with the extension.
- Cast a pack card from hand: everyone with the extension sees the real card the moment it lands; the third account sees Wastes.
- Card info dialog (right click → view information) on a mapped card shows the real card's text; translation setting other than English still resolves.
- −3: drag a mapped creature from graveyard to battlefield; identity persists.
- Token copy of a mapped creature: a real-card token appears.
- Reload one extension client mid-game: panel state restored, mapped cards still re-skinned after the reconnect `game_state`, peers receive a re-broadcast.
- Late joiner / spectator with the extension: receives `state`, `pack`, `map` lines within ~10 s.
- No red toasts from edhplay and no watchdog reconnects (Diagnostics → Connection stays `confirmed`) during the sweep and activations.
- Protocol bump: if edhplay ships `pv=5`, the panel shows the unsupported banner and sends nothing.
