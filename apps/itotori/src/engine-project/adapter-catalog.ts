import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseEngineProjectAdapterManifest,
  type EngineProjectAdapterManifest,
} from "./adapter-manifest.js";
import { EngineProjectAdapterManifestError } from "./errors.js";

export type EngineProjectAdapterCatalog = {
  readonly directory: string;
  readonly manifests: readonly EngineProjectAdapterManifest[];
  find(engine: string): EngineProjectAdapterManifest | undefined;
  describe(engine: string): EngineProjectAdapterManifest | undefined;
};

export type LoadEngineProjectAdapterCatalogOptions = {
  readonly directory?: string;
};

type LoadedManifest = {
  readonly path: string;
  readonly manifest: EngineProjectAdapterManifest;
};

/** Returns the directory that is discovered by default at runtime. */
export function defaultEngineProjectAdapterDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "adapters");
}

/**
 * Loads every JSON adapter manifest in a directory. No engine list is kept in
 * command code: adding a manifest makes its engine available to this catalog.
 */
export function loadEngineProjectAdapterCatalog(
  options: LoadEngineProjectAdapterCatalogOptions = {},
): EngineProjectAdapterCatalog {
  const directory = options.directory ?? defaultEngineProjectAdapterDirectory();
  const manifestPaths = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))
    .sort();
  const loadedManifests = manifestPaths.map((path) => ({ path, manifest: loadManifest(path) }));
  assertUniqueEngines(loadedManifests);
  const manifests = loadedManifests.map(({ manifest }) => manifest);

  const byEngine = new Map<string, EngineProjectAdapterManifest>();
  for (const manifest of manifests) {
    byEngine.set(manifest.engine, manifest);
  }

  const find = (engine: string): EngineProjectAdapterManifest | undefined => byEngine.get(engine);
  return { directory, manifests, find, describe: find };
}

function loadManifest(path: string): EngineProjectAdapterManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "could not be read";
    throw new EngineProjectAdapterManifestError({
      code: "invalid-manifest",
      source: path,
      key: "$",
      message: `Adapter manifest '${path}' is not valid JSON: ${reason}`,
    });
  }
  return parseEngineProjectAdapterManifest(value, path);
}

function assertUniqueEngines(manifests: readonly LoadedManifest[]): void {
  const sourceByEngine = new Map<string, string>();
  for (const loadedManifest of manifests) {
    const { manifest, path } = loadedManifest;
    const priorSource = sourceByEngine.get(manifest.engine);
    if (priorSource !== undefined) {
      throw new EngineProjectAdapterManifestError({
        code: "duplicate-engine",
        source: path,
        key: "engine",
        message: `Adapter engine '${manifest.engine}' is declared by both '${priorSource}' and '${path}'.`,
      });
    }
    sourceByEngine.set(manifest.engine, path);
  }
}
