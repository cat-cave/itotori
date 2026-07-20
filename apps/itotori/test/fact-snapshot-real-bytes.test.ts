// Env-gated real-byte oracle for the deterministic fact-snapshot pre-pass.
//
// Only runs on an operator machine with `ITOTORI_REAL_GAME_ROOT` exported to a
// real RealLive install (never committed). It drives the REAL native seams:
//   1. kaifuu extract --whole-seen  -> the v0.2 bridge bundle
//   2. utsushi structure --bridge   -> the narrative structure (joined)
// then runs the pure pre-pass and asserts the guarantees that only real bytes
// can prove: byte-identical rebuild, zero model calls, the join succeeds on
// genuine bytes, every materialized speaker/color identity EQUALS the bridge's
// (cited, never recomputed), and the entry scene carries zero parser_unknown
// speakers with the decoded known-speaker count. When the corpus is not staged
// the test prints a visible skip note (no silent pass).

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BridgeBundleV02, SpeakerContextV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";

import { runKaifuuExtract } from "../src/extract/kaifuu-extract-seam.js";
import {
  buildFactSnapshot,
  serializeFactSnapshot,
  type FactSnapshot,
} from "../src/prepass/index.js";
import { runUtsushiStructureExport } from "../src/structure-export/utsushi-structure-seam.js";
import type { NarrativeStructure } from "../src/structure/types.js";

/** Recursively locate the REALLIVEDATA dir (Sweetie HD nests it under a
 * title-named subfolder) and return the game root that contains it. */
function findRealliveRoot(
  root: string,
): { gameRoot: string; gameexe: string; seen: string } | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const seen = join(dir, "REALLIVEDATA", "Seen.txt");
    const gameexe = join(dir, "REALLIVEDATA", "Gameexe.ini");
    if (existsSync(seen) && existsSync(gameexe)) {
      return { gameRoot: dir, gameexe, seen };
    }
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
        // unreadable child — skip
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

/** Histogram of speaker knowledge states across the materialized units of one
 * scene. Counts are on the CITED bridge identities, not any re-derivation. */
function speakerStates(snapshot: FactSnapshot, sceneId: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const unit of snapshot.orderedUnits) {
    if (unit.sceneId !== sceneId) continue;
    const state = unit.speaker?.knowledgeState ?? "absent";
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

describe("buildFactSnapshot (env-gated real Sweetie byte oracle)", () => {
  const corpus = realCorpus();
  it.skipIf(!corpus)(
    "drives the real extract + structure seams and proves the pre-pass guarantees",
    () => {
      const workDir = mkdtempSync(join(tmpdir(), "itotori-fact-snapshot-real-"));
      const bridgePath = join(workDir, "bridge.json");
      const structurePath = join(workDir, "structure.json");

      // (1) real bridge over the whole Seen.txt.
      const extract = runKaifuuExtract({
        gameRoot: corpus!.gameRoot,
        gameId: "reallive-corpus",
        gameVersion: "real",
        sourceProfileId: "reallive-corpus",
        sourceLocale: "ja-JP",
        wholeSeen: true,
        bundleOutputPath: bridgePath,
      });
      expect(extract.status).toBe(0);

      // (2) real structure, joined to that bridge's unit evidence.
      const structureExport = runUtsushiStructureExport({
        engine: "reallive",
        gameexePath: corpus!.gameexe,
        seenPath: corpus!.seen,
        outputPath: structurePath,
        bridgePath,
      });
      expect(structureExport.status).toBe(0);

      const bundle = JSON.parse(readFileSync(bridgePath, "utf8")) as BridgeBundleV02;
      const structure = JSON.parse(readFileSync(structurePath, "utf8")) as NarrativeStructure;

      // (3) zero model calls — build with the network hard-disabled.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("network is forbidden in the deterministic pre-pass");
      });
      let snapshot: FactSnapshot;
      let rebuilt: FactSnapshot;
      try {
        snapshot = buildFactSnapshot(structure, bundle);
        rebuilt = buildFactSnapshot(structure, bundle);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }

      // (4) byte-identical rebuild.
      expect(rebuilt.snapshotId).toBe(snapshot.snapshotId);
      const firstSnapshotPath = join(workDir, "fact-snapshot-first.json");
      const secondSnapshotPath = join(workDir, "fact-snapshot-second.json");
      writeFileSync(firstSnapshotPath, serializeFactSnapshot(snapshot), "utf8");
      writeFileSync(secondSnapshotPath, serializeFactSnapshot(rebuilt), "utf8");
      // Compare serialized files, not object identity, so the oracle is a
      // byte-level diff of the two independently materialized snapshots.
      expect(
        Buffer.compare(readFileSync(firstSnapshotPath), readFileSync(secondSnapshotPath)),
      ).toBe(0);
      expect(snapshot.snapshotId).toMatch(/^sha256:[0-9a-f]{64}$/u);

      // (5) speaker/color identity EQUALS the bridge for EVERY unit (cite,
      //     never recompute).
      const bridgeSpeakerById = new Map<string, SpeakerContextV02 | undefined>(
        bundle.units.map((unit) => [unit.bridgeUnitId, unit.speaker]),
      );
      for (const unit of snapshot.orderedUnits) {
        expect(unit.speaker).toEqual(bridgeSpeakerById.get(unit.bridgeUnitId) ?? null);
      }

      // (6) Story entry-scene speaker truth on real bytes. The 129-unit output
      //     scope is scene 1017 (every unit decoded, zero parser_unknown); the
      //     speaker oracle is scene 1018, whose decoded identities are exactly
      //     25 known / 0 parser_unknown (the Bridge v0.2 pin). These are decode
      //     facts CITED from the bundle, never model outputs.
      const OUTPUT_SCOPE_SCENE = 1017;
      const SPEAKER_ORACLE_SCENE = 1018;
      const scopeUnits = snapshot.orderedUnits.filter((u) => u.sceneId === OUTPUT_SCOPE_SCENE);
      const scopeStates = speakerStates(snapshot, OUTPUT_SCOPE_SCENE);
      const oracleStates = speakerStates(snapshot, SPEAKER_ORACLE_SCENE);
      // eslint-disable-next-line no-console
      console.log(
        `[fact-snapshot] real bytes: units=${snapshot.orderedUnits.length} ` +
          `entryScene=${structure.entryScene} ` +
          `scene${OUTPUT_SCOPE_SCENE}(units=${scopeUnits.length})=${JSON.stringify(scopeStates)} ` +
          `scene${SPEAKER_ORACLE_SCENE}=${JSON.stringify(oracleStates)} ` +
          `snapshotId=${snapshot.snapshotId}`,
      );
      // Output-scope scene: the 129-unit scope with no unresolved parser speaker.
      expect(scopeUnits).toHaveLength(129);
      expect(scopeStates.parser_unknown ?? 0).toBe(0);
      // Speaker-oracle scene: exactly 25 known speakers, zero parser_unknown.
      expect(oracleStates.known ?? 0).toBe(25);
      expect(oracleStates.parser_unknown ?? 0).toBe(0);

      // (7) input mutation => new id (drop the last decoded scene from dispatch).
      const mutated: NarrativeStructure = {
        ...structure,
        sceneDispatchOrder: structure.sceneDispatchOrder.slice(0, -1),
      };
      expect(buildFactSnapshot(mutated, bundle).snapshotId).not.toBe(snapshot.snapshotId);

      expect(dirname(bridgePath)).toBe(workDir);
    },
    600_000,
  );
});
