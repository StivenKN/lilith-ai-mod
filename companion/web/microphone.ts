// Records the browser's microphone into a WAV file for the companion's speech recognition.
// Captured at the device's own rate (browsers refuse to resample a live stream into a 16 kHz
// context); whisper.cpp resamples on its side.

import { useCallback, useRef, useState } from "react";
import type { TranscribeResult } from "../src/server.ts";
import { encodeWav } from "../src/voice/wav.ts";

/** Copies each block of input samples to the page; runs on the audio thread. */
const CAPTURE = `registerProcessor("capture", class extends AudioWorkletProcessor {
  process(inputs) { const samples = inputs[0]?.[0]; if (samples) this.port.postMessage(samples.slice(0)); return true; }
});`;
const MAX_SECONDS = 30;

export function useMicrophone() {
  const [recording, setRecording] = useState(false);
  const session = useRef<{ stop: () => Promise<Uint8Array<ArrayBuffer>> } | null>(null);

  /** Starts recording; rejects if the browser or the player denies the microphone. */
  const start = useCallback(async (onLimit: () => void) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const context = new AudioContext();
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE], { type: "text/javascript" })));
    const capture = new AudioWorkletNode(context, "capture");
    const chunks: Float32Array[] = [];
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => chunks.push(event.data);
    context.createMediaStreamSource(stream).connect(capture);
    const limit = setTimeout(onLimit, MAX_SECONDS * 1000);

    session.current = {
      stop: async () => {
        clearTimeout(limit);
        for (const track of stream.getTracks()) track.stop();
        await context.close();
        const samples = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        return encodeWav(samples, context.sampleRate);
      },
    };
    setRecording(true);
  }, []);

  /** Stops and returns the recording as a WAV file. */
  const stop = useCallback(async () => {
    const current = session.current;
    session.current = null;
    setRecording(false);
    return current ? current.stop() : null;
  }, []);

  return { recording, start, stop };
}

/** Sends a recording to the companion; resolves with what it heard or a localized reason it couldn't. */
export async function transcribe(wav: Uint8Array<ArrayBuffer>): Promise<TranscribeResult> {
  const response = await fetch("/api/voice/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
  if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
  return (await response.json()) as TranscribeResult;
}

/** Plays a file the companion spoke; resolves when it's done (or couldn't play). */
export function play(url: string): Promise<void> {
  const audio = new Audio(url);
  return new Promise((resolve) => {
    audio.onended = audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });
}
