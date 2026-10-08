/** Opens a URL or folder through the default OS handler. Arguments never pass through a shell. */
export function openPath(target: string): void {
  const command = process.platform === "win32"
    ? /^https?:/i.test(target) ? ["rundll32", "url.dll,FileProtocolHandler", target] : ["explorer.exe", target]
    : process.platform === "darwin" ? ["open", target] : ["xdg-open", target];
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
}

export function checkedUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only http and https URLs without credentials can be opened");
  return url.href;
}
