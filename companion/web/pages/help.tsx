import { useCallback, useEffect, useRef, useState } from "react";
import type { LogEntry } from "../../src/log.ts";
import { call, useRpc, useServerEvents } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Note, useTr } from "../ui.tsx";

const problems = ["noMod", "f7", "slow", "errors", "antivirus", "wrongLanguage", "voice"] as const;

export function HelpPage(props: { overview: Overview }) {
  const tr = useTr();
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyReport = async () => {
    const { markdown } = await call("diagnostics");
    setReport(markdown);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <h1>{tr("help.title")}</h1>
      {props.overview.brain.lastError && (
        <Note tone="error" detail={props.overview.brain.lastError.detail}>
          <p>
            {tr("help.lastError", { time: new Date(props.overview.brain.lastError.at).toLocaleTimeString() })} {props.overview.brain.lastError.message}
          </p>
        </Note>
      )}

      <h2>{tr("help.problemsTitle")}</h2>
      <div className="faq">
        {problems.map((id) => (
          <details key={id}>
            <summary>{tr(`help.problem.${id}`)}</summary>
            <p>{tr(`help.problem.${id}.answer`)}</p>
          </details>
        ))}
      </div>

      <h2>{tr("help.reportTitle")}</h2>
      <p>{tr("help.reportIntro")}</p>
      <div className="row">
        <button className="primary" onClick={() => void copyReport()}>
          {tr("help.copyReport")}
        </button>
        <button className="quiet" onClick={() => void call("openFolder", { which: "logs" })}>
          {tr("help.openLogs")}
        </button>
        <button className="quiet" onClick={() => void call("openFolder", { which: "data" })}>
          {tr("help.openData")}
        </button>
      </div>
      {report && (
        <>
          <p className="hint">{copied ? tr("help.copied") : tr("help.copyManually")}</p>
          <textarea readOnly value={report} style={{ minHeight: 160, fontFamily: "var(--font-code)", fontSize: 12 }} />
        </>
      )}
      <p className="hint">{tr("help.logFile", { path: props.overview.app.logFile })}</p>

      <LiveLog />
    </>
  );
}

function LiveLog() {
  const tr = useTr();
  const initial = useRpc("logs");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initial.data) setEntries(initial.data);
  }, [initial.data]);
  const onLog = useCallback((entry: LogEntry) => setEntries((previous) => [...previous.slice(-999), entry]), []);
  const noop = useCallback(() => {}, []);
  useServerEvents(onLog, noop);
  useEffect(() => {
    const element = box.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);

  const shown = problemsOnly ? entries.filter((entry) => entry.level === "warn" || entry.level === "error") : entries;
  return (
    <>
      <h2>{tr("help.logTitle")}</h2>
      <label className="row" style={{ gap: 6, marginBottom: 8 }}>
        <input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} />
        {tr("help.problemsOnly")}
      </label>
      <div className="log" ref={box} role="log">
        {shown.map((entry, index) => (
          <div key={index} data-level={entry.level}>
            {entry.at.slice(11, 19)} [{entry.source}] {entry.message}
          </div>
        ))}
      </div>
    </>
  );
}
