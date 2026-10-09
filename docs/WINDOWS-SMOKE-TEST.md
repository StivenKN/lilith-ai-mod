# Windows smoke test (about 15 minutes)

Automated tests cover the companion logic and Windows bindings. This checklist checks desktop
behavior and the plugin in the real game. Use the release zip and ideally a Spanish keyboard layout.

Keep two things handy:
- the dashboard's **Help** tab, which has the live log and the diagnostic report;
- `<game>\BepInEx\LogOutput.log`.

| # | Do | Expect |
|---|---|---|
| 1 | Extract the zip, run `LilithAICompanion.exe` with the game closed | Browser opens the setup wizard; game folder detected; install succeeds |
| 2 | Start the game from Steam, wait for the first launch | `LogOutput.log` lists `capability <name>: ok` for say, busy, state, position, language, playerName, card. Write down any that aren't ok, with the reason. |
| 3 | Task Manager → Details | `LilithAICompanion.exe` running, no console window |
| 4 | With a browser focused, press **F7** | Chat popup appears near Lilith, focused, on the right monitor, sharp at 150% scaling. Esc closes it and gives focus back to the browser |
| 5 | Type `¿Qué tal? ñandú, pingüino, ¡acción!` (dead keys and AltGr) and press Enter | Text appears correctly in the popup; the bubble shows "…", then her reply |
| 6 | Check the reply | Spanish characters render in the bubble (no □); an expression plays. A long reply pages through several bubbles |
| 7 | Switch Windows to a Japanese IME, compose text, press Enter | Enter confirms the composition and doesn't send |
| 8 | In the game settings, switch the language between Español and English | The next reply follows. The **Game** tab shows the raw language value; write it down |
| 9 | Set a wrong API key (or stop Ollama), then chat | The bubble and popup show a clear Spanish error: invalid key / Ollama isn't running |
| 10 | Ollama first load: restart Ollama, then chat | The game stays responsive; the popup says the model is loading; the reply arrives (up to 3 min) |
| 11 | Popup ⚙ button; tray menu → "Configuración de Lilith AI" | The dashboard opens in the browser |
| 12 | End `LilithAICompanion.exe` in Task Manager | It restarts within a few seconds (log: "restarting the companion") |
| 13 | End `Lilith.exe` in Task Manager | `LilithAICompanion.exe` disappears too |
| 14 | Dashboard → Game → set the shortcut to a key another app already registered globally (e.g. a screenshot or recording tool's key) | Capability "hotkey" shows ✗ with the reason; picking a free key turns it ✓ |
| 15 | Help → Copy diagnostic report | Report includes versions, capabilities and the BepInEx log tail; no API key visible |
| 16 | Install an older release, then start the game with a newer one published | Within about a minute the dashboard says "Updated to version …"; `LilithAICompanion.*.old` files sit in the mod folder. Restart the game: **Game** shows the new version and the `.old` files are gone |
| 17 | Run the exe again, game closed → Install step → Uninstall | Game starts unmodded |
| 18 | Lilith → Using your PC → Check what she can do, with local AI | Reports vision or blind tools. With cloud AI, Automatic leaves control off; Always enables it. Never disables it for both. |
| 19 | Ask "Abre la calculadora" using its localized Start menu name | Calculator opens. The popup hides and returns focus before keyboard actions. |
| 20 | Open Notepad and ask Lilith to type `¡Hola! ñandú, pingüino` | Accents and punctuation appear correctly; Enter and Tab are real keys. The popup does not submit another message. |
| 21 | Ask a vision model to find something in the browser; repeat with a blind model | Vision model takes a screenshot and clicks accurately. Blind model explains it cannot see and uses only keyboard/app/link tools. |
| 22 | Ask her to type 1000 characters; press a key after 1 second. Move the mouse while she captures a 4K screen, drags or waits for AI | Task stops promptly, held keys/buttons release, and she says she stopped. No delayed app launch follows. Record stop latency; no input lag appears in other apps. |
| 23 | Repeat clicks at 150% DPI and with a monitor to the left of the primary display | Clicks land on the primary-screen targets shown in screenshots. Zoom does not change the coordinate space. |
| 24 | Ask her to open PowerShell, Run/Ejecutar or Task Manager, use Win+R/Win+X/Win+S/Win+Q or Ctrl+Esc, or type while a terminal or Run dialog is focused | Tools return errors; no command is typed. |
| 25 | Close the game after Lilith opens an app or browser | The companion exits; the opened app stays running. |
| 26 | Disable computer control during a task; send another message before and after actions start | Disabling control stops actions. A newer message stops actions already running; an ordinary pending reply still completes after a new message or settings change, and queued old tasks never act. |
| 27 | Ask her to send a message, delete something, buy, enter a password or accept terms | She asks first and ends the turn. Check both English and Spanish prompts. |
| 28 | From both the game and dashboard, ask vision and blind models to open Notepad and type, then open a URL and type. Repeat with launches Windows leaves in the background, Notepad already in front, and a URL while the browser is in front | Input begins only after the target's window is in front: a new window, or after a moment the app already in front, or the browser in front with the link's new tab. Any other launch reports an error and skips dependent actions. No text goes into the game or previous browser. Results name the active window. |
| 29 | Set Windows' primary mouse button to Right; repeat primary click, context click and drag, then restore the setting | Primary clicks activate, context clicks open menus, drags use the primary button and no button remains held. |
| 30 | In the companion source folder, run `bun test src/computer/windows.test.ts -t Restricted`; also test app lookup on an account with Restricted PowerShell policy | The catalog contains names and AppIDs without a script-policy error. The test sets Restricted only for its lookup subprocess; the user's policy is unchanged. |
| 31 | Chat casually with small local tool models in Automatic mode, including a follow-up while a reply is pending | Ordinary conversation completes without tools, focus handoff or desktop actions. |
| 32 | With qwen3-vl:4b-instruct (Ollama), ask: "Abre YouTube en el navegador y busca música lofi" | She opens the browser, clicks the search box (or uses the address bar), types and presses Enter; the results page shows. The log lists one action per step and no "malformed tool call" failures that end the task |
| 33 | With several apps open (one minimized), ask her to switch to the minimized one, maximize it, then go back to the browser | Each window comes to the front; the minimized one is restored. She never targets the game or her popup |
| 34 | Ask her to close Notepad with unsaved text | Notepad asks to save; she asks you what to do instead of choosing |
| 35 | Ask a blind model to list your open windows and switch to one | She names the open windows and switches; each result names the active window |
| 36 | Ask a vision model to click something that does nothing (blank space), several times | The second identical click after an unchanged screen is refused ("you just did exactly this" in the log); she tries another way or says she couldn't |
| 37 | Dashboard → **Cards**: share a note, then add a phone photo | She reacts in the bubble each time; the photo shows "She saw: …" (with a model that can see) |
| 38 | **Cards** → Ask for a card now | The tray's note badge lights up; the inbox shows the card on the game's note paper, accents intact. The dashboard marks it "in the game's inbox" |
| 39 | Dashboard → Voz: turn on «Lilith dice sus respuestas en voz alta», download, press «Escucharla» | The download shows progress and finishes; the browser plays her Spanish voice |
| 40 | Chat in game with the voice on | Each bubble page is spoken, and stays up until she finishes saying it; the game's own music and sounds keep playing |
| 41 | Voz: turn on «Hablarle a Lilith con tu micrófono», download; in game press **F8**, say "Hola Lilith, ¿cómo estás?", press **F8** again | The popup opens saying it's listening, with the mic button lit; then "Dijiste: «…»" and her reply. Her voice stops if you press F8 while she's talking |
| 42 | Windows Settings → Privacy → Microphone: deny desktop apps, then press **F8** | A clear Spanish error about the microphone, in the popup and the bubble |
| 43 | Press **F8** and stay silent for 30 s | Recording stops on its own; "No te entendí…" in the popup, nothing in the bubble |
| 44 | With Ollama: start the game, wait a minute and run `ollama ps`; press **F7**, then run it again | Nothing is loaded before the popup opens; right after, Lilith's model is listed |
| 45 | Close the game, then run `ollama ps` | Her model is no longer listed |
| 46 | **IA → Avanzado**: set «Liberar memoria después de» to 1; chat in game, wait 2 minutes, run `ollama ps` | Her model is gone while the game stays open; the next **F7** loads it again |
| 47 | With local AI, chat in game for 15+ messages: say your name and a few things about yourself, and pause 20 s now and then | Replies don't wait on memory upkeep, and she doesn't end reply after reply with the same line. Dashboard → **Lilith**: «Lo que sabe de ti» lists those facts, and «Lo que recuerda de sus conversaciones» sums up the early messages |
| 48 | **Lilith** → «Resumir ahora», then «Borrar el historial de conversación» | The summary gains lines; clearing empties it and keeps the notes |

## Things to report back

These help tune the defaults:
- How long speech recognition takes with "Preciso" vs "Rápido" on that PC, and whether F8 recordings
  sound clean (`%TEMP%\LilithAICompanion` holds a recording only until it's transcribed).
- Any ✗ capability, with its reason.
- Whether the expression changed with emotion `happy` vs `neutral`. If not, try leaving emotion empty.
  The relevant code is `ForceSay` in `plugin/src/GameApi.cs`.
- Whether the bubble wraps lines on its own. If text overflows or looks cramped, adjust
  **AI → Advanced → bubble line width / lines** and say which values look right.
- Where the popup appears relative to Lilith, especially with multiple monitors or scaling.
- How a long card looks on the note paper (does the text fit, wrap, or get cut?). The length limit is
  `CARD_MAX_CHARS` in `companion/src/prompt.ts`.
