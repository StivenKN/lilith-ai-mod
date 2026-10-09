import { expect, test } from "bun:test";
import { serveOnFreePort } from "./server.ts";

test("a second companion takes the next port instead of sharing the first one's", async () => {
  // Like an older companion: Bun's defaults, which may let another process bind the same port.
  const first = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, fetch: () => new Response("first") });
  const ports = [first.port!, first.port! + 1, first.port! + 2];
  // The second also keeps Bun's defaults: the check must not depend on the platform's socket options.
  const { port, server } = await serveOnFreePort(ports, (port) => Bun.serve({ hostname: "127.0.0.1", port, development: false, fetch: () => new Response("second") }), () => {});
  try {
    expect(port).not.toBe(first.port);
    // Every request to the first port still reaches the first companion, so its login link works.
    for (let n = 0; n < 6; n++) expect(await (await fetch(`http://127.0.0.1:${first.port}/`)).text()).toBe("first");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("second");
  } finally {
    server.stop(true);
    first.stop(true);
  }
});
