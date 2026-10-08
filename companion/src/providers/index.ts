import { createAnthropicProvider } from "./anthropic.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createOpenAiProvider } from "./openai-compat.ts";
import { getPreset, isLocalUrl, type PresetId } from "./presets.ts";
import { ProviderError, type Provider } from "./types.ts";

export interface ProviderSettings {
  preset: PresetId;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Ollama only: minutes the model stays in memory after its last request. */
  unloadAfterMinutes?: number;
}

/** Builds the adapter for a provider selection, or throws `not_configured` with what's missing. */
export function createProvider(settings: ProviderSettings, onAdjust: (message: string) => void): Provider {
  const preset = getPreset(settings.preset);
  if (!settings.baseUrl.trim()) throw new ProviderError("not_configured", "No server address set");
  if (!settings.model.trim()) throw new ProviderError("not_configured", "No model selected");
  if (preset.needsKey && !settings.apiKey && !isLocalUrl(settings.baseUrl)) {
    throw new ProviderError("not_configured", `No API key set for ${preset.label}`);
  }
  switch (preset.kind) {
    case "ollama":
      return createOllamaProvider({ baseUrl: settings.baseUrl, model: settings.model, unloadAfterMinutes: settings.unloadAfterMinutes, onAdjust });
    case "anthropic":
      return createAnthropicProvider({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, onAdjust });
    case "openai":
      return createOpenAiProvider({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, preset, onAdjust });
  }
}

/** Local servers (and LAN ones) get the long first-load timeout. */
export const isLocalProvider = (settings: Pick<ProviderSettings, "preset" | "baseUrl">): boolean =>
  getPreset(settings.preset).local || isLocalUrl(settings.baseUrl);

export { ProviderError } from "./types.ts";
export type { ChatTurn, ErrorKind, ModelInfo, Provider } from "./types.ts";
