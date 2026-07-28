// fnd-spa-shell — the SPA entry the server serves (index.html → this module).
// Mounts the single React app shell and loads the design-system CSS bundle
// ONCE (the `@itotori/ds` convention), so every screen + component is styled
// from the one Dusk Observatory token source.

import { createRoot } from "react-dom/client";
import "@itotori/ds/styles.css";
// App-shell chrome, layered on top of the DS bundle (never forking it): the
// frame around the screens, and the screen layout the screens render into.
import "./ui/shell-frame.css";
import "./ui/screen-layout.css";
import "./ui/legacy-surface.css";
import "./ui/screen-variants.css";
import { App } from "./ui/App.js";

const container = document.querySelector<HTMLDivElement>("#app");
if (container !== null) {
  createRoot(container).render(<App />);
}
