// Engine patch-back adapter registry entry point.
//
// Importing this module registers every engine's adapter (side-effect) and
// re-exports the registry surface. Consumers select an adapter through here so
// the registry is never observed empty — adding an engine is adding one import.

import "./reallive-adapter.js";
import "./rpgmaker-adapter.js";
import "./siglus-adapter.js";
import "./softpal-adapter.js";

export * from "./engine-adapter.js";
export { realLivePatchbackAdapter } from "./reallive-adapter.js";
export { rpgMakerPatchbackAdapter } from "./rpgmaker-adapter.js";
export { siglusPatchbackAdapter } from "./siglus-adapter.js";
export { softpalPatchbackAdapter } from "./softpal-adapter.js";
