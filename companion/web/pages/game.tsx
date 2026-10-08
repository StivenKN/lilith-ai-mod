import { resolveLanguage, languages } from "../../src/languages.ts";
import { CAP_OFF, capabilityNames } from "../../src/protocol.ts";
import { call } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Check, HotkeyRecorder, Note, Toggle, useTr } from "../ui.tsx";

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
                <Check key={name} ok={status === "ok" || (status === CAP_OFF && "warn")}>
                  {tr(`cap.${name}`)}
                  {status && status !== "ok" ? <span className="hint"> {status === CAP_OFF ? tr("game.capOff") : status}</span> : null}
                </Check>
              );
            })}
          </ul>
        </>
      )}

      <h2>{tr("game.hotkeyTitle")}</h2>
      <p className="hint">{tr("game.hotkeyIntro")}</p>
      <HotkeyRecorder
        hotkey={config.hotkey}
        taken={config.voice.listen ? { hotkey: config.voice.hotkey, message: tr("voice.hotkeySameAsChat") } : undefined}
        onSave={async (hotkey) => {
          await call("saveSettings", { hotkey });
          props.refresh();
        }}
      />

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

