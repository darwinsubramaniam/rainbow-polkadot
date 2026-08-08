import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { SdkGate } from "./SdkGate";
import { buildLine } from "./build";
import "./styles.css";

// First line in the console, before anything can fail. A stale service worker
// or a CID pinned in the gateway URL will serve an old bundle through a normal
// reload, and every symptom then belongs to code that is no longer on disk —
// so the very first thing any session says is which build is talking.
console.warn(`[rainbow] ${buildLine()}`);

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

// Where the "running without a host" notice gets left for App to pick up.
// A module-level slot rather than a prop chain: SdkGate learns this while
// recovering from an error, which is before App exists to be told.
export const standaloneReason = { value: null as string | null };

// Stable identity: SdkGate runs host detection once, keyed on this not changing.
const noteStandalone = (reason: string) => {
  standaloneReason.value = reason;
};

createRoot(root).render(
  <StrictMode>
    <SdkGate onStandalone={noteStandalone}>
      <App />
    </SdkGate>
  </StrictMode>,
);
