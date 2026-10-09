// Exists only in builds: build.ts runs extension/build.ts, which writes this file, before
// compiling. Imported dynamically by embedded.ts, and only inside the exe.
import bundle from "../../dist/browser-extension.txt" with { type: "text" };

export default bundle;
