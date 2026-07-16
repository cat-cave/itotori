// Env-gated real-Sweetie oracle for the native patchback + translated-byte replay.
//
// Runs only when `ITOTORI_REAL_GAME_ROOT` points at a real RealLive install
// (never committed). It drives the REAL native seams end to end:
//   1. kaifuu extract --whole-seen        -> the v0.2 bridge
//   2. utsushi structure --bridge         -> the narrative structure
//   3. buildFactSnapshot                  -> the immutable fact snapshot
//   4. accepted outputs (one per scoped unit) -> PatchExportV02
//   5. kaifuu patch --engine reallive     -> the byte-surgical patched Seen.txt
//   6. utsushi replay-validate            -> observed TARGET text from patched bytes
// and proves the guarantees only real bytes can prove:
//   - export->apply round-trip is byte-exact: every UNTOUCHED scene is
//     byte-identical, the scoped scene changed;
//   - one accepted source-hash-matched target per scoped unit (missing/dup/
//     hash-mismatch fail loud — covered by the synthetic suite);
//   - Utsushi observes the accepted TARGET text from the PATCHED artifact, and a
//     SOURCE-byte replay does NOT observe it (it shows the untranslated source).
// When the corpus is not staged the test prints a visible skip note.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";

import { runKaifuuRealliveExtract } from "../src/extract/kaifuu-extract-seam.js";
import { buildFactSnapshot, type FactSnapshot } from "../src/prepass/index.js";
import { runUtsushiStructureExport } from "../src/structure-export/utsushi-structure-seam.js";
import type { NarrativeStructure } from "../src/structure/types.js";
import type { AcceptedUnitOutput, NativePatchbackInput } from "../src/patchback/index.js";
import {
  buildNativePatchback,
  applyRealLivePatch,
  observedTextContains,
  replayObserve,
} from "../src/patchback/index.js";

/** The documented 129-unit output scope for the Sweetie min-root. */
const SCOPED_SCENE = 1017;
const REALLIVE_SLOTS = 10_000;

function findRealliveRoot(
  root: string,
): { gameRoot: string; gameexe: string; seen: string } | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const seen = join(dir, "REALLIVEDATA", "Seen.txt");
    const gameexe = join(dir, "REALLIVEDATA", "Gameexe.ini");
    if (existsSync(seen) && existsSync(gameexe)) return { gameRoot: dir, gameexe, seen };
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory() && entry !== "REALLIVEDATA") stack.push(child);
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return undefined;
}

function realCorpus(): { gameRoot: string; gameexe: string; seen: string } | undefined {
  const root = process.env.ITOTORI_REAL_GAME_ROOT;
  if (root === undefined || root.length === 0 || !existsSync(root)) return undefined;
  return findRealliveRoot(root);
}

/** Populated scene blobs `(sceneId -> {offset,len})` from the 10k-slot directory. */
function sceneBlobs(seen: Buffer): Map<number, { off: number; len: number }> {
  const map = new Map<number, { off: number; len: number }>();
  for (let slot = 0; slot < REALLIVE_SLOTS; slot++) {
    const off = seen.readUInt32LE(slot * 8);
    const len = seen.readUInt32LE(slot * 8 + 4);
    if (off !== 0 && len !== 0) map.set(slot, { off, len });
  }
  return map;
}

const corpus = realCorpus();

describe("native patchback + replay (env-gated real Sweetie byte oracle)", () => {
  it.skipIf(!corpus)(
    "applies accepted targets byte-exactly and Utsushi observes the target from the patched bytes",
    () => {
      const workDir = mkdtempSync(join(tmpdir(), "itotori-patchback-real-"));
      const bridgePath = join(workDir, "bridge.json");
      const structurePath = join(workDir, "structure.json");
      const bundlePath = join(workDir, "translated-bridge.json");
      const targetRoot = join(workDir, "patched");
      const g00Dir = join(corpus!.gameRoot, "REALLIVEDATA", "g00");
      if (!existsSync(g00Dir)) mkdirSync(g00Dir, { recursive: true });

      // (1) real bridge + (2) real structure + (3) real snapshot.
      expect(
        runKaifuuRealliveExtract({
          gameRoot: corpus!.gameRoot,
          gameId: "reallive-corpus",
          gameVersion: "real",
          sourceProfileId: "reallive-corpus",
          sourceLocale: "ja-JP",
          wholeSeen: true,
          bundleOutputPath: bridgePath,
        }).status,
      ).toBe(0);
      expect(
        runUtsushiStructureExport({
          gameexePath: corpus!.gameexe,
          seenPath: corpus!.seen,
          outputPath: structurePath,
          bridgePath,
        }).status,
      ).toBe(0);

      const bridge = JSON.parse(readFileSync(bridgePath, "utf8")) as BridgeBundleV02;
      const structure = JSON.parse(readFileSync(structurePath, "utf8")) as NarrativeStructure;
      const snapshot: FactSnapshot = buildFactSnapshot(structure, bridge);

      // (4) accepted outputs — one per scoped unit. Each target is a distinctive
      // translated line: the marker `翻訳<full-width index>` followed by the unit's
      // IN-BODY protected spans (e.g. the `【和人】` speaker bracket) reproduced
      // verbatim. The marker is Shift-JIS-encodable and multibyte-clean, so the
      // engine observes it as a real dialogue TextLine; the preserved spans keep
      // protected-span coverage honest; and `翻訳` never occurs in the source, so
      // the source-byte replay cannot observe it.
      const bridgeUnitById = new Map(bridge.units.map((u) => [u.bridgeUnitId, u]));
      const scoped = snapshot.orderedUnits.filter((u) => u.sceneId === SCOPED_SCENE);
      expect(scoped).toHaveLength(129);

      const targetTextFor = (bridgeUnitId: string, index: number): string => {
        const unit = bridgeUnitById.get(bridgeUnitId);
        const inBodySpans = (unit?.spans ?? [])
          .filter((s) => s.outOfBand !== true)
          .map((s) => s.raw);
        return `翻訳${fullWidthDigits(index)}${inBodySpans.join("")}`;
      };
      const accepted: AcceptedUnitOutput[] = scoped.map((unit, index) =>
        makeAcceptedUnit(unit.factId, unit.sourceHash, targetTextFor(unit.bridgeUnitId, index)),
      );
      // A scoped unit that carries an in-body protected span — used below to
      // prove the span survives into the observed patched text.
      const spannedUnit = scoped.find((u) =>
        (bridgeUnitById.get(u.bridgeUnitId)?.spans ?? []).some((s) => s.outOfBand !== true),
      )!;
      const spannedRaw = bridgeUnitById
        .get(spannedUnit.bridgeUnitId)!
        .spans.find((s) => s.outOfBand !== true)!.raw;
      const input: NativePatchbackInput = {
        snapshot,
        accepted,
        rawBridge: bridge,
        workScope: { inScopeUnitFactIds: scoped.map((u) => u.factId) },
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
      };

      // (5) PatchExportV02 -> translated bundle -> byte-surgical apply.
      const build = buildNativePatchback(input, bundlePath);
      expect(build.patchExport.entries).toHaveLength(129);
      const apply = applyRealLivePatch({
        sourceRoot: corpus!.gameRoot,
        targetRoot,
        translatedBundlePath: bundlePath,
        scope: "dialogue+choices",
      });
      expect(apply.status).toBe(0);

      // --- Proof A: export->apply round-trip is BYTE-EXACT ---------------------
      const sourceSeenPath = join(corpus!.gameRoot, "REALLIVEDATA", "Seen.txt");
      const patchedSeenPath = join(targetRoot, "REALLIVEDATA", "Seen.txt");
      const sourceSeen = readFileSync(sourceSeenPath);
      const patchedSeen = readFileSync(patchedSeenPath);
      const sourceScenes = sceneBlobs(sourceSeen);
      const patchedScenes = sceneBlobs(patchedSeen);
      expect([...patchedScenes.keys()].sort()).toEqual([...sourceScenes.keys()].sort());

      let untouchedCompared = 0;
      for (const [sceneId, src] of sourceScenes) {
        const pat = patchedScenes.get(sceneId)!;
        const srcBlob = sourceSeen.subarray(src.off, src.off + src.len);
        const patBlob = patchedSeen.subarray(pat.off, pat.off + pat.len);
        if (sceneId === SCOPED_SCENE) {
          expect(patBlob.equals(srcBlob)).toBe(false); // the scoped scene changed
        } else {
          expect(patBlob.equals(srcBlob)).toBe(true); // every other scene byte-identical
          untouchedCompared += 1;
        }
      }
      expect(untouchedCompared).toBeGreaterThan(0);

      // --- Proof B: Utsushi observes the TARGET from the PATCHED artifact, and a
      // SOURCE-byte replay does NOT observe it (source-byte replay fails the proof)
      const observedPatched = replayObserve({
        seenPath: patchedSeenPath,
        sceneId: SCOPED_SCENE,
        gameexePath: corpus!.gameexe,
        g00Dir,
        replayLogPath: join(workDir, "replay-patched.json"),
      });
      const observedSource = replayObserve({
        seenPath: sourceSeenPath,
        sceneId: SCOPED_SCENE,
        gameexePath: corpus!.gameexe,
        g00Dir,
        replayLogPath: join(workDir, "replay-source.json"),
      });

      const patchedTargetLines = observedPatched.observedBodies.filter((b) => b.includes("翻訳"));
      const sourceTargetLines = observedSource.observedBodies.filter((b) => b.includes("翻訳"));
      // eslint-disable-next-line no-console
      console.log(
        `[patchback-real] scoped=129 untouchedScenes=${untouchedCompared} ` +
          `patchedTextlines=${observedPatched.textLineCount} sourceTextlines=${observedSource.textLineCount} ` +
          `patchedTargetLines=${patchedTargetLines.length} sourceTargetLines=${sourceTargetLines.length}\n` +
          `  firstEntryTarget=${JSON.stringify(build.patchExport.entries[0]!.targetText)}\n` +
          `  patchedBodies=${JSON.stringify(observedPatched.observedBodies.slice(0, 3))}\n` +
          `  sourceBodies=${JSON.stringify(observedSource.observedBodies.slice(0, 3))}`,
      );

      // The engine actually decoded text from the patched bytes.
      expect(observedPatched.observedBodies.length).toBeGreaterThan(0);
      // The PATCHED artifact shows the accepted targets; the SOURCE bytes show none
      // (a source-byte replay fails the observe-target proof).
      expect(patchedTargetLines.length).toBeGreaterThanOrEqual(120);
      expect(observedTextContains(observedSource, "翻訳")).toBe(false);
      // Protected-span preservation: the spanned unit's in-body span survives into
      // an observed patched dialogue line alongside the translation marker.
      expect(
        observedPatched.observedBodies.some((b) => b.includes("翻訳") && b.includes(spannedRaw)),
      ).toBe(true);
      // The concrete first accepted target is itself observed verbatim.
      expect(observedTextContains(observedPatched, build.patchExport.entries[0]!.targetText)).toBe(
        true,
      );
    },
    600_000,
  );
});

/** Render an integer as full-width digits (U+FF10..U+FF19) — a multibyte,
 * Shift-JIS-clean unique suffix for the per-unit translation marker. */
function fullWidthDigits(n: number): string {
  return String(n)
    .split("")
    .map((d) => String.fromCharCode(0xff10 + Number(d)))
    .join("");
}

/** A minimal schema-valid unit AcceptedOutput bound to `factId` with `target`. */
function makeAcceptedUnit(factId: string, sourceHash: string, target: string): AcceptedUnitOutput {
  const sha = `sha256:${"0".repeat(64)}` as const;
  return {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: `output:${factId}`,
    version: 1,
    parentOutputIds: [],
    memoKeys: [],
    evidenceIds: [factId],
    acceptedAt: "2026-07-15T00:00:00.000Z",
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "test-dev",
      contextScope: "narrowed:patchback-real",
      reason: "test-dev",
    },
    subjectType: "unit",
    subjectId: factId,
    localizationSnapshotId: sha,
    stage: "final",
    sourceHash: sourceHash as `sha256:${string}`,
    value: {
      targetSkeleton: target,
      targetHash: sha,
      translationObjectId: `translation:${factId}`,
      translationObjectVersion: 1,
      parentDraftBatchId: "batch:patchback-real",
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible:real"] },
      gateReceipts: [{ gate: "protected-spans", evidenceHash: sha, status: "PASS" }],
      reviewVerdictIds: [],
    },
  };
}
