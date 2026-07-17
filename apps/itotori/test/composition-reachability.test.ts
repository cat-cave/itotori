import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Clause 2 (static half): NO request can reach the old path from a kept
// entrypoint. This walks the transitive import closure of the composition-root
// entrypoint modules and asserts NONE of the legacy modules is reachable — there
// is no import edge from a kept entrypoint to `ProjectWorkflowService`, a provider
// object, the context-correction worker, the journal reservation/finalizer, or a
// raw-MTL path. Deleting the cut (re-adding a route to the old service) fails it.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = normalize(join(here, "..", "..", ".."));
const srcRoot = join(repoRoot, "apps", "itotori", "src");

const ENTRYPOINTS = [
  "composition/index.ts",
  "composition/localize-entrypoint.ts",
  "composition/workflow-ports.ts",
  "composition/wiki-entrypoint.ts",
  "composition/play-entrypoint.ts",
  "composition/provisioning.ts",
  "composition/deps.ts",
].map((rel) => join(srcRoot, rel));

// The kept API mutation handlers for localize/draft / wiki write / patch-play. The
// cut is only real if THESE modules — the code the API dispatch actually
// delegates each kept mutation to — carry no import edge to the old path either.
// They live in their own modules (not the `api-handlers.ts` monolith, which
// legitimately imports the legacy graph for out-of-scope mutations) precisely so
// their transitive closure can be proven clean.
const API_HANDLER_ENTRYPOINTS = [
  "api/localize-route.ts",
  "api/wiki-route.ts",
  "api/play-route.ts",
].map((rel) => join(srcRoot, rel));

// The kept CLI command handlers for `localize` / `wiki` / `patch play` — same cut,
// proven from the CLI side. They live in their own modules (not the
// `cli-handlers.ts` monolith, which legitimately imports the legacy graph for
// out-of-scope commands) so their transitive closure can be proven clean.
const CLI_HANDLER_ENTRYPOINTS = [
  "cli/localize-command.ts",
  "cli/wiki-command.ts",
  "cli/play-command.ts",
  "cli/flags.ts",
].map((rel) => join(srcRoot, rel));

// The legacy modules that MUST be unreachable from any kept entrypoint. Each maps
// to one acceptance-clause hazard.
const FORBIDDEN: readonly { readonly needle: string; readonly hazard: string }[] = [
  { needle: "/services/project-workflow", hazard: "ProjectWorkflowService.draftProject" },
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
  const specRe = /(?:from|import)\s+["'](\.\.?\/[^"']+)["']/g;
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
    for (const match of contents.matchAll(specRe)) {
      const resolved = resolveImport(file, match[1]!);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

describe("composition reachability — no kept entrypoint reaches the old path", () => {
  it("resolves a non-trivial closure over the composition entrypoints", () => {
    const closure = importClosure(ENTRYPOINTS);
    // A meaningful proof: the closure actually spans the new pipeline (roles,
    // gates, patchback, wiki object-API, play launcher, workflow driver).
    expect(closure.size).toBeGreaterThan(50);
  });

  it("reaches NONE of the legacy service-graph modules", () => {
    const closure = importClosure(ENTRYPOINTS);
    const violations: string[] = [];
    for (const file of closure) {
      const rel = file.slice(repoRoot.length).replaceAll("\\", "/");
      if (rel.includes("/composition/")) continue;
      for (const { needle, hazard } of FORBIDDEN) {
        if (rel.includes(needle)) violations.push(`${rel} → ${hazard}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("API mutation-handler reachability — localize/draft / wiki / patch-play reach zero legacy modules", () => {
  it("spans the new pipeline from the kept API mutation handlers", () => {
    const closure = importClosure(API_HANDLER_ENTRYPOINTS);
    // The kept handlers reach the composition entrypoints, the live substrate
    // builders, the run policy, and the workflow driver — a non-trivial closure.
    expect(closure.size).toBeGreaterThan(50);
  });

  it("has NO import edge to project-workflow / providers / orchestrator / agents / WikiBrainService / raw-mtl", () => {
    const closure = importClosure(API_HANDLER_ENTRYPOINTS);
    const violations: string[] = [];
    for (const file of closure) {
      const rel = file.slice(repoRoot.length).replaceAll("\\", "/");
      // The composition root and the thin API handler modules themselves are the
      // cut, not the old path — everything else must be clean.
      if (rel.includes("/composition/") || rel.includes("/apps/itotori/src/api/")) continue;
      for (const { needle, hazard } of FORBIDDEN) {
        if (rel.includes(needle)) violations.push(`${rel} → ${hazard}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("CLI command-handler reachability — localize / wiki / patch-play reach zero legacy modules", () => {
  it("spans the new pipeline from the kept CLI handlers", () => {
    const closure = importClosure(CLI_HANDLER_ENTRYPOINTS);
    expect(closure.size).toBeGreaterThan(50);
  });

  it("has NO import edge to project-workflow / db-live-workflow-ports / providers / orchestrator / agents / raw-mtl", () => {
    const closure = importClosure(CLI_HANDLER_ENTRYPOINTS);
    const violations: string[] = [];
    for (const file of closure) {
      const rel = file.slice(repoRoot.length).replaceAll("\\", "/");
      if (rel.includes("/composition/") || rel.includes("/apps/itotori/src/cli/")) continue;
      for (const { needle, hazard } of FORBIDDEN) {
        if (rel.includes(needle)) violations.push(`${rel} → ${hazard}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
