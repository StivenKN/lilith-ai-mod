// Small shared pieces: locale context, form controls, notes, Lilith's bubble.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Hotkey } from "../src/config.ts";
import { translator } from "../src/i18n.ts";
import type { UiLocale } from "../src/languages.ts";

export const LocaleContext = createContext<UiLocale>("en");
export const useTr = () => translator(useContext(LocaleContext));
export const useLocale = () => useContext(LocaleContext);

/** Human-readable shortcut, e.g. "Ctrl + Shift + F7". */
export const hotkeyLabel = (hotkey: Hotkey) =>
  [hotkey.ctrl && "Ctrl", hotkey.alt && "Alt", hotkey.shift && "Shift", hotkey.key].filter(Boolean).join(" + ");

/** Labelled control. Pass `id` (and put it on the input) when the field also contains buttons. */
export function Field(props: { label: string; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="field">
      {props.id ? (
        <>
          <label htmlFor={props.id}>{props.label}</label>
          {props.children}
        </>
      ) : (
        <label>
          {props.label}
          {props.children}
        </label>
      )}
      {props.hint ? <small>{props.hint}</small> : null}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>
        {props.label}
        {props.hint ? <small className="hint" style={{ display: "block" }}>{props.hint}</small> : null}
      </span>
    </label>
  );
}

export function Note(props: { tone?: "ok" | "warn" | "error"; children: ReactNode; detail?: string | undefined }) {
  const tr = useTr();
  return (
    <div className="note" data-tone={props.tone} role={props.tone === "error" ? "alert" : undefined}>
      {props.children}
      {props.detail ? (
        <details>
          <summary>{tr("ui.technicalDetails")}</summary>
          <pre>{props.detail}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** Lilith speaking, drawn like her in-game speech bubble. */
export function Bubble(props: { text: string; meta?: string | undefined }) {
  return (
    <div className="bubble">
      {props.text}
      {props.meta ? <small>{props.meta}</small> : null}
    </div>
  );
}

export function ThinkingBubble() {
  return (
    <div className="bubble thinking" aria-live="polite">
      <span>●</span> <span>●</span> <span>●</span>
    </div>
  );
}

export type Mark = boolean | "warn";
export function Check(props: { ok: Mark; children: ReactNode }) {
  return (
    <li data-ok={String(props.ok)}>
      <span className="mark" aria-hidden>
        {props.ok === true ? "✓" : props.ok === "warn" ? "!" : "✗"}
      </span>
      <span>{props.children}</span>
    </li>
  );
}

const sameHotkey = (a: Hotkey, b: Hotkey) => a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;

type Feedback = "saved" | "unsupported" | "letter" | "taken";

/**
 * Shows the current shortcut; click it, then press the new combination and it saves right away.
 * Only keys the plugin can register are accepted (F1–F24, A–Z, 0–9, matched by physical key),
 * and a bare letter or number is refused because it would swallow that key in every other app.
 * `taken` is a shortcut it must not collide with (the chat and voice hotkeys can't share one).
 */
export function HotkeyRecorder(props: { hotkey: Hotkey; taken?: { hotkey: Hotkey; message: string } | undefined; onSave: (hotkey: Hotkey) => Promise<void> }) {
  const tr = useTr();
  const [hotkey, setHotkey] = useState(props.hotkey);
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState({ ctrl: false, alt: false, shift: false });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const { onSave, taken } = props;

  useEffect(() => setHotkey(props.hotkey), [props.hotkey]);

  useEffect(() => {
    if (!recording) return;
    const stop = () => {
      setRecording(false);
      setFeedback(null);
      setHeld({ ctrl: false, alt: false, shift: false });
    };
    const onKey = (event: KeyboardEvent) => {
      // Keep the browser from acting on the combination (F5 reload, Alt menu, Ctrl+F…).
      event.preventDefault();
      event.stopPropagation();
      const modifiers = { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey };
      setHeld(modifiers);
      if (event.type !== "keydown" || ["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
      if (event.code === "Escape") return stop();

      const key = event.code.replace(/^(Key|Digit)/, "");
      if (!/^(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9])$/.test(key)) return setFeedback("unsupported");
      if (key.length === 1 && !modifiers.ctrl && !modifiers.alt && !modifiers.shift) return setFeedback("letter");
      const next = { key, ...modifiers };
      if (taken && sameHotkey(next, taken.hotkey)) return setFeedback("taken");

      stop();
      setHotkey(next);
      void onSave(next).then(() => setFeedback("saved"));
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", stop);
    };
  }, [recording, onSave, taken]);

  const pending = [held.ctrl && "Ctrl", held.alt && "Alt", held.shift && "Shift", "…"].filter(Boolean).join(" + ");
  const warning = feedback === "letter" ? tr("game.hotkeyLetterWarning") : feedback === "unsupported" ? tr("game.hotkeyUnsupported") : feedback === "taken" ? taken?.message : null;

  return (
    <>
      <div className="row">
        <button
          className={recording ? "hotkey recording" : "hotkey"}
          aria-pressed={recording}
          onClick={() => {
            setFeedback(null);
            setRecording(!recording);
          }}
        >
          <kbd>{recording ? pending : hotkeyLabel(hotkey)}</kbd>
        </button>
        <span className="hint">
          {recording ? tr("game.hotkeyRecording") : feedback === "saved" ? tr("common.saved") : tr("game.hotkeyChange")}
        </span>
      </div>
      {warning && (
        <Note tone="warn">
          <p>{warning}</p>
        </Note>
      )}
    </>
  );
}
