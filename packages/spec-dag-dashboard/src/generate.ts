// Orchestrates a single dashboard generation:
//   load -> validate -> enrich -> collect git provenance -> bundle client ->
//   render -> write .tmp/dag-dashboard.html
//
// Pure pieces (enrich, render) are imported from their own modules; the only
// I/O here is reading the DAG (via the canonical loader), spawning git for
// provenance, and writing the output file.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleClient } from "./bundle-client.js";
import { loadDag, validateDag } from "./dag-loader.js";
import { buildDashboardData, enrich } from "./enrich.js";
import { collectGitProvenance } from "./provenance.js";
import { renderHtml } from "./render.js";

export interface GenerateResult {
  outPath: string;
  nodeCount: number;
  edgeCount: number;
  errorCount: number;
}

/** Repo root resolved from the compiled file location (dist/generate.js). */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/spec-dag-dashboard/dist -> repo root
  return resolve(here, "../../..");
}

export async function generateDashboard(): Promise<GenerateResult> {
  const root = repoRoot();
  const outPath = resolve(root, ".tmp/dag-dashboard.html");

  const dag = await loadDag();
  const validation = await validateDag(dag);
  const errors = validation.errors ?? [];

  const enriched = enrich(dag, errors);
  const provenance = collectGitProvenance(root);
  const data = buildDashboardData(dag, errors, enriched, provenance);

  const clientJs = await bundleClient();
  const html = renderHtml(data, clientJs);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  return {
    outPath,
    nodeCount: data.nodes.length,
    edgeCount: data.edgeCount,
    errorCount: data.errorCount,
  };
}

/** Reproduce the reference's stdout summary. */
export function printSummary(result: GenerateResult): void {
  const issueWord = result.errorCount === 1 ? "issue" : "issues";
  process.stdout.write(
    `dag dashboard -> ${result.outPath}\n` +
      `${result.nodeCount} nodes, ${result.edgeCount} edges, ${result.errorCount} validation ${issueWord}\n`,
  );
}
