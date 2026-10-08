import type { Action } from "./actions.ts";
import { parseKeys, parseModifiers } from "./keys.ts";

export interface Foreground { exe: string; className: string }

const blockedExe = /^(cmd|conhost|powershell|pwsh|windowsterminal|wt|regedit|mmc|wscript|cscript|mshta|bash|wsl|mintty|taskmgr|searchhost|searchapp|startmenuexperiencehost|powertoys\.powerlauncher|microsoft\.cmdpal\.ui)(\.exe)?$/i;
const blockedName = /\b(command prompt|powershell|terminal|regedit|registry editor|editor del registro|símbolo del sistema|simbolo del sistema|mmc|wsl|bash|task manager|administrador de tareas|powertoys run|command palette|paleta de comandos)\b/i;

export function blockedApp(name: string, id = ""): boolean {
  return /^(run|ejecutar)$/i.test(name.trim()) || /RunDialog/i.test(id)
    || blockedName.test(name) || blockedExe.test(name) || id.split(/[\\/!]/).some((part) => blockedExe.test(part));
}

/** Check resolved virtual keys too, so aliases such as win+r cannot bypass the guard. */
export function guardAction(action: Action, foreground: Foreground): void {
  const keyboard = action.type === "type" || action.type === "key" || ("modifiers" in action && !!action.modifiers);
  const shellDialog = foreground.exe.toLowerCase() === "explorer.exe" && foreground.className === "#32770";
  if (keyboard && (foreground.className === "LilithAICompanionChat" || blockedExe.test(foreground.exe) || shellDialog || /ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS/i.test(foreground.className))) {
    throw new Error("Keyboard input is disabled in the chat popup, terminals and system tools");
  }
  if (keyboard && (!foreground.exe || !foreground.className)) throw new Error("Could not identify the focused app; keyboard input was refused");
  if (action.type === "openApp" && blockedApp(action.name)) throw new Error("Opening terminals and system tools is disabled");
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
