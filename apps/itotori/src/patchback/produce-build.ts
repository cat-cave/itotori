// Produce a playable patched build from accepted outputs — the production patcher.
//
// This is the missing "run finalizer" byte producer: it drives the SAME native
// apply seam the CLI/tests use (`runNativePatchbackApply` -> `kaifuu patch`) to
// splice the accepted target bytes into a real, playable game tree, then records
// the hash-bound artifact manifest the delivery boundary
// (`createDeliveredPatchArchive`) archives for download. It never re-implements a
// second patchback path and never fabricates a build — the bytes under
// `patchTarget` are exactly what the byte-surgical Kaifuu apply wrote.
//
// The produced record is a strict `PlayablePatchExport`, so the exact same
// manifest verification + tar archiver used by the immutable-version delivery
// route serves it. `cleanup()` removes the owned build tree once its bytes have
// been captured into an in-memory archive.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hashLocalizationArtifact, type PlayablePatchExport } from "@itotori/db";

import type { RealLivePatchScope } from "./apply.js";
import { runNativePatchbackApply, writePatchExportV02 } from "./index.js";
import type { NativePatchbackInput } from "./types.js";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

/** Every artifact ref a produced playable build carries (delivery + runtime
 * launch both read these keys). `patchTarget` is the real patched game tree. */
export const PRODUCED_PATCHBACK_ARTIFACT_KEYS = [
  "patchTarget",
  "translatedBridge",
  "patchApply",
  "patchExport",
] as const;

export type ProducePatchbackBuildOptions = {
  /** Read-only source game root (contains REALLIVEDATA/Seen.txt). */
  sourceRoot: string;
  /** Owned, writable root the produced build + provenance artifacts live under. */
  buildRoot: string;
  scope: RealLivePatchScope;
  /** The run whose accepted outputs are being finalized into a build. */
  runId?: string;
  force?: boolean;
  /** Test seam; production defaults to the real sanitized native-CLI spawn. */
  nativeCli?: NativeCliRunner;
  log?: (message: string) => void;
};

export type ProducedPatchbackBuild = {
  /** A strict, hash-bound playable patch export ready for the delivery archiver. */
  patch: PlayablePatchExport;
  /** Remove the owned build tree; safe to call after the archive bytes are captured. */
  cleanup(): void;
};

/**
 * Splice the accepted targets into a real playable build via the native apply
 * seam and record the hash-bound artifact manifest. The returned
 * {@link PlayablePatchExport} is exactly the shape the immutable-version
 * delivery route serves — no fabricated build, no second apply path.
 */
export function produceNativePatchbackBuild(
  input: NativePatchbackInput,
  options: ProducePatchbackBuildOptions,
  now: () => Date = () => new Date(),
): ProducedPatchbackBuild {
  const buildRoot = options.buildRoot;
  const targetRoot = join(buildRoot, "patch-target");
  const translatedBundlePath = join(buildRoot, "translated-bridge.json");
  const patchExportPath = join(buildRoot, "patch-export.json");
  const patchApplyPath = join(buildRoot, "patch-apply.json");
  mkdirSync(buildRoot, { recursive: true });

  // (1) The REAL byte-surgical apply: build the strict PatchExportV02 from the
  // accepted outputs, materialize the translated bundle, and spawn `kaifuu patch`.
  const applied = runNativePatchbackApply({
    input,
    sourceRoot: options.sourceRoot,
    targetRoot,
    translatedBundlePath,
    scope: options.scope,
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.nativeCli !== undefined ? { nativeCli: options.nativeCli } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });

  // (2) Persist the canonical provenance the delivery + runtime-launch surfaces
  // read: the strict export JSON and the native apply receipt (argv + status).
  writePatchExportV02(patchExportPath, applied.patchExport);
  writeFileSync(
    patchApplyPath,
    `${JSON.stringify(
      {
        apply: {
          command: applied.apply.command,
          args: applied.apply.args,
          status: applied.apply.status,
        },
      },
      null,
      2,
    )}\n`,
  );

  // (3) The hash-bound manifest. Every ref is recomputed by
  // `verifyLocalizationArtifactManifest` at the delivery boundary, so a produced
  // build cannot silently change which bytes it addresses.
  const artifactRefs: Record<string, string> = {
    patchTarget: targetRoot,
    translatedBridge: translatedBundlePath,
    patchApply: patchApplyPath,
    patchExport: patchExportPath,
  };
  const artifactHashes: Record<string, string> = {};
  for (const key of PRODUCED_PATCHBACK_ARTIFACT_KEYS) {
    artifactHashes[key] = hashLocalizationArtifact(artifactRefs[key]!);
  }

  const patchVersionId = `patch-version:${applied.patchExport.patchExportId}`;
  const runId = options.runId ?? patchVersionId;
  const playableAt = now();
  const units = applied.patchExport.entries.map((entry, index) => ({
    bridgeUnitId: entry.bridgeUnitId,
    sourceRunId: runId,
    journalOutcomeId: entry.entryId,
    resultRevisionId: entry.entryId,
    memberOrigin: "run_written_outcome",
    reusedFromPatchVersionId: null,
    unitOrdinal: index,
    targetBody: entry.targetText,
    origin: "run_finalizer",
    actorUserId: null,
  }));

  const patch: PlayablePatchExport = {
    patchVersionId,
    runId,
    parentPatchVersionId: null,
    origin: "run_finalizer",
    actorUserId: null,
    status: "playable",
    selectedAt: null,
    playableAt,
    artifactHashes,
    artifactRefs,
    units,
  };

  return {
    patch,
    cleanup: () => rmSync(buildRoot, { recursive: true, force: true }),
  };
}
