# Architecture

```
Lilith.exe (game) ─ BepInEx 6.0.0-be.780 (IL2CPP)
   └─ LilithAICompanion.dll            plugin/ (C#, thin)
        │  JSON lines over stdin/stdout, UTF-8 without BOM
        │  child process inside a kill-on-close job object
        ▼
      LilithAICompanion.exe --bridge   companion/ (TypeScript on Bun, single exe)
        ├─ providers   OpenAI-compatible · Anthropic SDK · Ollama native
        ├─ brain       persona · prompt · reply shaping · paging · memory · speak-first
        ├─ search      DuckDuckGo lite (keyless) · Firecrawl (API key)
        ├─ computer    Windows x64 FFI · screenshots · input · bounded tool loop
        ├─ browser     the browser extension's connections · page snapshots · element numbers
        ├─ voice       Piper (speech) · whisper.cpp (recognition), short-lived local processes
        └─ dashboard   Bun.serve on 127.0.0.1:47321+ → React app (setup wizard, settings, help)
             ▲ WebSocket /api/browser
      Chrome / Edge / Brave ─ extension (MV3)    companion/extension/, loaded unpacked from the data folder

%APPDATA%\LilithAICompanion\   config.json · memory.json · keepsakes.json · keepsakes\*.jpg · logs\lilith-ai.log · voice\ · browser-extension\
```

## Why it's split this way

- **The plugin is as small as possible**, because it's the only part that can break when the game
  updates and the only part that can't be tested without the game.
  - It patches nothing. It only *calls* game APIs that earlier community mods proved work.
  - All of those calls live in `plugin/src/GameApi.cs`. Each sits in its own `NoInlining` method and
    is probed at startup.
  - A renamed member disables one capability and reports why. The rest keeps working.
- **Everything else is TypeScript**, so it can be unit-tested and run end to end without Windows or
  the game. `bun test` covers providers against replayed failure modes, reply shaping, the installer
  against a fake Steam tree, and the stdio bridge against a spawned companion.
- **Stdio instead of HTTP for the bridge.** The plugin owns the child process, so their lifetimes are
  tied:
  - the companion exits when its stdin closes;
  - a job object kills it if the game crashes;
  - there are no ports, tokens or stale `runtime.json` files to go wrong.
- **One exe, two modes.** Double-clicked, it is the installer and setup wizard. Launched by the plugin
  with `--bridge`, it is the brain. Both serve the same dashboard.

## Startup

1. The plugin's `Load()` starts three isolated stages:
   - the main-thread `Runtime` MonoBehaviour;
   - the chat window (its own thread);
   - the bridge, which launches the exe.
2. Once the game's `DialogueManager` exists (or after 30 s), the plugin probes capabilities and sends
   `state` then `hello`.
3. The companion answers `ready` with the hotkey and localized strings. It sends `ready` again
   whenever settings or the game language change.
4. If no AI is configured yet, the companion opens the dashboard's setup page in the browser.

## Live settings

Nothing needs a restart after a settings change:
- The brain reads the settings on every turn, so provider, model, persona, language and reply
  options apply from the next reply. The hotkey and popup strings reach the game in a new `ready`.
- `config.json` is watched. The setup exe and the game's copy can both be open, each with its own
  dashboard, and a save in either one (or a hand edit) applies in the other within a moment. Open
  dashboards refresh through a `config` server event. An invalid edit is logged and ignored.

## A chat turn

1. The player presses F7, the popup opens next to Lilith, and they type and press Enter. The plugin
   sends `chatOpened` when the popup appears (so a local model can load meanwhile, see below), then
   `chat`.
2. The companion queues the turn. Turns are serialized: one request in flight at a time.
3. The companion shows the thinking state: `chatStatus thinking`, plus `say "…"` in her bubble.
   - After 8 s it adds "still thinking", or "loading the model" for local AI.
4. It calls the provider with the persona, what she remembers (notes, the conversation summary),
   the turns since the summary, and the latest message with a short note in front of it (time, her
   state, how long since they last talked). See [Memory](#memory) for the layout.
   - Timeouts are explicit: 60 s, or 180 s while a local model loads.
   - 429 and 5xx errors get one retry.
   - A 400 that names a parameter drops or renames that parameter and retries.
   - With web search on, the prompt lets the model answer with only `[search: query]` (or
     `[buscar: …]`). The companion runs that search (`search.ts`), shows "searching the web" in the
     popup, and asks again with the top results in the note before the latest message. A failed search is logged and
     the model is told it got nothing, so she still answers. This works with every provider because
     it needs no tool-calling support.
5. It shapes the reply:
   - strips `<think>` blocks, markdown, emoji and stage directions;
   - reads the `[emotion]` tag (Spanish or English);
   - trims to length;
   - if the reply was empty because the model only reasoned, retries once with a 4× token budget;
   - leaves out sentences that repeat her recent replies; if little is left, retries once with a nudge.
6. It wraps the reply for the bubble (CJK counts as double width), splits it into pages, and sends
   `say` per page, paced by reading time.
7. On failure, the error is classified (auth, billing, model not found, rate limit, timeout,
   unreachable…). The player sees a localized, actionable message in the bubble and the popup; the
   technical detail goes to the log and the dashboard.

## Memory

`companion/src/memory.ts` keeps three layers in `memory.json`. They are sized for small local models
(a 4B model with an 8k context). The dashboard's Lilith tab shows the notes and the summary, and the
player can edit or clear them.

- **The conversation.** The last 400 turns are kept for the transcript. The model gets only the turns
  after the summary, within a budget. For local AI that's 1.2k tokens and at most 12 exchanges; online
  services get 9k tokens.
  - Tokens are estimated at 3 characters each (one per CJK character).
  - Every turn counts as at least 50 tokens, because a small model copies its own replies however
    short they are.
- **The summary.** Locally, once the turns after it pass 10 exchanges (1k tokens), the oldest are
  folded into it, down to the last 4 exchanges. Online, that's past 6k tokens, down to 2.5k. A fold
  always ends on one of her replies. Each pass writes 1 to 4 short lines of plain fact about the
  folded turns, from the player's messages only. Code appends them, skips near-duplicates, and
  retires the oldest lines past 12. Each choice comes from a 4B model's failures:
  - Asked for prose, it invented links between facts, and a wrong summary misleads every later reply.
  - Asked to rewrite the whole summary, it dropped what came before and kept trivia.
  - Given her messages too, it filled the summary with her stories, which then came back in her
    replies. Who she is comes from the persona.
- **Notes about the player.** Every 4 of their messages, a pass reads the new ones and answers with
  JSON changes: add, update by number, remove. Before each short reply of theirs, it sees her last
  sentence, so "yes, I love them" makes sense. Shown more of her lines, a 4B model noted what she
  said as facts about the player. Ollama and OpenAI-compatible servers enforce the JSON schema while
  decoding. Code checks every change: it ignores unknown numbers, questions and
  fragments, skips near-duplicates, and lets one pass remove at most a third of the notes. At most 30.

Upkeep runs in the turn queue, 15 s after her reply: first the notes pass, then the summary. Each is
one small request with its own focused prompt, which a 4B model handles better than one combined
task.
- A new message aborts upkeep, and it continues at the next pause. Ollama stops generating when the
  request is aborted.
- Once the turns no longer fit the window, the summary is overdue and finishes even if a message
  arrives. That costs one wait instead of every later reply silently dropping turns.
- Work started before the player edits or clears her memory is discarded.

The prompt is laid out for prompt caching. Ollama and llama.cpp reuse the longest common prefix of
the previous prompt, so a turn only processes what's new. The layout:

1. **System prompt:** persona, the player's name, notes, summary, reply format, and the search and
   computer rules. Nothing in it changes between messages.
2. **The turns since the summary.** They change only when a summary pass runs, not every message as
   a sliding window would.
3. **The latest message**, with a note in front of it: date and time, her state, the gap since they
   last talked, search results when she asked for them, and up to 3 notes that share words with the
   message. A small model overlooks a note at the top of the prompt, and pays the most attention to
   the end. The note isn't stored.

Ollama runs `qwen3vl` models with a single slot, so an upkeep request replaces the cached chat prompt.
The next reply then processes its whole prompt once.

Small models loop: they copy their own phrasing, and the more often a sentence appears in the context
the likelier it comes back. Ollama's repetition penalties only look at the last 64 tokens, so the fix
is in the context. In testing with qwen3-vl:4b, a presence penalty made things worse: that window
holds the note before the latest message, so it pushed her away from the very notes she was asked
about. Sampling stays at the model's defaults and the player's temperature.

Before a reply is shown and stored, it loses any sentence that echoes her last 6 replies or repeats
itself. If little is left, she's asked once more, at a slightly higher temperature, with a nudge that
doesn't quote the phrase (quoting it would prime it). The built-in persona's example replies don't all
end in a question, for the same reason.

## Local model memory

An Ollama model is in memory only while Lilith needs it. Defined in `brain.ts` and `providers/ollama.ts`.

- **Loading.** Nothing loads when the game starts. `chatOpened` (F7, the tray or the microphone
  hotkey) loads the model while the player types, or restarts its idle countdown if it's already
  loaded. Anything else that needs it (speak-first, cards, the dashboard) loads it on demand.
- **Unloading.** Every request sets `keep_alive` to **AI → Advanced → Free memory after** (10 minutes
  by default), so Ollama frees the model on its own, even if the companion is killed. It's freed at
  once (`keep_alive: 0`, only if `/api/ps` lists it) when the game closes, within the 3 s the plugin
  waits for the companion to exit, and when another model is chosen.
- Ollama lists a model in `/api/ps` while it's still loading, so one the companion is loading counts
  as cold until it's ready: the 180 s timeout and the "loading the model" status apply.
- Other local servers (LM Studio, llama.cpp…) manage their own memory.

## Voice

Optional, off by default, and entirely local. Defined in `companion/src/voice/`.

- **Downloads.** Nothing ships in the release. The Voice tab installs what the player turns on: the
  Piper and whisper.cpp Windows builds, a Piper voice per language, a whisper model. Each file is
  pinned by URL and SHA-256 in `voice/catalog.ts`, verified while streaming, and only then moved into
  `voice\`, so a half-finished download never looks installed.
- **Speaking.** When a reply is paged, every page is queued for speech at once; runs are serialized,
  so page 2 is synthesized while page 1 plays. Piper writes a WAV, the companion applies the volume to
  the samples (PlaySound has none), and `say` carries the file's path. A page stays up for its reading
  time or its audio, whichever is longer. If speech fails, she still shows the text and the reason is
  logged once and shown in the Voice tab.
- **Language.** Piper voices exist for Spanish and English. With the voice language on "auto", she
  speaks when her reply language is one of those; a fixed voice language also sets the reply language.
- **Listening.** The plugin records with MCI (`waveaudio`, 16 kHz mono) on the chat window's thread:
  the voice hotkey or the mic button starts it, a second press (or 30 s) stops it, and the plugin sends
  `voice{path}`. The companion transcribes with whisper.cpp in the reply language, deletes the file,
  shows "You said: «…»" in the popup, and runs a normal chat turn. Nothing heard → a hint in the popup;
  a microphone or engine problem → a localized error, like any other.
- **Paths.** The engines get relative paths only, run from `voice\`: their argv is narrow-char on
  Windows, and user folders can contain characters it can't represent.
- **Dashboard.** The chat tab has a mic button (recorded in the browser, sent as WAV) and plays her
  replies when the game isn't open.

## Protocol

Defined in `companion/src/protocol.ts` (Zod) and mirrored in `plugin/src/Protocol.cs`.

| plugin → companion | companion → plugin |
|---|---|
| `state{idle, sleep, busy, interacting, drag, langRaw, playerName}` | `ready{v, version, dashboardUrl, hotkey, voiceHotkey, strings}` |
| `hello{v, pluginVersion, gameVersion, unityVersion, bepinexVersion, gameDir, caps}` | `say{id, text, emotion, seconds, audio?}` |
| `chat{text}` · `chatOpened{}` · `voice{path}` · `voiceError{detail}` | `chatStatus{kind: idle\|thinking\|error, text?}` |
| `action{name: "dashboard"}` · `result{id, ok, error?}` · `log{level, msg}` | `yieldFocus{}` · `card{id, text}` (only when `caps.card` is ok) |

Bump `PROTOCOL_VERSION` on both sides for breaking changes. On a version mismatch, the companion exits
with code 2 and the plugin shows "reinstall the mod" instead of restarting it.

## Computer control

`features.computerControl` is `auto`, `on` or `off`. Automatic enables tools for local and LAN AI.
Speak-first remarks and provider connection tests never get computer tools. Unsupported hosts
and models without tool support use ordinary chat.

### Tools

The tools are shaped for a 4B local model, because a small model is only good at what it was
trained on. Defined in `computer/actions.ts`.

- **`computer_use`** mirrors the tool in Qwen3-VL's computer-use cookbook, wording included: one
  function with an `action` (`left_click`, `type`, `key`, `scroll`, `terminate`…), `coordinate`,
  `keys`, `pixels`, `time`. It says the screen is 1000×1000, so coordinates come on the 0–1000 grid
  Qwen-VL and Gemini models point with, whatever the real resolution. Asked for pixels in a
  1280×720 image, qwen3-vl:4b-instruct still wrote grid numbers, so on ten mock Windows screens none
  of its first clicks landed (and four calls didn't fit the old `{x, y}` schema). With this tool,
  nine of ten did. `screenshot` is added, because nothing is captured until the model acts. Blind
  models get only `key`, `type`, `wait`, `terminate` and `answer`.
- **`open_app`**, **`open_url`**, and **`window`** (`list`, `focus`, `maximize`, `minimize`,
  `close`): finding an app or window by name is more reliable for a small model than finding it
  on screen.
- **`browser`**, while the browser extension is connected; `open_url` then opens a tab in it. See
  [Browser](#browser).
- Small models drift from a schema, and each rejected call costs a step. So parsing accepts the
  usual near misses: an action called as a tool of its own, `click` for `left_click`, points as
  `[x, y]`, `{x, y}` or `"(x, y)"`, keys as an array or a string, pyautogui key names (`pgdn`,
  `winleft`), wheel notches or pixels for `pixels`, a URL without `https://`. Anything else
  is an error the model reads.
- Claude uses the current
  [computer toolset](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
  (pixels, explicit screenshots) on supported models, plus `open_app`, `open_url` and `window`.
  Rejected toolsets fall back to the custom tools.

### Acting instead of talking

Every message goes through the tool session while computer control is on, so one request decides
between chatting and acting. The reply format used to tell the model to *start* with an emotion
tag. With that, qwen3-vl:4b-instruct answered none of 12 PC requests with a tool call: it asked
whether it should, or said it was done. The tag's `[` left no room for a tool call. Moving the
rule or rewording it changed nothing; dropping it did.

- With PC tools, the format asks for the tag at the *end* of a reply. The same requests then got 12
  of 12 tool calls, and casual messages still got words (8 of 8). `parseReply` takes the tag
  wherever it is. Without tools, the format is unchanged. Don't move the tag back to the start.
- The note before the latest message says to act rather than ask, or claim it's done.
- The rules give two worked examples ("turn on Bluetooth" means Settings plus its switch; a YouTube
  search means `open_url` with the results address). Without them, the model asked which device
  to connect instead of opening Settings.
- An `answer` or `terminate` before anything has happened is sent back once, telling the model to
  act if that was the request. A second one stands, so a plain question still gets its answer.
- A misplaced call is still taken: another tool named as the action
  (`{"action": "open_app", …}`), the keys themselves (`{"action": "ctrl+w"}`), or fields wrapped
  in another `arguments` object.
- Built-in apps also answer to their English names on any Windows ("Notepad" for "Bloc de notas"),
  matched by AppID, which doesn't change with the language. A website asked for as an app gets
  pointed to `open_url`.

### Sessions

Each adapter owns one typed tool transcript. OpenAI-compatible servers preserve extra assistant
fields, including Gemini thought signatures. Ollama gets capabilities from `/api/show`; local
llama.cpp servers expose `/props`. Other compatible servers get a cached two-color vision check.
Capability checks do not capture the desktop. Tool sessions retain the same conversation history as
ordinary chat. OpenAI and Ollama keep only the latest screenshot; Claude transcripts are
append-only. Compatibility errors before any action fall back to ordinary chat, which retains
empty-reply and repetition retries.

- The first request decides between chatting and acting, at the player's temperature. Once there
  are tool results, requests use at most 0.3: steady coordinates and well-formed calls matter more
  than variety.
- Ollama answers HTTP 500 when the model writes a tool call it can't parse. That's sampling noise,
  so the request is retried up to twice, 0.3 warmer each time. Before, it fell back to ordinary
  chat, where she could claim to have done the task.
- A call a server left in the reply text, in the `<tool_call>` format Qwen and Hermes models write
  (or as a bare JSON reply naming one of the tools), is recovered as a real call. OpenAI-compatible
  transcripts record it as a tool call, because tool results must follow one.

### The loop

`computer/agent.ts` executes batches sequentially and skips later calls after a failure. A task has
no action or time limit: it goes on until the model replies, the player stops it (any input during
desktop actions, or Cancel on the browser's debugging bar), a new message supersedes it, or the
same unchanged action is tried a third time (see below). Each model request keeps its own timeout.
Before the first desktop action, `yieldFocus` hides the plugin popup and returns focus to the
previous app.

With custom tools, the model gets feedback after every batch, which a small model needs to notice a
missed click instead of claiming success:
- One screenshot, after 400 ms (1 s after a launch or window switch). Its caption restates the
  host's request, since by then it may have scrolled far up the transcript, or out of an 8k
  context.
- The active window's title and app.
- "The screen did not change", when the screenshot is identical to the previous one.

Two guards turn a small model's typical mistakes into a message instead of a wrong click:
- Coordinates picked before the model has seen the screen, or after an earlier action in the same
  batch changed it, are refused, and the new screenshot comes with the error.
- An action identical to the previous one, after which the screen did not change, is refused with a
  nudge to try another way. Waiting again is exempt: a slow app often looks the same while it loads.
  A small model can ignore the nudge and retry forever, since tasks have no action limit, so the
  third refusal ends the task, and the model is asked to tell its host what it managed and where it
  got stuck.

`terminate` or `answer` ends the task: the model is asked for its reply, and further calls end the
turn with the answer as the reply.

A message-only window receives queued Raw Input during computer turns. It ignores Lilith's marked
input; player keyboard or mouse input aborts actions and model requests. Raw Input does not block
other apps or silently time out during capture or garbage collection. A new message stops a turn
that has acted; a superseded turn that has not acted still answers without tools. Settings changes
also prevent further actions while preserving ordinary pending replies. Disconnect and shutdown stop
the turn, including provider retry waits. Watcher failures report an error. A stopped task needs a
new request to continue. Only the user message and final reply enter memory.

### Windows

`computer/windows.ts` uses `bun:ffi` with user32, gdi32, kernel32 and dwmapi. Screenshots cover the
primary display, encode opaque RGB PNGs and resize to a maximum edge of 1280 pixels. Input
coordinates are mapped back to physical pixels and normalized across the virtual desktop. Every
capture handle is released, and keys and drag buttons are released when a task stops. Logical mouse
buttons honor Windows' primary-button setting.

- **Apps.** Start apps are matched by localized names, ignoring accents, a trailing `.exe`, and
  extra words around a name ("the Google Chrome browser"). They're launched with argument arrays,
  never a shell command supplied by the model. App lookup enumerates the Shell apps folder with fixed
  inline PowerShell commands and works with Restricted execution policy without loading script
  modules or changing the user's policy.
- **Launches** wait up to five seconds for a new identifiable foreground window; otherwise
  dependent actions fail. After 1.5 s, the window already in front counts if it's the target: for
  an app, its executable is named after it or its title ends with its name, as Windows apps title
  themselves (a browser tab merely about the app doesn't count); for a link, a known browser in
  front whose title changed.
- **Windows.** `window` sees what Alt+Tab shows: visible, uncloaked, unowned top-level windows with a
  title, front to back, except Lilith's own (the game and the popup) and terminals or system tools,
  which she may not open either. Those are recognized by executable and console window class, never
  by title, since a browser tab's title can mention PowerShell. Names match a title or
  executable, whole before partial, frontmost first. Focusing restores a minimized window and sends
  an empty mouse event first, as PowerToys does: Windows only lets the process behind the latest
  input change the foreground window, and an Alt tap would open menu bars. `close` posts `WM_CLOSE`,
  like the window's X, so the app can still ask to save. Without a title, these act only on an app
  window, never the desktop or taskbar, where `WM_CLOSE` means shut down.
- **Guards.** Keyboard input into terminals (including consoles Windows reports under their client,
  such as `python.exe`), system tools, Run dialogs, Start/search hosts, PowerToys command launchers,
  the popup and the game is blocked. The game is often in front once the popup hands focus back, and
  Alt+F4 there would end the companion. Run and Task Manager app launches, Win+R, Win+X, Win+S,
  Win+Q, bare Win and Ctrl+Esc are refused, whatever the key is called. Explorer's address bar,
  command fields inside other apps and terminal mouse-paste actions remain protected by the prompt.
  Asking before consequential actions is a prompt rule, not a native transaction detector. Input into
  elevated apps can be blocked by Windows; a successful input submission cannot prove that an app
  handled it.

The companion remains in the plugin's kill-on-close job. `SILENT_BREAKAWAY_OK` lets processes it
starts survive the game closing. `computerCheck` reports capabilities, and `/api/ping` reports
whether desktop bindings loaded, including in a compiled exe.

For isolated development, `LILITH_AI_FAKE_DESKTOP=1` uses a gray screenshot and records actions
without opening apps or injecting input. Use a temporary `LILITH_AI_DATA_DIR`, disable automatic
updates, run `scripts/mock-llm.ts` on a spare port, and send a message starting with `!` to test a
tool round trip. The fake desktop is never selected unless that environment variable is set.

## Browser

An optional Chromium extension lets her use websites by their elements instead of the screen.
Defined in `companion/src/browser/` and `companion/extension/`. A 4B model picks
`[12] button "Search"` from a list far more reliably than a spot on a screenshot, and a model that
can't see can browse at all. The extension stays as thin as the plugin: transport, pairing and
primitives (look at a tab, click element 12 of document D, type, press keys). Wording, guards and
formatting are in the companion, under `bun test`.

```
background.js  WebSocket ⇄ /api/browser ──► browser/hub.ts      pairing, connections, calls
               chrome.debugger, tabs, groups browser/session.ts  one turn: tab, element numbers, guards, wording
page.js        injected on demand            browser/format.ts   raw page facts → the page she reads
```

- **Installing.** The exe carries the extension: `extension/build.ts` writes
  `dist/browser-extension.txt`, which `build.ts` embeds. At start, the companion writes it to
  `browser-extension\` in the data folder when it's missing or older (never downgrading), with
  `VERSION` last. The player loads that folder unpacked once. An older running extension is told to
  reload itself from it, once per version. Developer mode must stay on: with it off, Chrome turns
  unpacked extensions off (`unsupportedDeveloperExtension`).
- **Finding companions.** Each companion lists its port in the folder's `companions.json`. It drops
  ports that stopped answering, lists itself again every minute (two starting at once can lose an
  entry) and unlists itself on exit. The extension reads the file when it starts, every 30 seconds
  (an alarm wakes it) and when its button is clicked; an unpacked extension reads its files fresh.
  Knocking on all 20 dashboard ports instead put an error on chrome://extensions for every closed
  one, every 30 seconds.
- **Pairing.** 127.0.0.1 is shared by every Windows user, and the extension's ID is public (pinned
  by the manifest's `key`). So the upgrade checks the Host header and the Origin
  (`chrome-extension://<id>`, which webpages can't fake), then both sides prove they know the
  secret in the folder's `pairing.json`: HMAC-SHA256 over the side's role, both nonces and the
  port the extension dialed. The companion proves first, so a stranger on the port learns nothing,
  and the port keeps a stranger from relaying our handshake to the real companion. A port is listed
  only while a companion answers its ping there. An extension that hangs up on the companion's
  proof, or sends a wrong one, makes the dashboard say it isn't paired.
- **A turn.** While the extension is connected, the tool turn offers the `browser` tool and
  `open_url` opens a tab in her "Lilith" tab group. With two browsers, the one focused last gets
  the turn. Browser actions go through Chrome's debugger protocol: real clicks and typing that
  never touch the player's mouse. So they leave the popup up and don't start the input watch, and
  neither does waiting; the player keeps using the PC. Desktop actions still do both. Chrome shows
  its "is debugging this browser" bar from her first input until the turn ends. Cancel there stops
  her: the extension drops her queued calls and won't attach again until the turn ends.
- **Tabs in the background.** Looking, reading, keys and tab pictures work in a tab that isn't the
  one shown, so she doesn't take the player's tab away. A hidden tab drops mouse input, though:
  for a click, clicking into a field or scrolling, her tab comes to the front of its window.
- **Calls.** One at a time, in order. Each carries a deadline (the companion's own timeout), and a
  stopped turn cancels its pending ones. So nothing the model gave up on, like a second form
  submission, happens late.
- **What she sees.** A turn starts on the tab the player is on, the active tab of the last-focused
  window, so "what does this page say?" works. After every batch that used the browser, the result
  carries the page instead of a screenshot: tabs (numbered, hers marked), address, an open dialog's
  elements first, then what's on screen, then what's further down, and headings, in about 2,000
  characters. `read` swaps the elements for the page's text from where it's scrolled to. Models
  that see also get a picture of the tab, at most 1024 px wide, with nothing drawn on it. OpenAI
  and Ollama transcripts keep only the latest page, as with screenshots, and a text-only page stays
  a plain string.
- **Element numbers.** The page script numbers interactive elements per document, stable while an
  element lives, so one batch can fill several fields and click. A number she was never shown is
  refused before it reaches the browser. One from a page that has since been replaced is refused
  by the page ("a new page loaded since you last saw it"). An element under another one (a cookie
  wall) is refused naming the cover, which gets a number. After a page picture, screen coordinates
  are refused as guesses. A call with a ref and no coordinate goes to the browser whatever the tool
  is called: taken as a desktop click, `{"name": "click", "arguments": {"ref": 12}}` would land
  wherever the cursor is. Playwright MCP's and browser-use's names are accepted.
- **Acting.** `type` clicks the field, selects its text and inserts the new text. On a dropdown it
  chooses the option by its words (accents and case ignored) or lists the real options. Keys go to
  the page, not Chrome's window, so browser shortcuts are refused with what to use instead. A click
  that opens a tab takes her there, into her group. Dialogs her actions open (alert, confirm) are
  dismissed and reported.
- **Guards in code.**
  - Only http(s) pages, and never the dashboard, on any loopback name and dashboard port. That
    holds for the desktop `open_url` too: a tab shares the dashboard's saved login, so a page could
    otherwise talk her into changing the AI server.
  - Password values never leave the page, and password fields refuse text.
  - File choosers are refused, and she only closes tabs in her group.
  - Browser pages and the Web Store, which no extension may enter, are reported as such.
- **Hidden windows.** Chrome may not paint a window covered by others. A tab picture that takes
  more than 3 seconds is skipped, and the page text still arrives. A click checks that it reached
  its element, and otherwise clicks it from the page.

For development, run `bun src/main.ts --dev`, which rewrites the folder from source on every start,
then load `browser-extension\` from your `LILITH_AI_DATA_DIR` unpacked and reload it after changes.
`scripts/mock-llm.ts` plays a small model browsing when a message starts with `!b <url>`.

## Game APIs used

| Capability | API |
|---|---|
| say | `DialogueManager.instance.ForceSay(text, emotion, seconds)` |
| busy | `DialogueManager.IsBusyOrAwaitingResponse` (fallback `IsBusy`) |
| state | `CharacterController.s_activeInstance` → `IsIdle`, `IsSleep`, `IsInteracting`, `IsDrag` |
| position | `CharacterController.TryGetCharacterDesktopPoint(out x, out y)` |
| language | `GameSetting.Language` |
| playerName | `Archive.Instance.playerName` |
| tray | `ShowSystemTray.instance.tray.AddItem(label, Il2CppSystem.Action)`, re-added when the game rebuilds the menu |
| card | `NoteImageSaver.SaveNote(text, false)` then `NoteInbox.NotifySaved()` |

Hotkeys use `RegisterHotKey`, so the popup can take keyboard focus from any app. They don't use
Unity's `Input`: the game's click-through overlay is rarely focused, so Unity misses the keys.
Audio doesn't touch the game either: her voice plays through `PlaySound` and the microphone records
through MCI (both `winmm`), alongside Unity's own audio.

## Cards

`companion/src/keepsakes.ts` stores what the player shares; `brain.ts` writes the cards.

- **Keepsakes** are notes and pictures added in the dashboard's Cards tab. Nothing is collected on
  its own. The browser re-encodes each picture to a JPEG of at most 1280 px before upload, which also
  drops EXIF data. The server accepts only JPEGs and serves them back only by id, to the logged-in
  dashboard.
- **Seeing once.** When a picture arrives, the model is asked once for a one-line description (image
  input in all three adapters). Models that can't see just fail that call, and she goes by the
  caption. Everything after that is text, so cards work with any model and pictures aren't re-sent.
- **Reacting.** Sharing runs a normal chat turn with a cue describing what was shared, so she answers
  in her bubble and it lands in her conversation history.
- **Writing.** A card draws on the least recently used keepsake, recent messages and known facts, with
  rules that keep it warm without being unsettling: she speaks only of what was shown or told, never of
  files, AI or memory.
- **Delivering.** The plugin calls the game's own note saver on the main thread and answers `result`,
  which marks the card as in the inbox. Cards written while the game was closed go out on the next
  `hello`.
- **Automatic cards** come at most once every 20 hours. They need a few new messages or something
  newly shared, the player away for 10 minutes, and Lilith idle and awake.

## Updates

`companion/src/updater.ts`, with the file swap in `installer.ts`:

- The copy the game launches (`--bridge`, inside `BepInEx\plugins\LilithAICompanion`) checks
  GitHub Releases a minute after start, then every 6 hours. Betas follow betas and stable releases;
  stable installs only follow stable releases.
- It downloads the release zip and checks it against the `SHA-256` line in the release notes
  (written by `scripts/release.ts`). Only the plugin DLL and the companion exe are replaced. BepInEx
  stays as is, as it does when you reinstall over an existing install.
- The game holds both files open, and Windows lets them be renamed but not overwritten. So each is
  moved aside as `<name>.<time>.old` and the new file takes its place: both or neither. The game uses
  them from its next launch. The `.old` files are deleted the next time the companion starts.
- With **Update automatically** off, or from the downloaded setup exe, the dashboard only shows a
  banner (with **Update now** where possible).
- Caveat: if the companion crashes after an update, the plugin restarts the *new* exe next to the
  *old* DLL. That only matters when `PROTOCOL_VERSION` changed. The player then sees "different
  versions, reinstall the mod", and restarting the game is enough to fix it.

## Dashboard security

The dashboard is a local server that holds API keys, so it is locked down:
- It listens on 127.0.0.1 only.
- The `Host` header is checked, against DNS rebinding.
- Each run gets a fresh session token, delivered in the link the game or the console opens and
  stored as a `SameSite=Strict`, `HttpOnly` cookie.
- Each companion serves on its own port, from 47321 up. Bun can let two processes share a port
  (SO_REUSEPORT on Linux, address reuse on Windows), and then a login link reaches the other
  companion, whose token doesn't match, so the dashboard stays locked. Port sharing is off, and a
  port that already answers is skipped before binding, whatever the platform does.
- RPC calls must be JSON POSTs.
- `/api/browser` takes no cookie: it upgrades only for the pinned extension's Origin, which then has
  to prove it knows the pairing secret (see [Browser](#browser)).
- API keys are never sent back to the browser in full, and are redacted from logs and reports.
