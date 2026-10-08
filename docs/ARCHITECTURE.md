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
        └─ dashboard   Bun.serve on 127.0.0.1:47321+ → React app (setup wizard, settings, help)

%APPDATA%\LilithAICompanion\   config.json · memory.json · logs\lilith-ai.log
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

## A chat turn

1. The player presses F7, the popup opens next to Lilith, and they type and press Enter. The plugin
   sends `chat`.
2. The companion queues the turn. Turns are serialized: one request in flight at a time.
3. The companion shows the thinking state: `chatStatus thinking`, plus `say "…"` in her bubble.
   - After 8 s it adds "still thinking", or "loading the model" for local AI.
4. It calls the provider with the persona, the context (time, her state, the player's name, notes)
   and the last 20 turns.
   - Timeouts are explicit: 60 s, or 180 s while a local model loads.
   - 429 and 5xx errors get one retry.
   - A 400 that names a parameter drops or renames that parameter and retries.
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

## Protocol

Defined in `companion/src/protocol.ts` (Zod) and mirrored in `plugin/src/Protocol.cs`.

| plugin → companion | companion → plugin |
|---|---|
| `state{idle, sleep, busy, interacting, drag, langRaw, playerName}` | `ready{v, version, dashboardUrl, hotkey, strings}` |
| `hello{v, pluginVersion, gameVersion, unityVersion, bepinexVersion, gameDir, caps}` | `say{id, text, emotion, seconds}` |
| `chat{text}` | `chatStatus{kind: idle\|thinking\|error, text?}` |
| `action{name: "dashboard"}` · `result{id, ok, error?}` · `log{level, msg}` | |

Bump `PROTOCOL_VERSION` on both sides for breaking changes. On a version mismatch, the companion exits
with code 2 and the plugin shows "reinstall the mod" instead of restarting it.

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

Hotkeys use `RegisterHotKey`, so the popup can take keyboard focus from any app. They don't use
Unity's `Input`: the game's click-through overlay is rarely focused, so Unity misses the keys.

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
