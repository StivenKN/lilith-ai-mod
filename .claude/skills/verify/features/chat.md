# Chat

The player types to Lilith in the game's F7 popup or the dashboard's Chat tab. Her reply shows in
her speech bubble in the game, split across bubbles when long, and in the dashboard transcript.
Both sides share one conversation.

## Sub-features

- `chat-game` a message typed in the game gets a reply in her bubble, with a thinking state first.
- `chat-dashboard` a message sent from the Chat tab gets a reply in the transcript.
- `chat-cross` game messages appear in the dashboard marked "in the game"; dashboard replies also reach her bubble while the game is connected.
- `chat-state` her sleep/busy state and the game language change how she answers (sim `/sleep`, `/lang`).
- `chat-error` a broken AI gives an honest error in the bubble and the dashboard, not an in-character excuse.

## How to get to it (user POV)

- In the game: press F7, type, press Enter (the sim stands in for this).
- Dashboard: Chat tab (the first tab), the "Message Lilith…" box, Enter or "Send".
- Dashboard from the game: the tray's "Lilith AI settings" (sim `/settings`) opens the dashboard.

## Driving it with session.sh, tmux and cdp.ts

Preconditions: game-mode run, doctor passes, dashboard opened with `$LOGIN_URL`.

- **Game message.** `tmux send-keys -t "$TMUX_SESSION" "Hi Lilith, I baked a strawberry cake today" Enter`, wait ~3 s, `tmux capture-pane -p -t "$TMUX_SESSION"`. The pane shows `[thinking] Lilith is thinking…`, a `💬 (…)` "…" placeholder, then `[idle] <reply>` and `💬 (<emotion>, <seconds>s)` with the reply wrapped to the bubble's width.
- **Seen in the dashboard.** `scripts/cdp.ts wait "strawberry cake"` then `scripts/cdp.ts text css=.transcript`. The message shows with "<time>, in the game" under it, followed by her reply.
- **Dashboard message.** `scripts/cdp.ts type "Message Lilith…" "Do you remember what I baked?"`, `scripts/cdp.ts press Enter`, `scripts/cdp.ts wait "Do you remember what I baked?"`, then after ~3 s `scripts/cdp.ts text css=.transcript`. A reply bubble follows the message; `scripts/cdp.ts shot "$EVIDENCE/chat.png"`.
- **Dashboard reply in the game.** Capture the pane again: the same reply appears as a new `💬` block.
- **Side effect.** `bun -e "const m = await Bun.file('$LILITH_AI_DATA_DIR/memory.json').json(); console.log(m.history.map(t => [t.role, t.source, t.content]))" > "$EVIDENCE/history.txt"`. Four turns, sources `game`, `game`, `dashboard`, `dashboard`.
- **Header state.** The header says "Game connected" in game mode and "Game not running" in dashboard mode; the hint under the composer changes with it.
- **Honest error.** `kill $(cat "$RUN_DIR/mock.pid")`, then send from the dashboard and `sleep 6`. The dashboard shows an error note "127.0.0.1:<port> isn't running or isn't answering. Start it and try again." and puts the message back in the composer (it is not added to the transcript); the pane shows `[error] …` and a `💬 (sad, …)` bubble "Lilith AI: …" with the same text. End the run afterwards: the mock is gone.

## Gotchas

- Replies are canned and cycle per mock process, so the dashboard's reply is not "about" the cake. Assert arrival, not content.
- The sim answers every `say` with success instantly; real bubble timing (`seconds`) is printed, not waited for.
- Turns are serialized: a second message sent while one is in flight waits. Wait for `[idle]` before the next.
- In dashboard mode (no game) a reply is not spoken in a bubble anywhere; only the transcript proves it.
