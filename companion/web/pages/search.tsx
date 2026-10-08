import { useState } from "react";
import { searchModes, type SearchMode } from "../../src/search.ts";
import { call, type Output } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Field, Note, useTr } from "../ui.tsx";

/** Web search section of the AI tab: pick off / DuckDuckGo from this PC / Firecrawl, try a query, save. */
export function SearchSettings(props: { overview: Overview; refresh: () => void }) {
  const tr = useTr();
  const saved = props.overview.config.search;
  const [mode, setMode] = useState<SearchMode>(saved.mode);
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [test, setTest] = useState<Output<"testSearch"> | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const missingKey = mode === "firecrawl" && !apiKey.trim() && !saved.apiKey;
  const keyInput = apiKey.trim() ? { apiKey: apiKey.trim() } : {};

  const choose = (next: SearchMode) => {
    setMode(next);
    setTest(null);
    setSavedOk(false);
  };

  const runTest = async () => {
    if (mode === "off") return;
    setBusy("test");
    setTest(null);
    setTest(await call("testSearch", { mode, query, ...keyInput }));
    setBusy(null);
  };

  const save = async () => {
    setBusy("save");
    await call("saveSettings", { search: { mode, ...keyInput } });
    setBusy(null);
    setApiKey("");
    setSavedOk(true);
    props.refresh();
  };

  return (
    <>
      <h2>{tr("search.title")}</h2>
      <p className="hint">
        {tr("search.intro")} {tr("search.privacy")}
      </p>
      <div className="choices" role="radiogroup" aria-label={tr("search.title")}>
        {searchModes.map((option) => (
          <label className="choice" key={option}>
            <input type="radio" name="search-mode" checked={mode === option} onChange={() => choose(option)} />
            <span>
              <strong>{tr(`search.mode.${option}`)}</strong>
              <span className="hint">{tr(`search.mode.${option}.hint`)}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "firecrawl" && (
        <Field
          label={tr("provider.apiKey")}
          hint={
            <>
              {saved.apiKey ? tr("provider.keySaved", { key: saved.apiKey }) : tr("provider.keyPrivacy")}{" "}
              <a href="https://www.firecrawl.dev/app/api-keys" target="_blank" rel="noreferrer">
                {tr("search.getKey")}
              </a>
            </>
          }
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder={saved.apiKey ? tr("provider.keyReplacePlaceholder") : tr("provider.keyPlaceholder")}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
      )}

      {mode !== "off" && (
        <Field id="search-test" label={tr("search.testLabel")}>
          <div className="row">
            <input
              id="search-test"
              className="grow"
              value={query}
              placeholder={tr("search.testPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && query.trim() && !missingKey && busy === null) void runTest();
              }}
            />
            <button className="secondary" disabled={busy !== null || !query.trim() || missingKey} onClick={() => void runTest()}>
              {busy === "test" ? tr("search.testing") : tr("search.test")}
            </button>
          </div>
        </Field>
      )}

      {test?.ok === true &&
        (test.results.length > 0 ? (
          <Note tone="ok">
            <p>{tr("search.testOk", { count: test.results.length, seconds: (test.latencyMs / 1000).toFixed(1) })}</p>
            <ul>
              {test.results.map((result) => (
                <li key={result.url}>
                  <a href={result.url} target="_blank" rel="noreferrer">
                    {result.title}
                  </a>
                  {result.snippet ? <span className="hint"> {result.snippet}</span> : null}
                </li>
              ))}
            </ul>
          </Note>
        ) : (
          <Note tone="warn">
            <p>{tr("search.testEmpty")}</p>
          </Note>
        ))}
      {test?.ok === false && (
        <Note tone="error" detail={test.detail}>
          <p>{tr("search.testFailed")}</p>
        </Note>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="secondary" disabled={busy !== null || missingKey} onClick={() => void save()}>
          {tr("search.save")}
        </button>
        {savedOk && <span className="hint">{tr("search.saved")}</span>}
      </div>
      {missingKey && <p className="hint">{tr("search.needKey")}</p>}
    </>
  );
}
