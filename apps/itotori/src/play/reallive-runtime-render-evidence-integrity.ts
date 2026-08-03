// Integrity checks shared by RealLive's render-evidence operation.
//
// The patched tree and the immutable source-runtime tree are distinct: the
// former supplies localized script bytes, while the latter supplies untouched
// configuration, artwork, and the pristine script used to recover display
// attributes. Both must remain hash-bound for the entire replay/render pass.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { hashLocalizationArtifact, verifyLocalizationArtifactManifest } from "@itotori/db";

import {
  PatchRuntimeLaunchError,
  type RuntimeLaunchRequest,
  type RuntimePatchSurface,
} from "./runtime-launcher-registry.js";

export function verifiedPatchTarget(
  patch: RuntimePatchSurface,
  request: RuntimeLaunchRequest,
): string {
  if (patch.status !== "playable") {
    throw new PatchRuntimeLaunchError(
      "patch_not_playable",
      "only a playable patch version can be rendered in the runtime",
    );
  }
  verifyPatchManifest(patch);
  const patchTarget = patch.artifactRefs.patchTarget;
  if (patchTarget === undefined || patchTarget.trim().length === 0) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the exact patch is missing runtime provenance",
    );
  }
  const resolvedTarget = resolve(patchTarget);
  const requestedRoot = resolve(request.artifactRoot ?? resolvedTarget);
  if (requestedRoot !== resolvedTarget) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the selected runtime artifact root is not the patch's hash-verified target",
    );
  }
  return resolvedTarget;
}

export function verifiedRuntimeAssetRoot(
  patch: RuntimePatchSurface,
  requestedRoot: string,
): string {
  const runtimeAssets = requiredRuntimeAssets(patch);
  const pairedRoot = resolve(runtimeAssets.root);
  if (pairedRoot !== resolve(requestedRoot)) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the selected runtime assets are not the patch's hash-bound paired source tree",
    );
  }
  verifyRuntimeAssets(runtimeAssets);
  return pairedRoot;
}

export function assertRenderInputsRemainBound(input: {
  readonly patch: RuntimePatchSurface;
  readonly seenPath: string;
  readonly expectedPatchedBytesHash: `sha256:${string}`;
  readonly runtimeAssetRoot: string;
}): void {
  verifyPatchManifest(input.patch);
  if (hashEvidenceFile(input.seenPath) !== input.expectedPatchedBytesHash) {
    throw new PatchRuntimeLaunchError(
      "artifact_integrity_failed",
      "patched script bytes changed during runtime replay or render",
    );
  }
  verifiedRuntimeAssetRoot(input.patch, input.runtimeAssetRoot);
}

export function hashEvidenceFile(path: string): `sha256:${string}` {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    throw new PatchRuntimeLaunchError(
      "artifact_integrity_failed",
      "a required runtime evidence input could not be read",
    );
  }
}

/** The native renderer appends `.g00`; accept only one contained logical stem. */
export function verifiedBackgroundAsset(
  g00Dir: string,
  stem: string | undefined,
): string | undefined {
  if (stem === undefined) return undefined;
  if (
    stem.length === 0 ||
    stem === "." ||
    stem === ".." ||
    stem.includes("/") ||
    stem.includes("\\") ||
    stem.includes("\0")
  ) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "the runtime background asset must be a single contained asset stem",
    );
  }
  const root = resolve(g00Dir);
  const candidate = resolve(root, `${stem}.g00`);
  const traversal = relative(root, candidate);
  if (traversal === "" || traversal.startsWith("..") || traversal.includes("../")) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "the runtime background asset escapes the paired asset root",
    );
  }
  return stem;
}

function verifyPatchManifest(patch: RuntimePatchSurface): void {
  try {
    verifyLocalizationArtifactManifest(patch.artifactRefs, patch.artifactHashes);
  } catch {
    throw new PatchRuntimeLaunchError(
      "artifact_integrity_failed",
      "the exact patch artifacts failed integrity verification for runtime render",
    );
  }
}

function requiredRuntimeAssets(
  patch: RuntimePatchSurface,
): NonNullable<RuntimePatchSurface["runtimeAssets"]> {
  const runtimeAssets = patch.runtimeAssets;
  if (runtimeAssets === undefined || runtimeAssets.root.trim().length === 0) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "render evidence requires hash-bound paired runtime assets",
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(runtimeAssets.contentHash)) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the paired runtime assets have no valid content hash",
    );
  }
  return runtimeAssets;
}

function verifyRuntimeAssets(
  runtimeAssets: NonNullable<RuntimePatchSurface["runtimeAssets"]>,
): void {
  try {
    if (hashLocalizationArtifact(runtimeAssets.root) !== runtimeAssets.contentHash) {
      throw new Error("runtime asset hash mismatch");
    }
  } catch {
    throw new PatchRuntimeLaunchError(
      "artifact_integrity_failed",
      "paired runtime assets changed during runtime evidence capture",
    );
  }
}
