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
// The produced record is an accepted-output-native manifest with the exact
// fields the shared verifier + tar archiver need. `cleanup()` removes the owned
// build tree once its bytes have been captured into an in-memory archive.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hashLocalizationArtifact } from "@itotori/db";

import {
  toPatchbackEngineReceipt,
  type PatchbackEngineId,
  type PatchbackEngineReceipt,
  type PatchbackScope,
} from "./adapters.js";
import { runNativePatchbackApply } from "./index.js";
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
  /** Read-only source game root (the engine's source artifacts live under it). */
  sourceRoot: string;
  /** Owned, writable root the produced build + provenance artifacts live under. */
  buildRoot: string;
  scope: PatchbackScope;
  /** Explicit engine identity. When omitted the engine is DISCOVERED from the
   * source root's artifacts — never defaulted to RealLive. */
  engineId?: PatchbackEngineId;
  /** The run whose accepted outputs are being finalized into a build. */
  runId?: string;
  force?: boolean;
  /** Test seam; production defaults to the real sanitized native-CLI spawn. */
  nativeCli?: NativeCliRunner;
  log?: (message: string) => void;
};

/**
 * One delivered unit's accepted-output provenance. This is deliberately not a
 * result-revision / attempt-record projection: the applied bytes are linked
 * directly to the immutable accepted output that supplied their target text.
 */
export type ProducedAcceptedPatchUnit = {
  bridgeUnitId: string;
  factId: string;
  sourceHash: string;
  acceptedOutputId: string;
  acceptedTargetHash: string;
  targetText: string;
};

/** The self-contained, accepted-output-driven delivery manifest emitted by the
 * native patchback. It has the small structural surface the archive boundary
 * needs while preserving strict PatchExportV02 + accepted-output provenance. */
export type ProducedPatchbackManifest = {
  patchVersionId: string;
  patchExportId: string;
  runId: string;
  /** The engine whose adapter wrote the patched bytes (never assumed). */
  engineId: PatchbackEngineId;
  /** The typed, engine-discriminated apply receipt (adapter id + native argv). */
  patchReceipt: PatchbackEngineReceipt;
  sourceBridgeId: string;
  sourceBundleHash: string;
  targetLocale: string;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  units: ProducedAcceptedPatchUnit[];
};

export type ProducedPatchbackBuild = {
  /** A strict, hash-bound accepted-output patch ready for the delivery archiver. */
  patch: ProducedPatchbackManifest;
  /** Remove the owned build tree; safe to call after the archive bytes are captured. */
  cleanup(): void;
};

/**
 * Splice the accepted targets into a real playable build via the native apply
 * seam and record the hash-bound artifact manifest. The returned accepted-
 * output-native manifest is accepted directly by the shared delivery archive —
 * no fabricated build, no second apply path, and no legacy result projection.
 */
export function produceNativePatchbackBuild(
  input: NativePatchbackInput,
  options: ProducePatchbackBuildOptions,
): ProducedPatchbackBuild {
  const buildRoot = options.buildRoot;
  const targetRoot = join(buildRoot, "patch-target");
  const translatedBundlePath = join(buildRoot, "translated-bridge.json");
  const patchExportPath = join(buildRoot, "patch-export.json");
  const patchApplyPath = join(buildRoot, "patch-apply.json");
  mkdirSync(buildRoot, { recursive: true });

  // (1) The REAL byte-surgical apply: build the strict PatchExportV02 from the
  // accepted outputs, materialize the translated bundle + strict export (the
  // export is written before apply so an engine that consumes it — e.g. Softpal
  // via `--patch` — finds it on disk), then spawn the engine adapter's `kaifuu
  // patch`. The engine is explicit or discovered from the source; never defaulted.
  const applied = runNativePatchbackApply({
    input,
    sourceRoot: options.sourceRoot,
    targetRoot,
    translatedBundlePath,
    patchExportPath,
    scope: options.scope,
    ...(options.engineId !== undefined ? { engineId: options.engineId } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.nativeCli !== undefined ? { nativeCli: options.nativeCli } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  const patchReceipt = toPatchbackEngineReceipt(applied.apply, options.scope);

  // (2) Persist the native apply receipt (engine-discriminated argv + status).
  // The strict export JSON was already written by the apply above.
  writeFileSync(patchApplyPath, `${JSON.stringify({ apply: patchReceipt }, null, 2)}\n`);

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
  const acceptedByBridgeUnitId = new Map(
    applied.bound.map((bound) => [bound.fact.bridgeUnitId, bound]),
  );
  const units = applied.patchExport.entries.map((entry) => {
    const bound = acceptedByBridgeUnitId.get(entry.bridgeUnitId);
    if (bound === undefined) {
      throw new Error(
        `native patchback produced export entry ${entry.entryId} without an accepted-output binding`,
      );
    }
    return {
      bridgeUnitId: entry.bridgeUnitId,
      factId: bound.fact.factId,
      sourceHash: entry.sourceHash,
      acceptedOutputId: bound.accepted.outputId,
      acceptedTargetHash: bound.accepted.value.targetHash,
      targetText: entry.targetText,
    };
  });

  const patch: ProducedPatchbackManifest = {
    patchVersionId,
    patchExportId: applied.patchExport.patchExportId,
    runId,
    engineId: applied.apply.engineId,
    patchReceipt,
    sourceBridgeId: applied.patchExport.sourceBridgeId,
    sourceBundleHash: applied.patchExport.sourceBundleHash,
    targetLocale: applied.patchExport.targetLocale,
    artifactHashes,
    artifactRefs,
    units,
  };

  return {
    patch,
    cleanup: () => rmSync(buildRoot, { recursive: true, force: true }),
  };
}
