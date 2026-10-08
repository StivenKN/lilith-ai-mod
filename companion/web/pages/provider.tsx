import { useEffect, useState } from "react";
import { presets, type PresetId } from "../../src/providers/presets.ts";
import type { ModelInfo } from "../../src/providers/types.ts";
import { call, type Output } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Bubble, Field, Note, useTr } from "../ui.tsx";
import { SearchSettings } from "./search.tsx";

const cloudPresets = ["openai", "anthropic", "gemini", "deepseek", "openrouter", "groq", "mistral", "xai"] as const satisfies PresetId[];
const otherLocalPresets = ["lmstudio", "custom"] as const satisfies PresetId[];
type Kind = "ollama" | "cloud" | "otherLocal";
const kindOf = (preset: PresetId): Kind =>
  preset === "ollama" ? "ollama" : (otherLocalPresets as readonly PresetId[]).includes(preset) ? "otherLocal" : "cloud";

/** Models we suggest downloading in Ollama: good Spanish, run on ordinary gaming PCs. */
const recommended = [
  { id: "qwen3.5:9b", size: "6.6 GB", noteKey: "provider.recommendedBest" },
  { id: "qwen3.5:4b", size: "3.4 GB", noteKey: "provider.recommendedLight" },
] as const;

type TestResult = Output<"testProvider">;

export function ProviderForm(props: { overview: Overview; onSaved: () => void; saveLabel: string }) {
  const tr = useTr();
  const saved = props.overview.config.provider;
  const [preset, setPreset] = useState<PresetId>(saved.preset);
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
  const [model, setModel] = useState(saved.model);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [ollama, setOllama] = useState<Output<"ollamaStatus"> | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<"models" | "test" | "save" | null>(null);

  const info = presets[preset];
  const kind = kindOf(preset);
  const storedKey = props.overview.config.apiKeys[preset];
  const input = { preset, baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };

  const choosePreset = (next: PresetId) => {
    setPreset(next);
    setBaseUrl(presets[next].baseUrl);
    setModel(next === saved.preset ? saved.model : presets[next].defaultModel);
    setApiKey("");
    setModels(null);
    setModelsError(null);
    setTest(null);
  };

  const checkOllama = async () => {
    const status = await call("ollamaStatus", { baseUrl });
    setOllama(status);
    setModels(status.version ? status.models : null);
    if (status.models.length > 0 && !status.models.some((m) => m.id === model)) setModel(status.models[0]!.id);
  };

  useEffect(() => {
    if (preset === "ollama") void checkOllama();
  }, [preset]);

  const loadModels = async () => {
    setBusy("models");
    const result = await call("listModels", input);
    setBusy(null);
    if (result.ok) {
      setModels(result.models);
      setModelsError(null);
    } else {
      setModelsError(result.detail);
    }
  };

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    setTest(await call("testProvider", input));
    setBusy(null);
  };

  const save = async () => {
    setBusy("save");
    await call("saveSettings", {
      provider: { preset, baseUrl, model, configured: true },
      ...(apiKey.trim() ? { apiKeys: { [preset]: apiKey.trim() } } : {}),
    });
    setBusy(null);
    setApiKey("");
    props.onSaved();
  };

  const missingKey = info.needsKey && !apiKey.trim() && !storedKey;

  return (
    <div>
      <div className="choices" role="radiogroup">
        {(["ollama", "cloud", "otherLocal"] as const).map((option) => (
          <label className="choice" key={option}>
            <input
              type="radio"
              name="kind"
              checked={kind === option}
              onChange={() => choosePreset(option === "ollama" ? "ollama" : option === "cloud" ? "openai" : "lmstudio")}
            />
            <span>
              <strong>{tr(`provider.kind.${option}`)}</strong>
              <span className="hint">{tr(`provider.kind.${option}.hint`)}</span>
            </span>
          </label>
        ))}
      </div>

      {kind !== "ollama" && (
        <div className="provider-list" role="radiogroup" aria-label={tr("provider.service")}>
          {(kind === "cloud" ? cloudPresets : otherLocalPresets).map((id) => (
            <label key={id}>
              <input type="radio" name="preset" checked={preset === id} onChange={() => choosePreset(id)} />
              {presets[id].label}
            </label>
          ))}
        </div>
      )}

      {preset === "ollama" && <OllamaStatus baseUrl={baseUrl} status={ollama} onRecheck={checkOllama} onPulled={(id) => void checkOllama().then(() => setModel(id))} />}

      {(info.needsKey || preset === "custom") && (
        <Field
          label={tr("provider.apiKey")}
          hint={
            <>
              {storedKey ? tr("provider.keySaved", { key: storedKey }) : tr("provider.keyPrivacy")}{" "}
              {info.needsKey && (
                <a href={info.helpUrl} target="_blank" rel="noreferrer">
                  {tr("provider.getKey", { provider: info.label })}
                </a>
              )}
            </>
          }
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={storedKey ? tr("provider.keyReplacePlaceholder") : tr("provider.keyPlaceholder")}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
      )}

      {kind === "otherLocal" && (
        <p className="hint">
          {tr("provider.otherLocalHelp")}{" "}
          <a href={info.helpUrl} target="_blank" rel="noreferrer">
            {info.label}
          </a>
        </p>
      )}

      <Field id="model" label={tr("provider.model")} hint={models ? tr("provider.modelsAvailable", { count: models.length }) : preset === "ollama" ? tr("provider.modelHintOllama") : tr("provider.modelHint")}>
        <div className="row">
          <input id="model" className="grow" list="model-options" value={model} spellCheck={false} onChange={(event) => setModel(event.target.value)} />
          {preset !== "ollama" && (
            <button className="secondary" disabled={busy !== null || missingKey} onClick={() => void loadModels()}>
              {tr("provider.loadModels")}
            </button>
          )}
        </div>
        <datalist id="model-options">
          {models?.map((option) => <option key={option.id} value={option.id} />)}
        </datalist>
      </Field>
      {models && model && models.length > 0 && !models.some((option) => option.id === model) && (
        <Note tone="warn">
          <p>{tr("provider.modelNotListed", { model })}</p>
        </Note>
      )}
      {modelsError && (
        <Note tone="error" detail={modelsError}>
          <p>{tr("provider.modelsFailed")}</p>
        </Note>
      )}

      <details>
        <summary>{tr("provider.advancedAddress")}</summary>
        <Field label={tr("provider.baseUrl")} hint={tr("provider.baseUrlHint")}>
          <input value={baseUrl} spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} />
        </Field>
      </details>

      <div className="row" style={{ marginTop: 18 }}>
        <button className="secondary" disabled={busy !== null || !model || missingKey} onClick={() => void runTest()}>
          {busy === "test" ? tr("provider.testing") : tr("provider.test")}
        </button>
        <button className="primary" disabled={busy !== null || !model || missingKey} onClick={() => void save()}>
          {props.saveLabel}
        </button>
      </div>
      {missingKey && <p className="hint">{tr("provider.needKey")}</p>}

      {test?.ok === true && (
        <div style={{ marginTop: 18 }}>
          <Note tone="ok">
            <p>{tr("provider.testOk", { seconds: (test.latencyMs / 1000).toFixed(1) })}</p>
          </Note>
          <div className="screen">
            <div className="transcript" style={{ minHeight: 0 }}>
              <Bubble text={test.text} meta={test.model} />
            </div>
          </div>
        </div>
      )}
      {test?.ok === false && (
        <Note tone="error" detail={test.error.detail}>
          <p>{test.error.message}</p>
        </Note>
      )}
    </div>
  );
}

function OllamaStatus(props: { baseUrl: string; status: Output<"ollamaStatus"> | null; onRecheck: () => Promise<void>; onPulled: (model: string) => void }) {
  const tr = useTr();
  const [pull, setPull] = useState<{ model: string; percent: number | null; status: string; error?: string } | null>(null);
  if (!props.status) return <p className="hint">{tr("provider.ollamaChecking")}</p>;

  const download = async (model: string) => {
    setPull({ model, percent: null, status: tr("provider.downloadStarting") });
    const response = await fetch("/api/ollama/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: props.baseUrl, model }),
    });
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
        if (event.error) return setPull({ model, percent: null, status: "", error: event.error });
        if (event.status === "done") {
          setPull(null);
          return props.onPulled(model);
        }
        setPull({
          model,
          percent: event.total && event.completed ? Math.round((event.completed / event.total) * 100) : null,
          status: event.status ?? "",
        });
      }
    }
  };

  if (!props.status.version) {
    return (
      <Note tone="warn">
        <p>{tr("provider.ollamaMissing", { url: props.baseUrl })}</p>
        <ol>
          <li>{tr("provider.ollamaStep1")}</li>
          <li>{tr("provider.ollamaStep2")}</li>
          <li>{tr("provider.ollamaStep3")}</li>
        </ol>
        <div className="row">
          <a className="button" href="https://ollama.com/download" target="_blank" rel="noreferrer">
            {tr("provider.ollamaDownload")}
          </a>
          <button className="quiet" onClick={() => void props.onRecheck()}>
            {tr("provider.recheck")}
          </button>
        </div>
      </Note>
    );
  }

  const installed = new Set(props.status.models.map((model) => model.id));
  return (
    <>
      <Note tone="ok">
        <p>{tr("provider.ollamaRunning", { version: props.status.version, count: props.status.models.length })}</p>
      </Note>
      <h3>{tr("provider.recommendedTitle")}</h3>
      <ul className="checklist">
        {recommended.map((option) => (
          <li key={option.id} data-ok={installed.has(option.id) ? "true" : "warn"}>
            <span className="mark" aria-hidden>
              {installed.has(option.id) ? "✓" : "↓"}
            </span>
            <span className="row">
              <span className="grow">
                <strong>{option.id}</strong> ({option.size}). {tr(option.noteKey)}
              </span>
              {!installed.has(option.id) && (
                <button className="secondary" disabled={pull !== null} onClick={() => void download(option.id)}>
                  {tr("provider.download")}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {pull && !pull.error && (
        <div>
          <p className="hint">
            {tr("provider.downloading", { model: pull.model })} {pull.status} {pull.percent !== null ? `${pull.percent}%` : ""}
          </p>
          <div className="progress">
            <div style={{ width: `${pull.percent ?? 2}%` }} />
          </div>
        </div>
      )}
      {pull?.error && (
        <Note tone="error" detail={pull.error}>
          <p>{tr("provider.downloadFailed", { model: pull.model })}</p>
        </Note>
      )}
    </>
  );
}

/** The AI tab: provider form, web search, and the advanced knobs. */
export function ProviderPage(props: { overview: Overview; refresh: () => void }) {
  const tr = useTr();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  return (
    <>
      <h1>{tr("provider.title")}</h1>
      <p>{tr("provider.intro")}</p>
      <ProviderForm
        overview={props.overview}
        saveLabel={tr("provider.save")}
        onSaved={() => {
          setSavedAt(Date.now());
          props.refresh();
        }}
      />
      {savedAt && (
        <Note tone="ok">
          <p>{tr("provider.saved")}</p>
        </Note>
      )}
      <SearchSettings overview={props.overview} refresh={props.refresh} />
      <AdvancedSettings overview={props.overview} refresh={props.refresh} />
    </>
  );
}

function AdvancedSettings(props: { overview: Overview; refresh: () => void }) {
  const tr = useTr();
  const [advanced, setAdvanced] = useState(props.overview.config.advanced);
  const [saved, setSaved] = useState(false);
  const number = (key: keyof typeof advanced, value: string) => {
    setSaved(false);
    setAdvanced({ ...advanced, [key]: value === "" ? null : Number(value) });
  };
  const save = async () => {
    await call("saveSettings", { advanced });
    setSaved(true);
    props.refresh();
  };
  return (
    <>
      <h2>{tr("advanced.title")}</h2>
      <p className="hint">{tr("advanced.intro")}</p>
      <div className="fields">
        <div>
          <Field label={tr("advanced.timeout")} hint={tr("advanced.timeoutHint")}>
            <input type="number" min={10} max={600} value={advanced.timeoutSeconds ?? ""} placeholder={tr("advanced.auto")} onChange={(event) => number("timeoutSeconds", event.target.value)} />
          </Field>
        </div>
        {props.overview.config.provider.preset === "ollama" && (
          <div>
            <Field label={tr("advanced.unloadAfter")} hint={tr("advanced.unloadAfterHint")}>
              <input type="number" min={1} max={240} value={advanced.unloadAfterMinutes} onChange={(event) => number("unloadAfterMinutes", event.target.value)} />
            </Field>
          </div>
        )}
        <div>
          <Field label={tr("advanced.temperature")} hint={tr("advanced.temperatureHint")}>
            <input type="number" min={0} max={2} step={0.1} value={advanced.temperature} onChange={(event) => number("temperature", event.target.value)} />
          </Field>
        </div>
        <div>
          <Field label={tr("advanced.maxChars")} hint={tr("advanced.maxCharsHint")}>
            <input type="number" min={60} max={600} value={advanced.maxReplyChars} onChange={(event) => number("maxReplyChars", event.target.value)} />
          </Field>
        </div>
        <div>
          <Field label={tr("advanced.bubbleWidth")} hint={tr("advanced.bubbleWidthHint")}>
            <input type="number" min={12} max={80} value={advanced.bubbleLineUnits} onChange={(event) => number("bubbleLineUnits", event.target.value)} />
          </Field>
        </div>
        <div>
          <Field label={tr("advanced.bubbleLines")}>
            <input type="number" min={1} max={8} value={advanced.bubbleLines} onChange={(event) => number("bubbleLines", event.target.value)} />
          </Field>
        </div>
      </div>
      <div className="row">
        <button className="secondary" onClick={() => void save()}>
          {tr("advanced.save")}
        </button>
        {saved && <span className="hint">{tr("common.saved")}</span>}
      </div>
    </>
  );
}
