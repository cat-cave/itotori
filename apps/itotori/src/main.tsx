// fnd-spa-shell — the SPA entry the server serves (index.html → this module).
// Mounts the single React app shell and loads the design-system CSS bundle
// ONCE (the `@itotori/ds` convention), so every screen + component is styled
// from the one Dusk Observatory token source.

import { createRoot } from "react-dom/client";
import "@itotori/ds/styles.css";
import { App } from "./ui/App.js";

const container = document.querySelector<HTMLDivElement>("#app");
if (container !== null) {
  createRoot(container).render(<App />);
}
