---
name: verify
description: Launch and drive the Lilith AI companion (companion/, Bun + React dashboard) the way a player does, without the game or Windows — chat through the simulated game plugin (scripts/sim.ts in tmux) and the dashboard in headless Chrome, against the mock AI — and capture evidence. Use to prove a change to chat, memory, cards, connected accounts, AI setup, the setup wizard, or any dashboard page actually works, not just that tests pass.
---

# Verify the Lilith AI companion

The game plugin (`plugin/`, C#) needs Windows and the game; it can't be driven here. Everything
else can: the companion runs on Linux, `companion/scripts/sim.ts` plays the plugin's side of the
stdio bridge, `companion/scripts/mock-llm.ts` stands in for the AI, and
`companion/scripts/mock-google.ts` for Google's sign-in and APIs. Two surfaces:

- **Game side**: the sim terminal in tmux. You type what the player types in the F7 popup; it prints
  what reaches her speech bubble (`💬 (emotion, seconds)`), status lines (`[thinking]`, `[idle]`),
  and cards that reach the game inbox (`💌`).
- **Dashboard**: the React app on `127.0.0.1:47321+`, driven in headless Chrome over CDP.

Both helpers live in `.claude/skills/verify/scripts/`. Paths below are relative to that folder.

## Launch

```sh
./session.sh up            # "game" mode: sim.ts spawns `main.ts --bridge` (dashboard says "Game connected")
./session.sh up dashboard  # no game: `main.ts --dev --no-open` (dashboard says "Game not running")
./session.sh up --fresh    # either mode, AI left unconfigured so the setup wizard shows (features/setup-wizard.md)
eval "$(./session.sh env)" # exports RUN_DIR, LOGIN_URL, DASHBOARD_PORT, CDP_PORT, TMUX_SESSION, EVIDENCE, ...
```

`up` prints the env when it's ready; it has already waited for the mock AI and mock Google to
answer, the companion to write `instance.json`, and Chrome's CDP port. Each run gets:

- a scratch data folder `LILITH_AI_DATA_DIR=/tmp/lilith-verify/<run>/data`, seeded with a
  `config.json` that points the "Custom (OpenAI-compatible)" provider at the mock AI, English UI,
  `autoUpdate: false` (`--fresh`: only the last two). The player's real folder (`~/.config/LilithAICompanion`) is never touched.
- `LILITH_AI_FAKE_DESKTOP=1`: computer-control turns record actions on a gray fake screen instead
  of moving your mouse.
- `LILITH_AI_GOOGLE_URL` at the mock Google and a `mock` client id and secret, so "Sign in with
  Google" works offline (features/accounts.md).
- free ports for everything. The dashboard takes the first free port in 47321–47340, skipping one
  a real companion holds, so runs and a player's own companion coexist.

`/tmp/lilith-verify/current` points at the latest run. To drive an older one, set
`VERIFY_RUN=/tmp/lilith-verify/<run>` before calling either helper.

Teardown is `./session.sh down` (see Cleanup).

## Doctor

Run first, and again whenever anything looks off:

```sh
./session.sh doctor
```

It checks: the companion pid is alive; the dashboard port answers `/api/ping` as
`lilith-ai-companion` with the version in `companion/package.json` and the expected mode
(`bridge` for game, `dev` for dashboard); `instance.json` in this run's data folder names that pid
and port (so you're not driving someone else's companion); mock AI, mock Google, Chrome CDP and
the tmux session answer. On failure it prints the companion log's tail. Don't drive a run whose doctor fails: `down`
it and `up` a new one.

## Drive

**Game side (tmux).** Send a line as the player and read the pane:

```sh
tmux send-keys -t "$TMUX_SESSION" "Hi Lilith" Enter
sleep 3; tmux capture-pane -p -t "$TMUX_SESSION" | tail -20
```

Sim commands: `/sleep` `/wake` (her sleep state), `/busy` `/free`, `/lang <code>` (game language,
e.g. `es-419`, `en`, `ja`), `/settings` (the tray's "open settings" action), `/voice <file.wav>`.
The pane's full history is also appended to `$EVIDENCE/terminal.log`.

The mock AI reacts to message prefixes (see the header of `companion/scripts/mock-llm.ts`): `?q`
asks for a web search when search is on, `!` runs a computer-control turn on the fake desktop,
`!b <url>` drives the browser extension. Plain messages cycle through canned in-character replies,
so assert that *a* reply arrived and where, not its wording.

**Dashboard (headless Chrome).** Always open the login link first; it sets the session cookie
(any other URL shows "locked"):

```sh
./cdp.ts open "$LOGIN_URL"
./cdp.ts click "Lilith"                       # tabs: Chat, Lilith, Cards, Accounts, Voice, AI, Game, Help
./cdp.ts type "Message Lilith…" "Hello"      # fields by aria-label, placeholder or <label> text; replaces their text
./cdp.ts press Enter
./cdp.ts wait "Hello"                         # waits for rendered text, not placeholders (default 15 s)
./cdp.ts text css=.transcript                 # read a region
./cdp.ts shot "$EVIDENCE/chat.png"
```

Run `./cdp.ts` with no arguments for every command. Targets are what the player reads: button,
tab, link, `<summary>` and label text (a radio choice matches by its first line, e.g. "Another
local server"), or aria-label; prefix `css=` only when there is no visible name. `click` sends a
real mouse click and accepts `confirm()` dialogs the way clicking OK would. A miss exits 1 and
lists the names that were on the page. The UI language is English because the seeded config sets
`uiLanguage: "en"`; the "Español"/"English" buttons in the header switch it.

Per-feature recipes, entry points and gotchas are in [features/](features/README.md). Read the
feature's file before driving it.

## Evidence

Put everything in `$EVIDENCE` (`/tmp/lilith-verify/<run>/evidence/`). `down` adds
`companion.log` (the companion's own log) next to `terminal.log` and keeps the folder.

A proof:

- **Exercises the real path.** Type in the sim or click in the dashboard. Don't call `/api/rpc/*`
  with curl or edit `config.json`/`memory.json` to make the feature happen; the seeded config is
  the only shortcut, and it stands in for the setup wizard, which has its own feature file.
- **Captures the action and the resulting state**: the pane after the player's line, a screenshot
  after the click, not just a final screen.
- **Checks side effects** next to what's visible. They live in `$LILITH_AI_DATA_DIR`:
  `memory.json` (`history`, `notes`, `summary`), `keepsakes.json` and `keepsakes/*.jpg` (cards and
  shared things), `config.json` (saved settings), `logs/lilith-ai.log`. Copy the relevant excerpt
  into `$EVIDENCE` before `down` deletes the data folder.
- **Crosses surfaces when the feature does.** A reply to a dashboard message also shows in the
  game bubble when the game is connected; a game message appears in the dashboard Chat as "in the
  game"; a card written from the Cards tab prints `💌` in the sim.
- **Mocks only the AI and Google.** The mock AI and the mock Google stand at boundaries the app
  already has (the provider's base URL, `LILITH_AI_GOOGLE_URL`). Real providers, Google's own
  consent page, Ollama model pulls, voice engines and web search hit the network or need
  downloads: say so in the report instead of claiming them verified.

## Cleanup

```sh
./session.sh down
```

It copies the companion log into the evidence, ends the tmux session (sim.ts exits, which closes
the companion's stdin and stops it), then signals only the pids this run recorded (companion, mock
AI, mock Google, Chrome), with SIGKILL for any still alive after a second. It deletes `data/` and `chrome/` and
keeps `evidence/`, printing its path and contents. Never `pkill bun` or `pkill chrome`: the player
may be running their own.

After a failed or abandoned attempt, still run `down` for that run (set `VERIFY_RUN` if it is no
longer `current`), then check nothing of it is left:

```sh
ss -ltn | grep -E ":($DASHBOARD_PORT|$MOCK_PORT|$GOOGLE_PORT|$CDP_PORT) "   # should print nothing
```

## Helpers

| Script | What it does |
| --- | --- |
| `scripts/session.sh up [game\|dashboard]` / `doctor` / `env` / `down` | Run lifecycle, described above. |
| `scripts/cdp.ts <command> ...` | One CDP command against the run's Chrome tab. Needs `CDP_PORT` (from `session.sh env`). |

Both need `bun`, `tmux`, `curl` and Google Chrome or Chromium; `up` runs `pnpm install` in
`companion/` if `node_modules` is missing.
