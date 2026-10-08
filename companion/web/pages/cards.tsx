// Cards: what the player shares with Lilith (notes, pictures they pick themselves) and the cards
// she writes from it for the game's note inbox.

import { useEffect, useState } from "react";
import { isLocalUrl, presets } from "../../src/providers/presets.ts";
import { call, useRpc, type Output } from "../api.ts";
import type { Overview } from "../app.tsx";
import { Note, Toggle, useLocale, useTr } from "../ui.tsx";

type Shared = Output<"keepsakes">["keepsakes"][number];
type Card = Output<"keepsakes">["cards"][number];
type Failure = Extract<Output<"writeCard">, { ok: false }>["error"];

/** Longest side of a shared picture; plenty for a model to see it, small enough to keep and send. */
const MAX_SIDE = 1280;

/**
 * Re-encodes a picture the player picked as a smaller JPEG, in the browser. Drawing it onto a
 * canvas keeps only the pixels, so hidden details such as GPS location never reach the disk.
 */
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2D canvas");
  context.fillStyle = "#ffffff"; // transparent PNGs would otherwise turn black
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export function CardsPage(props: { overview: Overview; refresh: () => void; tick: number }) {
  const tr = useTr();
  const { config, brain } = props.overview;
  const data = useRpc("keepsakes");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [writing, setWriting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // Her reactions, what she saw in a picture, and cards from the game all arrive as brain events.
  useEffect(() => {
    void data.reload();
  }, [props.tick]);

  const online = !presets[config.provider.preset].local && !isLocalUrl(config.provider.baseUrl);

  const shareNote = async () => {
    const text = note.trim();
    if (!text) return;
    await call("shareNote", { text });
    setNote("");
    await data.reload();
  };

  const addPictures = async (files: readonly File[]) => {
    setAdding(true);
    const failed: string[] = [];
    const pictures: string[] = [];
    for (const file of files.slice(0, 12)) {
      try {
        pictures.push(await shrink(file));
      } catch {
        failed.push(tr("cards.pictureError", { name: file.name }));
      }
    }
    try {
      if (pictures.length > 0) await call("sharePictures", { pictures });
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
    setProblems(failed);
    setAdding(false);
    await data.reload();
  };

  const writeCard = async () => {
    setWriting(true);
    setFailure(null);
    const result = await call("writeCard");
    if (!result.ok) setFailure(result.error);
    setWriting(false);
    await data.reload();
  };

  const saveSettings = async (cards: boolean) => {
    await call("saveSettings", { features: { cards } });
    props.refresh();
  };

  const shared = data.data?.keepsakes ?? [];
  const cards = data.data?.cards ?? [];

  return (
    <>
      <h1>{tr("cards.title")}</h1>
      <p className="hint">{tr("cards.intro")}</p>
      {!brain.connected ? (
        <Note>
          <p>{tr("cards.gameOff")}</p>
        </Note>
      ) : (
        data.data &&
        !data.data.canLeaveCards && (
          <Note tone="warn">
            <p>{tr("cards.noInbox")}</p>
          </Note>
        )
      )}

      <Toggle checked={config.features.cards} onChange={(cards) => void saveSettings(cards)} label={tr("cards.auto")} hint={tr("cards.autoHint")} />
      <div className="row">
        <button className="primary" disabled={writing || !config.provider.configured} onClick={() => void writeCard()}>
          {writing ? tr("cards.writing") : tr("cards.writeNow")}
        </button>
      </div>
      {failure && (
        <Note tone="error" detail={failure.detail}>
          <p>{failure.message}</p>
        </Note>
      )}

      <h2>{tr("cards.sharedTitle")}</h2>
      <p className="hint">
        {tr("cards.sharedIntro")} {online && tr("cards.sharedOnline")}
      </p>
      <textarea
        style={{ minHeight: 70 }}
        maxLength={500}
        value={note}
        placeholder={tr("cards.notePlaceholder")}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="secondary" disabled={!note.trim()} onClick={() => void shareNote()}>
          {tr("cards.shareNote")}
        </button>
        <label className="button secondary" aria-disabled={adding}>
          {adding ? tr("cards.adding") : tr("cards.addPictures")}
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            disabled={adding}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length > 0) void addPictures(files);
            }}
          />
        </label>
      </div>
      {problems.length > 0 && (
        <Note tone="warn">
          {problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </Note>
      )}

      {shared.length === 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          {tr("cards.emptyShared")}
        </p>
      ) : (
        <ul className="keepsakes">
          {shared.map((keepsake) => (
            <SharedItem key={keepsake.id} keepsake={keepsake} onChange={() => void data.reload()} />
          ))}
        </ul>
      )}

      <h2>{tr("cards.historyTitle")}</h2>
      {cards.length === 0 ? (
        <p className="hint">{tr("cards.emptyCards")}</p>
      ) : (
        <ul className="cards">
          {cards.map((card) => (
            <CardItem key={card.id} card={card} />
          ))}
        </ul>
      )}
    </>
  );
}

function SharedItem(props: { keepsake: Shared; onChange: () => void }) {
  const tr = useTr();
  const { keepsake } = props;
  const [caption, setCaption] = useState(keepsake.kind === "picture" ? keepsake.caption : "");
  const remove = () => void call("removeKeepsake", { id: keepsake.id }).then(props.onChange);

  if (keepsake.kind === "note") {
    return (
      <li className="keepsake">
        <p className="keepsake-note">{keepsake.text}</p>
        <button className="quiet" onClick={remove}>
          {tr("cards.remove")}
        </button>
      </li>
    );
  }
  return (
    <li className="keepsake">
      <img src={keepsake.url} alt={keepsake.caption || keepsake.seen} loading="lazy" />
      <label className="hint">
        {tr("cards.caption")}
        <textarea
          maxLength={300}
          value={caption}
          placeholder={tr("cards.captionPlaceholder")}
          onChange={(event) => setCaption(event.target.value)}
          onBlur={() => {
            if (caption.trim() !== keepsake.caption) void call("captionPicture", { id: keepsake.id, caption }).then(props.onChange);
          }}
        />
      </label>
      <small className="hint">{keepsake.seen ? tr("cards.seen", { seen: keepsake.seen }) : tr("cards.notSeen")}</small>
      <button className="quiet" onClick={remove}>
        {tr("cards.remove")}
      </button>
    </li>
  );
}

function CardItem(props: { card: Card }) {
  const tr = useTr();
  const locale = useLocale();
  const { card } = props;
  const when = new Date(card.at).toLocaleString(locale === "es" ? "es-419" : "en", { dateStyle: "medium", timeStyle: "short" });
  const status = card.inGame ? tr("cards.inGame") : card.error ? tr("cards.failed", { error: card.error }) : tr("cards.pending");
  return (
    <li>
      <p className="card-paper">{card.text}</p>
      <small className="hint">
        {when} · {card.trigger === "auto" ? tr("cards.byHer") : tr("cards.asked")} · {status}
      </small>
    </li>
  );
}
