// Plays the game plugin's side of the bridge in a terminal, so the whole chat loop can be tried
// without the game (or Windows).   bun scripts/sim.ts [langRaw]     (default "es-419")
// Type a message to chat. Commands: /sleep, /wake, /busy, /free, /lang <code>, /settings, /quit,
// /voice <file.wav> (send a copy of a recording, as the microphone hotkey does)
// Cards written from the dashboard's Cards tab are printed as they reach the simulated inbox.

import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLineDecoder } from "../src/bridge.ts";
import { PROTOCOL_VERSION, type CompanionMessage } from "../src/protocol.ts";

const state = { idle: true, sleep: false, busy: false, interacting: false, drag: false, langRaw: process.argv[2] ?? "es-419", playerName: "Simulador" };

const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "--bridge"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});
const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
const sendState = () => send({ type: "state", ...state });

const show = (message: CompanionMessage) => {
  switch (message.type) {
    case "ready":
      console.log(`\x1b[2m[ready] dashboard: ${message.dashboardUrl}\x1b[0m`);
      return;
    case "chatStatus":
      console.log(`\x1b[2m[${message.kind}] ${message.text ?? ""}\x1b[0m`);
      return;
    case "say":
      console.log(`\x1b[35m💬 (${message.emotion}, ${message.seconds}s)\x1b[0m\n${message.text}${message.audio ? `\n\x1b[2m🔊 ${message.audio}\x1b[0m` : ""}\n`);
      send({ type: "result", id: message.id, ok: true });
      return;
    case "card":
      console.log(`\x1b[33m💌 card in the inbox\x1b[0m\n${message.text}\n`);
      send({ type: "result", id: message.id, ok: true });
      return;
  }
};
const lines = createLineDecoder((line) => show(JSON.parse(line) as CompanionMessage));
void (async () => {
  for await (const chunk of child.stdout) lines.push(chunk);
})();

sendState();
send({
  type: "hello",
  v: PROTOCOL_VERSION,
  pluginVersion: "sim",
  gameVersion: "sim",
  unityVersion: "2021.3.45",
  bepinexVersion: "sim",
  gameDir: "",
  caps: { say: "ok", busy: "ok", position: "simulated", state: "ok", language: "ok", playerName: "ok", tray: "simulated", hotkey: "simulated", chatWindow: "simulated", card: "ok", voiceHotkey: "simulated" },
});

console.log("Simulated game connected. Type to talk to Lilith (/quit to exit).");
for await (const input of console) {
  const text = input.trim();
  if (!text) continue;
  const [command, argument] = text.split(/\s+/);
  if (command === "/quit") break;
  else if (command === "/sleep" || command === "/wake") (state.sleep = command === "/sleep"), sendState();
  else if (command === "/busy" || command === "/free") (state.busy = command === "/busy"), sendState();
  else if (command === "/lang" && argument) (state.langRaw = argument), sendState();
  else if (command === "/settings") send({ type: "action", name: "dashboard" });
  else if (command === "/voice" && argument) {
    // The companion deletes what it's sent, so send a copy.
    const copy = join(tmpdir(), `lilith-sim-${Date.now()}.wav`);
    await copyFile(resolve(argument), copy);
    send({ type: "voice", path: copy });
  }
  else send({ type: "chat", text });
}
child.stdin.end();
await child.exited;
