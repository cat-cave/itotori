import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Clause 2 (static half): NO request can reach the old path from a kept
// entrypoint. This walks each entrypoint's *runtime* import closure and asserts
// NONE of the legacy modules is reachable — there is no executable import edge to
// the retired project-workflow surface, a provider object, the context-correction worker, the
// journal reservation/finalizer, or a raw-MTL path. Type-only imports are erased
// before a request runs and are intentionally not runtime edges. Deleting the cut
// (or re-adding any old route) fails this test.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = normalize(join(here, "..", "..", ".."));
const srcRoot = join(repoRoot, "apps", "itotori", "src");

const ENTRYPOINTS = [
  "cli/localize-command.ts",
  "cli/wiki-command.ts",
  "cli/play-command.ts",
  "cli/flags.ts",
  "api/localize-route.ts",
  "api/wiki-route.ts",
  "api/play-route.ts",
  "api-handlers.ts",
  "composition/index.ts",
  "composition/localize-entrypoint.ts",
  "composition/workflow-ports.ts",
  "composition/wiki-entrypoint.ts",
  "composition/play-entrypoint.ts",
  "composition/provisioning.ts",
  "composition/deps.ts",
].map((rel) => join(srcRoot, rel));

// The legacy modules that MUST be unreachable from any kept entrypoint. Each maps
// to one acceptance-clause hazard.
const FORBIDDEN: readonly { readonly needle: string; readonly hazard: string }[] = [
  { needle: "/services/project-workflow", hazard: "retired project-workflow surface" },
  { needle: "/services/db-live-workflow-ports", hazard: "provider object / pass driver" },
  { needle: "/services/database-services", hazard: "legacy service graph factory" },
  { needle: "/services/context-correction-redrafter", hazard: "context-correction worker" },
  { needle: "/providers/", hazard: "provider object" },
  { needle: "/orchestrator/", hazard: "old orchestrator / journal reservation-finalizer" },
  { needle: "/raw-mtl-baseline-proof/", hazard: "raw-MTL path" },
  { needle: "/benchmark-stages/raw-mtl-baseline", hazard: "raw-MTL path" },
  { needle: "/agents/", hazard: "legacy agents tree" },
  { needle: "/wiki/service", hazard: "legacy WikiBrainService" },
  { needle: "/iteration/patch-iteration-service", hazard: "legacy journal/finalizer play path" },
];

function resolveImport(importer: string, specifier: string): string | null {
  const stripped = specifier.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u, "");
  const base = normalize(join(dirname(importer), stripped));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importClosure(entrypoints: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of runtimeRelativeImports(contents)) {
      const resolved = resolveImport(file, specifier);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/** Return only imports which exist after TypeScript erases types. The separate
 * `export` pattern matters for the composition barrel: every value it re-exports
 * is part of the gateway's runtime closure and must be audited as well. */
function runtimeRelativeImports(contents: string): readonly string[] {
  const specifiers: string[] = [];
  const importRe = /\bimport\s+(type\s+)?(?:[^"']*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/g;
  const exportRe = /\bexport\s+(type\s+)?(?:[^"']*?\s+from\s+)["'](\.\.?\/[^"']+)["']/g;
  for (const match of contents.matchAll(importRe)) {
    if (match[1] === undefined) specifiers.push(match[2]!);
  }
  for (const match of contents.matchAll(exportRe)) {
    if (match[1] === undefined) specifiers.push(match[2]!);
  }
  return specifiers;
}

describe("composition reachability — no kept entrypoint reaches the old path", () => {
  it("resolves a non-trivial runtime closure over every kept gateway", () => {
    const closure = importClosure(ENTRYPOINTS);
    // A meaningful proof: the closure actually spans the snapshot, roles, gates,
    // patchback, Wiki object API, play launcher, and workflow driver.
    expect(closure.size).toBeGreaterThan(50);
  });

  it("reaches NONE of the severed draft/provider/correction/journal/raw-MTL edges", () => {
    const closure = importClosure(ENTRYPOINTS);
    const violations: string[] = [];
    for (const file of closure) {
      const rel = file.slice(repoRoot.length).replaceAll("\\", "/");
      for (const { needle, hazard } of FORBIDDEN) {
        if (rel.includes(needle)) violations.push(`${rel} → ${hazard}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
