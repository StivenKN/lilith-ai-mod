// The Voice tab: turn speaking and listening on, download what they need, pick and try her voice,
// and try the microphone. Everything here runs on the player's PC.

import { useState } from "react";
import type { Config } from "../../src/config.ts";
import { languages } from "../../src/languages.ts";
import { componentBytes, sttModelIds, voiceIdsFor, voices, type ComponentId, type SpokenLanguage, type VoiceOf } from "../../src/voice/catalog.ts";
import { call, useRpc, type Output } from "../api.ts";
import type { Overview } from "../app.tsx";
import { play, transcribe, useMicrophone } from "../microphone.ts";
import { Field, hotkeyLabel, HotkeyRecorder, Note, Toggle, useTr } from "../ui.tsx";

type VoiceStatus = Output<"voiceStatus">;
const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
const sizeOf = (ids: readonly ComponentId[]) => megabytes(ids.reduce((sum, id) => sum + componentBytes(id), 0));

export function VoicePage(props: { overview: Overview; refresh: () => void }) {
  const tr = useTr();
  const status = useRpc("voiceStatus");
  const { config } = props.overview;
  const voice = config.voice;

  const save = async (patch: Partial<Config["voice"]>) => {
    await call("saveSettings", { voice: patch });
    props.refresh();
    await status.reload();
  };

  if (!status.data) return null;
  const { installed, spokenLanguage, lastVoiceError } = status.data;
  const voiceFor = (language: SpokenLanguage) => (language === "es" ? voice.esVoice : voice.enVoice);
  const speakNeeds: ComponentId[] = ["piper", ...(spokenLanguage ? [`voice:${voiceFor(spokenLanguage)}` as const] : [])];
  const listenNeeds: ComponentId[] = ["whisper", `stt:${voice.sttModel}`];
  const replyLanguage = languages[props.overview.brain.replyLanguage].native;

  return (
    <>
      <h1>{tr("voice.title")}</h1>
      <p>{tr("voice.intro")}</p>
      {!status.data.supported && (
        <Note tone="warn">
          <p>{tr("voice.unsupported")}</p>
        </Note>
      )}

      <h2>{tr("voice.speakTitle")}</h2>
      <Toggle checked={voice.speak} onChange={(speak) => void save({ speak })} label={tr("voice.speak")} hint={tr("voice.speakHint")} />
      {voice.speak && <Downloads ids={speakNeeds} status={status.data} onDone={status.reload} />}

      <Field
        label={tr("voice.language")}
        hint={voice.language === "auto" ? tr("voice.languageAutoHint", { language: replyLanguage }) : tr("voice.languageFixedHint")}
      >
        <select value={voice.language} onChange={(event) => void save({ language: event.target.value as Config["voice"]["language"] })}>
          <option value="auto">{tr("voice.languageAuto")}</option>
          <option value="es">{languages.es.native}</option>
          <option value="en">{languages.en.native}</option>
        </select>
      </Field>
      {voice.speak && !spokenLanguage && (
        <Note tone="warn">
          <p>{tr("voice.noVoiceForLanguage", { language: replyLanguage })}</p>
        </Note>
      )}

      <VoicePicker language="es" selected={voice.esVoice} installed={installed} onSelect={(esVoice) => void save({ esVoice })} onDownloaded={status.reload} />
      <VoicePicker language="en" selected={voice.enVoice} installed={installed} onSelect={(enVoice) => void save({ enVoice })} onDownloaded={status.reload} />

      <div className="row">
        <Slider label={tr("voice.speed")} value={voice.speed} min={0.6} max={1.6} step={0.05} format={(value) => `${value.toFixed(2)}×`} onCommit={(speed) => void save({ speed })} />
        <Slider label={tr("voice.volume")} value={voice.volume} min={0} max={100} step={5} format={(value) => `${value} %`} onCommit={(volume) => void save({ volume })} />
      </div>

      {lastVoiceError && (
        <Note tone="warn" detail={lastVoiceError.detail}>
          <p>{tr("voice.lastError")}</p>
        </Note>
      )}

      <h2>{tr("voice.listenTitle")}</h2>
      <Toggle
        checked={voice.listen}
        onChange={(listen) => void save({ listen })}
        label={tr("voice.listen")}
        hint={tr("voice.listenHint", { key: hotkeyLabel(voice.hotkey) })}
      />
      {voice.listen && <Downloads ids={listenNeeds} status={status.data} onDone={status.reload} />}

      <Field label={tr("voice.model")}>
        <select value={voice.sttModel} onChange={(event) => void save({ sttModel: event.target.value as Config["voice"]["sttModel"] })}>
          {sttModelIds.map((id) => (
            <option key={id} value={id}>
              {tr(`voice.model.${id}`, { size: sizeOf([`stt:${id}`]) })}
            </option>
          ))}
        </select>
      </Field>

      <h3>{tr("voice.hotkey")}</h3>
      <HotkeyRecorder
        hotkey={voice.hotkey}
        taken={{ hotkey: config.hotkey, message: tr("voice.hotkeySameAsChat") }}
        onSave={(hotkey) => save({ hotkey })}
      />

      {listenNeeds.every((id) => installed[id]) && <MicrophoneTest />}
    </>
  );
}

/** One language's voice: choose it, download it, hear it. */
function VoicePicker<L extends SpokenLanguage>(props: {
  language: L;
  selected: VoiceOf<L>;
  installed: VoiceStatus["installed"];
  onSelect: (id: VoiceOf<L>) => void;
  onDownloaded: () => Promise<void>;
}) {
  const tr = useTr();
  const [testing, setTesting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = props.installed.piper && props.installed[`voice:${props.selected}`];
  const choices = voiceIdsFor(props.language);

  const test = async () => {
    setTesting(true);
    setFailure(null);
    const result = await call("speak", { voice: props.selected });
    setTesting(false);
    if (result.ok) await play(result.url);
    else setFailure(result.detail);
  };

  return (
    <Field label={tr(props.language === "es" ? "voice.esVoice" : "voice.enVoice")} id={`voice-${props.language}`}>
      <div className="row">
        <select
          id={`voice-${props.language}`}
          className="grow"
          value={props.selected}
          onChange={(event) => {
            const id = choices.find((choice) => choice === event.target.value);
            if (id) props.onSelect(id);
          }}
        >
          {choices.map((id) => (
            <option key={id} value={id}>
              {voices[id].name} ({voices[id].accent}) · {megabytes(componentBytes(`voice:${id}`))} · {voices[id].license}
            </option>
          ))}
        </select>
        {ready && (
          <button className="secondary" disabled={testing} onClick={() => void test()}>
            {testing ? tr("voice.testing") : tr("voice.test")}
          </button>
        )}
      </div>
      {!props.installed[`voice:${props.selected}`] && (
        <Downloads ids={[`voice:${props.selected}`]} status={{ installed: props.installed }} onDone={props.onDownloaded} />
      )}
      {failure && (
        <Note tone="error" detail={failure}>
          <p>{tr("error.internal")}</p>
        </Note>
      )}
    </Field>
  );
}

/** What a feature still needs on disk, with a download button and live progress. */
function Downloads(props: { ids: readonly ComponentId[]; status: Pick<VoiceStatus, "installed">; onDone: () => Promise<void> }) {
  const tr = useTr();
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const missing = props.ids.filter((id) => !props.status.installed[id]);
  if (missing.length === 0) return <p className="hint">✓ {tr("voice.ready")}</p>;

  const download = async () => {
    setError(null);
    setPercent(0);
    const total = missing.reduce((sum, id) => sum + componentBytes(id), 0);
    const done = new Map<ComponentId, number>();
    const response = await fetch("/api/voice/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: missing }) });
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (reader) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line) as { id?: ComponentId; received?: number; status?: string; error?: string };
        if (event.error) setError(event.error);
        if (event.id && event.received !== undefined) {
          done.set(event.id, event.received);
          setPercent(Math.round(([...done.values()].reduce((sum, bytes) => sum + bytes, 0) / total) * 100));
        }
      }
    }
    if (!response.ok) setError(`HTTP ${response.status}`);
    setPercent(null);
    await props.onDone();
  };

  return (
    <div style={{ margin: "4px 0 16px" }}>
      {percent === null ? (
        <div className="row">
          <span className="hint grow">{tr("voice.missing", { size: sizeOf(missing) })}</span>
          <button className="secondary" onClick={() => void download()}>
            {tr("voice.download", { size: sizeOf(missing) })}
          </button>
        </div>
      ) : (
        <>
          <p className="hint">{tr("voice.downloading", { percent })}</p>
          <div className="progress">
            <div style={{ width: `${Math.max(2, percent)}%` }} />
          </div>
        </>
      )}
      {error && (
        <Note tone="error" detail={error}>
          <p>{tr("voice.downloadFailed")}</p>
        </Note>
      )}
    </div>
  );
}

/** A range input that saves when the player lets go, not on every step. */
function Slider(props: { label: string; value: number; min: number; max: number; step: number; format: (value: number) => string; onCommit: (value: number) => void }) {
  const [value, setValue] = useState(props.value);
  const commit = () => value !== props.value && props.onCommit(value);
  return (
    <div className="grow">
      <Field label={`${props.label}: ${props.format(value)}`}>
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={value}
          onChange={(event) => setValue(Number(event.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
        />
      </Field>
    </div>
  );
}

/** Records in the browser and shows what speech recognition understood, without chatting. */
function MicrophoneTest() {
  const tr = useTr();
  const microphone = useMicrophone();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string; detail?: string } | null>(null);

  const finish = async () => {
    const wav = await microphone.stop();
    if (!wav) return;
    setBusy(true);
    const heard = await transcribe(wav);
    setBusy(false);
    setResult(heard.ok ? { tone: "ok", text: tr("voice.heardHere", { text: heard.text }) } : { tone: "error", text: heard.message, ...(heard.detail ? { detail: heard.detail } : {}) });
  };
  const toggle = async () => {
    if (microphone.recording) return finish();
    setResult(null);
    try {
      await microphone.start(() => void finish());
    } catch (error) {
      setResult({ tone: "error", text: tr("voice.micDenied", { detail: error instanceof Error ? error.message : String(error) }) });
    }
  };

  return (
    <>
      <button className={microphone.recording ? "secondary recording" : "secondary"} disabled={busy} onClick={() => void toggle()}>
        {busy ? tr("chat.transcribing") : microphone.recording ? tr("voice.stopMic") : tr("voice.tryMic")}
      </button>
      {result && (
        <Note tone={result.tone} detail={result.detail}>
          <p>{result.text}</p>
        </Note>
      )}
    </>
  );
}
