# Third-party notices

The release zip bundles or embeds the following components. Each keeps its own license.

| Component | Use | License |
|---|---|---|
| [BepInEx](https://github.com/BepInEx/BepInEx) 6.0.0-be.780 (with Il2CppInterop, HarmonyX, Doorstop and the .NET runtime it ships) | Mod loader, shipped unmodified in `payload/bepinex` | LGPL-2.1 (BepInEx); see the licenses inside that folder for its components |
| Unity libraries 2021.3.45 from unity.bepinex.dev | Unstripped Unity assemblies BepInEx needs on first launch | Unity's terms, as distributed by the BepInEx project |
| [Bun](https://bun.com) runtime | Embedded in LilithAICompanion.exe | MIT |
| [React](https://react.dev) | Dashboard | MIT |
| [Zod](https://zod.dev) | Validation | MIT |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) | Claude provider | MIT |
| [Zen Maru Gothic](https://fonts.google.com/specimen/Zen+Maru+Gothic) via Fontsource | Dashboard text | SIL Open Font License 1.1 |
| [Corben](https://fonts.google.com/specimen/Corben) via Fontsource | Dashboard titles | SIL Open Font License 1.1 |

Voice components are **not** in the release. The dashboard's Voice tab downloads them on request,
each pinned by SHA-256, into `%APPDATA%\LilithAICompanion\voice`:

| Component | Use | License |
|---|---|---|
| [Piper](https://github.com/rhasspy/piper) 2023.11.14-2 (with espeak-ng and ONNX Runtime) | Text to speech | MIT (Piper); GPL-3.0 (espeak-ng); MIT (ONNX Runtime) |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 1.9.2 | Speech to text | MIT |
| Whisper `base` / `small` models, ggml q8_0 ([ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)) | Speech recognition | MIT |
| Piper voices ([rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)): es_AR daniela, es_MX claude, en_US amy, en_US ljspeech | Her voice | CC BY-SA 4.0; Apache-2.0; see MycroftAI/mimic3-voices; public domain |

*The NOexistenceN of Lilith*, its characters, text and assets belong to their rights holders. This
project contains none of them.
