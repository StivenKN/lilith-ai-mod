<img src="assets/icon.svg" width="64" height="64" alt="">

# Lilith AI Companion

**English · [Español](README.es.md)**

An unofficial mod for *The NOexistenceN of Lilith* that lets you talk with Lilith. You type, she
answers in her own speech bubble, in character, in your language, and remembers what you tell her.

> Fan-made. Not affiliated with or endorsed by the game's developers or publishers.

## What it does

- **Chat with Lilith.** Press **F7** (rebindable), type, and her reply appears in her speech bubble
  with a matching expression. Long replies are split across several bubbles.
- **Real Spanish support.** Her personality is written natively in Latin American Spanish, not
  translated, and the dashboard and in-game messages are fully localized. She replies in the game's
  language (all 12) or one you pick.
- **Memory.** She follows the conversation and keeps notes about you that you can read, edit and delete.
- **Speaks first** (optional) after a quiet while, never while she's asleep.
- **Your choice of AI:** Ollama on your PC (free, private), OpenAI, Claude, Gemini, DeepSeek,
  OpenRouter, Groq, Mistral, xAI, LM Studio, or any OpenAI-compatible server.
- **Updates itself.** New versions install in the background and take effect the next time you
  start the game (turn it off in **Game → Installation**).
- **Honest errors.** When something fails, she doesn't make up an excuse: the bubble says what broke
  and how to fix it ("The OpenAI API key isn't valid…", "Ollama isn't running…").

## Install

1. Close the game.
2. Download `LilithAICompanion-<version>.zip` from [Releases](https://github.com/StivenKN/lilith-ai-mod/releases) and **extract** it.
3. Open `LilithAICompanion.exe`. A page opens in your browser that finds the game in your Steam
   library, installs BepInEx and the mod, offers to turn off other AI mods that would clash, and
   helps you pick and test an AI.
4. Start the game from Steam. **The first launch takes 1 to 3 minutes** while BepInEx prepares itself.
5. Press **F7** and say hi.

If Windows shows "Windows protected your PC", click **More info**, then **Run anyway** (normal for new,
unsigned programs).

## Privacy

Settings, API keys, memory and logs stay on your PC in `%APPDATA%\LilithAICompanion`. With Ollama or
another local server nothing leaves your PC. With an online service, your message, the recent
conversation, Lilith's persona, her notes about you, the time and your player name go to that
service. To check for updates, the mod asks GitHub for the list of releases every few hours; nothing
about you is sent. The mod never reads your screen, windows or files.

## Uninstall

With the game closed, open `LilithAICompanion.exe` and expand **Uninstall** in the **Install** step,
or delete `BepInEx\plugins\LilithAICompanion` from the game folder. Your data in
`%APPDATA%\LilithAICompanion` stays until you delete it.

## Troubleshooting

Open the dashboard (⚙ in the chat window, or "Lilith AI settings" in the game's tray menu) → **Help**:
common fixes, a **Copy diagnostic report** button (versions, settings with keys masked, recent log, no
conversations), and a live log. The **Game** tab shows which mod features work in your game version.

---

## For developers

```
companion/   TypeScript (Bun): setup wizard, dashboard, AI providers, persona, memory → one .exe
plugin/      C# BepInEx 6 IL2CPP plugin (thin): bubble, chat window, hotkey, game state
packaging/   BepInEx.cfg shipped with releases
docs/        BUILDING.md · ARCHITECTURE.md · WINDOWS-SMOKE-TEST.md
```

```sh
cd companion
pnpm install
pnpm test            # unit + end-to-end bridge tests
pnpm typecheck
bun scripts/mock-llm.ts                         # fake AI (OpenAI + Ollama APIs) on :11555
bun src/main.ts --dev                           # dashboard with hot reload
bun scripts/sim.ts es-419                       # play the game plugin's side in a terminal
bun build.ts                                    # dist/LilithAICompanion.exe
bun scripts/release.ts --plugin <path/to/LilithAICompanion.dll>
```

The plugin builds with or without the game installed; releases are cut by pushing a version tag. See [docs/BUILDING.md](docs/BUILDING.md).
How the pieces fit: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Credits

The game's internal API (speech bubble, character state, language, tray) was learned from the
open-source community mods by **GoodLight999** (Lilith-AI-Mod) and **cza2019**
(The-NOexistenceN-of-Lilith-Mod), and LilithMod by **pat58151** set the feature baseline. This project
shares no code with them.

## License

[MIT](LICENSE), for this project's code. *The NOexistenceN of Lilith* and its characters, text and
art belong to their rights holders and aren't covered. Bundled components keep their own licenses:
see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Contributions are welcome: issues and pull
requests in English or Spanish.
