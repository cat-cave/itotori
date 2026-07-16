// Structural no-legacy guard: the native patchback path imports NOTHING from the
// old orchestrator apply/replay home (patch-apply-seam / wholegame-render-
// validation-seam / attempt-outcome journal). Physical deletion of that home is a
// separate refactor with live consumers; here we prove the new path is decoupled
// by extracting every import specifier under src/patchback and asserting none
// reaches into `orchestrator/` (or the journal it read from).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const patchbackDir = join(here, "..", "src", "patchback");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Extract every import/export-from module specifier (string literal source). */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specs.push(match[1]!);
  // Bare side-effect imports (`import "x"`).
  const bare = /\bimport\s*["']([^"']+)["']/gu;
  while ((match = bare.exec(source)) !== null) specs.push(match[1]!);
  return specs;
}

const FORBIDDEN = [
  /orchestrator/u,
  /attempt-outcome-journal/u,
  /patch-apply-seam/u,
  /wholegame-render-validation/u,
];

describe("native patchback structural no-legacy boundary", () => {
  const files = tsFiles(patchbackDir);

  it("finds the patchback module files", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("imports nothing from the old orchestrator apply/replay home", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (FORBIDDEN.some((re) => re.test(spec))) {
          violations.push(`${file.slice(patchbackDir.length + 1)} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
