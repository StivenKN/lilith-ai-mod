# Changelog

What changed in each release. Add a line under Unreleased with each change players or maintainers would notice; a release renames Unreleased to its version.

## Unreleased

## 0.1.0-beta.11 (2026-10-12)

- Lilith finishes browser tasks instead of writing the next step for the player, stops a task after 15 actions, and can close the tabs she opened. (#27)

## 0.1.0-beta.10 (2026-10-11)

- Two settings saves at once, from a double click or two open dashboards, no longer lose a change or reset every setting and API key. (#20)
- Web searches stop when Lilith's turn stops, and a PC request that needs a search first asks the AI one time fewer. (#21)
- After you sign in with Google, Lilith can search and read your Gmail, Drive and Calendar to answer questions about them. (#24)
- A new Accounts tab connects a Google account and sets whether Lilith may read its mail, files and calendar. (#25)
- Small local models keep acting on PC and browser requests after the first one instead of only answering in words. (#26)

## 0.1.0-beta.9 (2026-10-09)

- Maintainers have a verify skill that drives the companion like a player, with no game or Windows needed.
- Lilith does a PC request again when you repeat it, instead of saying she already did it. (#22)
- On sites with big menus such as YouTube, Lilith sees the page's content before the sidebar, so she opens the video you asked for. (#23)

## 0.1.0-beta.8 (2026-10-09)

- A browser extension for Chrome, Edge, Brave and other Chromium browsers lets Lilith use websites by their buttons and fields, in your own browser with your logins. (#17)

## 0.1.0-beta.7 (2026-10-08)

- The dashboard no longer stays locked on "Open this page from the game" while another copy of the companion is running.

## 0.1.0-beta.6 (2026-10-08)

- Small local models such as qwen3-vl:4b act on PC requests instead of describing them, click closer to the target, and no longer claim a task is done after a failed tool call. (#16)

## 0.1.0-beta.5 (2026-10-08)

- Zip files work outside Windows too, so developers can run voice downloads, updates and release packaging on Linux and macOS.
- Ollama loads Lilith's model when you open the chat and frees its memory when the game closes or after a few idle minutes, set in AI → Advanced. (#14)
- Lilith's memory is rebuilt for small local models, with a short recent window, a growing summary and notes about you, so she stops repeating the same line. (#15)

## 0.1.0-beta.4 (2026-10-07)

- The in-game chat input is a dark frosted-glass pill with a round send button. (#4)
- The mod updates itself from GitHub Releases, with an "Update automatically" switch in Game → Installation; installs on beta.3 or older need one manual update to get it. (#5)
- Settings saved in one dashboard apply right away to the copy the game is running. (#6)
- You change the chat shortcut by clicking it and pressing the new keys. (#8)
- Lilith can search the web, from your PC with DuckDuckGo or with a Firecrawl key, set in the AI tab. (#7)
- Lilith can use your Windows PC through screenshots, keyboard, mouse and opening apps and websites, set to Automatic, Always or Never in the dashboard. (#10)
- The dashboard is restyled after the game's art. (#9)
- Lilith writes handwritten cards to the game's note inbox from notes and pictures you share in the new Cards tab. (#11)
- The dashboard's tests catch undefined CSS variables that would silently break a style. (#13)
- Lilith can speak her replies and hear you through the microphone (F8), in Spanish or English and all on your PC, set up in the new Voice tab. (#12)

## 0.1.0-beta.3 (2026-10-07)

- Double-clicking LilithAICompanion.exe on Windows opens the setup wizard instead of quitting silently. (#3)

## 0.1.0-beta.2 (2026-10-07)

- The setup wizard and the in-game settings button bring the browser to the front on Windows instead of opening it hidden. (#2)

## 0.1.0-beta.1 (2026-10-07)

- First release: a setup wizard finds the game, installs BepInEx and the mod, and helps you pick an AI (Ollama, LM Studio, an OpenAI-compatible service or Claude), then F7 in game opens a chat with Lilith in the game's language. (#1)
- Releases are built and published by CI without the game installed. (#2)
