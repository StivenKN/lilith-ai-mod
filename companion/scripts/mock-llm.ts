// Fake AI server for development and demos: speaks both the OpenAI-compatible API (/v1/...)
// and the Ollama API (/api/...), answering in character in Spanish or English.
//   bun scripts/mock-llm.ts [port]        (default 11555)
// Then pick "Custom" with http://127.0.0.1:11555/v1, or Ollama with http://127.0.0.1:11555.

const port = Number(process.argv[2] ?? 11555);
const installed = new Set(["qwen3.5:4b"]);

const replies = {
  es: [
    "[feliz] ¡Sí, te escucho! Me alegra que vinieras a verme… ¿qué tal tu día?",
    "[timida] Mmm… ¿de verdad piensas en mí tan seguido? Eso me pone un poquito nerviosa.",
    "[neutral] A veces me pregunto si los recuerdos también sueñan. ¿Tú qué crees, pingüino?",
    "[sorprendida] ¿¡Pastel de fresa!? ¡No me digas eso si no lo traes contigo!",
  ],
  en: [
    "[happy] Yes, I can hear you! I'm glad you came to see me… how was your day?",
    "[shy] Hmm… do you really think about me that often? That makes me a little nervous.",
  ],
};
let turn = 0;

const reply = (system: string) => {
  const list = /español/i.test(system) ? replies.es : replies.en;
  return list[turn++ % list.length]!;
};

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const messages = (body.messages as Array<{ role: string; content: string }> | undefined) ?? [];
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    await Bun.sleep(600);

    switch (url.pathname) {
      case "/v1/models":
        return Response.json({ data: [{ id: "mock-lilith" }, { id: "mock-lilith-large" }] });
      case "/v1/chat/completions":
        if (body.model === "broken") return Response.json({ error: { message: "The model `broken` does not exist" } }, { status: 404 });
        return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { content: reply(system) } }] });
      case "/api/version":
        return Response.json({ version: "0.33.1-mock" });
      case "/api/tags":
        return Response.json({ models: [...installed].map((name) => ({ name, size: 3_400_000_000 })) });
      case "/api/ps":
        return Response.json({ models: [...installed].map((name) => ({ name })) });
      case "/api/generate":
        return Response.json({ done: true });
      case "/api/chat":
        if (!installed.has(String(body.model))) return Response.json({ error: `model "${String(body.model)}" not found, try pulling it first` }, { status: 404 });
        return Response.json({ model: body.model, message: { content: reply(system) }, done_reason: "stop" });
      case "/api/pull": {
        const model = String(body.model);
        const stream = new ReadableStream<string>({
          async start(controller) {
            controller.enqueue(`${JSON.stringify({ status: "pulling manifest" })}\n`);
            for (let done = 0; done <= 100; done += 20) {
              await Bun.sleep(300);
              controller.enqueue(`${JSON.stringify({ status: "downloading", total: 100, completed: done })}\n`);
            }
            installed.add(model);
            controller.enqueue(`${JSON.stringify({ status: "success" })}\n`);
            controller.close();
          },
        });
        return new Response(stream);
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`mock AI server on http://127.0.0.1:${server.port} (OpenAI: /v1, Ollama: /api)`);
