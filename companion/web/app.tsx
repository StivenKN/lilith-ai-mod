import { useCallback, useState } from "react";
import { call, useRpc, useServerEvents, type Output } from "./api.ts";
import { ChatPage } from "./pages/chat.tsx";
import { GamePage } from "./pages/game.tsx";
import { HelpPage } from "./pages/help.tsx";
import { LilithPage } from "./pages/lilith.tsx";
import { ProviderPage } from "./pages/provider.tsx";
import { SetupWizard } from "./pages/setup.tsx";
import { LocaleContext, useTr } from "./ui.tsx";
import type { UiLocale } from "../src/languages.ts";

const tabs = ["chat", "lilith", "ai", "game", "help"] as const;
type Tab = (typeof tabs)[number];
export type Overview = Output<"overview">;

export function App() {
  const overview = useRpc("overview");
  const [tick, setTick] = useState(0);
  const onChange = useCallback(() => {
    setTick((value) => value + 1);
    void overview.reload();
  }, [overview.reload]);
  useServerEvents(null, onChange);

  if (overview.error === "unauthorized") return <Locked />;
  if (!overview.data) return overview.error ? <p className="center-card">{overview.error}</p> : null;
  const data = overview.data;
  return (
    <LocaleContext.Provider value={data.brain.uiLocale}>
      <Shell overview={data} tick={tick} refresh={onChange} />
    </LocaleContext.Provider>
  );
}

function Shell(props: { overview: Overview; tick: number; refresh: () => void }) {
  const tr = useTr();
  const { overview } = props;
  const inSetup = overview.app.mode === "setup";
  const [wizard, setWizard] = useState(inSetup || !overview.config.provider.configured);
  const [tab, setTab] = useState<Tab>("chat");
  const connected = overview.brain.connected;

  const setLanguage = async (uiLanguage: UiLocale) => {
    await call("saveSettings", { uiLanguage });
    props.refresh();
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">
          Lilith <span>AI</span>
        </div>
        <span className="presence" data-on={connected}>
          {connected ? tr("shell.gameConnected") : tr("shell.gameNotConnected")}
        </span>
        <div className="lang-switch" role="group" aria-label={tr("shell.language")}>
          {(["es", "en"] as const).map((locale) => (
            <button key={locale} aria-pressed={overview.brain.uiLocale === locale} onClick={() => void setLanguage(locale)}>
              {locale === "es" ? "Español" : "English"}
            </button>
          ))}
        </div>
      </header>

      {wizard ? (
        <SetupWizard overview={overview} refresh={props.refresh} onFinish={() => setWizard(false)} />
      ) : (
        <>
          <nav className="tabs" role="tablist">
            {tabs.map((id) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {tr(`tab.${id}`)}
              </button>
            ))}
          </nav>
          <main>
            {tab === "chat" && <ChatPage overview={overview} tick={props.tick} />}
            {tab === "lilith" && <LilithPage overview={overview} refresh={props.refresh} />}
            {tab === "ai" && <ProviderPage overview={overview} refresh={props.refresh} />}
            {tab === "game" && <GamePage overview={overview} refresh={props.refresh} openWizard={() => setWizard(true)} />}
            {tab === "help" && <HelpPage overview={overview} />}
          </main>
        </>
      )}
    </div>
  );
}

/** Shown when the page was opened without the one-time login link. */
function Locked() {
  const locale: UiLocale = navigator.language.startsWith("es") ? "es" : "en";
  return (
    <LocaleContext.Provider value={locale}>
      <LockedMessage />
    </LocaleContext.Provider>
  );
}

function LockedMessage() {
  const tr = useTr();
  return (
    <div className="center-card">
      <h1>{tr("locked.title")}</h1>
      <p>{tr("locked.body")}</p>
    </div>
  );
}
