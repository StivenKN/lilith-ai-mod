import { useEffect, useState } from "react";
import { call, type Output } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Check, Field, Note, Toggle, hotkeyLabel, useTr } from "../ui.tsx";
import { ProviderForm } from "./provider.tsx";

type Step = "game" | "ai" | "done";

export function SetupWizard(props: { overview: Overview; refresh: () => void; onFinish: () => void }) {
  const tr = useTr();
  // The game step only makes sense when the player launched the installer (not from inside the game).
  const steps: Step[] = props.overview.app.mode === "bridge" ? ["ai", "done"] : ["game", "ai", "done"];
  const [step, setStep] = useState<Step>(steps[0]!);
  const index = steps.indexOf(step);
  const next = () => setStep(steps[index + 1] ?? "done");

  return (
    <div className="wizard">
      {/* The steps as the to-do note taped to Lilith's door in the game's art. */}
      <aside className="todo">
        <p className="todo-title">{tr("setup.todo")}</p>
        <ol className="steps">
          {steps.map((id, i) => (
            <li key={id} data-state={i < index ? "done" : i === index ? "current" : "todo"} aria-current={i === index ? "step" : undefined}>
              <span>{tr(`setup.step.${id}`)}</span>
            </li>
          ))}
        </ol>
      </aside>
      <section>
        {step === "game" && <GameStep onNext={next} />}
        {step === "ai" && (
          <>
            <h1>{tr("setup.aiTitle")}</h1>
            <p>{tr("setup.aiIntro")}</p>
            <ProviderForm
              overview={props.overview}
              saveLabel={tr("setup.saveAndContinue")}
              onSaved={() => {
                props.refresh();
                next();
              }}
            />
          </>
        )}
        {step === "done" && <DoneStep overview={props.overview} onFinish={props.onFinish} />}
        {step !== "done" && (
          <p style={{ marginTop: 28 }}>
            <button className="quiet" onClick={props.onFinish}>
              {tr("setup.skipToSettings")}
            </button>
          </p>
        )}
      </section>
    </div>
  );
}

type Detection = Output<"detectGame">;
type GameStatus = NonNullable<Detection["status"]>;

function GameStep(props: { onNext: () => void }) {
  const tr = useTr();
  const [detection, setDetection] = useState<Detection | null>(null);
  const [gameDir, setGameDir] = useState("");
  const [status, setStatus] = useState<GameStatus | null>(null);
  const [disableConflicts, setDisableConflicts] = useState(true);
  const [result, setResult] = useState<Output<"install"> | null>(null);
  const [removal, setRemoval] = useState<Output<"uninstall"> | null>(null);
  const [removeBepInEx, setRemoveBepInEx] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call("detectGame").then((found) => {
      setDetection(found);
      setGameDir(found.candidates[0] ?? "");
      setStatus(found.status);
    });
  }, []);

  const inspect = async (dir = gameDir) => {
    if (dir.trim()) setStatus(await call("inspectGame", { gameDir: dir.trim() }));
  };

  const runInstall = async () => {
    setBusy(true);
    setResult(await call("install", { gameDir, disableConflicts }));
    await inspect();
    setBusy(false);
  };

  const runUninstall = async () => {
    if (!confirm(tr("setup.uninstallConfirm"))) return;
    setBusy(true);
    setRemoval(await call("uninstall", { gameDir, removeBepInEx }));
    setResult(null);
    await inspect();
    setBusy(false);
  };

  if (!detection) return <p className="hint">{tr("setup.searching")}</p>;
  const canInstall = Boolean(status?.valid && status.gameRunning !== true && detection.payload.available);

  return (
    <>
      <h1>{tr("setup.gameTitle")}</h1>
      <p>{detection.candidates.length > 0 ? tr("setup.gameFound") : tr("setup.gameNotFound")}</p>

      {!detection.payload.available && (
        <Note tone="error" detail={detection.payload.missing.join("\n")}>
          <p>{tr("setup.payloadMissing")}</p>
        </Note>
      )}

      <Field id="game-folder" label={tr("setup.gameFolder")} hint={tr("setup.gameFolderHint")}>
        <div className="row">
          <input id="game-folder" className="grow" value={gameDir} spellCheck={false} onChange={(event) => setGameDir(event.target.value)} />
          <button className="secondary" onClick={() => void inspect()}>
            {tr("setup.check")}
          </button>
        </div>
      </Field>

      {status && (
        <ul className="checklist">
          <Check ok={status.valid}>{status.valid ? tr("setup.isGame") : tr("setup.notGame", { missing: status.missing.join(", ") })}</Check>
          {status.valid && <Check ok={status.bepinexInstalled || "warn"}>{status.bepinexInstalled ? tr("setup.bepinexPresent") : tr("setup.bepinexWillInstall")}</Check>}
          {status.valid && (
            <Check ok={status.mod.installed || "warn"}>
              {status.mod.installed ? tr("setup.modPresent", { version: status.mod.version ?? "?" }) : tr("setup.modWillInstall")}
            </Check>
          )}
          {status.gameRunning === true && <Check ok={false}>{tr("setup.gameRunning")}</Check>}
          {status.smartAppControl === "on" && <Check ok="warn">{tr("setup.smartAppControl")}</Check>}
          {status.conflicts.length > 0 && (
            <Check ok="warn">{tr("setup.conflicts", { mods: status.conflicts.map((conflict) => conflict.name).join(", ") })}</Check>
          )}
        </ul>
      )}
      {status && status.conflicts.length > 0 && (
        <Toggle checked={disableConflicts} onChange={setDisableConflicts} label={tr("setup.disableConflicts")} hint={tr("setup.disableConflictsHint")} />
      )}

      <div className="row">
        <button className="primary" disabled={!canInstall || busy} onClick={() => void runInstall()}>
          {busy ? tr("setup.installing") : status?.mod.installed ? tr("setup.repair") : tr("setup.install")}
        </button>
        {status?.mod.installed && (
          <button className="secondary" onClick={props.onNext}>
            {tr("setup.continue")}
          </button>
        )}
      </div>

      {result && (
        <>
          <ul className="checklist" style={{ marginTop: 18 }}>
            {result.steps.map((step, index) => (
              <Check key={index} ok={step.ok}>
                {tr(`setup.installStep.${step.id}`)}
                {/* Details are technical (paths, file counts); only worth showing when a step fails. */}
                {!step.ok && <span className="hint">: {step.detail}</span>}
              </Check>
            ))}
          </ul>
          {result.ok ? (
            <Note tone="ok">
              <p>{tr("setup.installed")}</p>
              <button className="primary" onClick={props.onNext}>
                {tr("setup.continue")}
              </button>
            </Note>
          ) : (
            <Note tone="error">
              <p>{tr("setup.installFailed")}</p>
            </Note>
          )}
        </>
      )}

      {status?.mod.installed && (
        <details style={{ marginTop: 28 }}>
          <summary>{tr("setup.uninstallTitle")}</summary>
          <p style={{ marginTop: 10 }}>{tr("setup.uninstallIntro")}</p>
          <Toggle checked={removeBepInEx} onChange={setRemoveBepInEx} label={tr("setup.uninstallBepInEx")} hint={tr("setup.uninstallBepInExHint")} />
          <button className="secondary danger" disabled={busy || status.gameRunning === true} onClick={() => void runUninstall()}>
            {tr("setup.uninstall")}
          </button>
        </details>
      )}
      {removal && (
        <Note tone={removal.ok ? "ok" : "error"}>
          <p>
            {removal.outcome === "bepinexKept"
              ? tr("setup.uninstalled.bepinexKept", { mods: removal.otherMods.join(", ") })
              : tr(`setup.uninstalled.${removal.outcome}`)}
          </p>
        </Note>
      )}
    </>
  );
}

function DoneStep(props: { overview: Overview; onFinish: () => void }) {
  const tr = useTr();
  const keyLabel = hotkeyLabel(props.overview.config.hotkey);
  const fromGame = props.overview.app.mode === "bridge";
  return (
    <>
      <h1>{tr("setup.doneTitle")}</h1>
      {fromGame ? (
        <p>{tr("setup.doneInGame", { key: keyLabel })}</p>
      ) : (
        <ol>
          <li>{tr("setup.doneStep1")}</li>
          <li>{tr("setup.doneStep2")}</li>
          <li>{tr("setup.doneStep3", { key: keyLabel })}</li>
        </ol>
      )}
      <p className="hint">{tr("setup.doneSettings")}</p>
      <button className="primary" onClick={props.onFinish}>
        {tr("setup.openDashboard")}
      </button>
    </>
  );
}
