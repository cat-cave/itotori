// Native patchback + translated-byte replay — the rehomed apply/replay seam.
//
// Consumes the immutable fact snapshot + accepted-output CAS through a strict
// PatchExportV02 (never a journal outcome), splices the accepted target bytes via
// the Kaifuu patchback, and observes the translated bytes back through Utsushi.
// Deterministic, no model call, no network. The single authoritative home for the
// accepted-output-driven byte apply; it imports nothing from the old orchestrator
// apply/replay home (enforced by the no-legacy guard).

import { writeFileSync } from "node:fs";

import type { PatchExportV02 } from "@itotori/localization-bridge-schema";

import { applyRealLivePatch, type RealLiveApplyResult, type RealLivePatchScope } from "./apply.js";
import { bindScopedTargets } from "./bind-scoped-targets.js";
import { buildPatchExportV02 } from "./build-patch-export.js";
import { writeTranslatedBundle } from "./translated-bundle.js";
import type { BoundScopedTarget, NativePatchbackInput } from "./types.js";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

export type {
  AcceptedUnitOutput,
  BoundScopedTarget,
  NativePatchbackInput,
  PatchbackBindingCode,
  PatchbackWorkScope,
} from "./types.js";
export { PatchbackBindingError } from "./types.js";
export { bindScopedTargets } from "./bind-scoped-targets.js";
export { buildPatchExportV02, PatchExportBuildError } from "./build-patch-export.js";
export {
  materializeTranslatedBundle,
  writeTranslatedBundle,
  TranslatedBundleError,
} from "./translated-bundle.js";
export {
  applyRealLivePatch,
  realLivePatchArgs,
  RealLiveApplyError,
  type RealLiveApplyArgs,
  type RealLiveApplyResult,
  type RealLivePatchScope,
} from "./apply.js";
export {
  replayObserve,
  replayValidateArgs,
  parseObservedBodies,
  observedTextContains,
  ReplayObserveError,
  type ObservedReplay,
  type ReplayObserveArgs,
} from "./replay.js";
export { deterministicUuid7 } from "./uuid7.js";

export type NativePatchbackBuild = {
  bound: readonly BoundScopedTarget[];
  patchExport: PatchExportV02;
  translatedBundle: Record<string, unknown>;
};

export type NativePatchbackApplyArgs = {
  input: NativePatchbackInput;
  sourceRoot: string;
  targetRoot: string;
  /** Where the translated v0.2 bundle JSON is written for `kaifuu patch --bundle`. */
  translatedBundlePath: string;
  scope: RealLivePatchScope;
  force?: boolean;
  nativeCli?: NativeCliRunner;
  log?: (message: string) => void;
};

export type NativePatchbackApplyResult = NativePatchbackBuild & {
  apply: RealLiveApplyResult;
};

/**
 * Build the strict PatchExportV02 from the snapshot + accepted outputs and write
 * the translated bundle to disk. Pure up to the single file write — no process
 * spawn, so a caller can inspect the export/bundle before applying.
 */
export function buildNativePatchback(
  input: NativePatchbackInput,
  translatedBundlePath: string,
): NativePatchbackBuild {
  const bound = bindScopedTargets(input);
  const patchExport = buildPatchExportV02(input, bound);
  const translatedBundle = writeTranslatedBundle(
    translatedBundlePath,
    input.rawBridge,
    patchExport,
    input.targetLocale,
  );
  return { bound, patchExport, translatedBundle };
}

/** Persist the built PatchExportV02 as canonical JSON (evidence / re-apply). */
export function writePatchExportV02(path: string, patchExport: PatchExportV02): void {
  writeFileSync(path, `${JSON.stringify(patchExport, null, 2)}\n`);
}

/**
 * The one shipped native path: build the PatchExportV02 from accepted outputs,
 * materialize the translated bundle, and apply it byte-surgically via Kaifuu. The
 * translated-byte replay is driven separately (per scene/unit) via `replayObserve`.
 */
export function runNativePatchbackApply(
  args: NativePatchbackApplyArgs,
): NativePatchbackApplyResult {
  const build = buildNativePatchback(args.input, args.translatedBundlePath);
  const apply = applyRealLivePatch({
    sourceRoot: args.sourceRoot,
    targetRoot: args.targetRoot,
    translatedBundlePath: args.translatedBundlePath,
    scope: args.scope,
    ...(args.force !== undefined ? { force: args.force } : {}),
    ...(args.nativeCli !== undefined ? { nativeCli: args.nativeCli } : {}),
    ...(args.log !== undefined ? { log: args.log } : {}),
  });
  return { ...build, apply };
}
