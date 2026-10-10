# Lilith AI companion verification map

The maintained source for verifying what a player can do with the companion. Read this index,
then the feature's file, before driving it with the [verify skill](../SKILL.md).

## Baseline preconditions

- A run started with `scripts/session.sh up` (game mode) unless the feature says `up dashboard`.
- `eval "$(scripts/session.sh env)"` in the shell you drive from.
- `scripts/session.sh doctor` passes. Never drive a companion this run didn't start.
- The seeded config: "Custom (OpenAI-compatible)" provider at the mock AI, English UI, no
  self-updates. Memory, notes, cards, shared things and connected accounts start empty.
- The fake Google (`companion/scripts/mock-google.ts`) runs on `$GOOGLE_PORT`, and the companion
  signs in against it.
- For the dashboard, `scripts/cdp.ts open "$LOGIN_URL"` once per run.

## Driving conventions

- Game side: `tmux send-keys -t "$TMUX_SESSION" "<text>" Enter`, then
  `tmux capture-pane -p -t "$TMUX_SESSION"`.
- Dashboard: `scripts/cdp.ts` with the names the player reads (tab, button, label, placeholder).
- The mock AI's plain replies are canned and cycle; assert that a reply arrived and where.
- Data-folder files (`$LILITH_AI_DATA_DIR/...`) are a second, read-only view of a side effect,
  never a way to cause one.

## Proof and skip reporting

- Save screenshots, pane captures and data-file excerpts to `$EVIDENCE` before `session.sh down`.
- Name the feature, sub-feature and entry point with each artifact.
- Report a path you couldn't reach (the real game, a real AI service, voice engines, the browser
  extension) as not verified, with the reason. Don't count a different entry point as covering it.

## Feature entry contract

Each feature file has an H1 and a paragraph on what the player sees, then four H2s in this order:
`Sub-features`, `How to get to it (user POV)`, `Driving it with session.sh, tmux and cdp.ts`,
`Gotchas`.

## Features

- [Chat](./chat.md): talking to Lilith from the game popup and the dashboard Chat tab, and how each shows the other.
- [Memory](./memory.md): the Lilith tab's notes about the player, conversation summary and history.
- [Cards](./cards.md): sharing notes and pictures, asking for a card, and the card reaching the game inbox.
- [AI provider](./ai-provider.md): choosing, testing and saving Lilith's AI on the AI tab.
- [Accounts](./accounts.md): signing in with Google on the Accounts tab, Try it, lookups from chat, the online gate and disconnecting.
- [Setup wizard](./setup-wizard.md): first-run flow of the setup exe (game step, AI step, done).
