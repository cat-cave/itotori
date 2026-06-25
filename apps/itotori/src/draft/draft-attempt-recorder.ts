// ITOTORI-077 - Draft attempt cost + provenance recorder.
//
// Translation invocation already returns token counts, prompt hash,
// and model metadata. This recorder maps that surface into the
// `draft_attempt_provider_ledger` table, capturing the fallback chain
// and recorded-bundle id along the way.
//
// **Redaction contract**: the raw prompt body, raw response payload,
// API keys, private corpus text, and private asset paths NEVER land
// in the ledger row. Only the prompt hash from
// `TranslationInvocationResult.promptHashUsed` is persisted (with a
// `sha256:` scheme prefix). A regression test in
// `apps/itotori/test/draft-attempt-recorder.test.ts` asserts that a
// fixture carrying a literal `REDACTED-MUST-NEVER-APPEAR` body is
// not present anywhere in the serialised ledger entry.

import type {
  AuthorizationActor,
  DraftAttemptFallbackChainEntry,
  DraftAttemptProviderLedgerContextRef,
  DraftAttemptProviderLedgerEntry,
  DraftAttemptProviderLedgerPolicyVersions,
  ItotoriDraftAttemptProviderLedgerRepositoryPort,
  RecordLedgerEntryInput,
} from "@itotori/db";
import type { TranslationInvocationResult } from "../agents/translation/shapes.js";

export type FallbackEntry = DraftAttemptFallbackChainEntry;

export type DraftAttemptCostUsd = {
  unit: string;
  amount: string;
};

export type DraftAttemptRecorderArgs = {
  draftJobAttemptId: string;
  translationResult: TranslationInvocationResult;
  fallbackChain: ReadonlyArray<FallbackEntry>;
  costUsd: DraftAttemptCostUsd;
  latencyMs: number;
  recordedProviderBundleId?: string;
  policyVersions?: DraftAttemptProviderLedgerPolicyVersions;
  contextArtifactRefs?: ReadonlyArray<DraftAttemptProviderLedgerContextRef>;
  promptTemplateVersion?: string;
};

export class DraftAttemptRecorder {
  constructor(private readonly repository: ItotoriDraftAttemptProviderLedgerRepositoryPort) {}

  async record(
    actor: AuthorizationActor,
    args: DraftAttemptRecorderArgs,
  ): Promise<DraftAttemptProviderLedgerEntry> {
    const result = args.translationResult;
    const providerRun = result.modelMetadata.providerRun;
    const profile = result.modelMetadata.modelProfile;
    const identity = result.modelMetadata.providerIdentity;

    const isRecorded = result.recordedArtifactId !== undefined;
    const recordedBundleId =
      args.recordedProviderBundleId ?? (isRecorded ? result.recordedArtifactId : undefined);
    const providerProofId = isRecorded
      ? `recorded:${recordedBundleId ?? result.recordedArtifactId ?? providerRun.runId}`
      : `live:${providerRun.runId}`;

    // Redacted by construction: we hand the repository ONLY the hash
    // of the prompt (with sha256 scheme), token counts, model
    // metadata, fallback chain, and cost. The raw prompt body and the
    // raw response payload are NEVER referenced here.
    //
    // ITOTORI-232 — usage_response_json is plumbed verbatim from the
    // providerRun. Live OR runs and recorded replays carry the
    // originating `usage` block (with a real `cost` field equal to
    // costUsd.amount within 1e-9 USD); fake / local providers carry a
    // typed sentinel without a `cost` key. The DB CHECK enforces the
    // equality where applicable; callers cannot smuggle in a fake
    // cost_amount without it being visible in the ledger row.
    const input: RecordLedgerEntryInput = {
      draftJobAttemptId: args.draftJobAttemptId,
      providerProofId,
      modelProviderFamily: identity.providerFamily,
      modelId: profile.modelId,
      // ITOTORI-220 — pinned providerId travels into the ledger row so
      // an audit can verify the same (model, provider) pair would be
      // used on rerun. The providerRun identity carries the requested
      // pair; the profile carries the policy-declared pair; they MUST
      // match by construction (typed) and we surface the identity here.
      providerId: identity.requestedProviderId,
      modelContextWindowTokens: profile.contextWindowTokens,
      modelMaxOutputTokens: profile.maxOutputTokens,
      promptTemplateVersion: args.promptTemplateVersion ?? providerRun.prompt.templateVersion,
      promptHash: `sha256:${result.promptHashUsed}`,
      policyVersions: args.policyVersions ?? {},
      contextArtifactRefs: [...(args.contextArtifactRefs ?? [])],
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUnit: args.costUsd.unit,
      costAmount: args.costUsd.amount,
      usageResponseJson: providerRun.usageResponseJson,
      latencyMs: args.latencyMs,
      fallbackChain: [...args.fallbackChain],
      isRecordedProvider: isRecorded,
      recordedProviderBundleId: recordedBundleId,
    };

    return this.repository.recordLedgerEntry(actor, input);
  }
}
