import { useEffect, useRef, useState } from "react";
import type { Config, SettingsPatch } from "../../src/config.ts";
import { languageCodes, languages, type Language } from "../../src/languages.ts";
import { call, useRpc, type Output } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Field, Toggle, useTr } from "../ui.tsx";

export function LilithPage(props: { overview: Overview; tick: number; refresh: () => void }) {
  const tr = useTr();
  const { config } = props.overview;
  const persona = useRpc("persona");
  const memory = useRpc("memory");
  const [personaText, setPersonaText] = useState("");
  const [notesText, setNotesText] = useState("");
  const [summaryText, setSummaryText] = useState("");
  /** What the boxes last showed from the server, to tell the player's edits from background updates. */
  const shown = useRef({ notes: "", summary: "" });
  const [summarizing, setSummarizing] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [computer, setComputer] = useState<Output<"computerCheck"> | null>(null);
  const checkVersion = useRef(0);

  useEffect(() => {
    checkVersion.current++;
    setComputer(null);
    setChecking(false);
    return () => { checkVersion.current++; };
  }, [config.provider.baseUrl, config.provider.model, config.provider.preset, config.apiKeys[config.provider.preset]]);

  useEffect(() => {
    if (persona.data) setPersonaText(persona.data.custom ?? persona.data.builtIn);
  }, [persona.data]);
  // She updates her notes and summary in the background: show the new ones, except in a box the player is editing.
  useEffect(() => {
    void memory.reload();
  }, [props.tick]);
  useEffect(() => {
    if (!memory.data) return;
    const next = { notes: memory.data.notes.join("\n"), summary: memory.data.summary };
    // Updaters run later, during render: compare with what was shown before this update.
    const previous = shown.current;
    shown.current = next;
    setNotesText((current) => (current === previous.notes ? next.notes : current));
    setSummaryText((current) => (current === previous.summary ? next.summary : current));
  }, [memory.data]);

  const saveSettings = async (patch: SettingsPatch) => {
    await call("saveSettings", patch);
    props.refresh();
  };
  const flash = (message: string) => {
    setStatus(message);
    setTimeout(() => setStatus(null), 2500);
  };

  const summarizeNow = async () => {
    setSummarizing(true);
    setMemoryStatus(null);
    try {
      const result = await call("summarizeNow");
      if (result.error) setMemoryStatus(tr("lilith.summarizeFailed", { message: result.error.message }));
      else setMemoryStatus(tr(result.summarized > 0 ? "lilith.summarized" : "lilith.nothingToSummarize"));
      await memory.reload();
    } catch (error) {
      setMemoryStatus(tr("lilith.summarizeFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSummarizing(false);
    }
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
            void call("saveNotes", { notes: notesText.split("\n") }).then(async (notes) => {
              setNotesText(notes.join("\n"));
              await memory.reload();
              flash(tr("common.saved"));
            })
          }
        >
          {tr("lilith.notesSave")}
        </button>
      </div>

      <h2>{tr("lilith.summaryTitle")}</h2>
      <p className="hint">{tr("lilith.summaryIntro")}</p>
      <textarea value={summaryText} placeholder={tr("lilith.summaryEmpty")} onChange={(event) => setSummaryText(event.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="secondary"
          onClick={() =>
            void call("saveSummary", { summary: summaryText }).then(async (summary) => {
              setSummaryText(summary);
              await memory.reload();
              flash(tr("common.saved"));
            })
          }
        >
          {tr("lilith.summarySave")}
        </button>
        <button className="quiet" disabled={summarizing || !config.provider.configured} onClick={() => void summarizeNow()}>
          {tr(summarizing ? "lilith.summarizing" : "lilith.summarizeNow")}
        </button>
        {memoryStatus && <span role="status" className="hint">{memoryStatus}</span>}
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

      <h2>{tr("computer.title")}</h2>
      <Field label={tr("computer.mode")}>
        <select value={config.features.computerControl} onChange={(event) => void saveSettings({ features: { computerControl: event.target.value as Config["features"]["computerControl"] } })}>
          <option value="auto">{tr("computer.auto")}</option>
          <option value="on">{tr("computer.on")}</option>
          <option value="off">{tr("computer.off")}</option>
        </select>
      </Field>
      <p className="hint">{tr("computer.privacy")}</p>
      {!props.overview.brain.computer.enabled && <p className="hint">{tr("computer.disabled")}</p>}
      <button className="secondary" disabled={checking} onClick={() => {
        const version = ++checkVersion.current;
        setChecking(true);
        void call("computerCheck").then((result) => {
          if (version === checkVersion.current) setComputer(result);
        }).catch((error: unknown) => {
          if (version === checkVersion.current) setComputer({ available: false, tools: false, vision: false, reason: error instanceof Error ? error.message : String(error) });
        }).finally(() => { if (version === checkVersion.current) setChecking(false); });
      }}>{tr(checking ? "computer.checking" : "computer.check")}</button>
      {(() => {
        const state = computer ?? props.overview.brain.computer;
        if (!state.available || state.reason) return <p role="status" className="hint">{tr("computer.unavailable", { reason: state.reason ?? "" })}</p>;
        if (state.tools === undefined) return null;
        return <p role="status" className="hint">{tr(!state.tools ? "computer.noTools" : state.vision ? "computer.vision" : "computer.blind")}</p>;
      })()}

      <h2>{tr("lilith.historyTitle")}</h2>
      <p className="hint">{tr("lilith.historyIntro")}</p>
      <button
        className="secondary danger"
        onClick={() => {
          if (confirm(tr("lilith.historyConfirm"))) {
            void call("clearHistory").then(async () => {
              setSummaryText("");
              await memory.reload();
              flash(tr("lilith.historyCleared"));
            });
          }
        }}
      >
        {tr("lilith.historyClear")}
      </button>
    </>
  );
}
