<img src="assets/icon.svg" width="64" height="64" alt="">

# Lilith AI Companion

**[English](README.md) · Español**

Un mod no oficial para *The NOexistenceN of Lilith* que te deja hablar con Lilith. Le escribes, ella
responde en su globo de diálogo, con su personalidad, en tu idioma, y recuerda lo que le cuentas.

> Hecho por fans. No está afiliado ni respaldado por los desarrolladores o editores del juego.

## Qué hace

- **Chat con Lilith.** Pulsa **F7** (configurable), escribe y su respuesta aparece en su globo, con
  una expresión que acompaña lo que dice. Las respuestas largas se reparten en varios globos.
- **Español completo.** Su personalidad está escrita en español latinoamericano, no traducida. El
  panel, los mensajes del juego y esta guía están en español. Responde en el idioma del juego (12
  idiomas) o en el que elijas.
- **Memoria.** Sigue la conversación y guarda datos sobre ti que puedes leer, editar y borrar.
- **Habla por iniciativa propia** (opcional) cuando llevan un rato sin hablar, nunca mientras duerme.
- **La IA que prefieras:** Ollama en tu PC (gratis y privado), OpenAI, Claude, Gemini, DeepSeek,
  OpenRouter, Groq, Mistral, xAI, LM Studio o cualquier servidor compatible con OpenAI.
- **Errores claros.** Si algo falla, Lilith no inventa una excusa: el globo dice qué pasó y cómo
  arreglarlo («La clave de API de OpenAI no es válida…», «Ollama no está abierto…»).

## Requisitos

- *The NOexistenceN of Lilith* en Windows 10 u 11 (64 bits).
- Una IA: [Ollama](https://ollama.com/download) en tu PC, o una clave de API de un servicio en línea.

## Instalación

1. Cierra el juego.
2. Descarga `LilithAICompanion-<versión>.zip` desde la página de versiones y **extráelo** en una carpeta.
3. Abre `LilithAICompanion.exe`. Se abre una página en tu navegador que:
   - encuentra el juego en tu biblioteca de Steam,
   - instala BepInEx (el cargador de mods) y el mod,
   - te ofrece desactivar otros mods de IA que chocarían con este,
   - te ayuda a elegir y probar la IA.
4. Abre el juego desde Steam. **El primer inicio tarda de 1 a 3 minutos** mientras BepInEx se
   prepara; no lo cierres.
5. Pulsa **F7** y escríbele a Lilith.

> Si Windows muestra «Windows protegió tu PC», pulsa **Más información** y luego **Ejecutar de todas
> formas**. Es normal en programas nuevos sin firma digital.

## Elegir la IA

| Opción | Costo | Privacidad | Notas |
|---|---|---|---|
| **Ollama** (en tu PC) | Gratis | Nada sale de tu PC | El panel descarga el modelo recomendado (`qwen3.5:9b`, 6,6 GB; o `qwen3.5:4b`, 3,4 GB para PCs modestas). |
| **Servicio en línea** | Unos centavos por día de charla | Tus mensajes van a ese servicio | Rápido en cualquier PC. Necesitas una clave de API. |
| **Otro servidor local** | Gratis | En tu PC o tu red | LM Studio, llama.cpp, vLLM… |

El botón **Probar conexión** envía un mensaje real y te muestra la respuesta de Lilith, o el error
exacto y cómo resolverlo. Los modelos se cargan desde el servicio, así que siempre ves la lista actual.

## Uso diario

- **F7**: abre la ventana de chat junto a Lilith. **Enter** envía, **Esc** la cierra.
- **Botón ⚙** de esa ventana, o **«Configuración de Lilith AI»** en el menú de la bandeja del juego:
  abre el panel (IA, personalidad, memoria, ajustes, ayuda).
- El panel también tiene una pestaña **Chat**, por si quieres escribirle desde el navegador.

## Privacidad

- Tu configuración, tu clave de API, la memoria y los registros se guardan solo en tu PC, en
  `%APPDATA%\LilithAICompanion`.
- Con Ollama u otro servidor local, nada sale de tu PC.
- Con un servicio en línea, se envía a ese servicio: tu mensaje, la conversación reciente, la
  personalidad de Lilith, las notas sobre ti, la hora y tu nombre de jugador. Tu clave solo se envía a
  ese servicio.
- El mod no lee tu pantalla, tus ventanas ni tus archivos.

## Si algo falla

Abre el panel, pestaña **Ayuda**:

- **Problemas comunes** con su solución.
- **Copiar informe de diagnóstico**: versiones, configuración (con las claves ocultas) y el registro
  reciente, sin tus conversaciones. Pégalo en tu reporte.
- **Registro en vivo** para ver qué está pasando.

La pestaña **Juego** muestra qué funciones del mod están activas en tu versión del juego. Si una
actualización del juego rompe algo, solo deja de funcionar esa parte y ahí aparece el motivo.

Archivos útiles: `%APPDATA%\LilithAICompanion\logs\lilith-ai.log` y, en la carpeta del juego,
`BepInEx\LogOutput.log`.

## Desinstalar

Con el juego cerrado, abre `LilithAICompanion.exe` y, en el paso **Instalar**, despliega
**Desinstalar**. O borra a mano `BepInEx\plugins\LilithAICompanion` en la carpeta del juego. Tus datos
en `%APPDATA%\LilithAICompanion` se conservan hasta que los borres.

## Para desarrolladores

Ver [README.md](README.md#for-developers), [docs/BUILDING.md](docs/BUILDING.md) y
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
