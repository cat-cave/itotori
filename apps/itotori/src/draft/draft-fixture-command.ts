// ITOTORI-019 — Translation drafting fixture command.
//
// End-to-end (gate 4 closer) for the drafting side. Wires:
//
//   - TranslationAgent (ITOTORI-075)
//   - RecordedModelProvider (ITOTORI-078)
//   - DraftProtectedSpanValidator (ITOTORI-076)
//   - RetryPolicy (ITOTORI-076)
//   - acceptOrRejectDraft + routeFailedAttempt (ITOTORI-076)
//   - DraftAttemptRecorder (ITOTORI-077)
//   - ItotoriDraftJobRepository (ITOTORI-074) — port surface
//   - ItotoriDraftAttemptProviderLedgerRepository (ITOTORI-077) — port surface
//
// The command is **fixture mode only**: the provider is always
// `RecordedModelProvider`, keyed off a JSON bundle that ships in
// `apps/itotori/src/draft/draft-fixture-bundles/`. Live providers are
// rejected up-front via the explicit refusal guard.
//
// Outcome: a strict `DraftArtifactBundle` (schema in
// `@itotori/localization-bridge-schema`) written to disk. Every draft
// entry — accepted OR terminally rejected — names its source unit,
// provider proof id, ledger entry ref, and validator status.

import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  DraftAttemptFallbackChainEntry,
  DraftAttemptProviderLedgerContextRef,
  DraftAttemptProviderLedgerEntry,
  DraftAttemptProviderLedgerPolicyVersions,
  ItotoriDraftAttemptProviderLedgerRepositoryPort,
  ItotoriDraftJobRepositoryPort,
} from "@itotori/db";
import {
  assertDraftArtifactBundle,
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  type DraftArtifactBundle,
  type DraftArtifactDraftEntry,
  type DraftArtifactLedgerSummary,
  type DraftArtifactProtectedSpanValidationResult,
  type DraftArtifactProtectedSpanViolation,
  type DraftArtifactRetryFallbackState,
  type TranslationDraft,
} from "@itotori/localization-bridge-schema";
import { deterministicFixtureDataHandlingPolicy } from "../providers/policy.js";
import {
  RecordedModelProvider,
  type RecordedProviderBundle,
  type RecordedProviderResponse,
} from "../providers/recorded.js";
import {
  TranslationAgent,
  TranslationDraftResponseValidationError,
  TranslationPartialResultError,
  TranslationProviderCapabilityError,
  type TranslationBridgeUnit,
  type TranslationGlossaryEntry,
  type TranslationInvocationInput,
  type TranslationInvocationResult,
  type TranslationModelProfile,
  type TranslationProtectedSpanInput,
  type TranslationStyleGuideRule,
} from "../agents/translation/index.js";
import {
  acceptOrRejectDraft,
  DraftProtectedSpanValidator,
  RetryPolicy,
  routeFailedAttempt,
  type DraftFailure,
  type DraftProtectedSpanViolation,
  type DraftSourceProtectedSpan,
} from "./index.js";
import { DraftAttemptRecorder } from "./draft-attempt-recorder.js";

// ---------------------------------------------------------------------------
// Fixture project + bundle wire shapes
// ---------------------------------------------------------------------------

/**
 * On-disk shape for `--project <path>`. Carries enough to drive the
 * draft loop without depending on the live project repository — the
 * fixture command runs entirely from local JSON.
 */
export type DraftFixtureProject = {
  schemaVersion: "itotori.draft-fixture-project.v1";
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  targetLocale: string;
  draftJobId: string;
  promptTemplateVersion: string;
  bundlePath: string;
  bridgeUnits: DraftFixtureBridgeUnit[];
  protectedSpansBySource: Array<{
    bridgeUnitId: string;
    spans: DraftFixtureProtectedSpan[];
  }>;
  glossary: TranslationGlossaryEntry[];
  styleGuide: TranslationStyleGuideRule[];
  contextArtifactRefs?: string[];
  modelProfile: TranslationModelProfile;
  attemptIndexMax: number;
};

export type DraftFixtureBridgeUnit = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string;
};

export type DraftFixtureProtectedSpan = {
  refId: string;
  sourceText: string;
  spanKind: DraftSourceProtectedSpan["spanKind"];
  expectedTargetForm?: string;
};

/**
 * On-disk shape for one of the `draft-fixture-bundles/*.json` files.
 * `attempts` is the per-attempt-index list the fixture command replays
 * sequentially. Each entry names:
 *
 *   - `outcome.kind`: how the attempt resolves —
 *      - `provider_invocation_success` → provider returns a structured
 *        response and the agent accepts it (then the validator + retry
 *        policy decide whether to retry, fallback, succeed, or terminally
 *        reject);
 *      - `provider_invocation_capability_failure` → simulate a
 *        provider-capability failure that triggers the fallback path;
 *      - `provider_invocation_partial` → simulate a provider partial
 *        response (treated as retryable);
 *      - `schema_validation_failure` → simulate the agent throwing a
 *        TranslationDraftResponseValidationError (retryable for
 *        non-`required`/`type`/`minLength` rules).
 *
 *   - `provider`: which captured provider identity / family this attempt
 *     emulates — switches between primary and fallback provenance.
 *
 *   - `response`: the recorded `RecordedProviderResponse` to return on
 *     this attempt (only used for `provider_invocation_*` shapes).
 */
export type DraftFixtureBundle = {
  schemaVersion: "itotori.draft-fixture-bundle.v1";
  bundleId: string;
  attempts: DraftFixtureAttempt[];
};

export type DraftFixtureAttemptProviderIdentity = {
  capturedProviderFamily: RecordedProviderBundle["capturedProviderFamily"];
  capturedProviderName: string;
  capturedRequestedModelId: string;
  /**
   * ITOTORI-220 — providerId pinned at the time the bundle was captured.
   * Optional in the on-disk shape so the existing fixture bundles can be
   * loaded; new fixtures must declare it.
   */
  capturedProviderId?: string;
  capturedActualModelId: string;
};

export type DraftFixtureAttempt = {
  attemptIndex: number;
  provider: DraftFixtureAttemptProviderIdentity;
  outcome:
    | { kind: "provider_invocation_success"; response: RecordedProviderResponse }
    | {
        kind: "provider_invocation_capability_failure";
        providerName: string;
        providerFamily: RecordedProviderBundle["capturedProviderFamily"];
        detail: string;
      }
    | {
        kind: "provider_invocation_partial";
        finishReason: string;
        detail: string;
      }
    | {
        kind: "schema_validation_failure";
        path: string;
        rule: string;
        detail: string;
      };
  /**
   * Optional cost override. The fixture command derives a deterministic
   * cost from the token counts when omitted.
   */
  costEstimateOverride?: { unit: string; amount: string };
};

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

export type DraftFixtureCommandIo = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

export type DraftFixtureCommandArgs = {
  projectPath: string;
  outputPath: string;
  locale: string;
  io: DraftFixtureCommandIo;
  actor: AuthorizationActor;
  draftJobRepository: ItotoriDraftJobRepositoryPort;
  ledgerRepository: ItotoriDraftAttemptProviderLedgerRepositoryPort;
  /**
   * Time source so tests + recorded runs both produce byte-equal output.
   * Defaults to a deterministic counter pinned to a fixed epoch.
   */
  now?: () => Date;
  /**
   * Resolves bundlePath references inside the project JSON. Tests pass
   * an in-memory map; production uses the same json file store as the
   * outer CLI.
   */
  resolveBundle?: (bundlePath: string) => DraftFixtureBundle;
  log?: (message: string) => void;
};

export class DraftFixtureCommandLiveProviderRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftFixtureCommandLiveProviderRefusalError";
  }
}

export class DraftFixtureCommandLocaleMismatchError extends Error {
  constructor(
    public readonly requestedLocale: string,
    public readonly fixtureLocale: string,
  ) {
    super(
      `draft fixture command refused: --locale '${requestedLocale}' does not match fixture project targetLocale '${fixtureLocale}'`,
    );
    this.name = "DraftFixtureCommandLocaleMismatchError";
  }
}

export class DraftFixtureCommandUnknownProvenanceError extends Error {
  constructor(public readonly draftId: string) {
    super(
      `draft fixture command refused: draft ${draftId} could not be linked to a ledger entry; missing provenance is a hard failure`,
    );
    this.name = "DraftFixtureCommandUnknownProvenanceError";
  }
}

/**
 * Main entry point. Reads the fixture project from `projectPath`,
 * runs the deterministic draft loop, and writes the bundle to
 * `outputPath`.
 *
 * Returns the bundle for in-process callers (the test suite).
 */
export async function runDraftFixtureCommand(
  args: DraftFixtureCommandArgs,
): Promise<DraftArtifactBundle> {
  if (process.env.ITOTORI_LIVE_PROVIDER === "1") {
    throw new DraftFixtureCommandLiveProviderRefusalError(
      "draft fixture command refused: ITOTORI_LIVE_PROVIDER=1 is set; the fixture mode never invokes a live provider",
    );
  }

  const rawProject = args.io.readJson(args.projectPath);
  const project = assertDraftFixtureProject(rawProject);
  if (project.targetLocale !== args.locale) {
    throw new DraftFixtureCommandLocaleMismatchError(args.locale, project.targetLocale);
  }
  const bundle = resolveBundle(args, project);
  assertDraftFixtureBundle(bundle);

  const now = args.now ?? deterministicNow();
  const log = args.log ?? (() => {});

  // Create the parent draft job. The command treats the whole project
  // bridge-unit list as a single batch; partitioning across batches is
  // out of scope for this fixture command (the orchestrator owns it).
  const draftJob = await args.draftJobRepository.createDraftJob(args.actor, {
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    sourceUnitIds: project.bridgeUnits.map((unit) => unit.bridgeUnitId),
    styleGuideVersion: "fixture-style-guide-v1",
    glossaryVersion: "fixture-glossary-v1",
    policyVersions: {
      promptTemplateVersion: project.promptTemplateVersion,
      modelProviderFamily: project.modelProfile.providerFamily,
      modelId: project.modelProfile.modelId,
      providerId: project.modelProfile.providerId,
    },
  });
  log(`created draft job ${draftJob.draftJobId}`);

  const protectedSpansBySource = projectProtectedSpansMap(project);
  const sourceBridgeUnits = project.bridgeUnits.map(projectBridgeUnitToTranslation);
  const sourceSpansForGate = projectProtectedSpansForGate(project);

  const validator = new DraftProtectedSpanValidator();
  const retryPolicy = new RetryPolicy();
  const recorder = new DraftAttemptRecorder(args.ledgerRepository);

  const ledgerEntriesByProviderProof = new Map<string, DraftAttemptProviderLedgerEntry>();
  const allLedgerEntries: DraftAttemptProviderLedgerEntry[] = [];
  const fallbackChain: DraftAttemptFallbackChainEntry[] = [];

  let finalDrafts: TranslationDraft[] | undefined;
  let finalLedgerEntry: DraftAttemptProviderLedgerEntry | undefined;
  let finalProviderProofId: string | undefined;
  let finalRetryFallbackState: DraftArtifactRetryFallbackState | undefined;
  let finalValidationResult: DraftArtifactProtectedSpanValidationResult | undefined;
  let finalTerminalReason: string | undefined;
  let switchedFamilyAtLeastOnce = false;
  let priorAttemptCount = 0;

  let attemptIndex = 0;
  const totalFixtureAttempts = bundle.attempts.length;

  while (attemptIndex < totalFixtureAttempts) {
    const fixtureAttempt = bundle.attempts[attemptIndex];
    if (fixtureAttempt === undefined) {
      throw new Error(
        `draft fixture command: bundle attempts[${attemptIndex}] is missing; bundle is malformed`,
      );
    }
    if (fixtureAttempt.attemptIndex !== attemptIndex) {
      throw new Error(
        `draft fixture command: bundle attempts[${attemptIndex}].attemptIndex=${fixtureAttempt.attemptIndex} mismatches loop position`,
      );
    }

    // Detect family switch for the fallback-chain bookkeeping.
    if (attemptIndex > 0) {
      const prior = bundle.attempts[attemptIndex - 1];
      if (
        prior !== undefined &&
        prior.provider.capturedProviderFamily !== fixtureAttempt.provider.capturedProviderFamily
      ) {
        switchedFamilyAtLeastOnce = true;
        fallbackChain.push({
          modelProviderFamily: prior.provider.capturedProviderFamily,
          modelId: prior.provider.capturedActualModelId,
          failureReason: priorAttemptFailureReason(bundle.attempts, attemptIndex - 1),
          attemptedAt: now().toISOString(),
        });
      }
    }

    const startedAt = now();
    const attemptRecord = await args.draftJobRepository.recordAttempt(
      args.actor,
      draftJob.draftJobId,
      { attemptIndex, startedAt },
    );
    log(
      `attempt ${attemptIndex} recorded as ${attemptRecord.draftJobAttemptId} (family=${fixtureAttempt.provider.capturedProviderFamily})`,
    );

    const recordedProviderBundle = buildRecordedProviderBundle({
      bundleIdRoot: bundle.bundleId,
      fixtureAttempt,
      project,
      promptHashSlot: deterministicAttemptPromptHash(bundle.bundleId, attemptIndex, project),
    });
    const provider = new RecordedModelProvider({
      bundle: recordedProviderBundle,
      bundleKey: () => deterministicAttemptPromptHash(bundle.bundleId, attemptIndex, project),
    });
    const agent = new TranslationAgent({ provider });

    const invocationInput: TranslationInvocationInput = {
      draftJobId: draftJob.draftJobId,
      draftJobAttemptId: attemptRecord.draftJobAttemptId,
      projectId: project.projectId,
      localeBranchId: project.localeBranchId,
      sourceLocale: project.sourceLocale,
      targetLocale: project.targetLocale,
      sourceBridgeUnits,
      protectedSpansBySource,
      glossary: project.glossary,
      styleGuide: project.styleGuide,
      contextArtifactRefs: project.contextArtifactRefs ?? [],
      modelProfile: project.modelProfile,
      promptTemplateVersion: project.promptTemplateVersion,
      now,
    };

    const invocationResult = await tryInvocationWithSimulatedFailures(
      agent,
      args.actor,
      invocationInput,
      fixtureAttempt,
    );

    if (invocationResult.kind === "failure") {
      const failure = invocationResult.failure;
      const endedAt = now();
      const classification = await routeFailedAttempt({
        failure,
        retryPolicy,
        repository: args.draftJobRepository,
        draftJobAttemptId: attemptRecord.draftJobAttemptId,
        actor: args.actor,
        endedAt,
      });
      // Record the provider's ledger entry for the failed attempt. We
      // synthesize a minimal TranslationInvocationResult so the recorder
      // can persist token / cost / proof provenance even when the agent
      // itself rejected.
      const synth = synthesizeFailureLedgerInput({
        fixtureAttempt,
        project,
        attemptIndex,
        attemptId: attemptRecord.draftJobAttemptId,
      });
      const ledgerEntry = await recorder.record(args.actor, {
        draftJobAttemptId: attemptRecord.draftJobAttemptId,
        translationResult: synth.result,
        fallbackChain: [...fallbackChain],
        costEstimate: synth.cost,
        latencyMs: 0,
        policyVersions: fixturePolicyVersions(),
        contextArtifactRefs: fixtureContextArtifactRefs(project),
        promptTemplateVersion: project.promptTemplateVersion,
      });
      allLedgerEntries.push(ledgerEntry);
      ledgerEntriesByProviderProof.set(ledgerEntry.providerProofId, ledgerEntry);
      priorAttemptCount += 1;

      if (!classification.retryable) {
        finalTerminalReason = classification.terminalReason;
        finalRetryFallbackState = "terminal-rejection";
        finalLedgerEntry = ledgerEntry;
        finalProviderProofId = ledgerEntry.providerProofId;
        finalValidationResult = { accepted: true }; // No protected-span gate ran.
        log(`attempt ${attemptIndex} non-retryable: ${classification.terminalReason}`);
        break;
      }
      if (classification.attemptIndexNext > project.attemptIndexMax) {
        finalTerminalReason = `retry policy exceeded attemptIndexMax=${project.attemptIndexMax}`;
        finalRetryFallbackState = "terminal-rejection";
        finalLedgerEntry = ledgerEntry;
        finalProviderProofId = ledgerEntry.providerProofId;
        finalValidationResult = { accepted: true };
        log(`attempt ${attemptIndex} retryable but exceeds attemptIndexMax`);
        break;
      }
      log(
        `attempt ${attemptIndex} failed (retryable=${classification.retryable}); advancing to attempt ${classification.attemptIndexNext}`,
      );
      attemptIndex = classification.attemptIndexNext;
      continue;
    }

    // Invocation succeeded — run the acceptance gate.
    const endedAt = now();
    const draftsForGate = injectGlossaryRefsForGate({
      drafts: invocationResult.result.drafts,
      project,
    });
    const gateResult = await acceptOrRejectDraft({
      drafts: draftsForGate,
      sourceBridgeUnits,
      sourceProtectedSpansBySource: sourceSpansForGate,
      validator,
      retryPolicy,
      repository: args.draftJobRepository,
      draftJobAttemptId: attemptRecord.draftJobAttemptId,
      attemptIndexCurrent: attemptIndex,
      actor: args.actor,
      endedAt,
      ...(invocationResult.result.providerRunId !== undefined
        ? { providerRunId: invocationResult.result.providerRunId }
        : {}),
      ...(invocationResult.result.recordedArtifactId !== undefined
        ? { recordedProviderArtifactId: invocationResult.result.recordedArtifactId }
        : {}),
    });

    const ledgerEntry = await recorder.record(args.actor, {
      draftJobAttemptId: attemptRecord.draftJobAttemptId,
      translationResult: invocationResult.result,
      fallbackChain: [...fallbackChain],
      costEstimate:
        fixtureAttempt.costEstimateOverride ??
        deriveCostFromTokens(invocationResult.result.tokensIn + invocationResult.result.tokensOut),
      latencyMs: 0,
      policyVersions: fixturePolicyVersions(),
      contextArtifactRefs: fixtureContextArtifactRefs(project),
      promptTemplateVersion: project.promptTemplateVersion,
    });
    allLedgerEntries.push(ledgerEntry);
    ledgerEntriesByProviderProof.set(ledgerEntry.providerProofId, ledgerEntry);
    priorAttemptCount += 1;

    if (gateResult.accepted) {
      finalDrafts = invocationResult.result.drafts;
      finalLedgerEntry = ledgerEntry;
      finalProviderProofId = ledgerEntry.providerProofId;
      finalRetryFallbackState = pickSuccessState({
        attemptIndex,
        switchedFamilyAtLeastOnce,
      });
      finalValidationResult = { accepted: true };
      log(`attempt ${attemptIndex} accepted; state=${finalRetryFallbackState}`);
      break;
    }

    // Gate rejected — classify + route.
    if (gateResult.classification.retryable === false) {
      // Terminal protected-span rejection.
      finalTerminalReason = gateResult.classification.terminalReason;
      finalRetryFallbackState = "terminal-rejection";
      finalLedgerEntry = ledgerEntry;
      finalProviderProofId = ledgerEntry.providerProofId;
      finalValidationResult = {
        accepted: false,
        violations: violationsToBundleViolations(gateResult.violations),
      };
      log(
        `attempt ${attemptIndex} acceptance-gate terminal: ${gateResult.classification.terminalReason}`,
      );
      break;
    }
    if (gateResult.classification.attemptIndexNext > project.attemptIndexMax) {
      finalTerminalReason = `retry policy exceeded attemptIndexMax=${project.attemptIndexMax} after acceptance-gate failure`;
      finalRetryFallbackState = "terminal-rejection";
      finalLedgerEntry = ledgerEntry;
      finalProviderProofId = ledgerEntry.providerProofId;
      finalValidationResult = {
        accepted: false,
        violations: violationsToBundleViolations(gateResult.violations),
      };
      log(
        `attempt ${attemptIndex} acceptance-gate retryable but exceeds attemptIndexMax=${project.attemptIndexMax}`,
      );
      break;
    }
    log(
      `attempt ${attemptIndex} acceptance-gate failed; advancing to attempt ${gateResult.classification.attemptIndexNext}`,
    );
    attemptIndex = gateResult.classification.attemptIndexNext;
  }

  if (finalRetryFallbackState === undefined || finalLedgerEntry === undefined) {
    throw new Error(
      `draft fixture command: ran out of bundle attempts (${totalFixtureAttempts}) without resolving the draft job; bundle authority error`,
    );
  }

  // Build the bundle.
  const draftEntries: DraftArtifactDraftEntry[] = [];

  if (finalRetryFallbackState === "terminal-rejection") {
    // For terminal rejections, emit one entry per source unit so the
    // bundle never silently drops a unit.
    for (const unit of project.bridgeUnits) {
      draftEntries.push({
        sourceUnitId: unit.bridgeUnitId,
        draftId: `draft-rejected-${unit.bridgeUnitId}`,
        providerProofId: requireProviderProofId(finalProviderProofId),
        protectedSpanValidationResult: requireValidationResult(finalValidationResult),
        retryFallbackState: "terminal-rejection",
        costLedgerEntryRef: finalLedgerEntry.ledgerEntryId,
        terminalReason: requireTerminalReason(finalTerminalReason),
      });
    }
  } else {
    if (finalDrafts === undefined) {
      throw new Error(
        `draft fixture command: success state ${finalRetryFallbackState} resolved without final drafts`,
      );
    }
    for (const draft of finalDrafts) {
      draftEntries.push({
        sourceUnitId: draft.bridgeUnitId,
        draftId: `draft-${finalLedgerEntry.ledgerEntryId}-${draft.bridgeUnitId}`,
        providerProofId: requireProviderProofId(finalProviderProofId),
        protectedSpanValidationResult: { accepted: true },
        retryFallbackState: finalRetryFallbackState,
        costLedgerEntryRef: finalLedgerEntry.ledgerEntryId,
        draftText: draft.draftText,
      });
    }
  }

  const ledgerSummary = summarizeLedger(allLedgerEntries);
  const artifact: DraftArtifactBundle = {
    schemaVersion: DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    draftJobId: draftJob.draftJobId,
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    drafts: draftEntries,
    ledgerSummary,
  };
  assertDraftArtifactBundle(artifact);
  args.io.writeJson(args.outputPath, artifact);
  return artifact;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBundle(
  args: DraftFixtureCommandArgs,
  project: DraftFixtureProject,
): DraftFixtureBundle {
  if (args.resolveBundle) {
    return args.resolveBundle(project.bundlePath);
  }
  const raw = args.io.readJson(project.bundlePath);
  return raw as DraftFixtureBundle;
}

function assertDraftFixtureProject(value: unknown): DraftFixtureProject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("draft fixture project must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "itotori.draft-fixture-project.v1") {
    throw new Error(
      `draft fixture project schemaVersion must be 'itotori.draft-fixture-project.v1' (got ${String(record.schemaVersion)})`,
    );
  }
  return value as DraftFixtureProject;
}

function assertDraftFixtureBundle(value: unknown): asserts value is DraftFixtureBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("draft fixture bundle must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "itotori.draft-fixture-bundle.v1") {
    throw new Error(
      `draft fixture bundle schemaVersion must be 'itotori.draft-fixture-bundle.v1' (got ${String(record.schemaVersion)})`,
    );
  }
}

/**
 * The translation agent's protected-span preservation check is
 * byte-equal: the literal `sourceText` must reappear at the declared
 * draft range. That semantic only matches `variable`, `markup`, and
 * `source_unit` spans. `glossary` spans are NEVER given to the agent
 * — the second-layer `DraftProtectedSpanValidator` at the acceptance
 * gate covers capitalization-drift / mistranslation detection using
 * the `expectedTargetForm` data. The fixture command rewrites each
 * accepted draft so the glossary refs reappear in the gate's
 * `draftProtectedSpanRefs` for the validator to score; see
 * `injectGlossaryRefsForGate` below.
 */
function projectProtectedSpansMap(
  project: DraftFixtureProject,
): ReadonlyMap<string, ReadonlyArray<TranslationProtectedSpanInput>> {
  const map = new Map<string, ReadonlyArray<TranslationProtectedSpanInput>>();
  for (const entry of project.protectedSpansBySource) {
    const agentSpans: TranslationProtectedSpanInput[] = [];
    for (const span of entry.spans) {
      if (span.spanKind === "glossary") continue;
      agentSpans.push({ refId: span.refId, sourceText: span.sourceText });
    }
    map.set(entry.bridgeUnitId, agentSpans);
  }
  return map;
}

function projectProtectedSpansForGate(
  project: DraftFixtureProject,
): ReadonlyMap<string, ReadonlyArray<DraftSourceProtectedSpan>> {
  const map = new Map<string, ReadonlyArray<DraftSourceProtectedSpan>>();
  for (const entry of project.protectedSpansBySource) {
    map.set(
      entry.bridgeUnitId,
      entry.spans.map((span) => {
        const out: DraftSourceProtectedSpan = {
          refId: span.refId,
          sourceText: span.sourceText,
          spanKind: span.spanKind,
        };
        if (span.expectedTargetForm !== undefined) {
          out.expectedTargetForm = span.expectedTargetForm;
        }
        return out;
      }),
    );
  }
  return map;
}

/**
 * After the agent accepts a draft, the fixture command injects the
 * glossary spans back into the draft's `protectedSpanRefs` so the
 * second-layer validator has something to score. Position is the
 * first case-insensitive occurrence of the expected target form in
 * the draft text (a glossary-mistranslation case where the model
 * substituted a wholly different term will have NO occurrence and we
 * leave the ref out — the validator then reports `span_deleted`,
 * which still routes through the non-retryable
 * `glossary_mistranslation` classifier in the orchestrator's policy
 * via the cap-drift detection path).
 */
function injectGlossaryRefsForGate(args: {
  drafts: ReadonlyArray<TranslationDraft>;
  project: DraftFixtureProject;
}): TranslationDraft[] {
  const glossaryByUnit = new Map<string, DraftFixtureProtectedSpan[]>();
  for (const entry of args.project.protectedSpansBySource) {
    const glossary = entry.spans.filter((s) => s.spanKind === "glossary");
    if (glossary.length > 0) {
      glossaryByUnit.set(entry.bridgeUnitId, glossary);
    }
  }
  return args.drafts.map((draft) => {
    const glossary = glossaryByUnit.get(draft.bridgeUnitId);
    if (glossary === undefined || glossary.length === 0) {
      return draft;
    }
    const additions: typeof draft.protectedSpanRefs = [];
    for (const span of glossary) {
      const expected = span.expectedTargetForm ?? span.sourceText;
      const lower = draft.draftText.toLowerCase();
      const start = lower.indexOf(expected.toLowerCase());
      if (start < 0) {
        // Skip — validator will report span_deleted on the gate side.
        continue;
      }
      additions.push({
        refId: span.refId,
        startInDraft: start,
        endInDraft: start + expected.length,
      });
    }
    if (additions.length === 0) {
      return draft;
    }
    const merged = [...draft.protectedSpanRefs, ...additions].sort(
      (a, b) => a.startInDraft - b.startInDraft,
    );
    return { ...draft, protectedSpanRefs: merged };
  });
}

function projectBridgeUnitToTranslation(unit: DraftFixtureBridgeUnit): TranslationBridgeUnit {
  const out: TranslationBridgeUnit = {
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sourceText: unit.sourceText,
    sourceHash: unit.sourceHash,
  };
  if (unit.speaker !== undefined) {
    out.speaker = unit.speaker;
  }
  return out;
}

function buildRecordedProviderBundle(args: {
  bundleIdRoot: string;
  fixtureAttempt: DraftFixtureAttempt;
  project: DraftFixtureProject;
  promptHashSlot: string;
}): RecordedProviderBundle {
  const responses: Record<string, RecordedProviderResponse> = {};
  if (args.fixtureAttempt.outcome.kind === "provider_invocation_success") {
    responses[args.promptHashSlot] = args.fixtureAttempt.outcome.response;
  } else {
    // For non-success outcomes the response key is never hit because we
    // synthesize the failure path before calling the recorded provider.
    // We still register a stub keyed off the slot so the bundle is
    // structurally complete.
    responses[args.promptHashSlot] = { content: null, finishReason: "stop" };
  }
  return {
    bundleId: `${args.bundleIdRoot}::attempt-${args.fixtureAttempt.attemptIndex}`,
    capturedProviderFamily: args.fixtureAttempt.provider.capturedProviderFamily,
    capturedProviderName: args.fixtureAttempt.provider.capturedProviderName,
    capturedRequestedModelId: args.fixtureAttempt.provider.capturedRequestedModelId,
    // ITOTORI-220 — default the captured providerId to the project's
    // pinned providerId so the bundle stays self-consistent. Authors of
    // new fixtures supply it explicitly.
    capturedProviderId:
      args.fixtureAttempt.provider.capturedProviderId ?? args.project.modelProfile.providerId,
    capturedActualModelId: args.fixtureAttempt.provider.capturedActualModelId,
    responses,
  };
}

function deterministicAttemptPromptHash(
  bundleId: string,
  attemptIndex: number,
  project: DraftFixtureProject,
): string {
  const hash = createHash("sha256");
  hash.update(`${bundleId}|${attemptIndex}|${project.projectId}|${project.localeBranchId}`);
  return `sha256:${hash.digest("hex")}`;
}

function deterministicNow(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

function priorAttemptFailureReason(
  attempts: ReadonlyArray<DraftFixtureAttempt>,
  index: number,
): string {
  const attempt = attempts[index];
  if (attempt === undefined) {
    return "unknown";
  }
  switch (attempt.outcome.kind) {
    case "provider_invocation_success":
      return "provider succeeded but acceptance gate rejected";
    case "provider_invocation_capability_failure":
      return `provider_capability: ${attempt.outcome.detail}`;
    case "provider_invocation_partial":
      return `provider_partial: ${attempt.outcome.detail}`;
    case "schema_validation_failure":
      return `schema_validation: ${attempt.outcome.path}: ${attempt.outcome.detail}`;
    default:
      return "unspecified failure";
  }
}

type InvocationOutcome =
  | { kind: "success"; result: TranslationInvocationResult }
  | { kind: "failure"; failure: DraftFailure };

async function tryInvocationWithSimulatedFailures(
  agent: TranslationAgent,
  actor: AuthorizationActor,
  input: TranslationInvocationInput,
  fixtureAttempt: DraftFixtureAttempt,
): Promise<InvocationOutcome> {
  if (fixtureAttempt.outcome.kind === "provider_invocation_capability_failure") {
    return {
      kind: "failure",
      failure: {
        kind: "provider_capability",
        error: new TranslationProviderCapabilityError(
          fixtureAttempt.outcome.providerName,
          fixtureAttempt.outcome.providerFamily,
          fixtureAttempt.outcome.detail,
        ),
        attemptIndexCurrent: fixtureAttempt.attemptIndex,
      },
    };
  }
  if (fixtureAttempt.outcome.kind === "provider_invocation_partial") {
    return {
      kind: "failure",
      failure: {
        kind: "provider_partial",
        error: new TranslationPartialResultError(
          "fixture-provider-run",
          input.draftJobAttemptId,
          fixtureAttempt.outcome.finishReason,
          fixtureAttempt.outcome.detail,
        ),
        attemptIndexCurrent: fixtureAttempt.attemptIndex,
      },
    };
  }
  if (fixtureAttempt.outcome.kind === "schema_validation_failure") {
    return {
      kind: "failure",
      failure: {
        kind: "schema_validation",
        error: new TranslationDraftResponseValidationError(
          fixtureAttempt.outcome.path,
          fixtureAttempt.outcome.rule,
          fixtureAttempt.outcome.detail,
        ),
        attemptIndexCurrent: fixtureAttempt.attemptIndex,
      },
    };
  }
  const result = await agent.invokeTranslation(actor, input);
  return { kind: "success", result };
}

function synthesizeFailureLedgerInput(args: {
  fixtureAttempt: DraftFixtureAttempt;
  project: DraftFixtureProject;
  attemptIndex: number;
  attemptId: string;
}): { result: TranslationInvocationResult; cost: { unit: string; amount: string } } {
  const providerRunId = `fixture-failed-${args.attemptId}`;
  const promptHash = createHash("sha256")
    .update(
      `${args.fixtureAttempt.provider.capturedProviderName}|attempt|${args.attemptIndex}|${args.project.projectId}`,
    )
    .digest("hex");
  const result: TranslationInvocationResult = {
    drafts: [],
    providerRunId,
    promptHashUsed: promptHash,
    modelMetadata: {
      modelProfile: args.project.modelProfile,
      providerIdentity: {
        providerFamily: args.fixtureAttempt.provider.capturedProviderFamily,
        endpointFamily: "recorded-fixture",
        providerName: args.fixtureAttempt.provider.capturedProviderName,
        requestedModelId: args.fixtureAttempt.provider.capturedRequestedModelId,
        requestedProviderId:
          args.fixtureAttempt.provider.capturedProviderId ?? args.project.modelProfile.providerId,
        actualModelId: args.fixtureAttempt.provider.capturedActualModelId,
      },
      providerRun: {
        runId: providerRunId,
        taskKind: "draft_translation",
        startedAt: "2026-06-24T12:00:00.000Z",
        completedAt: "2026-06-24T12:00:00.000Z",
        latencyMs: 0,
        status: "failed",
        provider: {
          providerFamily: args.fixtureAttempt.provider.capturedProviderFamily,
          endpointFamily: "recorded-fixture",
          providerName: args.fixtureAttempt.provider.capturedProviderName,
          requestedModelId: args.fixtureAttempt.provider.capturedRequestedModelId,
          requestedProviderId:
            args.fixtureAttempt.provider.capturedProviderId ?? args.project.modelProfile.providerId,
          actualModelId: args.fixtureAttempt.provider.capturedActualModelId,
        },
        structuredOutputMode: "json_schema",
        retryCount: 0,
        errorClasses: [],
        fallbackUsed: false,
        fallbackPlan: [args.fixtureAttempt.provider.capturedActualModelId],
        tokenUsage: {
          tokenCountSource: "deterministic_counter",
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
        cost: { costKind: "zero", currency: "USD", amountMicrosUsd: 0 },
        prompt: {
          presetId: "itotori-translation-agent",
          templateVersion: args.project.promptTemplateVersion,
          promptHash: `sha256:${promptHash}`,
        },
        dataHandling: deterministicFixtureDataHandlingPolicy,
      },
    },
    tokensIn: 0,
    tokensOut: 0,
  };
  if (args.fixtureAttempt.provider.capturedProviderFamily === "recorded") {
    result.recordedArtifactId = `${args.project.draftJobId}::failed-attempt-${args.attemptIndex}`;
  }
  return {
    result,
    cost: args.fixtureAttempt.costEstimateOverride ?? { unit: "usd", amount: "0.00000000" },
  };
}

function fixturePolicyVersions(): DraftAttemptProviderLedgerPolicyVersions {
  return {
    styleGuide: "fixture-style-guide-v1",
    glossary: "fixture-glossary-v1",
  };
}

function fixtureContextArtifactRefs(
  project: DraftFixtureProject,
): DraftAttemptProviderLedgerContextRef[] {
  return (project.contextArtifactRefs ?? []).map((id, index) => ({
    contextArtifactId: id,
    category: "context-artifact",
    contentHash: createHash("sha256").update(`${project.projectId}|${id}|${index}`).digest("hex"),
  }));
}

function deriveCostFromTokens(totalTokens: number): { unit: string; amount: string } {
  // Deterministic micro-cost mapping for fixture mode: 1 micro-USD per
  // token. Keeps the totals stable for snapshot tests.
  const micros = totalTokens;
  const amount = (micros / 1_000_000).toFixed(8);
  return { unit: "usd", amount };
}

function pickSuccessState(args: {
  attemptIndex: number;
  switchedFamilyAtLeastOnce: boolean;
}): DraftArtifactRetryFallbackState {
  if (args.switchedFamilyAtLeastOnce) {
    return "fallback-then-success";
  }
  if (args.attemptIndex > 0) {
    return "retried-then-success";
  }
  return "success";
}

function violationsToBundleViolations(
  violations: ReadonlyArray<DraftProtectedSpanViolation>,
): DraftArtifactProtectedSpanViolation[] {
  return violations.map((violation) => ({
    kind: violation.kind,
    spanRefId: violation.spanRefId,
    spanKind: violation.spanKind,
    bridgeUnitId: violation.bridgeUnitId,
    detail: violation.detail,
  }));
}

function summarizeLedger(
  entries: ReadonlyArray<DraftAttemptProviderLedgerEntry>,
): DraftArtifactLedgerSummary {
  let totalMicros = 0n;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const providerProofIds: string[] = [];
  for (const entry of entries) {
    // The cost amount is a decimal USD string; convert to micros via
    // integer arithmetic to keep the running total deterministic across
    // JS double-precision floats. Negative amounts already rejected by
    // the ledger repo's validator.
    totalMicros += amountToMicros(entry.costAmount);
    totalTokensIn += entry.tokensIn ?? 0;
    totalTokensOut += entry.tokensOut ?? 0;
    providerProofIds.push(entry.providerProofId);
  }
  return {
    totalCost: microsToAmount(totalMicros),
    totalTokensIn,
    totalTokensOut,
    attemptCount: entries.length,
    providerProofIds,
  };
}

function amountToMicros(amount: string): bigint {
  // amount looks like "0.00000000" or "0.01250000" (fixed 8 dp).
  // Normalize to 6 dp (micros).
  const [whole, fractional] = amount.split(".");
  const wholeBig = BigInt(whole ?? "0");
  const fractionalDigits = (fractional ?? "").slice(0, 6).padEnd(6, "0");
  return wholeBig * 1_000_000n + BigInt(fractionalDigits);
}

function microsToAmount(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const fractional = (micros % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${fractional}00`;
}

function requireProviderProofId(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new DraftFixtureCommandUnknownProvenanceError("(missing)");
  }
  return value;
}

function requireValidationResult(
  value: DraftArtifactProtectedSpanValidationResult | undefined,
): DraftArtifactProtectedSpanValidationResult {
  if (value === undefined) {
    throw new Error(
      "draft fixture command: validation result missing on terminal outcome (programmer error)",
    );
  }
  return value;
}

function requireTerminalReason(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      "draft fixture command: terminal rejection missing a terminalReason (programmer error)",
    );
  }
  return value;
}
