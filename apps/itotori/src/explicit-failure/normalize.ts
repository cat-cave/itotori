import {
  AuthorizedCancellationError,
  DisclosurePolicyError,
  InProfileDefectError,
  InProfileOperationError,
  ProviderDeadlineError,
  ProviderUnavailableError,
  RequiredAssetError,
  SourceRevisionChangedError,
  UnsupportedSourceProfileError,
  classifyExplicitFailure as classifySharedFailure,
  hasExplicitFailureEvidence as hasSharedFailureEvidence,
  type ExplicitFailureClassification,
} from "@itotori/db";
import { EgressDeniedError } from "../egress/policy.js";
import { LocalizationTargetPolicyError } from "../gates/policy/registry.js";
import { LlmPhysicalAttemptError } from "../llm/physical-attempt-policy.js";
import { PatchbackBindingError } from "../patchback/types.js";
import { PatchRuntimeLaunchError } from "../play/runtime-launcher-registry.js";

/**
 * Application adapter for the shared taxonomy. Existing source errors are
 * mapped only by their typed discriminants; their message text is log-only.
 */
export function classifyApplicationFailure(error: unknown): ExplicitFailureClassification {
  return classifySharedFailure(sharedSourceError(error));
}

export function hasApplicationFailureEvidence(error: unknown): boolean {
  return hasSharedFailureEvidence(error) || applicationSourceError(error) !== null;
}

function sharedSourceError(error: unknown): unknown {
  return applicationSourceError(error) ?? error;
}

function applicationSourceError(error: unknown): Error | null {
  if (
    error instanceof LocalizationTargetPolicyError &&
    (error.kind === "unknown-policy" || error.kind === "unknown-adapter")
  ) {
    return new UnsupportedSourceProfileError("unregistered-adapter-policy");
  }
  if (error instanceof PatchRuntimeLaunchError) return runtimeSourceError(error);
  if (error instanceof LlmPhysicalAttemptError) {
    if (error.failure.kind === "deadline") return new ProviderDeadlineError(0);
    if (error.failure.kind === "cancelled") {
      return new AuthorizedCancellationError("localization-run");
    }
    return new ProviderUnavailableError(error.failure.httpStatus ?? 503);
  }
  if (error instanceof PatchbackBindingError && error.code === "source-hash-mismatch") {
    return new SourceRevisionChangedError();
  }
  if (error instanceof EgressDeniedError) return new DisclosurePolicyError(error.code);
  return null;
}

function runtimeSourceError(error: PatchRuntimeLaunchError): Error {
  switch (error.code) {
    case "unknown_runtime_adapter":
      return new UnsupportedSourceProfileError("unknown-runtime-adapter");
    case "unsupported_runtime_operation":
      return new InProfileOperationError("unsupported-runtime-operation");
    case "runtime_assets_missing":
      return new RequiredAssetError("runtime-script");
    case "artifact_integrity_failed":
    case "patch_provenance_invalid":
      return new SourceRevisionChangedError();
    case "patch_not_playable":
    case "scene_not_available":
    case "invalid_launch_descriptor":
    case "runtime_failed":
    case "runtime_observation_missing":
      return new InProfileDefectError("repair-in-profile-operation");
  }
}
