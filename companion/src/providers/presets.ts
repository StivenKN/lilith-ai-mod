// Catalog of supported AI services. Everything the setup wizard and the adapters need to know
// about a provider lives here, so adding one is a single entry.

export type ProviderKind = "openai" | "anthropic" | "ollama";

export interface Preset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Pre-selected model; the picker always offers the provider's live list too. */
  defaultModel: string;
  /** Runs on the user's machine or network: no key, longer first-load timeout. */
  local: boolean;
  needsKey: boolean;
  /** Where to create an API key (or download the app, for local servers). */
  helpUrl: string;
  /** Provider-specific request fields. Dropped automatically if the server rejects them. */
  extraBody?: Record<string, unknown>;
  /** OpenAI's newer models only accept `max_completion_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  extraHeaders?: Record<string, string>;
}

export const presets = {
  ollama: {
    label: "Ollama (local)",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    defaultModel: "qwen3.5:9b",
    local: true,
    needsKey: false,
    helpUrl: "https://ollama.com/download",
  },
  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4-mini",
    local: false,
    needsKey: true,
    helpUrl: "https://platform.openai.com/api-keys",
    extraBody: { reasoning_effort: "low" },
    maxTokensField: "max_completion_tokens",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-opus-5-5",
    local: false,
    needsKey: true,
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    label: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.8-flash",
    local: false,
    needsKey: true,
    helpUrl: "https://aistudio.google.com/apikey",
    extraBody: { reasoning_effort: "minimal" },
  },
  deepseek: {
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    local: false,
    needsKey: true,
    helpUrl: "https://platform.deepseek.com/api_keys",
    extraBody: { thinking: { type: "disabled" } },
  },
  openrouter: {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "",
    local: false,
    needsKey: true,
    helpUrl: "https://openrouter.ai/keys",
    extraHeaders: { "HTTP-Referer": "https://github.com/lilith-ai-companion", "X-Title": "Lilith AI Companion" },
  },
  groq: {
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    local: false,
    needsKey: true,
    helpUrl: "https://console.groq.com/keys",
    extraBody: { reasoning_effort: "low" },
  },
  mistral: {
    label: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    local: false,
    needsKey: true,
    helpUrl: "https://console.mistral.ai/api-keys",
  },
  xai: {
    label: "xAI (Grok)",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.20-non-reasoning",
    local: false,
    needsKey: true,
    helpUrl: "https://console.x.ai",
  },
  lmstudio: {
    label: "LM Studio (local)",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "",
    local: true,
    needsKey: false,
    helpUrl: "https://lmstudio.ai",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    kind: "openai",
    baseUrl: "http://localhost:8080/v1",
    defaultModel: "",
    local: true,
    needsKey: false,
    helpUrl: "https://github.com/ggml-org/llama.cpp/tree/master/tools/server",
  },
} as const satisfies Record<string, Preset>;

export type PresetId = keyof typeof presets;
export const presetIds = Object.keys(presets) as [PresetId, ...PresetId[]];

export const getPreset = (id: PresetId): Preset => presets[id];

/** Private-network hosts behave like local servers (no key, slow first load). */
export function isLocalUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    if (host.includes(":")) return host === "::1" || /^(fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(host);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const parts = host.split(".").map(Number);
      if (parts.some((part) => part > 255)) return false;
      return parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)
        || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
        || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127);
    }
    return (
      host === "localhost" ||
      host.endsWith(".local") ||
      !host.includes(".")
    );
  } catch {
    return false;
  }
}
