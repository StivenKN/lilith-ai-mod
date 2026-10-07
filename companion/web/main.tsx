import { createRoot } from "react-dom/client";
import { startSession } from "./api.ts";
import { App } from "./app.tsx";

// No top-level await: the compiled build bundles to a format that doesn't allow it.
void startSession().then(() => createRoot(document.getElementById("root")!).render(<App />));
