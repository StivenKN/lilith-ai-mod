import { join } from "node:path";

/**
 * The tar that reads and writes zip: bsdtar (libarchive). Windows 10+ ships it as System32\tar.exe,
 * macOS as bsdtar, Linux in libarchive-tools. GNU tar (Linux's default, Git for Windows) can't do zip,
 * so a plain "tar" from PATH isn't safe.
 */
export const zipTar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar";
