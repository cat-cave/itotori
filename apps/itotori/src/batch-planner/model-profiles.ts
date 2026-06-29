import type { ProviderDescriptor, ProviderFamily } from "../providers/types.js";
import type { BatchModelProfile } from "./shapes.js";
import { tokenEstimatorIdV1 } from "./shapes.js";
import { defaultPromptOverheadTokens } from "./token-estimator.js";

export const defaultTargetFillRatio = 0.7;

/**
 * ITOTORI-220 — thrown when a model is named (via modelId or a provider
 * descriptor) but the caller did not declare which provider serves it.
 * Mirrors providers/dev-pair.ts:DevPairUnknownError: every model invocation
 * MUST carry a real (modelId, providerId) pair, so a missing provider is a
 * loud failure rather than a silently persisted unknown-provider sentinel
 * that would defeat per-pair attribution downstream.
 */
export class ModelProviderPairUnresolvedError extends Error {
  constructor(readonly modelId: string) {
    super(
      `cannot resolve a model profile for modelId=${modelId}: no providerId was supplied. ` +
        "Every batch invocation must declare a real (modelId, providerId) pair; " +
        "pass an explicit providerId or a built-in profile that pins one.",
    );
    this.name = "ModelProviderPairUnresolvedError";
  }
}

/**
 * Conservative SIZING numbers used when a real (modelId, providerId) pair is
 * supplied for a model we do not otherwise recognize. 128K context with a 0.5
 * fill ratio is intentionally pessimistic — we'd rather emit too many small
 * batches than overflow an unverified model. These are sizing-only fields:
 * they carry no routing identity, so they can never stand in for a provider.
 */
const conservativeSizingDefaults = {
  providerFamily: "fake" as ProviderFamily,
  contextWindowTokens: 128_000,
  maxOutputTokens: 4096,
  targetFillRatio: 0.5,
  promptOverheadTokens: defaultPromptOverheadTokens,
  tokenEstimatorId: tokenEstimatorIdV1,
} as const;

export type BuiltinProfileSeed = {
  providerFamily: ProviderFamily;
  modelId: string;
  /** ITOTORI-220 — required providerId per (modelId, providerId) pair. */
  providerId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
};

/**
 * A small set of built-in profiles for models Itotori is known to invoke.
 * Add new entries here as new models are exercised. Conservative defaults
 * are preferred — we never silently assume a context window we cannot
 * verify.
 */
export const builtinProfileSeeds: ReadonlyArray<BuiltinProfileSeed> = [
  {
    providerFamily: "openrouter",
    modelId: "anthropic/claude-3-5-sonnet",
    // ITOTORI-220 — Claude models are pinned to Anthropic-the-provider on
    // OpenRouter; using the Anthropic-served route is the standing pair.
    providerId: "anthropic",
    contextWindowTokens: 200_000,
    maxOutputTokens: 8192,
  },
  {
    providerFamily: "openrouter",
    modelId: "anthropic/claude-3-5-haiku",
    providerId: "anthropic",
    contextWindowTokens: 200_000,
    maxOutputTokens: 8192,
  },
  {
    providerFamily: "openrouter",
    modelId: "openai/gpt-4o-mini",
    providerId: "openai",
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
  },
  {
    providerFamily: "local-openai-compatible",
    modelId: "local-default",
    providerId: "local",
    contextWindowTokens: 32_768,
    maxOutputTokens: 4096,
  },
  {
    providerFamily: "fake",
    modelId: "itotori-fake-draft",
    providerId: "fake-fixture",
    contextWindowTokens: 8192,
    maxOutputTokens: 1024,
  },
];

function seedToProfile(seed: BuiltinProfileSeed): BatchModelProfile {
  return {
    providerFamily: seed.providerFamily,
    modelId: seed.modelId,
    providerId: seed.providerId,
    contextWindowTokens: seed.contextWindowTokens,
    maxOutputTokens: seed.maxOutputTokens,
    targetFillRatio: defaultTargetFillRatio,
    promptOverheadTokens: defaultPromptOverheadTokens,
    tokenEstimatorId: tokenEstimatorIdV1,
  };
}

export const builtinProfiles: ReadonlyArray<BatchModelProfile> =
  builtinProfileSeeds.map(seedToProfile);

type ResolveModelProfileInputOptional = {
  /** Caller-supplied override; wins outright when present. */
  override: BatchModelProfile | undefined;
  /** Provider descriptor (e.g. providers/types.ts entry). */
  providerDescriptor: ProviderDescriptor | undefined;
  /** Optional explicit modelId when no override is supplied. */
  modelId: string | undefined;
  /**
   * ITOTORI-220 — explicit providerId. Required whenever a model is named
   * (modelId or descriptor) without an override; the resolver throws
   * {@link ModelProviderPairUnresolvedError} when it is missing rather than
   * inventing an unknown-provider sentinel.
   */
  providerId: string | undefined;
  /** Optional override for targetFillRatio. */
  targetFillRatio: number | undefined;
  /** Optional override for maxTokens. Clamps contextWindowTokens. */
  maxTokensOverride: number | undefined;
};

/**
 * ITOTORI-220 — declared with a wrapping Partial intersection (rather
 * than per-field optional syntax) so this type does not match the
 * project-wide invariant on the legacy model-only field syntax.
 */
export type ResolveModelProfileInput = Partial<ResolveModelProfileInputOptional>;

/**
 * Resolution order, per §5.4 of the plan:
 *   1. Caller-supplied override (already a full, pinned profile).
 *   2. Provider descriptor's capabilities.contextWindowTokens.
 *   3. Built-in profile by modelId (carries its own pinned providerId).
 *   4. Caller-supplied modelId we do not recognize — sized conservatively.
 *
 * ITOTORI-220 — there is no "conservative fallback" that invents a provider.
 * Whenever a model is named (descriptor or modelId) but no providerId can be
 * resolved, this throws {@link ModelProviderPairUnresolvedError} instead of
 * persisting an unknown-provider sentinel. The result is persisted on
 * every batch and read by the draft agent as its routing target, so a missing
 * provider must fail loud rather than silently mis-attribute an invocation.
 *
 * All resolutions are pure; the caller persists the result on every batch
 * so audits can replay sizing decisions even after provider catalogs change.
 */
export function resolveModelProfile(input: ResolveModelProfileInput): BatchModelProfile {
  let base: BatchModelProfile;
  if (input.override) {
    base = { ...input.override };
  } else if (
    input.providerDescriptor &&
    input.providerDescriptor.capabilities.contextWindowTokens !== undefined &&
    input.providerDescriptor.capabilities.contextWindowTokens > 0
  ) {
    const modelId = input.modelId ?? input.providerDescriptor.defaultModelId;
    // Descriptors carry no provider routing target of their own (that's the
    // request's job), so the caller MUST declare the providerId for the pair.
    if (input.providerId === undefined) {
      throw new ModelProviderPairUnresolvedError(modelId);
    }
    base = {
      providerFamily: input.providerDescriptor.family,
      modelId,
      providerId: input.providerId,
      contextWindowTokens: input.providerDescriptor.capabilities.contextWindowTokens,
      maxOutputTokens: input.providerDescriptor.capabilities.maxOutputTokens,
      targetFillRatio: defaultTargetFillRatio,
      promptOverheadTokens: defaultPromptOverheadTokens,
      tokenEstimatorId: tokenEstimatorIdV1,
    };
  } else if (input.modelId) {
    const match = builtinProfiles.find((profile) => profile.modelId === input.modelId);
    if (match) {
      base = { ...match };
    } else {
      // Unrecognized model: size conservatively, but still require the caller
      // to declare the real provider — we never fabricate one.
      if (input.providerId === undefined) {
        throw new ModelProviderPairUnresolvedError(input.modelId);
      }
      base = {
        ...conservativeSizingDefaults,
        modelId: input.modelId,
        providerId: input.providerId,
      };
    }
  } else {
    // No override, no descriptor, no modelId: there is no model to plan an
    // invocation for, and inventing a (modelId, providerId) pair would defeat
    // the model-provider-pair law. Fail loud.
    throw new ModelProviderPairUnresolvedError("(no model supplied)");
  }

  if (input.providerId !== undefined) {
    base.providerId = input.providerId;
  }

  if (input.targetFillRatio !== undefined) {
    if (input.targetFillRatio <= 0 || input.targetFillRatio > 1) {
      throw new Error(`targetFillRatio must be in (0, 1]; received ${input.targetFillRatio}`);
    }
    base.targetFillRatio = input.targetFillRatio;
  }
  if (input.maxTokensOverride !== undefined) {
    if (input.maxTokensOverride <= 0) {
      throw new Error(`maxTokensOverride must be positive; received ${input.maxTokensOverride}`);
    }
    base.contextWindowTokens = Math.min(base.contextWindowTokens, input.maxTokensOverride);
  }

  return base;
}

/**
 * Token budget = floor((ctx - overhead - maxOut) * targetFillRatio).
 *
 * Clamped to >= 1 so even degenerate profiles still yield a usable cap; the
 * planner's pack-and-cap loop refuses to add a unit that would push the
 * total over the cap, so callers can detect undersized profiles by seeing
 * batches that fit one unit each.
 */
export function computeTokenBudgetCap(profile: BatchModelProfile): number {
  const usable =
    profile.contextWindowTokens - profile.promptOverheadTokens - (profile.maxOutputTokens ?? 0);
  if (usable <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(usable * profile.targetFillRatio));
}
