# Building

There are two parts:
- **The companion** (`companion/`, TypeScript) builds anywhere.
- **The plugin** (`plugin/`, C#) builds only on a Windows PC with the game installed, because it
  compiles against interop DLLs that BepInEx generates from your copy of the game.

## Companion

Requirements: Node 20+ and pnpm. Bun is installed as a dev dependency, so nothing else is needed.

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

## Plugin

Requirements: Windows, the .NET 8 SDK, and the game installed through Steam.

1. Give the game BepInEx and run it once, so BepInEx generates `BepInEx\interop\*.dll`. The easiest
   way is to run a release's `LilithAICompanion.exe` and install. Or extract the pinned BepInEx build
   (URL and SHA-256 in `companion/scripts/release.ts`) into the game folder. Then start the game and
   wait until it's fully on screen; the first launch takes 1–3 minutes.
2. Point the build at the game. Either pass it on the command line:

   ```sh
   cd plugin
   dotnet build -c Release -p:GameDir="C:\Program Files (x86)\Steam\steamapps\common\The NOexistenceN of Lilith"
   ```

   or create a `plugin/Directory.Build.props` (it's git-ignored):

   ```xml
   <Project><PropertyGroup><GameDir>D:\SteamLibrary\steamapps\common\The NOexistenceN of Lilith</GameDir></PropertyGroup></Project>
   ```
3. The output is `plugin/bin/Release/net6.0/LilithAICompanion.dll`.

### If it doesn't compile

`plugin/src/GameApi.cs` is the only file that names game types.
- The members it uses come from what the community mods used in game builds 24273498+ (1.0.x–1.1.0).
- If the game renamed something, the compiler error points at exactly one method. Fix it there and
  keep the method tiny.
- `IsBusy` is the fallback for `IsBusyOrAwaitingResponse`. If either no longer exists, delete that
  method and its use.

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

On the Windows PC that built the plugin:

```sh
cd companion
bun build.ts
bun scripts/release.ts --plugin ..\plugin\bin\Release\net6.0\LilithAICompanion.dll
```

This downloads the pinned BepInEx and Unity libraries and refuses them if the checksums don't match.
It then writes `dist/release/LilithAICompanion-<version>.zip`, laid out as:

```
LilithAICompanion-<version>/
  LilithAICompanion.exe
  LEEME - README.txt
  payload/bepinex/ · payload/unity-libs/2021.3.45.zip · payload/BepInEx.cfg · payload/plugin/LilithAICompanion.dll · payload/VERSION
```

Before publishing:
1. Run [WINDOWS-SMOKE-TEST.md](WINDOWS-SMOKE-TEST.md).
2. Check the exe on VirusTotal. Unsigned exes are often flagged by machine-learning heuristics.
3. Ideally, code-sign it and submit it to Microsoft's false-positive portal.

Bump the version in three places:
- `companion/package.json`
- `plugin/LilithAICompanion.csproj` (`<Version>`)
- `Plugin.Version` in `plugin/src/Plugin.cs`

If the protocol changes, bump `PROTOCOL_VERSION` / `Protocol.Version` on both sides.
