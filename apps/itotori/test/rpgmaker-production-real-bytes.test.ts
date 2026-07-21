// Real-byte proof for the shipped RPG Maker extract + generic patch registry.
//
// The periodic strict lane supplies two read-only corpora and the built native
// binary. This test extracts every supported JSON-text surface through the app
// seam, changes one non-empty unit, routes that translated bundle through the
// registered patch adapter, then applies the emitted delta and compares output
// trees. No source or target text is logged or committed.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { runKaifuuExtract } from "../src/extract/kaifuu-extract-seam.js";
import { runNativeCli } from "../src/native-bin/cli-bin-resolver.js";
import { applyEnginePatchback } from "../src/patchback/index.js";

type RealCorpus = { label: string; root: string | undefined };
type RawBundle = {
  units: Array<{ sourceText: string; target?: { locale: string; text: string } }>;
};

const realCorpora: readonly RealCorpus[] = [
  { label: "real-corpus-1", root: process.env.ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ },
  { label: "real-corpus-2", root: process.env.ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ_2 },
];
const nativeBin = process.env.ITOTORI_KAIFUU_BIN;
const enabled =
  typeof nativeBin === "string" &&
  existsSync(nativeBin) &&
  realCorpora.every((corpus) => typeof corpus.root === "string" && existsSync(corpus.root));

/** Resolve an engine `www/` directory from a direct path or a bounded mounted
 * parent. `data/System.json` is the generic engine marker. */
function resolveWwwDir(root: string): string {
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 5 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (existsSync(join(current.path, "data", "System.json"))) return current.path;
    const www = join(current.path, "www");
    if (existsSync(join(www, "data", "System.json"))) return www;
    if (current.depth === 0) continue;
    let entries: string[];
    try {
      entries = readdirSync(current.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "www") continue;
      const child = join(current.path, entry);
      try {
        if (statSync(child).isDirectory()) pending.push({ path: child, depth: current.depth - 1 });
      } catch {
        // The mounted corpus may contain unreadable paths unrelated to data.
      }
    }
  }
  throw new Error(`no engine data directory under ${root}`);
}

function hashTree(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        hashes.set(
          relative(root, path),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        );
      }
    }
  };
  visit(root);
  return hashes;
}

describe.skipIf(!enabled)("RPG Maker production extract and patch on real bytes", () => {
  for (const corpus of realCorpora) {
    it(`${corpus.label} extracts, patches, and delta-applies JSON text`, () => {
      const sourceRoot = resolveWwwDir(corpus.root!);
      const workDir = mkdtempSync(join(tmpdir(), "itotori-rpgmaker-real-"));
      try {
        const bridgePath = join(workDir, "bridge.json");
        runKaifuuExtract({
          engine: "rpg-maker",
          gameDir: sourceRoot,
          gameId: corpus.label,
          gameVersion: "0.0.0",
          sourceProfileId: "real-bytes",
          sourceLocale: "ja-JP",
          bundleOutputPath: bridgePath,
        });

        const bundle = JSON.parse(readFileSync(bridgePath, "utf8")) as RawBundle;
        const changed = bundle.units.find((unit) => unit.sourceText.trim().length > 0);
        expect(changed).toBeDefined();
        for (const unit of bundle.units) {
          unit.target = { locale: "en-US", text: unit.sourceText };
        }
        changed!.target = { locale: "en-US", text: "[localized]" };
        const translatedBundlePath = join(workDir, "translated-bridge.json");
        writeFileSync(translatedBundlePath, `${JSON.stringify(bundle)}\n`);

        const patchedDataPath = join(workDir, "patched-data");
        const patch = applyEnginePatchback({
          engineId: "rpg-maker",
          sourceRoot,
          targetRoot: patchedDataPath,
          translatedBundlePath,
          scope: "dialogue+choices",
        });
        expect(patch.status).toBe(0);
        const deltaPath = join(workDir, "patch-delta.kaifuu");
        expect(existsSync(deltaPath)).toBe(true);

        const deltaAppliedPath = join(workDir, "delta-applied");
        const deltaApply = runNativeCli("kaifuu-cli", [
          "apply",
          join(sourceRoot, "data"),
          "--patch",
          deltaPath,
          "--output",
          deltaAppliedPath,
          "--report-output",
          join(workDir, "delta-apply-report.json"),
        ]);
        expect(deltaApply.status).toBe(0);

        const source = hashTree(join(sourceRoot, "data"));
        const patched = hashTree(patchedDataPath);
        const deltaApplied = hashTree(deltaAppliedPath);
        expect(deltaApplied).toEqual(patched);
        expect([...patched].filter(([path, hash]) => source.get(path) !== hash)).not.toHaveLength(
          0,
        );
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
