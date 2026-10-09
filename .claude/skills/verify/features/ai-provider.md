# AI provider

On the AI tab the player picks where Lilith's replies come from (Ollama on the PC, an online
service with an API key, or another local server), tests the connection and saves. The new AI
answers from her next reply. Advanced settings (timeouts, temperature, bubble size) and web
search sit on the same tab.

## Sub-features

- `ai-choose` switch between "On your PC with Ollama", "Online service", "Another local server" and the services under each.
- `ai-models` "Show available models" lists the server's models.
- `ai-test` "Test connection" shows "Connected. Lilith answered in N s:" and her sample reply, or the error.
- `ai-save` "Save and use" stores the choice; the next chat uses it.
- `ai-advanced` advanced settings save.
- `ai-search` web search mode (off, DuckDuckGo, Firecrawl).

## How to get to it (user POV)

- Dashboard → AI tab.
- First run: the setup wizard's "Choose Lilith's AI" step shows the same form (see setup-wizard.md).

## Driving it with session.sh, tmux and cdp.ts

Preconditions: any run, doctor passes, dashboard open, `scripts/cdp.ts click "AI"`.

- **Current choice.** The form opens on "Another local server" with "Custom (OpenAI-compatible)" selected and model `mock`.
- **Pick a server.** `scripts/cdp.ts click "Another local server"`, `scripts/cdp.ts click "Custom (OpenAI-compatible)"`, `scripts/cdp.ts click "Server address"` (a `<details>`), `scripts/cdp.ts type "Address" "http://127.0.0.1:$MOCK_PORT/v1"`, `scripts/cdp.ts type "Model" "mock"`. The mock also speaks the Ollama API: "On your PC with Ollama" with address `http://127.0.0.1:$MOCK_PORT` lists its one installed model, `qwen3.5:4b`.
- **Test.** `scripts/cdp.ts click "Test connection"`, `scripts/cdp.ts wait "Connected. Lilith answered in"`. Screenshot to `$EVIDENCE/ai-test.png`.
- **Save.** `scripts/cdp.ts click "Save and use"`, `scripts/cdp.ts wait "Saved. Lilith will use this AI from her next reply."`. `$LILITH_AI_DATA_DIR/config.json` shows the new `provider`.
- **Used next turn.** Send a chat message (chat.md); `$RUN_DIR/mock-llm.log` or the companion log shows the request on the new API.
- **Broken AI.** Set the address to a closed port and Test: an error note names the problem.

## Gotchas

- Clicking a different preset resets the address and model to that preset's defaults; set them after choosing the preset.
- Wait on visible text ("Connected. Lilith answered in"), not on a field's placeholder: `wait` reads rendered text only.
- Online services need real API keys and network: not verifiable here. Report them as skipped.
- Ollama model downloads ("Download" buttons) need a real Ollama: skip.
