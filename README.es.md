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
- **Voz** (opcional, todo en tu PC). Puede decir sus respuestas en voz alta, en español o inglés, y
  tú puedes hablarle: pulsa **F8**, habla y vuelve a pulsarla. La voz la genera
  [Piper](https://github.com/rhasspy/piper) y la reconoce
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp); la pestaña **Voz** del panel descarga solo
  lo que actives (entre 100 y 400 MB) y te deja elegir su voz, velocidad y volumen.
- **Memoria.** Sigue la conversación, resume la parte más antigua cuando se alarga para no perder el
  hilo, y guarda datos sobre ti que corrige cuando algo cambia. Puedes leer, editar y borrar ambos.
  Pensada para modelos de IA pequeños en tu propio PC.
- **Tarjetas de Lilith.** Te deja tarjetas escritas a mano en la bandeja de notas del propio juego,
  como mucho una al día, sobre lo que han hablado y lo que decidas compartirle: notas, y fotos que
  eliges de tu PC en la pestaña **Tarjetas** del panel. Reacciona en su globo cuando le compartes
  algo, y puedes pedirle una tarjeta cuando quieras.
- **Habla por iniciativa propia** (opcional) cuando llevan un rato sin hablar, nunca mientras duerme.
- **La IA que prefieras:** Ollama en tu PC (gratis y privado), OpenAI, Claude, Gemini, DeepSeek,
  OpenRouter, Groq, Mistral, xAI, LM Studio o cualquier servidor compatible con OpenAI. Con Ollama,
  su modelo se carga al abrir el chat y libera la memoria tras 10 minutos sin uso, o en cuanto cierras
  el juego (cambia la espera en **IA → Avanzado**).
- **Búsqueda en internet** (opcional). Puede buscar noticias, clima, precios y otros datos
  actuales: gratis desde tu PC (DuckDuckGo, sin cuenta) o con [Firecrawl](https://www.firecrawl.dev)
  y tu clave de API. Actívala en **IA → Búsqueda en internet**.
- **Tus cuentas** (opcional). Inicia sesión con Google en la pestaña **Cuentas** del panel y Lilith
  podrá responderte con tu Gmail, Drive y Calendar cuando se lo pidas («¿Laura ya me contestó?»,
  «¿qué dice mi hoja de presupuesto?»). Solo lee, nunca cambia ni envía nada, y tú eliges qué puede
  leer. **Probar** te muestra exactamente lo que encontraría.
- **Se actualiza solo.** Las versiones nuevas se instalan en segundo plano y se aplican la próxima
  vez que abres el juego (puedes desactivarlo en **Juego → Instalación**).
- **Errores claros.** Si algo falla, Lilith no inventa una excusa: el globo dice qué pasó y cómo
  arreglarlo («La clave de API de OpenAI no es válida…», «Ollama no está abierto…»).
- **Control del PC.** Pídele que haga cosas en tu PC: abrir apps o enlaces, cambiar de ventana,
  escribir, hacer clic y desplazarse por una app, paso a paso. Los modelos con visión ven la pantalla
  después de cada acción; los demás usan el teclado, las apps y las ventanas. Solo Windows x64.
- **Extensión del navegador** (opcional, para Chrome, Edge, Brave y otros navegadores Chromium). Usa
  los sitios web por sus botones y campos numerados en vez del mouse, en tu navegador y con tus
  sesiones iniciadas: mucho más fiable con IA local pequeña, e incluso los modelos que no ven pueden
  navegar. Abre páginas en su propio grupo de pestañas «Lilith» mientras sigues usando tu PC. Instálala una
  vez desde **Lilith → Usar tu PC → Navegador**.

## Requisitos

- *The NOexistenceN of Lilith* en Windows 10 u 11 (64 bits).
- Una IA: [Ollama](https://ollama.com/download) en tu PC, o una clave de API de un servicio en línea.

## Instalación

1. Cierra el juego.
2. Descarga `LilithAICompanion-<versión>.zip` desde [Releases](https://github.com/StivenKN/lilith-ai-mod/releases) y **extráelo** en una carpeta.
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
- **F8** (si activaste «Hablarle con tu micrófono» en la pestaña **Voz**): empieza a escucharte;
  pulsa otra vez para enviar. El botón del micrófono en la ventana de chat hace lo mismo.
- **Botón ⚙** de esa ventana, o **«Configuración de Lilith AI»** en el menú de la bandeja del juego:
  abre el panel (IA, personalidad, memoria, ajustes, ayuda).
- El panel también tiene una pestaña **Chat**, por si quieres escribirle desde el navegador.

## Privacidad

- Tu configuración, tu clave de API, la memoria y los registros se guardan solo en tu PC, en
  `%APPDATA%\LilithAICompanion`.
- Con Ollama u otro servidor en este PC, nada sale de tu PC. Un servidor en tu red local recibe los datos por esa red.
- La voz siempre funciona en tu PC. Las grabaciones se borran en cuanto se convierten en texto, y lo
  que dices solo sale de tu PC como ese texto, igual que un mensaje escrito.
- Con un servicio en línea, se envía a ese servicio: tu mensaje, la conversación reciente y su
  resumen, la personalidad de Lilith, las notas sobre ti, lo que le compartes para sus tarjetas,
  la hora y tu nombre de jugador. Tu clave solo se envía a ese servicio.
- Con la búsqueda en internet activada, solo se envían a DuckDuckGo o Firecrawl las palabras que
  ella elige buscar, nunca tu conversación.
- Para buscar actualizaciones, el mod le pide a GitHub la lista de versiones cada pocas horas; no
  envía nada sobre ti.
- Con una cuenta conectada en **Cuentas**, Lilith solo mira en ella para responder un mensaje tuyo,
  nunca cuando habla por iniciativa propia ni cuando escribe una tarjeta. Las palabras que busca van
  a Google, a tu propia cuenta. Lo que encuentra solo va a la IA que escribe su respuesta, y nunca
  entra en sus notas sobre ti, en el resumen de la conversación ni en sus tarjetas. Una IA en línea
  solo lee una cuenta, o lo que Lilith te contó de ella, si activas **La IA en línea puede leer esta
  cuenta** en ella. Tu inicio de sesión se queda en tu PC, en `%APPDATA%\LilithAICompanion\accounts\`;
  **Desconectar** lo borra y le pide a Google que le quite el acceso.
- El control del PC se activa automáticamente con IA local o de tu red. Con servicios en línea
  está desactivado hasta que lo actives en **Lilith → Usar tu PC**. Cuando le pidas una tarea,
  Lilith puede identificar la app enfocada y enviar capturas de la pantalla principal al servidor
  de IA elegido si el modelo puede ver imágenes. Las capturas solo están en memoria durante el
  turno, no se guardan en el historial ni en los registros.
- Sin visión, solo puede abrir apps y enlaces, escribir y presionar teclas. Mueve el mouse o
  presiona una tecla para detenerla. El prompt le indica que pregunte antes de comprar, enviar
  mensajes, borrar, ingresar contraseñas o aceptar términos. El código bloquea la entrada de
  teclado en terminales y herramientas del sistema.
- Con la extensión del navegador, el control del PC también puede leer y usar páginas web: el texto
  y los botones y campos de las páginas que usa, y los títulos de las pestañas de esa ventana, se
  envían al servidor de IA elegido (y una imagen de la pestaña, si su modelo puede ver). Empieza en
  la pestaña que estás mirando, así que «¿qué dice esta página?» funciona. En el código, nunca lee ni
  escribe contraseñas, nunca abre su propia página de configuración ni páginas del navegador
  (`chrome://`), no sube archivos y solo cierra pestañas que ella abrió. La extensión solo habla con
  la Lilith de este PC, después de que ambas demuestran que comparten un secreto guardado en tu
  carpeta de datos. Para detenerla, pulsa **Cancelar** en la barra donde el navegador avisa que se
  está depurando.
- Las fotos que compartes para sus tarjetas son los únicos archivos que el mod lee para ellas, y solo
  las que tú eliges. Tu navegador las achica y las vuelve a codificar antes de guardarlas, lo que
  también les quita datos ocultos como la ubicación GPS. Con una IA en línea, cada foto se envía una
  sola vez para que pueda verla; después, las tarjetas usan la breve descripción que ella escribió y
  tu comentario. **Quitar** borra la foto de tu PC.

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

## Licencia

[MIT](LICENSE), para el código de este proyecto. *The NOexistenceN of Lilith*, sus personajes,
textos y arte pertenecen a sus dueños y no están cubiertos. Los componentes incluidos conservan sus
propias licencias: ver [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Las contribuciones son
bienvenidas: issues y pull requests en español o inglés.
