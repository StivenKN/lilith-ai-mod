import { useState } from "react";
import { resolveLanguage, languages } from "../../src/languages.ts";
import { capabilityNames } from "../../src/protocol.ts";
import { call } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Check, Field, Note, useTr } from "../ui.tsx";

const keys = [...Array.from({ length: 12 }, (_, i) => `F${i + 1}`), ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), ..."0123456789".split("")];

export function GamePage(props: { overview: Overview; refresh: () => void; openWizard: () => void }) {
  const tr = useTr();
  const { brain, config } = props.overview;
  const hello = brain.hello;
  const [hotkey, setHotkey] = useState(config.hotkey);
  const [saved, setSaved] = useState(false);
  const language = resolveLanguage(brain.state?.langRaw);

  const saveHotkey = async () => {
    await call("saveSettings", { hotkey });
    setSaved(true);
    props.refresh();
  };

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
      <div className="row">
        {(["ctrl", "alt", "shift"] as const).map((modifier) => (
          <label key={modifier} className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={hotkey[modifier]}
              onChange={(event) => {
                setSaved(false);
                setHotkey({ ...hotkey, [modifier]: event.target.checked });
              }}
            />
            {modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"}
          </label>
        ))}
        <select
          style={{ width: "auto" }}
          value={hotkey.key}
          aria-label={tr("game.hotkeyKey")}
          onChange={(event) => {
            setSaved(false);
            setHotkey({ ...hotkey, key: event.target.value });
          }}
        >
          {keys.map((key) => (
            <option key={key}>{key}</option>
          ))}
        </select>
        <button className="secondary" onClick={() => void saveHotkey()}>
          {tr("game.hotkeySave")}
        </button>
        {saved && <span className="hint">{tr("common.saved")}</span>}
      </div>
      {!hotkey.ctrl && !hotkey.alt && !hotkey.shift && /^[A-Z0-9]$/.test(hotkey.key) && (
        <Note tone="warn">
          <p>{tr("game.hotkeyLetterWarning")}</p>
        </Note>
      )}

      <h2>{tr("game.installTitle")}</h2>
      <p className="hint">{tr("game.installIntro")}</p>
      <button className="secondary" onClick={props.openWizard}>
        {tr("game.openInstaller")}
      </button>
    </>
  );
}
