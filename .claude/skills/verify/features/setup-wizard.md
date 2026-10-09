# Setup wizard

When the player double-clicks the exe, the dashboard opens on a three-step wizard: "Install the
mod" (find the game, install BepInEx and the mod), "Choose the AI", and "All set". Launched by
the game with no AI configured, the wizard shows only the AI and done steps.

## Sub-features

- `setup-game` the game step searches Steam libraries, checks a folder, and installs or repairs.
- `setup-ai` the AI step's form (same as ai-provider.md) with "Save and continue".
- `setup-done` the done step, "Go to settings" opens the tabbed dashboard.
- `setup-skip` "Skip to settings" leaves the wizard at any step.

## How to get to it (user POV)

- Run the exe with no arguments: `scripts/session.sh up dashboard --fresh` runs `main.ts --dev`, whose wizard starts at "Install the mod".
- Start the game with no AI configured: `scripts/session.sh up --fresh` (sim + `--bridge`), whose wizard has only "Choose the AI" and "Done".
- Dashboard → Game tab has a button that reopens the wizard.

## Driving it with session.sh, tmux and cdp.ts

Preconditions: a `--fresh` run (the seeded config sets only English UI and no self-updates, so the AI is unconfigured), doctor passes, `scripts/cdp.ts open "$LOGIN_URL"`.

- **Game step** (`up dashboard --fresh`). `scripts/cdp.ts wait "Install the mod"`. On Linux it says "Couldn't find the game automatically" and "Some installer files are missing" (no payload next to a dev companion), so "Install" stays disabled. `scripts/cdp.ts type "Game folder" "/tmp"`, `scripts/cdp.ts click "Check"`: the checklist reads "This isn't the game folder (missing Lilith.exe, GameAssembly.dll, Lilith_Data)." Without a mod install there's no "Continue", so this run can only "Skip to settings"; drive the AI step from a game-mode run.
- **AI step** (`up --fresh`). `scripts/cdp.ts wait "Choose Lilith's AI"`; the to-do note lists "Choose the AI", "Done". `scripts/cdp.ts click "Another local server"`, `click "Custom (OpenAI-compatible)"`, `click "Server address"`, `type "Address" "http://127.0.0.1:$MOCK_PORT/v1"`, `type "Model" "mock"`, `click "Test connection"`, `wait "Connected. Lilith answered in"`, screenshot to `$EVIDENCE/setup-ai.png`, then `click "Save and continue"`.
- **Done.** `scripts/cdp.ts wait "All set"`: "Press F7 in the game to talk to Lilith." `scripts/cdp.ts click "Go to settings"`, `scripts/cdp.ts wait "Write me something"`: the tabbed dashboard on Chat.
- **Side effect.** `cp "$LILITH_AI_DATA_DIR/config.json" "$EVIDENCE/"`: `provider` is `custom`, the mock's address, model `mock`, `"configured": true`.

## Gotchas

- Installing for real needs a fake game tree (see `companion/src/installer.test.ts`) and `LILITH_AI_PAYLOAD_DIR` pointing at a built payload; report install/repair/uninstall as unverified otherwise. Never point the game step at a real game folder.
- Uninstall asks through `confirm()`; `cdp.ts click` accepts it.
