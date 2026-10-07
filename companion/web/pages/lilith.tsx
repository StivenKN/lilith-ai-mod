import { useEffect, useState } from "react";
import type { SettingsPatch } from "../../src/config.ts";
import { languageCodes, languages, type Language } from "../../src/languages.ts";
import { call, useRpc } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Field, Toggle, useTr } from "../ui.tsx";

export function LilithPage(props: { overview: Overview; refresh: () => void }) {
  const tr = useTr();
  const { config } = props.overview;
  const persona = useRpc("persona");
  const notes = useRpc("notes");
  const [personaText, setPersonaText] = useState("");
  const [notesText, setNotesText] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (persona.data) setPersonaText(persona.data.custom ?? persona.data.builtIn);
  }, [persona.data]);
  useEffect(() => {
    if (notes.data) setNotesText(notes.data.join("\n"));
  }, [notes.data]);

  const saveSettings = async (patch: SettingsPatch) => {
    await call("saveSettings", patch);
    props.refresh();
  };
  const flash = (message: string) => {
    setStatus(message);
    setTimeout(() => setStatus(null), 2500);
  };

  const savePersona = async (custom: string | null) => {
    await saveSettings({ persona: { custom } });
    await persona.reload();
    flash(custom === null ? tr("lilith.personaRestored") : tr("common.saved"));
  };

  return (
    <>
      <h1>{tr("lilith.title")}</h1>

      <Field label={tr("lilith.replyLanguage")} hint={tr("lilith.replyLanguageHint", { language: props.overview.languageName })}>
        <select
          value={config.replyLanguage}
          onChange={(event) => void saveSettings({ replyLanguage: event.target.value as Language | "auto" })}
        >
          <option value="auto">{tr("lilith.followGame")}</option>
          {languageCodes.map((code) => (
            <option key={code} value={code}>
              {languages[code].native}
            </option>
          ))}
        </select>
      </Field>

      <h2>{tr("lilith.personaTitle")}</h2>
      <p className="hint">{tr("lilith.personaIntro")}</p>
      <textarea style={{ minHeight: 280 }} value={personaText} onChange={(event) => setPersonaText(event.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="secondary" onClick={() => void savePersona(personaText.trim() === persona.data?.builtIn.trim() ? null : personaText)}>
          {tr("lilith.personaSave")}
        </button>
        {persona.data?.custom !== null && (
          <button className="quiet" onClick={() => void savePersona(null)}>
            {tr("lilith.personaRestore")}
          </button>
        )}
        {status && <span className="hint">{status}</span>}
      </div>

      <h2>{tr("lilith.notesTitle")}</h2>
      <p className="hint">{tr("lilith.notesIntro")}</p>
      <textarea value={notesText} placeholder={tr("lilith.notesPlaceholder")} onChange={(event) => setNotesText(event.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="secondary"
          onClick={() =>
            void call("saveNotes", { notes: notesText.split("\n") }).then(async () => {
              await notes.reload();
              flash(tr("common.saved"));
            })
          }
        >
          {tr("lilith.notesSave")}
        </button>
      </div>

      <h2>{tr("lilith.behaviorTitle")}</h2>
      <Toggle
        checked={config.features.learnFacts}
        onChange={(learnFacts) => void saveSettings({ features: { learnFacts } })}
        label={tr("lilith.learnFacts")}
        hint={tr("lilith.learnFactsHint")}
      />
      <Toggle
        checked={config.features.speakFirst}
        onChange={(speakFirst) => void saveSettings({ features: { speakFirst } })}
        label={tr("lilith.speakFirst")}
        hint={tr("lilith.speakFirstHint")}
      />
      {config.features.speakFirst && (
        <Field label={tr("lilith.speakFirstMinutes")}>
          <input
            type="number"
            min={5}
            max={240}
            defaultValue={config.features.speakFirstMinutes}
            onBlur={(event) => void saveSettings({ features: { speakFirstMinutes: Number(event.target.value) || 30 } })}
          />
        </Field>
      )}

      <h2>{tr("lilith.historyTitle")}</h2>
      <p className="hint">{tr("lilith.historyIntro")}</p>
      <button
        className="secondary danger"
        onClick={() => {
          if (confirm(tr("lilith.historyConfirm"))) void call("clearHistory").then(() => flash(tr("lilith.historyCleared")));
        }}
      >
        {tr("lilith.historyClear")}
      </button>
    </>
  );
}
