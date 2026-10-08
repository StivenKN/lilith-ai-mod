import { useEffect, useRef, useState } from "react";
import { call, useRpc, type Output } from "../api.ts";
import type { Overview } from "../app.tsx";
import { play, transcribe, useMicrophone } from "../microphone.ts";
import { Bubble, Note, ThinkingBubble, useLocale, useTr } from "../ui.tsx";

type Failure = Pick<Extract<Output<"chat">, { ok: false }>["error"], "message" | "detail">;

export function ChatPage(props: { overview: Overview; tick: number }) {
  const tr = useTr();
  const locale = useLocale();
  const history = useRpc("history");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const microphone = useMicrophone();
  const [transcribing, setTranscribing] = useState(false);
  const { voice } = props.overview.config;

  // Messages sent from the game show up here too.
  useEffect(() => {
    void history.reload();
  }, [props.tick]);
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView.
    void end.current?.scrollIntoView({ block: "end" });
  }, [history.data, pending]);

  const send = async (text = draft.trim()) => {
    if (!text || pending) return;
    setDraft("");
    setPending(text);
    setFailure(null);
    const result = await call("chat", { text });
    if (!result.ok) {
      setFailure(result.error);
      setDraft(text);
    }
    await history.reload();
    setPending(null);
    // With the game open she speaks there; otherwise she speaks here.
    if (result.ok && voice.speak && !props.overview.brain.connected) {
      const spoken = await call("speak", { text: result.text });
      if (spoken.ok) await play(spoken.url);
    }
  };

  /** First press records, second press (or the time limit) recognizes and sends what was heard. */
  const toggleMicrophone = async () => {
    if (microphone.recording) return sendRecording();
    setFailure(null);
    try {
      await microphone.start(() => void sendRecording());
    } catch (error) {
      setFailure({ message: tr("voice.micDenied", { detail: error instanceof Error ? error.message : String(error) }), detail: "" });
    }
  };
  const sendRecording = async () => {
    const wav = await microphone.stop();
    if (!wav) return;
    setTranscribing(true);
    const heard = await transcribe(wav);
    setTranscribing(false);
    if (heard.ok) await send(heard.text);
    else setFailure({ message: heard.message, detail: heard.detail ?? "" });
  };

  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale === "es" ? "es-419" : "en", { hour: "2-digit", minute: "2-digit" });
  const turns = history.data ?? [];

  return (
    <>
      {/* Her room as a little screen: the conversation on the lilac wall, the composer along the bottom. */}
      <div className="screen">
        <div className="transcript" aria-live="polite">
          {turns.length === 0 && !pending && <Bubble text={tr("chat.empty")} />}
          {turns.map((turn, index) =>
            turn.role === "assistant" ? (
              <Bubble key={index} text={turn.content} meta={turn.source === "speakFirst" ? `${time(turn.at)}, ${tr("chat.spokeFirst")}` : time(turn.at)} />
            ) : (
              <div key={index} className="said">
                {turn.content}
                <small>
                  {turn.source === "game"
                    ? `${time(turn.at)}, ${tr("chat.fromGame")}`
                    : turn.source === "keepsake"
                      ? `${time(turn.at)}, ${tr("chat.shared")}`
                      : time(turn.at)}
                </small>
              </div>
            ),
          )}
          {pending && (
            <>
              <div className="said">{pending}</div>
              <ThinkingBubble />
            </>
          )}
          <div ref={end} />
        </div>

        <div className="composer">
          <textarea
            aria-label={tr("plugin.placeholder")}
            placeholder={tr("plugin.placeholder")}
            value={draft}
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {voice.listen && (
            <button
              className={microphone.recording ? "secondary recording" : "secondary"}
              disabled={pending !== null || transcribing}
              onClick={() => void toggleMicrophone()}
            >
              {transcribing ? tr("chat.transcribing") : microphone.recording ? tr("chat.stopRecording") : tr("chat.record")}
            </button>
          )}
          <button className="primary" disabled={!draft.trim() || pending !== null} onClick={() => void send()}>
            {tr("plugin.send")}
          </button>
        </div>
      </div>

      {failure && (
        <Note tone="error" detail={failure.detail}>
          <p>{failure.message}</p>
        </Note>
      )}
      <p className="hint">{props.overview.brain.connected ? tr("chat.hintConnected") : tr("chat.hintOffline")}</p>
    </>
  );
}
