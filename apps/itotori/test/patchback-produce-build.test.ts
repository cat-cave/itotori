// Real-bytes proof for the produce-a-playable-build path (the API trigger's seam).
//
// The produce mutation (`POST /api/patchback/produce`) drives
// `PatchbackProduceService.produceArchive` -> `produceNativePatchbackBuild` ->
// the REAL native `kaifuu patch` apply, then hands the produced build to the
// SAME `createDeliveredPatchArchive` the durable delivery route uses. This test
// proves that whole path against REAL RealLive bytes: the produced archive is a
// non-empty tar of a real patched game tree (REALLIVEDATA/Seen.txt present) whose
// bytes differ from the source — no stub of the native op, no fabricated build.
//
// Env-gated: runs only when `ITOTORI_REAL_GAME_ROOT` points at a real RealLive
// install (never committed). When the corpus is not staged it prints a skip note.
// A deterministic 404-path test (no native op) always runs.

import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";

import { runKaifuuRealliveExtract } from "../src/extract/kaifuu-extract-seam.js";
import { buildFactSnapshot, type FactSnapshot } from "../src/prepass/index.js";
import { runUtsushiStructureExport } from "../src/structure-export/utsushi-structure-seam.js";
import type { NarrativeStructure } from "../src/structure/types.js";
import type { AcceptedUnitOutput, NativePatchbackInput } from "../src/patchback/index.js";
import { produceNativePatchbackBuild } from "../src/patchback/produce-build.js";
import {
  PatchbackProduceService,
  type LoadedProducePlan,
  type PatchbackProduceInputLoaderPort,
} from "../src/play/patchback-produce-service.js";
import { createDeliveredPatchArchive } from "../src/patch-export/delivery-archive.js";
import type { AuthorizationActor } from "@itotori/db";

const SCOPED_SCENE = 1017;

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

/** Read the entry paths of a ustar archive (only what we need to assert shape). */
function tarEntryPaths(bytes: Buffer): string[] {
  const paths: string[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const nameField = bytes.subarray(offset, offset + 100);
    const nul = nameField.indexOf(0);
    const name = nameField.subarray(0, nul < 0 ? 100 : nul).toString("utf8");
    if (name.length === 0) break; // trailing zero blocks
    const sizeField = bytes
      .subarray(offset + 124, offset + 136)
      .toString("ascii")
      .replace(/\0.*$/u, "")
      .trim();
    const size = parseInt(sizeField, 8) || 0;
    paths.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

const corpus = realCorpus();

const actor = { userId: "produce-test", permissions: [] } as unknown as AuthorizationActor;

describe("produce playable build (env-gated real Sweetie byte oracle)", () => {
  it.skipIf(!corpus)(
    "drives the real native apply and archives a real, non-empty patched build",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "itotori-produce-real-"));
      const bridgePath = join(workDir, "bridge.json");
      const structurePath = join(workDir, "structure.json");

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

      // (4) accepted outputs — one distinctive translated line per scoped unit.
      const bridgeUnitById = new Map(bridge.units.map((u) => [u.bridgeUnitId, u]));
      const scoped = snapshot.orderedUnits.filter((u) => u.sceneId === SCOPED_SCENE);
      expect(scoped.length).toBeGreaterThan(0);
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
      const input: NativePatchbackInput = {
        snapshot,
        accepted,
        rawBridge: bridge,
        workScope: { inScopeUnitFactIds: scoped.map((u) => u.factId) },
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
      };

      // (5a) direct producer: the REAL apply produces a real patched game tree.
      const buildRoot = join(workDir, "produced");
      const produced = produceNativePatchbackBuild(input, {
        sourceRoot: corpus!.gameRoot,
        buildRoot,
        scope: "dialogue+choices",
      });
      const patchTarget = produced.patch.artifactRefs.patchTarget!;
      const patchedSeen = join(patchTarget, "REALLIVEDATA", "Seen.txt");
      expect(existsSync(patchedSeen)).toBe(true);
      // The produced patched bytes differ from the source (a real translation was spliced).
      expect(readFileSync(patchedSeen).equals(readFileSync(corpus!.seen))).toBe(false);
      // The manifest carries all four hash-bound artifact keys.
      expect(Object.keys(produced.patch.artifactRefs).sort()).toEqual([
        "patchApply",
        "patchExport",
        "patchTarget",
        "translatedBridge",
      ]);

      // (5b) the delivery archiver serves the produced bytes as a real tar.
      const archive = await createDeliveredPatchArchive(produced.patch);
      expect(archive.contentType).toBe("application/x-tar");
      expect(archive.bytes.byteLength).toBeGreaterThan(1024);
      const entries = tarEntryPaths(archive.bytes);
      expect(entries).toContain("REALLIVEDATA/Seen.txt");
      produced.cleanup();
      expect(existsSync(patchTarget)).toBe(false);

      // (6) the full service path (what the API mutation invokes) returns the
      // same real archive from a produce plan loaded through the injected port.
      const loader: PatchbackProduceInputLoaderPort = {
        async load(): Promise<LoadedProducePlan> {
          return {
            input,
            sourceRoot: corpus!.gameRoot,
            scope: "dialogue+choices",
            runId: "run-produce-test",
          };
        },
      };
      const service = new PatchbackProduceService({ loader });
      const serviceArchive = await service.produceArchive(actor, { runId: "run-produce-test" });
      expect(serviceArchive).not.toBeNull();
      expect(serviceArchive!.bytes.byteLength).toBeGreaterThan(1024);
      expect(tarEntryPaths(serviceArchive!.bytes)).toContain("REALLIVEDATA/Seen.txt");

      // eslint-disable-next-line no-console
      console.log(
        `[produce-real] scopedUnits=${scoped.length} archiveBytes=${archive.bytes.byteLength} ` +
          `entries=${entries.length} patchVersionId=${produced.patch.patchVersionId}`,
      );
    },
    600_000,
  );

  it("returns null (a clean 404) when the produce plan loader finds no eligible run", async () => {
    const loader: PatchbackProduceInputLoaderPort = {
      async load(): Promise<LoadedProducePlan | null> {
        return null;
      },
    };
    const service = new PatchbackProduceService({ loader });
    expect(await service.produceArchive(actor, { runId: "missing" })).toBeNull();
  });
});

function fullWidthDigits(n: number): string {
  return String(n)
    .split("")
    .map((d) => String.fromCharCode(0xff10 + Number(d)))
    .join("");
}

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
      contextScope: "narrowed:produce-real",
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
      parentDraftBatchId: "batch:produce-real",
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible:real"] },
      gateReceipts: [{ gate: "protected-spans", evidenceHash: sha, status: "PASS" }],
      reviewVerdictIds: [],
    },
  };
}
