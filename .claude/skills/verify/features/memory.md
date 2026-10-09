# Memory

On the Lilith tab the player reads and edits what she keeps: notes about them ("What she knows
about you"), the summary of older conversation ("What she remembers of your talks"), and the
conversation history, which they can clear. She uses all of it on her next reply.

## Sub-features

- `memory-notes` edit and save notes, one fact per line; they persist.
- `memory-summary` edit and save the summary; "Summarize now" condenses older turns.
- `memory-clear` "Clear conversation history" empties history and summary, keeps notes.
- `memory-learn` the "Remember things about me automatically" toggle.
- `memory-persona` edit, save and restore her personality text.

## How to get to it (user POV)

- Dashboard → Lilith tab. Sections in order: Reply language, Personality, What she knows about you, What she remembers of your talks, Behavior, Conversation history, then Using your PC.

## Driving it with session.sh, tmux and cdp.ts

Preconditions: any run, doctor passes, dashboard open, `scripts/cdp.ts click "Lilith"` (the tab; the wordmark is not a button).

- **Save notes.** `scripts/cdp.ts type "For example: I'm learning to play guitar" "My cat is called Mochi"` (the notes box's placeholder, shown only while empty), `scripts/cdp.ts click "Save notes"`, `scripts/cdp.ts wait "Saved."`. Check `notes` in `$LILITH_AI_DATA_DIR/memory.json` contains the line.
- **Notes survive a reload.** `scripts/cdp.ts open "http://127.0.0.1:$DASHBOARD_PORT/"`, click "Lilith", `scripts/cdp.ts eval "[...document.querySelectorAll('textarea')].map(t => t.value)"`: the note is there.
- **Summarize now.** `scripts/cdp.ts click "Summarize now"`, then `scripts/cdp.ts wait "Nothing to summarize yet"` with only a few turns of history. It only condenses once the history outgrows what she keeps in view; with enough turns the status is "Done: the summary and the notes are up to date." and the summary box fills with the mock's one-line record.
- **Clear history.** `scripts/cdp.ts click "Clear conversation history"` (the confirm dialog is accepted and printed), `scripts/cdp.ts wait "History cleared."`. `memory.json` has an empty `history` and `summary`, `notes` unchanged; the Chat tab shows the empty-state bubble.
- **Proof.** `scripts/cdp.ts shot "$EVIDENCE/memory.png"` plus a copy of `memory.json`.

## Gotchas

- The notes and summary boxes are `<textarea>`s with no label; `type` finds them by placeholder, which still matches after they have text (the attribute stays). The personality box has neither: use `css=textarea` (it's the first one).
- `learnFacts` runs in the background "while you're not typing"; the mock answers it with no changes, so notes never change on their own here.
- "Summarize now" is disabled until an AI is configured (the seeded config is).
