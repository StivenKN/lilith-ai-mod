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
        ├─ voice       Piper (speech) · whisper.cpp (recognition), short-lived local processes
        └─ dashboard   Bun.serve on 127.0.0.1:47321+ → React app (setup wizard, settings, help)

%APPDATA%\LilithAICompanion\   config.json · memory.json · keepsakes.json · keepsakes\*.jpg · logs\lilith-ai.log · voice\
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
4. It calls the provider with the persona, the context (time, her state, the player's name, notes)
   and the last 20 turns.
   - Timeouts are explicit: 60 s, or 180 s while a local model loads.
   - 429 and 5xx errors get one retry.
   - A 400 that names a parameter drops or renames that parameter and retries.
   - With web search on, the prompt lets the model answer with only `[search: query]` (or
     `[buscar: …]`). The companion runs that search (`search.ts`), shows "searching the web" in the
     popup, and asks again with the top results in the system prompt. A failed search is logged and
     the model is told it got nothing, so she still answers. This works with every provider because
     it needs no tool-calling support.
5. It shapes the reply:
   - strips `<think>` blocks, markdown, emoji and stage directions;
   - reads the `[emotion]` tag (Spanish or English);
   - trims to length;
   - if the reply was empty because the model only reasoned, retries once with a 4× token budget;
   - if it's a near-repeat, retries once with a nudge.
6. It wraps the reply for the bubble (CJK counts as double width), splits it into pages, and sends
   `say` per page, paced by reading time.
7. On failure, the error is classified (auth, billing, model not found, rate limit, timeout,
   unreachable…). The player sees a localized, actionable message in the bubble and the popup; the
   technical detail goes to the log and the dashboard.

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

Each adapter owns one typed tool transcript. Claude uses the current
[computer toolset](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
on supported models and custom function tools otherwise. Rejected toolsets fall back to custom
tools. OpenAI-compatible servers preserve extra assistant fields, including Gemini thought
signatures. Ollama gets capabilities from `/api/show`; local llama.cpp servers expose `/props`.
Other compatible servers get a cached two-color vision check. Capability checks do not capture
the desktop. Tool sessions retain the same conversation history as ordinary chat. OpenAI and
Ollama keep only the latest screenshot; Claude transcripts are append-only. Compatibility errors
before any action fall back to ordinary chat, which retains empty-reply and repetition retries.

The loop executes batches sequentially, skips later calls after a failure, and caps each task at
20 actions or 180 seconds after the first tool call, so model loading uses the provider timeout.
Before the first action, `yieldFocus` hides the plugin popup and returns focus to the previous app.
A message-only window receives queued Raw Input during computer turns. It ignores Lilith's
marked input; player keyboard or mouse input aborts actions and model requests. Raw Input does
not block other apps or silently time out during capture or garbage collection. A new message
stops a turn that has acted; a superseded turn that has not acted still answers without tools.
Settings changes also prevent further actions while preserving ordinary pending replies.
Disconnect and shutdown stop the turn, including provider retry waits. Watcher failures report an error.
A stopped task needs a new request to continue. Only the user message and final reply enter memory.

`computer/windows.ts` uses `bun:ffi` with user32, gdi32 and kernel32. Screenshots cover the primary
display, encode opaque RGB PNGs and resize to a maximum edge of 1280 pixels. Input coordinates are
mapped back to physical pixels and normalized across the virtual desktop. Every capture handle
is released, and keys and drag buttons are released when a task stops. Start apps are matched
by localized names and launched with argument arrays, never a shell command supplied by the model.
App lookup enumerates the Shell apps folder with fixed inline PowerShell commands and works with
Restricted execution policy without loading script modules or changing the user's policy.
App and URL launches wait up to five seconds for an identifiable foreground window to change;
otherwise dependent actions fail. Opening a target already in the foreground can therefore
report a focus error. Blind keyboard results report the focused executable. Logical mouse buttons
honor Windows' primary-button setting.
Keyboard input into terminals, system tools, Run dialogs, Start/search hosts, PowerToys command
launchers and the popup is blocked; Run and Task Manager app launches, Win+R, Win+X, Win+S, Win+Q,
bare Win and Ctrl+Esc are refused.
Explorer's address bar, command fields inside other apps and terminal mouse-paste actions remain
protected by the prompt. Asking before consequential
actions is a prompt rule, not a native transaction detector. Input into elevated apps can be
blocked by Windows; a successful input submission cannot prove that an app handled it.

The companion remains in the plugin's kill-on-close job. `SILENT_BREAKAWAY_OK` lets processes it
starts survive the game closing. `computerCheck` reports capabilities, and `/api/ping` reports
whether desktop bindings loaded, including in a compiled exe.

For isolated development, `LILITH_AI_FAKE_DESKTOP=1` uses a gray screenshot and records actions
without opening apps or injecting input. Use a temporary `LILITH_AI_DATA_DIR`, disable automatic
updates, run `scripts/mock-llm.ts` on a spare port, and send a message starting with `!` to test a
tool round trip. The fake desktop is never selected unless that environment variable is set.

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
- RPC calls must be JSON POSTs.
- API keys are never sent back to the browser in full, and are redacted from logs and reports.
