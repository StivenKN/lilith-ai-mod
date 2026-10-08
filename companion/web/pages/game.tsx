import { useEffect, useState } from "react";
import type { Hotkey } from "../../src/config.ts";
import { resolveLanguage, languages } from "../../src/languages.ts";
import { capabilityNames } from "../../src/protocol.ts";
import { call } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Check, Note, Toggle, hotkeyLabel, useTr } from "../ui.tsx";

export function GamePage(props: { overview: Overview; refresh: () => void; openWizard: () => void }) {
  const tr = useTr();
  const { brain, config } = props.overview;
  const hello = brain.hello;
  const language = resolveLanguage(brain.state?.langRaw);

  return (
    <>
      <h1>{tr("game.title")}</h1>
      {brain.connected && hello ? (
        <Note tone="ok">
          <p>{tr("game.connected")}</p>
        </Note>
      ) : (
        <Note tone="warn">
          <p>{tr("game.notConnected")}</p>
        </Note>
      )}

      {hello && (
        <dl className="facts">
          <dt>{tr("game.gameVersion")}</dt>
          <dd>{hello.gameVersion}</dd>
          <dt>{tr("game.modVersion")}</dt>
          <dd>
            {hello.pluginVersion} / {props.overview.app.version}
          </dd>
          <dt>BepInEx</dt>
          <dd>{hello.bepinexVersion}</dd>
          <dt>{tr("game.gameLanguage")}</dt>
          <dd>
            {language ? languages[language].native : tr("game.languageUnknown")} ({brain.state?.langRaw || "?"})
          </dd>
          <dt>{tr("game.folder")}</dt>
          <dd>{hello.gameDir}</dd>
        </dl>
      )}

      {hello && (
        <>
          <h2>{tr("game.capabilitiesTitle")}</h2>
          <p className="hint">{tr("game.capabilitiesIntro")}</p>
          <ul className="checklist">
            {capabilityNames.map((name) => {
              const status = hello.caps[name];
              return (
                <Check key={name} ok={status === "ok"}>
                  {tr(`cap.${name}`)}
                  {status && status !== "ok" ? <span className="hint"> {status}</span> : null}
                </Check>
              );
            })}
          </ul>
        </>
      )}

      <h2>{tr("game.hotkeyTitle")}</h2>
      <p className="hint">{tr("game.hotkeyIntro")}</p>
      <HotkeyRecorder hotkey={config.hotkey} refresh={props.refresh} />

      <h2>{tr("game.installTitle")}</h2>
      <p className="hint">{tr("game.installIntro")}</p>
      <Toggle
        checked={config.features.autoUpdate}
        label={tr("game.autoUpdate")}
        hint={tr("game.autoUpdateHint")}
        onChange={(autoUpdate) => void call("saveSettings", { features: { autoUpdate } }).then(props.refresh)}
      />
      <button className="secondary" onClick={props.openWizard}>
        {tr("game.openInstaller")}
      </button>
    </>
  );
}

type Feedback = "saved" | "unsupported" | "letter";

/**
 * Shows the current shortcut; click it, then press the new combination and it saves right away.
 * Only keys the plugin can register are accepted (F1–F24, A–Z, 0–9, matched by physical key),
 * and a bare letter or number is refused because it would swallow that key in every other app.
 */
function HotkeyRecorder(props: { hotkey: Hotkey; refresh: () => void }) {
  const tr = useTr();
  const [hotkey, setHotkey] = useState(props.hotkey);
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState({ ctrl: false, alt: false, shift: false });
  const [feedback, setFeedback] = useState<Feedback | null>(null);

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
      stop();
      setHotkey(next);
      void call("saveSettings", { hotkey: next }).then(() => {
        setFeedback("saved");
        props.refresh();
      });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", stop);
    };
  }, [recording, props.refresh]);

  const pending = [held.ctrl && "Ctrl", held.alt && "Alt", held.shift && "Shift", "…"].filter(Boolean).join(" + ");

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
      {(feedback === "unsupported" || feedback === "letter") && (
        <Note tone="warn">
          <p>{tr(feedback === "letter" ? "game.hotkeyLetterWarning" : "game.hotkeyUnsupported")}</p>
        </Note>
      )}
    </>
  );
}
