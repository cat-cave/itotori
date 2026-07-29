import { SOURCE_FILES } from "./synthetic-coverage-manifest.mjs";

export function group(sourceId, derivation, components) {
  const spec = SOURCE_FILES[sourceId];
  return {
    source: `${spec.path}${spec.symbols?.length ? `#${spec.symbols.join("+")}` : ""}`,
    derivation,
    count: components.length,
    components,
  };
}
