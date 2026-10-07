// Small shared pieces: locale context, form controls, notes, Lilith's bubble.

import { createContext, useContext, type ReactNode } from "react";
import { translator } from "../src/i18n.ts";
import type { UiLocale } from "../src/languages.ts";

export const LocaleContext = createContext<UiLocale>("en");
export const useTr = () => translator(useContext(LocaleContext));
export const useLocale = () => useContext(LocaleContext);

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
