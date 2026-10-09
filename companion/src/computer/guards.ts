import type { Action } from "./actions.ts";
import { parseKeys, parseModifiers } from "./keys.ts";

export interface Foreground { exe: string; className: string; title: string }

/** The game (closing it ends this companion too) and the chat popup. Window actions never target them. */
export const ownWindow = (window: Pick<Foreground, "exe" | "className">): boolean =>
  /^lilith(aicompanion)?\.exe$/i.test(window.exe) || window.className === "LilithAICompanionChat";

const blockedExe = /^(cmd|conhost|powershell|pwsh|windowsterminal|wt|regedit|mmc|wscript|cscript|mshta|bash|wsl|mintty|taskmgr|searchhost|searchapp|startmenuexperiencehost|powertoys\.powerlauncher|microsoft\.cmdpal\.ui)(\.exe)?$/i;
const blockedName = /\b(command prompt|powershell|terminal|regedit|registry editor|editor del registro|símbolo del sistema|simbolo del sistema|mmc|wsl|bash|task manager|administrador de tareas|powertoys run|command palette|paleta de comandos)\b/i;

/** Consoles go by class too: Windows reports a console window under its client, such as python.exe. */
export const terminalWindow = (window: Pick<Foreground, "exe" | "className">): boolean =>
  blockedExe.test(window.exe) || /ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS/i.test(window.className);

export function blockedApp(name: string, id = ""): boolean {
  return /^(run|ejecutar)$/i.test(name.trim()) || /RunDialog/i.test(id)
    || blockedName.test(name) || blockedExe.test(name) || id.split(/[\\/!]/).some((part) => blockedExe.test(part));
}

/** Check resolved virtual keys too, so aliases such as win+r cannot bypass the guard. */
export function guardAction(action: Action, foreground: Foreground): void {
  const keyboard = action.type === "type" || action.type === "key" || ("modifiers" in action && !!action.modifiers);
  const shellDialog = foreground.exe.toLowerCase() === "explorer.exe" && foreground.className === "#32770";
  // The game is often in front once the popup hands focus back, and alt+F4 there would end this companion.
  if (keyboard && (ownWindow(foreground) || terminalWindow(foreground) || shellDialog)) {
    throw new Error("Keyboard input is disabled in Lilith's own windows, terminals and system tools. Bring an app to the front first, with open_app or window");
  }
  if (keyboard && (!foreground.exe || !foreground.className)) throw new Error("Could not identify the focused app; keyboard input was refused");
  if (action.type === "openApp" && blockedApp(action.name)) throw new Error("Opening terminals and system tools is disabled");
  if (action.type === "window" && action.op !== "list" && action.op !== "focus" && action.title === null && ownWindow(foreground)) {
    throw new Error("The active window is Lilith's own. Name the window to act on, or focus another window first");
  }
  if (action.type === "key") {
    for (const combo of parseKeys(action.combo)) {
      if ("vk" in combo.key && ([0x5b, 0x5c].includes(combo.key.vk) || combo.key.vk === 0x1b && combo.modifiers.some((key) => [0x11, 0xa2, 0xa3].includes(key.vk)))) {
        throw new Error("Opening Start with keyboard shortcuts is disabled; use open_app");
      }
      if (combo.modifiers.some((key) => key.vk === 0x5b || key.vk === 0x5c) && "vk" in combo.key && [0x52, 0x58, 0x53, 0x51].includes(combo.key.vk)) {
        throw new Error("Win+R, Win+X, Win+S and Win+Q are disabled");
      }
    }
  }
  if ("modifiers" in action) parseModifiers(action.modifiers);
}
