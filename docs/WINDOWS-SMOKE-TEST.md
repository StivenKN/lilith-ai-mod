# Windows smoke test (about 10 minutes)

Automated tests cover the companion logic and Windows bindings. This checklist checks desktop
behavior and the plugin in the real game. Use the release zip and ideally a Spanish keyboard layout.

Keep two things handy:
- the dashboard's **Help** tab, which has the live log and the diagnostic report;
- `<game>\BepInEx\LogOutput.log`.

| # | Do | Expect |
|---|---|---|
| 1 | Extract the zip, run `LilithAICompanion.exe` with the game closed | Browser opens the setup wizard; game folder detected; install succeeds |
| 2 | Start the game from Steam, wait for the first launch | `LogOutput.log` lists `capability <name>: ok` for say, busy, state, position, language, playerName. Write down any that aren't ok, with the reason. |
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
| 28 | From both the game and dashboard, ask vision and blind models to open Notepad and type, then open a URL and type. Repeat with launches Windows leaves in the background and a target already focused | Input begins only after a different identifiable window takes focus. A launch without that change reports an error and skips dependent actions. No text goes into the game or previous browser. Blind results name the focused executable. |
| 29 | Set Windows' primary mouse button to Right; repeat primary click, context click and drag, then restore the setting | Primary clicks activate, context clicks open menus, drags use the primary button and no button remains held. |
| 30 | In the companion source folder, run `bun test src/computer/windows.test.ts -t Restricted`; also test app lookup on an account with Restricted PowerShell policy | The catalog contains names and AppIDs without a script-policy error. The test sets Restricted only for its lookup subprocess; the user's policy is unchanged. |
| 31 | Chat casually with small local tool models in Automatic mode, including a follow-up while a reply is pending | Ordinary conversation completes without tools, focus handoff or desktop actions. |

## Things to report back

These help tune the defaults:
- Any ✗ capability, with its reason.
- Whether the expression changed with emotion `happy` vs `neutral`. If not, try leaving emotion empty.
  The relevant code is `ForceSay` in `plugin/src/GameApi.cs`.
- Whether the bubble wraps lines on its own. If text overflows or looks cramped, adjust
  **AI → Advanced → bubble line width / lines** and say which values look right.
- Where the popup appears relative to Lilith, especially with multiple monitors or scaling.
