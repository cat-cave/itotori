// Real-bytes proof for the RPG Maker MV/MZ patch-apply wiring (this PR).
//
// Drives the ACTUAL `applyKaifuuRpgMakerPatch` seam — the byte-surgical apply
// step the `localize-live --engine rpg-maker-mv-mz --source --patch-target`
// pipeline now dispatches to — against the REAL kaifuu-cli on REAL MV/MZ
// `www` bytes, then verifies the produced `.kaifuu` delta round-trips
// BYTE-FOR-BYTE via `kaifuu apply`. No retail bytes are committed or asserted
// verbatim; the corpora are supplied out-of-band via env.
//
// SKIPPED by default (mirrors the crate's `#[ignore]` real-bytes test). To run:
//   ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ=<LustMemory root> \
//   ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ_2=<Countryside Life root> \
//   ITOTORI_KAIFUU_BIN=<path to built kaifuu-cli> \
//   pnpm --filter @itotori/app exec vitest run test/rpgmaker-patch-apply-real-bytes.test.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { applyKaifuuRpgMakerPatch } from "../src/orchestrator/patch-apply-seam.js";

const CORPUS_ROOT = process.env.ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ;
const CORPUS_ROOT_2 = process.env.ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ_2;
const KAIFUU_BIN = process.env.ITOTORI_KAIFUU_BIN;

type RealCorpus = {
  label: string;
  root: string | undefined;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  translatedUnitKey: string;
  translatedText: string;
};

const REAL_CORPORA: readonly RealCorpus[] = [
  {
    label: "LustMemory",
    root: CORPUS_ROOT,
    gameId: "lustmemory",
    gameVersion: "v1.02",
    sourceProfileId: "lustmemory-test",
    translatedUnitKey: "rpgmaker:Actors.json#/1/name",
    translatedText: "Chloe (EN)",
  },
  {
    label: "Countryside Life",
    root: CORPUS_ROOT_2,
    gameId: "countryside-life",
    gameVersion: "v1.0",
    sourceProfileId: "countryside-life-test",
    translatedUnitKey: "rpgmaker:Actors.json#/1/name",
    translatedText: "Hiro (EN)",
  },
];

// The periodic lane pre-checks both roots before invoking this suite. Keeping
// the test env-gated makes author-run invocation safe on machines without the
// out-of-band corpora while ensuring the lane cannot turn an absent corpus
// into a false green.
const enabled = Boolean(KAIFUU_BIN) && REAL_CORPORA.every((corpus) => Boolean(corpus.root));

/** Bounded BFS to the RPG Maker `www` dir (the one holding `data/`). */
function resolveWwwDir(root: string): string {
  const isWwwWithData = (dir: string): boolean =>
    dir.toLowerCase().endsWith("www") &&
    (statSync(join(dir, "data"), { throwIfNoEntry: false })?.isDirectory() ?? false);
  const find = (dir: string, depth: number): string | undefined => {
    if (isWwwWithData(dir)) return dir;
    if (depth === 0) return undefined;
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      if (!statSync(p).isDirectory()) continue;
      const hit = find(p, depth - 1);
      if (hit) return hit;
    }
    return undefined;
  };
  if (statSync(join(root, "data"), { throwIfNoEntry: false })?.isDirectory()) return root;
  const hit = find(root, 5);
  if (!hit) throw new Error(`no www/data tree under ${root}`);
  return hit;
}

function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!enabled)("applyKaifuuRpgMakerPatch on real MV/MZ bytes", () => {
  for (const corpus of REAL_CORPORA) {
    it(`${corpus.label}: patches www/data byte-surgically and round-trips byte-for-byte`, () => {
      const www = resolveWwwDir(corpus.root!);
      const bin = KAIFUU_BIN!;
      const sp = mkdtempSync(join(tmpdir(), "mvmz-real-"));
      try {
        // 1. REAL extract of REAL bytes -> v0.2 bridge.
        const bridgePath = join(sp, "bridge.json");
        const ex = spawnSync(
          bin,
          [
            "extract",
            "--engine",
            "rpgmaker",
            "--game-dir",
            www,
            "--game-id",
            corpus.gameId,
            "--game-version",
            corpus.gameVersion,
            "--source-profile-id",
            corpus.sourceProfileId,
            "--source-locale",
            "ja-JP",
            "--bundle-output",
            bridgePath,
          ],
          { encoding: "utf8" },
        );
        expect(ex.status, ex.stderr).toBe(0);

        // 2. Translated bundle: every unit carries a target (source text = no-op)
        //    with EXACTLY ONE ASCII surface translated so the patch is surgical.
        const bridge = JSON.parse(readFileSync(bridgePath, "utf8")) as {
          units: Array<{ sourceUnitKey: string; sourceText: string; target?: unknown }>;
        };
        expect(bridge.units.some((u) => u.sourceUnitKey === corpus.translatedUnitKey)).toBe(true);
        for (const u of bridge.units) {
          const text =
            u.sourceUnitKey === corpus.translatedUnitKey ? corpus.translatedText : u.sourceText;
          u.target = { locale: "en-US", text };
        }
        const translatedBundlePath = join(sp, "translated-bridge.json");
        writeFileSync(translatedBundlePath, JSON.stringify(bridge));

        // 3. Drive the NEW seam on REAL bytes (spawns the real kaifuu-cli).
        const patchedDataOutputPath = join(sp, "patched-data");
        const deltaOutputPath = join(sp, "rpgmaker-delta.kaifuu");
        const apply = applyKaifuuRpgMakerPatch({
          sourceRoot: www,
          patchedDataOutputPath,
          deltaOutputPath,
          translatedBundlePath,
          env: { ...process.env, ITOTORI_KAIFUU_BIN: bin },
        });
        expect(apply.status).toBe(0);

        // 4. Byte round-trip: kaifuu apply(delta) over the read-only source data
        //    reproduces the patched tree byte-for-byte.
        const appliedDir = join(sp, "applied");
        const ap = spawnSync(
          bin,
          [
            "apply",
            join(www, "data"),
            "--patch",
            deltaOutputPath,
            "--output",
            appliedDir,
            "--report-output",
            join(sp, "apply-report.json"),
          ],
          { encoding: "utf8" },
        );
        expect(ap.status, ap.stderr).toBe(0);

        const patched = hashTree(patchedDataOutputPath);
        const applied = hashTree(appliedDir);
        const source = hashTree(join(www, "data"));

        // Round-trip is byte-identical.
        expect(applied).toEqual(patched);

        // Surgical: exactly the translated file differs from source.
        const changed = [...patched].filter(([k, v]) => source.get(k) !== v).map(([k]) => k);
        expect(changed).toEqual(["Actors.json"]);

        // eslint-disable-next-line no-console
        console.log(
          `[real-bytes] title=${corpus.label} units=${bridge.units.length} ` +
            `patchedFiles=${patched.size} changed=${changed.join(",")} ` +
            "byteRoundTrip=PASS",
        );
      } finally {
        rmSync(sp, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
