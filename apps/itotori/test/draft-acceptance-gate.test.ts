// ITOTORI-076 — Draft acceptance gate end-to-end tests.
//
// Uses a `FakeDraftJobRepository` (records its method calls, no DB) to
// assert the gate routes the right write call:
//
//   - Happy path: validates → calls markAttemptSucceeded ONCE; does NOT
//     call markAttemptFailed.
//   - Failure path (retryable): validates → calls markAttemptFailed with
//     retryable=true; does NOT call markAttemptSucceeded.
//   - Failure path (non-retryable): validates → calls markAttemptFailed
//     with retryable=false.
//   - routeFailedAttempt: classifies and writes for non-protected-span
//     failures (schema_validation, provider_capability, etc.).

import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  DraftJobAttemptRecord,
  DraftJobInput,
  DraftJobRecord,
  ItotoriDraftJobRepositoryPort,
  LoadDraftJobsByProjectOptions,
  RecordDraftJobAttemptInput,
} from "@itotori/db";
import {
  TranslationDraftResponseValidationError,
  type TranslationDraft,
} from "@itotori/localization-bridge-schema";
import { TranslationPartialResultError } from "../src/agents/translation/index.js";
import {
  acceptOrRejectDraft,
  DraftProtectedSpanValidator,
  DRAFT_FIXTURE_BRIDGE_UNIT_ID,
  draftFixtureBridgeUnit,
  draftFixtureSourceSpans,
  nonRetryableFixture,
  RetryPolicy,
  routeFailedAttempt,
  spanDeletedDraftFixture,
  validDraftFixture,
  type DraftFailure,
  type DraftSourceProtectedSpan,
} from "../src/draft/index.js";

const FIXED_ACTOR: AuthorizationActor = { userId: "local-user" };
const FIXED_ENDED_AT = new Date("2026-06-24T12:00:00Z");
const FIXED_ATTEMPT_ID = "draft-job-attempt-fixture";

type MarkSucceededCall = {
  draftJobAttemptId: string;
  endedAt: Date;
  providerRunId: string | undefined;
  recordedProviderArtifactId: string | undefined;
};

type MarkFailedCall = {
  draftJobAttemptId: string;
  failureReason: string;
  retryable: boolean;
  endedAt: Date;
};

/**
 * In-memory port impl that records method calls. Throws if the gate
 * calls a method the test didn't expect — keeps the assertions sharp.
 */
class FakeDraftJobRepository implements ItotoriDraftJobRepositoryPort {
  succeededCalls: MarkSucceededCall[] = [];
  failedCalls: MarkFailedCall[] = [];

  async createDraftJob(_actor: AuthorizationActor, _input: DraftJobInput): Promise<DraftJobRecord> {
    throw new Error("FakeDraftJobRepository.createDraftJob unexpectedly invoked");
  }
  async recordAttempt(
    _actor: AuthorizationActor,
    _draftJobId: string,
    _attemptInput: RecordDraftJobAttemptInput,
  ): Promise<DraftJobAttemptRecord> {
    throw new Error("FakeDraftJobRepository.recordAttempt unexpectedly invoked");
  }
  async markAttemptSucceeded(
    _actor: AuthorizationActor,
    draftJobAttemptId: string,
    endedAt: Date,
    providerRunId?: string,
    recordedProviderArtifactId?: string,
  ): Promise<void> {
    this.succeededCalls.push({
      draftJobAttemptId,
      endedAt,
      providerRunId,
      recordedProviderArtifactId,
    });
  }
  async markAttemptFailed(
    _actor: AuthorizationActor,
    draftJobAttemptId: string,
    failureReason: string,
    retryable: boolean,
    endedAt: Date,
  ): Promise<void> {
    this.failedCalls.push({
      draftJobAttemptId,
      failureReason,
      retryable,
      endedAt,
    });
  }
  async cancelDraftJob(_actor: AuthorizationActor, _draftJobId: string): Promise<void> {
    throw new Error("FakeDraftJobRepository.cancelDraftJob unexpectedly invoked");
  }
  async loadDraftJob(
    _actor: AuthorizationActor,
    _draftJobId: string,
  ): Promise<DraftJobRecord | null> {
    throw new Error("FakeDraftJobRepository.loadDraftJob unexpectedly invoked");
  }
  async loadDraftJobsByProject(
    _actor: AuthorizationActor,
    _projectId: string,
    _opts?: LoadDraftJobsByProjectOptions,
  ): Promise<DraftJobRecord[]> {
    throw new Error("FakeDraftJobRepository.loadDraftJobsByProject unexpectedly invoked");
  }
  async loadDraftJobAttempts(
    _actor: AuthorizationActor,
    _draftJobId: string,
  ): Promise<DraftJobAttemptRecord[]> {
    throw new Error("FakeDraftJobRepository.loadDraftJobAttempts unexpectedly invoked");
  }
}

function buildDraftFromValidFixture(): TranslationDraft {
  const valid = validDraftFixture();
  return {
    bridgeUnitId: valid.sourceBridgeUnit.bridgeUnitId,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    draftText: valid.draftText,
    protectedSpanRefs: [...valid.draftProtectedSpanRefs],
    citationRefs: [],
    agentRationale: "fixture rationale",
    confidenceFloor: "high",
  };
}

function buildDraftFromSpanDeletedFixture(): TranslationDraft {
  const fixture = spanDeletedDraftFixture();
  return {
    bridgeUnitId: fixture.sourceBridgeUnit.bridgeUnitId,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    draftText: fixture.draftText,
    protectedSpanRefs: [...fixture.draftProtectedSpanRefs],
    citationRefs: [],
    agentRationale: "fixture rationale",
    confidenceFloor: "medium",
  };
}

function buildDraftFromNonRetryableFixture(): TranslationDraft {
  const fixture = nonRetryableFixture();
  return {
    bridgeUnitId: fixture.sourceBridgeUnit.bridgeUnitId,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    draftText: fixture.draftText,
    protectedSpanRefs: [...fixture.draftProtectedSpanRefs],
    citationRefs: [],
    agentRationale: "fixture rationale",
    confidenceFloor: "low",
  };
}

describe("acceptOrRejectDraft happy path", () => {
  it("calls markAttemptSucceeded exactly once and returns accepted=true", async () => {
    const repo = new FakeDraftJobRepository();
    const draft = buildDraftFromValidFixture();
    const spans = new Map<string, ReadonlyArray<DraftSourceProtectedSpan>>([
      [DRAFT_FIXTURE_BRIDGE_UNIT_ID, draftFixtureSourceSpans()],
    ]);
    const result = await acceptOrRejectDraft({
      drafts: [draft],
      sourceBridgeUnits: [draftFixtureBridgeUnit()],
      sourceProtectedSpansBySource: spans,
      validator: new DraftProtectedSpanValidator(),
      retryPolicy: new RetryPolicy(),
      repository: repo,
      draftJobAttemptId: FIXED_ATTEMPT_ID,
      attemptIndexCurrent: 0,
      actor: FIXED_ACTOR,
      endedAt: FIXED_ENDED_AT,
      providerRunId: "provider-run-happy",
      recordedProviderArtifactId: "recorded-artifact-happy",
    });
    expect(result.accepted).toBe(true);
    expect(repo.succeededCalls).toHaveLength(1);
    expect(repo.succeededCalls[0]).toEqual({
      draftJobAttemptId: FIXED_ATTEMPT_ID,
      endedAt: FIXED_ENDED_AT,
      providerRunId: "provider-run-happy",
      recordedProviderArtifactId: "recorded-artifact-happy",
    });
    expect(repo.failedCalls).toHaveLength(0);
  });
});

describe("acceptOrRejectDraft failure path (retryable)", () => {
  it("calls markAttemptFailed with retryable=true for span_deleted", async () => {
    const repo = new FakeDraftJobRepository();
    const draft = buildDraftFromSpanDeletedFixture();
    const spans = new Map<string, ReadonlyArray<DraftSourceProtectedSpan>>([
      [DRAFT_FIXTURE_BRIDGE_UNIT_ID, draftFixtureSourceSpans()],
    ]);
    const result = await acceptOrRejectDraft({
      drafts: [draft],
      sourceBridgeUnits: [draftFixtureBridgeUnit()],
      sourceProtectedSpansBySource: spans,
      validator: new DraftProtectedSpanValidator(),
      retryPolicy: new RetryPolicy(),
      repository: repo,
      draftJobAttemptId: FIXED_ATTEMPT_ID,
      attemptIndexCurrent: 0,
      actor: FIXED_ACTOR,
      endedAt: FIXED_ENDED_AT,
    });
    expect(result.accepted).toBe(false);
    expect(repo.succeededCalls).toHaveLength(0);
    expect(repo.failedCalls).toHaveLength(1);
    const call = repo.failedCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.retryable).toBe(true);
    expect(call.failureReason).toContain("span_deleted");
    expect(call.failureReason).toContain("span-markup-br");
    if (result.accepted === false) {
      expect(result.classification.retryable).toBe(true);
      expect(result.violations.some((v) => v.kind === "span_deleted")).toBe(true);
    }
  });
});

describe("acceptOrRejectDraft failure path (non-retryable)", () => {
  it("calls markAttemptFailed with retryable=false for capitalization_drift", async () => {
    const repo = new FakeDraftJobRepository();
    const draft = buildDraftFromNonRetryableFixture();
    const spans = new Map<string, ReadonlyArray<DraftSourceProtectedSpan>>([
      [
        DRAFT_FIXTURE_BRIDGE_UNIT_ID,
        [
          {
            refId: "span-glossary-hero",
            sourceText: "勇者",
            spanKind: "glossary",
            expectedTargetForm: "Hero",
          },
        ],
      ],
    ]);
    const result = await acceptOrRejectDraft({
      drafts: [draft],
      sourceBridgeUnits: [draftFixtureBridgeUnit()],
      sourceProtectedSpansBySource: spans,
      validator: new DraftProtectedSpanValidator(),
      retryPolicy: new RetryPolicy(),
      repository: repo,
      draftJobAttemptId: FIXED_ATTEMPT_ID,
      attemptIndexCurrent: 1,
      actor: FIXED_ACTOR,
      endedAt: FIXED_ENDED_AT,
    });
    expect(result.accepted).toBe(false);
    expect(repo.succeededCalls).toHaveLength(0);
    expect(repo.failedCalls).toHaveLength(1);
    const call = repo.failedCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.retryable).toBe(false);
    expect(call.failureReason).toContain("capitalization_drift");
    if (result.accepted === false) {
      expect(result.classification.retryable).toBe(false);
    }
  });
});

describe("acceptOrRejectDraft surfaces unknown bridge units as a violation", () => {
  it("treats an unknown bridgeUnitId as a synthetic span_deleted violation", async () => {
    const repo = new FakeDraftJobRepository();
    const draft: TranslationDraft = {
      bridgeUnitId: "019ed079-0000-7000-8000-deadbeefdead",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      draftText: "stray draft",
      protectedSpanRefs: [],
      citationRefs: [],
      agentRationale: "stray",
      confidenceFloor: "low",
    };
    const result = await acceptOrRejectDraft({
      drafts: [draft],
      sourceBridgeUnits: [draftFixtureBridgeUnit()],
      sourceProtectedSpansBySource: new Map(),
      validator: new DraftProtectedSpanValidator(),
      retryPolicy: new RetryPolicy(),
      repository: repo,
      draftJobAttemptId: FIXED_ATTEMPT_ID,
      attemptIndexCurrent: 0,
      actor: FIXED_ACTOR,
      endedAt: FIXED_ENDED_AT,
    });
    expect(result.accepted).toBe(false);
    expect(repo.failedCalls).toHaveLength(1);
    if (result.accepted === false) {
      expect(result.violations[0]?.bridgeUnitId).toBe("019ed079-0000-7000-8000-deadbeefdead");
    }
  });
});

describe("routeFailedAttempt", () => {
  it("classifies a non-retryable schema_validation failure and writes markAttemptFailed", async () => {
    const repo = new FakeDraftJobRepository();
    const failure: DraftFailure = {
      kind: "schema_validation",
      error: new TranslationDraftResponseValidationError(
        "drafts[0].confidenceFloor",
        "required",
        "missing required field confidenceFloor",
      ),
      attemptIndexCurrent: 0,
    };
    const classification = await routeFailedAttempt({
      failure,
      retryPolicy: new RetryPolicy(),
      repository: repo,
      draftJobAttemptId: FIXED_ATTEMPT_ID,
      actor: FIXED_ACTOR,
      endedAt: FIXED_ENDED_AT,
    });
    expect(classification.retryable).toBe(false);
    expect(repo.failedCalls).toHaveLength(1);
    expect(repo.failedCalls[0]?.retryable).toBe(false);
    expect(repo.failedCalls[0]?.failureReason).toContain("schema_validation");
  });

  it("classifies a retryable provider_partial failure and writes markAttemptFailed", async () => {
    const repo = new FakeDraftJobRepository();
    const failure: DraftFailure = {
      kind: "provider_partial",
      error: new TranslationPartialResultError(
        "provider-run-1",
        FIXED_ATTEMPT_ID,
        "length",
        "truncated",
      ),
      attemptIndexCurrent: 0,
    };
    const classification = await routeFailedAttempt({
      failure,
      retryPolicy: new RetryPolicy(),
      repository: repo,
      draftJobAttemptId: FIXED_ATTEMPT_ID,
      actor: FIXED_ACTOR,
      endedAt: FIXED_ENDED_AT,
    });
    expect(classification.retryable).toBe(true);
    expect(repo.failedCalls).toHaveLength(1);
    expect(repo.failedCalls[0]?.retryable).toBe(true);
    expect(repo.failedCalls[0]?.failureReason).toContain("provider_partial");
  });
});
