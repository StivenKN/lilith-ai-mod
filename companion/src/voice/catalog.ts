// Everything the local voice needs, pinned by URL and SHA-256 like the release's own downloads
// (scripts/pinned.ts). Nothing is bundled in the release: the player downloads only what they turn
// on, from the dashboard's Voice tab, into %APPDATA%\LilithAICompanion\voice.
//   Speaking:  Piper (MIT) + one voice per language   https://github.com/rhasspy/piper
//   Listening: whisper.cpp (MIT) + a multilingual model https://github.com/ggml-org/whisper.cpp

/** One file to fetch. `extract` unpacks a zip into that folder (relative to the voice folder). */
export interface Download {
  url: string;
  sha256: string;
  bytes: number;
  /** Where the file lives, relative to the voice folder. */
  path: string;
  extract?: string;
}

/** A unit the player installs as a whole. It's installed when `ready` exists. */
export interface Component {
  files: readonly Download[];
  ready: string;
}

const PIPER_VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/375a0fe641dea077c2a47b4e9a056d6da521eed3";
const WHISPER_MODELS = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1";

/** Windows x64 builds of the two engines. Other platforms use LILITH_AI_PIPER / LILITH_AI_WHISPER (development). */
export const engines = {
  piper: {
    files: [
      {
        url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
        sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
        bytes: 22_477_236,
        path: "downloads/piper_windows_amd64.zip",
        extract: "bin",
      },
    ],
    ready: "bin/piper/piper.exe",
  },
  whisper: {
    files: [
      {
        url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip",
        sha256: "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a",
        bytes: 8_194_445,
        path: "downloads/whisper-bin-x64.zip",
        extract: "bin/whisper",
      },
    ],
    ready: "bin/whisper/Release/whisper-cli.exe",
  },
} as const satisfies Record<string, Component>;

export type SpokenLanguage = "es" | "en";
export const spokenLanguages = ["es", "en"] as const satisfies readonly SpokenLanguage[];

const piperVoice = (path: string, model: { sha256: string; bytes: number }, config: { sha256: string; bytes: number }) => {
  const name = path.split("/").at(-1)!;
  return {
    files: [
      // The config goes first: the model is the "ready" marker, so a half-finished install never looks done.
      { url: `${PIPER_VOICES}/${path}.onnx.json`, ...config, path: `voices/${name}.onnx.json` },
      { url: `${PIPER_VOICES}/${path}.onnx`, ...model, path: `voices/${name}.onnx` },
    ],
    ready: `voices/${name}.onnx`,
  };
};

/** Female voices that suit Lilith. The first one per language is the default. */
export const voices = {
  "es_AR-daniela-high": {
    language: "es",
    name: "Daniela",
    accent: "Argentina",
    license: "CC BY-SA 4.0",
    ...piperVoice(
      "es/es_AR/daniela/high/es_AR-daniela-high",
      { sha256: "7ceb1fc0dab349418c5b54a639ae9ee595212d7c9ea422220d8419163d5cc985", bytes: 114_199_011 },
      { sha256: "aedbf69647e1d754c62ecf8e0366ca5f16af3e768e3c6b5329af6eb6bde3852b", bytes: 7_248 },
    ),
  },
  "es_MX-claude-high": {
    language: "es",
    name: "Claude",
    accent: "México",
    license: "Apache-2.0",
    ...piperVoice(
      "es/es_MX/claude/high/es_MX-claude-high",
      { sha256: "3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0", bytes: 63_122_309 },
      { sha256: "1afc81f703c0e4cb3b4d7c0dca096b8b54a98806807f0170cf5eb5557723c12d", bytes: 4_963 },
    ),
  },
  "en_US-amy-medium": {
    language: "en",
    name: "Amy",
    accent: "US",
    license: "Mimic 3 voices (MycroftAI)",
    ...piperVoice(
      "en/en_US/amy/medium/en_US-amy-medium",
      { sha256: "b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18", bytes: 63_201_294 },
      { sha256: "95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77", bytes: 4_882 },
    ),
  },
  "en_US-ljspeech-medium": {
    language: "en",
    name: "Linda",
    accent: "US",
    license: "Public domain (LJ Speech)",
    ...piperVoice(
      "en/en_US/ljspeech/medium/en_US-ljspeech-medium",
      { sha256: "6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22", bytes: 63_531_379 },
      { sha256: "141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860", bytes: 4_972 },
    ),
  },
} as const satisfies Record<string, Component & { language: SpokenLanguage; name: string; accent: string; license: string }>;

export type VoiceId = keyof typeof voices;
export const voiceIds = Object.keys(voices) as [VoiceId, ...VoiceId[]];
/** Voices of one language, as a non-empty tuple (what z.enum wants). */
export const voiceIdsFor = <L extends SpokenLanguage>(language: L) =>
  voiceIds.filter((id): id is VoiceOf<L> => voices[id].language === language) as [VoiceOf<L>, ...VoiceOf<L>[]];
export type VoiceOf<L extends SpokenLanguage> = { [K in VoiceId]: (typeof voices)[K]["language"] extends L ? K : never }[VoiceId];

export const defaultVoice = { es: "es_AR-daniela-high", en: "en_US-amy-medium" } as const satisfies { [L in SpokenLanguage]: VoiceOf<L> };

/** Multilingual speech recognition models (quantized: same accuracy, half the size and faster on CPU). */
export const sttModels = {
  base: {
    files: [
      {
        url: `${WHISPER_MODELS}/ggml-base-q8_0.bin`,
        sha256: "c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9",
        bytes: 81_768_585,
        path: "models/ggml-base-q8_0.bin",
      },
    ],
    ready: "models/ggml-base-q8_0.bin",
  },
  small: {
    files: [
      {
        url: `${WHISPER_MODELS}/ggml-small-q8_0.bin`,
        sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
        bytes: 264_464_607,
        path: "models/ggml-small-q8_0.bin",
      },
    ],
    ready: "models/ggml-small-q8_0.bin",
  },
} as const satisfies Record<string, Component>;

export type SttModelId = keyof typeof sttModels;
export const sttModelIds = Object.keys(sttModels) as [SttModelId, ...SttModelId[]];

/** Installable things, addressed by one id: "piper", "whisper", "voice:<id>", "stt:<id>". */
export type ComponentId = keyof typeof engines | `voice:${VoiceId}` | `stt:${SttModelId}`;

export function componentFor(id: ComponentId): Component {
  if (id === "piper" || id === "whisper") return engines[id];
  const [kind, name] = id.split(":") as ["voice", VoiceId] | ["stt", SttModelId];
  return kind === "voice" ? voices[name] : sttModels[name];
}

export const isComponentId = (value: string): value is ComponentId =>
  value in engines ||
  (value.startsWith("voice:") && value.slice(6) in voices) ||
  (value.startsWith("stt:") && value.slice(4) in sttModels);

export const componentBytes = (id: ComponentId): number => componentFor(id).files.reduce((sum, file) => sum + file.bytes, 0);
