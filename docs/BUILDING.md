# Building

Two parts, and both build on any OS:
- **The companion** (`companion/`, TypeScript)
- **The plugin** (`plugin/`, C#). It can build against your installed game, which is best while
  developing, or without the game, using the pinned BepInEx and small reference stand-ins for the
  game's API. CI and releases use the second mode.

## Companion

Requirements: Node 20+ and pnpm. Bun is installed as a dev dependency. Zips are read and written
with bsdtar, which Windows and macOS already include; on Linux install it (`libarchive-tools` on
Debian/Ubuntu, `libarchive` elsewhere), because GNU tar can't handle zip.

```sh
cd companion
pnpm install
pnpm typecheck
pnpm test
bun build.ts           # → dist/LilithAICompanion.exe (Windows x64, cross-compiles from any OS)
bun build.ts --host    # → dist/LilithAICompanion-<os>, to smoke-test locally
```

Icon and version metadata are only embedded when `build.ts` runs on Windows, as it does in CI.

Development loop, no game needed:

```sh
bun scripts/mock-llm.ts                # fake AI: OpenAI API on :11555/v1, Ollama API on :11555
bun src/main.ts --dev                  # dashboard with hot reload (backend changes need a restart)
bun scripts/sim.ts es-419              # act as the game plugin: type to chat, /sleep, /lang en, /settings
```

Set `LILITH_AI_DATA_DIR` to a temporary folder to keep test settings away from your real ones.

Voice: the Voice tab downloads the engines on Windows only. Elsewhere, point the companion at
engines you installed yourself, then download voices and models from the tab as usual:

```sh
export LILITH_AI_PIPER=/path/to/piper            # e.g. `pip install piper-tts` in a venv
export LILITH_AI_WHISPER=/path/to/whisper-cli    # built from whisper.cpp
bun scripts/sim.ts es-419                        # then /voice some-recording.wav
```

## Plugin

You need the .NET 8 SDK.

**Without the game** (what CI does):

```sh
cd companion && bun scripts/pinned.ts bepinex dist/bepinex && cd ..
dotnet build plugin/LilithAICompanion.csproj -c Release -p:BepInExDir="$PWD/companion/dist/bepinex" -p:UseReferenceStubs=true
```

`plugin/reference/` holds reference-only stand-ins for `Assembly-CSharp`, `UnityEngine.CoreModule` and
`Il2Cppmscorlib`. Each declares exactly the members the plugin calls, nothing more.
- They are never shipped.
- In the game, the plugin binds by assembly, type and member name to the real interop DLLs that
  BepInEx generated.
- If the game no longer has a member, only the capability that uses it turns off, and the reason
  appears in the log and the dashboard's Game tab.

**Against your installed game**, which catches API changes at compile time:
1. Install the mod once (or extract the pinned BepInEx into the game folder).
2. Start the game until it's fully on screen, so BepInEx generates `BepInEx\interop\*.dll`. The first
   launch takes 1–3 minutes.
3. Build against the game folder. Either pass it on the command line:

   ```sh
   dotnet build plugin/LilithAICompanion.csproj -c Release -p:GameDir="C:\Program Files (x86)\Steam\steamapps\common\The NOexistenceN of Lilith"
   ```

   or create a git-ignored `plugin/Directory.Build.props`:

   ```xml
   <Project><PropertyGroup><GameDir>D:\SteamLibrary\steamapps\common\The NOexistenceN of Lilith</GameDir></PropertyGroup></Project>
   ```

The output is `plugin/bin/Release/net6.0/LilithAICompanion.dll`.

### When the game updates

`plugin/src/GameApi.cs` is the only file that uses game types, and `reference/Assembly-CSharp/Game.cs`
mirrors exactly those members.
1. Build against the game. If something was renamed, the compiler error points at one tiny method.
2. Fix that method.
3. Update the stand-in to match, so CI builds stay in sync.

`IsBusy` is the fallback for `IsBusyOrAwaitingResponse`. If either is gone, delete that method and
its use.

### Quick test without a release

1. Copy `LilithAICompanion.dll` into `<game>\BepInEx\plugins\LilithAICompanion\`.
2. Put `companion/dist/LilithAICompanion.exe` next to it.
3. Start the game.

## Bridge harness (CI)

`plugin/harness` compiles the plugin's `Bridge.cs`, `Native.cs` and `Protocol.cs` into a console
app, and drives the real exe without the game. It checks:
- the handshake;
- Spanish text both ways (UTF-8);
- that closing stdin stops the companion;
- on Windows, that killing the host also kills the companion (job object).

```sh
bun scripts/mock-llm.ts 11555 &
dotnet run --project plugin/harness -c Release -- companion/dist/LilithAICompanion.exe http://127.0.0.1:11555/v1
```

## Release

Releases are built and published by `.github/workflows/release.yml` on Windows, with no game needed:

1. Bump the versions:
   - `companion/package.json` (the release version, e.g. `0.2.0` or `0.2.0-beta.1`);
   - `plugin/LilithAICompanion.csproj` `<Version>` and `Plugin.Version` in `plugin/src/Plugin.cs`
     (plain `x.y.z`).
   - If the protocol changed, also bump `PROTOCOL_VERSION` / `Protocol.Version` on both sides.
2. Merge to `main`.
3. Tag and push. The tag must match `package.json`:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

4. The workflow then:
   - runs the tests;
   - builds the exe and the plugin;
   - runs the bridge harness;
   - assembles `LilithAICompanion-<version>.zip` with the pinned, checksum-verified BepInEx and
     Unity libraries;
   - publishes the GitHub release with Spanish and English install notes.

   Tags with a `-` (e.g. `-beta.1`) are published as pre-releases.

   Installed copies pick the release up on their own within a few hours (see
   [ARCHITECTURE.md](ARCHITECTURE.md#updates)). If you edit the release notes by hand, keep the
   `SHA-256` line: the updater skips releases without it.

To build the zip locally instead:

```sh
cd companion
bun build.ts
bun scripts/release.ts --plugin ../plugin/bin/Release/net6.0/LilithAICompanion.dll
```

Before announcing a release:
1. Run [WINDOWS-SMOKE-TEST.md](WINDOWS-SMOKE-TEST.md).
2. Check the exe on VirusTotal. Unsigned exes are often flagged by machine-learning heuristics.
3. Ideally, code-sign it and submit it to Microsoft's false-positive portal.
