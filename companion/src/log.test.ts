import { expect, test } from "bun:test";
import { Logger } from "./log.ts";

test("Google tokens, client secrets and OAuth query parameters never reach the log", () => {
  const logger = new Logger(null);
  const line = [
    "token ya29.a0AfH6SMB-abcdefghijklmnop refreshed with 1//0gAbCdEfGhIjKlMnOp",
    "client GOCSPX-abcdefghijklmn",
    "callback ?code=4/0AX4XfWh-abc&state=Zm9vYmFy",
    "body refresh_token=1//secret&client_secret=GOCSPX-x",
  ].join(" ");
  const redacted = logger.redact(line);
  for (const secret of ["a0AfH6SMB", "0gAbCdEfGh", "abcdefghijklmn", "4/0AX4XfWh", "Zm9vYmFy", "1//secret", "GOCSPX-x"]) expect(redacted).not.toContain(secret);
  expect(redacted).toBe("token *** refreshed with *** client *** callback ?code=***&state=*** body refresh_token=***&client_secret=***");
});
