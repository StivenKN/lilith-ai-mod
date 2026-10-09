# Cards

The player shares notes and pictures with Lilith on the Cards tab; she reacts in her bubble.
She writes handwritten cards into the game's note inbox, on her own at most once a day or when
asked with "Ask for a card now". The tab lists what was shared and the cards she wrote.

## Sub-features

- `cards-note` share a note; it's listed and she reacts in the game.
- `cards-picture` add pictures; they're shrunk, stored, and described ("She saw: …").
- `cards-remove` remove a shared thing.
- `cards-ask` ask for a card now; it appears in the list and, with the game connected, in the inbox.
- `cards-auto` the "Let her write me cards on her own" toggle.

## How to get to it (user POV)

- Dashboard → Cards tab.
- In the game, the card shows up in the note inbox (the sim prints `💌 card in the inbox`).

## Driving it with session.sh, tmux and cdp.ts

Preconditions: game-mode run (for the inbox), doctor passes, dashboard open, `scripts/cdp.ts click "Cards"`.

- **Share a note.** `scripts/cdp.ts type "Something you'd like her to know or keep: a plan, a memory, a small win…" "I finished my first 5k run"`, `scripts/cdp.ts click "Share note"`. The note appears under "Things you've shared"; the pane shows a `💬` reaction.
- **Add a picture.** Any PNG or JPG works; a screenshot is handy: `scripts/cdp.ts shot "$EVIDENCE/pic.png"`, then `scripts/cdp.ts upload file "$EVIDENCE/pic.png"` and `scripts/cdp.ts wait "She saw" 30000`. The item shows "She saw: A grey cat asleep on a keyboard." (the mock's description of every picture), `$LILITH_AI_DATA_DIR/keepsakes/` gains a `.jpg`, and the pane shows another `💬` reaction.
- **Ask for a card.** `scripts/cdp.ts click "Ask for a card now"`, `scripts/cdp.ts gone "She's writing…" 30000`. The card text shows under "Cards she wrote" marked "you asked · in the game's inbox"; the pane shows `💌 card in the inbox` with the same text.
- **Side effect.** Copy `$LILITH_AI_DATA_DIR/keepsakes.json` to `$EVIDENCE`: it holds the note, the picture entry and the card.
- **Proof.** `scripts/cdp.ts shot "$EVIDENCE/cards.png"` and the pane capture.

## Gotchas

- In dashboard mode the tab says the game isn't running and cards wait for it ("waiting for the game"); the inbox can only be proven in game mode.
- The picture input is hidden behind the "Add pictures…" label; `upload` sets files on it directly, which is what the file picker does.
- A screenshot is a fine test picture; the mock describes every picture the same way.
