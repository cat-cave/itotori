import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This is deliberately a source-level regression test. The control arm must
// remain a composition of the rebuilt dispatch/workflow surface and never grow
// an import edge to a retired baseline or hand-built provider stack.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = normalize(join(here, "..", "..", ".."));
const srcRoot = join(repoRoot, "apps", "itotori", "src");
const ablationRoot = join(srcRoot, "ablation");

const bannedImportFragments = [
  "raw-mtl-baseline-proof",
  "benchmark-stages/raw-mtl-baseline",
  "/providers/",
  "/agents/",
] as const;

function resolveImport(importer: string, specifier: string): string | null {
  const stripped = specifier.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u, "");
  const base = normalize(join(dirname(importer), stripped));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importClosure(entry: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const pending = [entry];
  const relativeImport = /(?:from|import)\s+["'](\.\.?\/[^"']+)["']/g;
  while (pending.length > 0) {
    const file = pending.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(relativeImport)) {
      const resolved = resolveImport(file, match[1]!);
      if (resolved !== null) pending.push(resolved);
    }
  }
  return seen;
}

describe("pure-MTL ablation import hygiene", () => {
  it("reaches the shared driver and certified dispatch without a retired import edge", () => {
    const closure = [...importClosure(join(ablationRoot, "index.ts"))]
      .map((file) => file.slice(repoRoot.length).replaceAll("\\", "/"))
      .sort();

    expect(closure).toContain("/apps/itotori/src/workflow/driver.ts");
    expect(closure).toContain("/apps/itotori/src/llm/dispatch.ts");
    expect(closure).toContain("/apps/itotori/src/gates/index.ts");
    expect(closure).toContain("/apps/itotori/src/patchback/index.ts");
    for (const fragment of bannedImportFragments) {
      expect(
        closure.some((file) => file.includes(fragment)),
        fragment,
      ).toBe(false);
    }
  });

  it("keeps every direct ablation import off the retired surface", () => {
    const files = ["driver.ts", "index.ts", "lineage.ts", "policy.ts", "types.ts"];
    const offenders = files.flatMap((file) => {
      const text = readFileSync(join(ablationRoot, file), "utf8");
      return bannedImportFragments
        .filter((fragment) => new RegExp(`from\\s+["'][^"']*${fragment}`, "u").test(text))
        .map((fragment) => `${file}: ${fragment}`);
    });
    expect(offenders).toEqual([]);
  });
});
