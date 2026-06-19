// The ONLY module that touches the untyped, repo-root spec-dag.mjs validator.
//
// We dynamic-import the canonical script so the dashboard's notion of "what's
// off" matches the repo validator exactly (no second, drifting rule set). The
// script is plain ESM with no type declarations, so we resolve it relative to
// the *compiled* file (dist/dag-loader.js) and cast its two exports. Everything
// downstream of this file is pure, typed TypeScript.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ValidationResult {
  errors: string[];
}

interface SpecDagModule {
  loadDag: () => unknown;
  validateDag: (value: unknown) => ValidationResult;
}

async function importSpecDag(): Promise<SpecDagModule> {
  // dist/dag-loader.js -> ../../../scripts/spec-dag.mjs (package is two dirs
  // below the repo root: packages/spec-dag-dashboard/dist).
  const here = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(here, "../../../scripts/spec-dag.mjs");
  const mod = (await import(pathToFileURL(scriptPath).href)) as unknown as SpecDagModule;
  return mod;
}

/** Load the raw DAG document via the canonical loader. */
export async function loadDag(): Promise<unknown> {
  const mod = await importSpecDag();
  return mod.loadDag();
}

/** Validate a DAG document via the canonical validator. */
export async function validateDag(value: unknown): Promise<ValidationResult> {
  const mod = await importSpecDag();
  return mod.validateDag(value);
}
