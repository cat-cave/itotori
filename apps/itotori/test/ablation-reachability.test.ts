import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Clause 1 (static half) + Clause 4: the ablation module is a CONFIGURATION of
// the real pipeline, not a parallel/forked implementation, AND it imports none of
// the old raw-MTL / provider surface. This walks the transitive import closure of
// the ablation barrel and asserts (a) it REACHES the shared substrate modules
// (run-policy, workflow driver/ports, deterministic gates, the live dispatch
// runtime, native patchback) so it composes them rather than reinventing them, and
// (b) it reaches NONE of the forbidden old raw-MTL / provider / agents modules.
// Re-adding an old raw-MTL import (or forking off the shared substrate) fails it.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = normalize(join(here, "..", "..", ".."));
const srcRoot = join(repoRoot, "apps", "itotori", "src");

const ENTRYPOINT = join(srcRoot, "ablation", "index.ts");

// The forbidden old surface (clause 4). Each needle maps to the hazard it guards.
const FORBIDDEN: readonly { readonly needle: string; readonly hazard: string }[] = [
  { needle: "/raw-mtl-baseline-proof/", hazard: "old raw-MTL baseline proof" },
  { needle: "/benchmark-stages/raw-mtl-baseline", hazard: "old raw-MTL baseline stage" },
  { needle: "/providers/", hazard: "old provider abstraction" },
  { needle: "/agents/", hazard: "legacy agents tree" },
  { needle: "/orchestrator/", hazard: "old orchestrator / journal reservation-finalizer" },
  { needle: "/services/project-workflow", hazard: "legacy ProjectWorkflowService" },
];

// The shared substrate the ablation MUST compose (clause 1). If any is absent
// from the closure, the ablation has forked its own implementation of it.
const REQUIRED_SUBSTRATE: readonly { readonly needle: string; readonly piece: string }[] = [
  { needle: "/run-policy/", piece: "the run-policy legality boundary" },
  { needle: "/workflow/", piece: "the shared workflow ports + per-unit CAS finalize" },
  { needle: "/gates/", piece: "the deterministic gates" },
  { needle: "/composition/", piece: "the live composition substrate (dispatch boundary)" },
  { needle: "/patchback/", piece: "native patchback" },
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

describe("ablation reachability — same substrate, no old raw-MTL import", () => {
  it("resolves a non-trivial closure spanning the new pipeline", () => {
    const closure = importClosure([ENTRYPOINT]);
    expect(closure.size).toBeGreaterThan(50);
  });

  it("clause 1: composes every shared-substrate module (does not fork one)", () => {
    const closure = importClosure([ENTRYPOINT]);
    const rels = [...closure].map((file) => file.slice(repoRoot.length).replaceAll("\\", "/"));
    for (const { needle, piece } of REQUIRED_SUBSTRATE) {
      expect(
        rels.some((rel) => rel.includes(needle)),
        `ablation must compose ${piece} (${needle})`,
      ).toBe(true);
    }
  });

  it("clause 4: reaches NONE of the old raw-MTL / provider / agents modules", () => {
    const closure = importClosure([ENTRYPOINT]);
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

describe("ablation static import hygiene — the barrel itself", () => {
  it("clause 4: the ablation source names no old raw-MTL module directly", () => {
    // The whole ablation directory, read directly — a belt-and-suspenders check
    // that no file in the module text-references the forbidden old modules, even
    // in a comment or a type-only import the closure walk might skip.
    const abDir = join(srcRoot, "ablation");
    const files = ["index.ts", "driver.ts", "policy.ts", "lineage.ts", "types.ts"].map((name) =>
      join(abDir, name),
    );
    const banned = [
      "raw-mtl-baseline-proof",
      "benchmark-stages/raw-mtl-baseline",
      "/providers/",
      "/agents/",
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const term of banned) {
        // Only flag genuine import specifiers, not incidental prose mentions.
        const importRe = new RegExp(`from\\s+["'][^"']*${term.replace(/[/]/g, "\\/")}`, "u");
        if (importRe.test(text)) offenders.push(`${file} imports ${term}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
