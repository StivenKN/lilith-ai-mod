# Windows smoke test (about 10 minutes)

Everything except the game-facing plugin is covered by automated tests. This checklist covers the
rest on a real PC. Use the release zip, the game on Steam, and ideally a Spanish keyboard layout.

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

## Things to report back

These help tune the defaults:
- Any ✗ capability, with its reason.
- Whether the expression changed with emotion `happy` vs `neutral`. If not, try leaving emotion empty.
  The relevant code is `ForceSay` in `plugin/src/GameApi.cs`.
- Whether the bubble wraps lines on its own. If text overflows or looks cramped, adjust
  **AI → Advanced → bubble line width / lines** and say which values look right.
- Where the popup appears relative to Lilith, especially with multiple monitors or scaling.
