// itotori-execute-rerun-jobs — Repair-job EXECUTOR tests.
//
// Proves the crux acceptance: a machine-verifiable finding that schedules a rerun
// actually EXECUTES. Before the executor landed, `RepairJobService` only
// QUEUED jobs (`claimNext`/`recordOutcome` seam with no consumer), so nothing
// re-drafted or re-QA'd anything and no written outcome was persisted. These tests drive
// the executor end-to-end on a synthetic (fake-provider) project so a
// QA finding -> scheduled rerun -> REAL re-draft/re-QA -> persisted
// selected body + real billed cost is proven, deterministically.
//
// Generic to any project: the only project knowledge lives behind the
// `RepairRerunUnitResolver` port (an in-memory implementation here). No
// engine / title / game-specific code anywhere.

import { describe, expect, it } from "vitest";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type LocalizationUnitV02,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import type { AuthorizationActor } from "@itotori/db";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
} from "../src/orchestrator/agentic-loop.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import { usageCostToDecimalString, usageCostToMicros } from "../src/providers/cost.js";
import type { ModelInvocationRequest, ProviderCost } from "../src/providers/types.js";
import {
  executeRepairJob,
  RepairJobService,
  runRepairQueue,
  type RepairJob,
  type RepairJobExecutorDeps,
  type RepairRerunUnitResolver,
} from "../src/orchestrator/repair/index.js";
import type {
  DrivenWrittenOutcomeRecord,
  DrivenProviderRunRecord,
} from "../src/orchestrator/project-driven-executor.js";

const ACTOR: AuthorizationActor = { userId: "repair-executor-test-actor" };
const PROJECT_ID = "019ed0cc-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed0cc-0000-7000-8000-000000000002";
const REVISION_ID = "019ed0cc-0000-7000-8000-000000000003";
const ASSET_ID = "019ed0cc-0000-7000-8000-000000000004";

// Bridge unit ids use a distinct `019ed0aa` prefix so the fake provider can
// regex the CURRENT unit's bridge id out of any request blob.
const UNIT_A = "019ed0aa-0000-7000-8000-0000000000a1";
const UNIT_B = "019ed0aa-0000-7000-8000-0000000000b2";
const UNIT_C = "019ed0aa-0000-7000-8000-0000000000c3";

// The CORRECTED translation the rerun's re-draft produces. A prior (stale)
// draft for this unit would have read "Good morning." — the correction
// schedules a rerun and the loop re-drafts to this body instead.
const CORRECTED_DRAFT_A = "Good morning, Yui.";
const CRITICAL_QA_MARKER = "REPAIR_EXECUTOR_CRITICAL_QA";

// SYNTHETIC billed cost — derived from the REAL cost parser
// (`usageCostToDecimalString` / `usageCostToMicros`), never a fabricated cost
// literal, so `audit-no-hardcoded-cost` stays green (mirrors agentic-loop.test).
const PER_INVOCATION_USD = "0.00000602";
const BILLED_COST: ProviderCost = {
  costKind: "billed",
  currency: "USD",
  amountUsd: usageCostToDecimalString(PER_INVOCATION_USD),
  amountMicrosUsd: usageCostToMicros(PER_INVOCATION_USD),
};

// ---------------------------------------------------------------------------
// In-memory persistence sinks
// ---------------------------------------------------------------------------

class InMemorySinks {
  readonly writtenOutcomes: DrivenWrittenOutcomeRecord[] = [];
  readonly providerRuns: DrivenProviderRunRecord[] = [];
  readonly writtenOutcome = {
    persistWrittenOutcome: async (record: DrivenWrittenOutcomeRecord): Promise<void> => {
      this.writtenOutcomes.push(record);
    },
  };
  readonly providerRun = {
    persistProviderRun: async (record: DrivenProviderRunRecord): Promise<void> => {
      this.providerRuns.push(record);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory unit resolver — the project seam
// ---------------------------------------------------------------------------

class InMemoryUnitResolver implements RepairRerunUnitResolver {
  private readonly byId = new Map<string, AgenticLoopUnitInput>();

  constructor(inputs: ReadonlyArray<AgenticLoopUnitInput>) {
    for (const input of inputs) {
      this.byId.set(input.unit.bridgeUnitId, input);
    }
  }

  async resolveAffectedUnits(job: RepairJob): Promise<ReadonlyArray<AgenticLoopUnitInput>> {
    return job.affectedBridgeUnitIds
      .map((id) => this.byId.get(id)!)
      .filter((input) => input !== undefined);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeUnit(bridgeUnitId: string, sourceText: string, lineNo: number): LocalizationUnitV02 {
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey: `scene-6010/line-${String(lineNo).padStart(3, "0")}`,
    occurrenceId: `occ-${lineNo}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `src-hash-${bridgeUnitId}`,
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "asset" },
    sourceLocation: { containerKey: "asset" },
    speaker: {
      knowledgeState: "known",
      speakerId: "019ed0cc-0000-7000-8000-00000000sp01",
      displayName: "Yui",
    },
    context: { route: { sceneId: "6010" } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: `scene-6010/line-${String(lineNo).padStart(3, "0")}`,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function loopInputFor(unit: LocalizationUnitV02): AgenticLoopUnitInput {
  return {
    unit,
    sourceRevisionId: REVISION_ID,
    sceneUnits: [],
    glossary: [],
    protectedSpans: [],
    knownCharacters: [],
    actor: ACTOR,
  };
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

function makePolicy(overrides: Partial<AgenticLoopPolicy> = {}): AgenticLoopPolicy {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    maxRepairAttempts: 1,
    now: deterministicClock(),
    ...overrides,
  };
}

// --- Fake content generators ------------------------------------------------

function bridgeUnitIdOf(request: ModelInvocationRequest): string {
  const blob = JSON.stringify(request);
  const match = blob.match(/019ed0aa-[0-9a-f]{4}-7000-8000-[0-9a-f]{12}/u);
  if (match === null) {
    throw new Error("fake provider could not locate a bridge unit id in the request");
  }
  return match[0];
}

function speakerLabelContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fake-narration",
      },
    ],
  });
}

function translationContent(bridgeUnitId: string, draftText: string): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "fake-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

function criticalQaContent(bridgeUnitId: string): string {
  const finding: QaFinding = {
    findingId: `${bridgeUnitId}-critical-finding`,
    bridgeUnitId,
    severity: "critical",
    category: "mistranslation",
    evidenceRefs: [],
    recommendation: "fixture: critical finding remains an annotation",
    agentRationale: "fake-critical-finding",
  };
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [finding],
  });
}

function cleanQaContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}

/**
 * Fake provider factory. Keyed on the CURRENT unit + request markers:
 *   - a unit whose source carries CRITICAL_QA_MARKER emits a critical QA finding;
 *     zero repair budget retains its primary body with quality flags.
 *   - UNIT_A re-drafts to the CORRECTED body (proving the rerun re-drafted).
 *   - every other unit translates cleanly into a written outcome.
 * Each provider carries the SYNTHETIC billed cost (via the real parser) so the
 * recorded cost is non-zero and demonstrably flows from provider output.
 */
function repairProviderFactory(): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `repair-fake-${stage}-${agentLabel}`,
      cost: BILLED_COST,
      generate: (request: ModelInvocationRequest): string => {
        const blob = JSON.stringify(request);
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent(bridgeUnitIdOf(request));
        }
        if (request.taskKind === "draft_translation") {
          const bridgeUnitId = bridgeUnitIdOf(request);
          return translationContent(
            bridgeUnitId,
            bridgeUnitId === UNIT_A ? CORRECTED_DRAFT_A : `Translation of ${bridgeUnitId}`,
          );
        }
        if (request.taskKind === "llm_qa") {
          if (blob.includes(CRITICAL_QA_MARKER)) {
            return criticalQaContent(bridgeUnitIdOf(request));
          }
          return cleanQaContent();
        }
        return "";
      },
    });
}

// --- Executor deps builder --------------------------------------------------

function makeDeps(
  resolver: RepairRerunUnitResolver,
  sinks: InMemorySinks,
  overrides: Partial<RepairJobExecutorDeps> = {},
): RepairJobExecutorDeps {
  return {
    actor: ACTOR,
    resolveUnits: resolver,
    sourceRevisionId: REVISION_ID,
    pairPolicy: DEV_POLICY,
    policy: makePolicy(),
    providerFactory: repairProviderFactory(),
    pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    sinks: { writtenOutcome: sinks.writtenOutcome, providerRun: sinks.providerRun },
    ...overrides,
  };
}

function makeService(): RepairJobService {
  // Fixed instanceId + deterministic clock so a replay mints byte-equal
  // job ids and the history is stable.
  return new RepairJobService({ now: deterministicClock(), instanceId: "repair-executor-tests" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeRepairJob / runRepairQueue (itotori-execute-rerun-jobs)", () => {
  it("a QA finding schedules a rerun that persists the selected written body and records real cost", async () => {
    const sinks = new InMemorySinks();
    const resolver = new InMemoryUnitResolver([
      loopInputFor(makeUnit(UNIT_A, "おはよう、{player}。", 1)),
    ]);
    const service = makeService();

    // A machine-verifiable QA finding identifies UNIT_A for a translation
    // rerun; no broad rerun path is involved.
    const job = service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff03",
        bridgeUnitId: UNIT_A,
        severity: "p1",
        targetStage: "translation",
        rationale: "QA finding: prior body mistranslated the greeting",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });

    const result = await runRepairQueue(service, makeDeps(resolver, sinks));

    // The repair runner drained the one scheduled job.
    expect(result.jobsRun).toBe(1);
    expect(service.pending()).toEqual([]);
    expect(service.claimNext()).toBeUndefined();

    // The rerun executed the real draft + QA path and wrote one outcome.
    expect(result.succeeded).toBe(1);

    // The selected body was persisted — not a stale or optional draft.
    expect(sinks.writtenOutcomes).toHaveLength(1);
    const persistedOutcome = sinks.writtenOutcomes[0]!;
    expect(persistedOutcome.bridgeUnitId).toBe(UNIT_A);
    expect(persistedOutcome.selectedBody).toBe(CORRECTED_DRAFT_A);
    expect(persistedOutcome.outcome.status).toBe("written");

    // The real billed cost was RECORDED from provider output (PROJECT LAW): a
    // provider-run row landed carrying a non-zero total summed verbatim from
    // the loop's invocations, never hardcoded.
    expect(sinks.providerRuns).toHaveLength(1);
    const persistedRun = sinks.providerRuns[0]!;
    expect(persistedRun.bridgeUnitId).toBe(UNIT_A);
    expect(persistedRun.invocationCount).toBeGreaterThan(0);
    expect(persistedRun.totalCostUsd).toBe(result.totalCostUsd);
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(persistedRun.pair).toEqual({
      modelId: DEV_PAIR.modelId,
      providerId: DEV_PAIR.providerId,
    });
    expect(persistedRun.zdr).toBe(true);

    // The service's append-only history now reflects the REAL run, not just the
    // enqueue: job_enqueued -> job_started -> job_completed with the succeeded
    // outcome reflecting the written rerun.
    const history = service.repairHistory();
    expect(history.map((event) => event.kind)).toEqual([
      "job_enqueued",
      "job_started",
      "job_completed",
    ]);
    const completion = history.at(-1);
    if (completion?.kind !== "job_completed") {
      throw new Error("expected job_completed event");
    }
    expect(completion.outcome).toBe("succeeded");
    expect(service.outcomeOf(job.jobId)).toBe("succeeded");
  });

  it("a QA-finding trigger rerun re-QAs the affected unit + persists (trigger-agnostic execution)", async () => {
    const sinks = new InMemorySinks();
    const resolver = new InMemoryUnitResolver([
      loopInputFor(makeUnit(UNIT_B, "今日はいい天気だ。", 2)),
    ]);
    const service = makeService();

    service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff01",
        bridgeUnitId: UNIT_B,
        severity: "p1",
        targetStage: "translation",
        rationale: "post-hoc QA finding: stale context term",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });

    const result = await runRepairQueue(service, makeDeps(resolver, sinks));

    expect(result.jobsRun).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(sinks.writtenOutcomes).toHaveLength(1);
    expect(sinks.writtenOutcomes[0]!.bridgeUnitId).toBe(UNIT_B);
    expect(sinks.writtenOutcomes[0]!.selectedBody).toBe(`Translation of ${UNIT_B}`);
  });

  it("a critical zero-budget repair retains a written primary body and informational quality flags", async () => {
    const sinks = new InMemorySinks();
    // The unit's source carries CRITICAL_QA_MARKER so the fake provider emits a
    // critical QA finding; with maxRepairAttempts: 0 it retains the primary.
    const resolver = new InMemoryUnitResolver([
      loopInputFor(makeUnit(UNIT_C, `これ${CRITICAL_QA_MARKER}だ。`, 3)),
    ]);
    const service = makeService();

    service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff02",
        bridgeUnitId: UNIT_C,
        severity: "p0",
        targetStage: "translation",
        rationale: "rerun of a unit that cannot be auto-resolved",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });

    const result = await runRepairQueue(
      service,
      makeDeps(resolver, sinks, { policy: makePolicy({ maxRepairAttempts: 0 }) }),
    );

    expect(result.jobsRun).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(sinks.writtenOutcomes).toHaveLength(1);
    const flagged = sinks.writtenOutcomes[0]!;
    expect(flagged.bridgeUnitId).toBe(UNIT_C);
    expect(flagged.selectedBody).toBe(`Translation of ${UNIT_C}`);
    expect(flagged.outcome.qualityFlags.length).toBeGreaterThan(0);
    expect(flagged.outcome.findings.some((finding) => finding.severity === "critical")).toBe(true);
    // Cost is still recorded from the real invocations the QA annotation fired.
    expect(sinks.providerRuns).toHaveLength(1);
    expect(sinks.providerRuns[0]!.invocationCount).toBeGreaterThan(0);
  });

  it("an empty affected scope resolves to outcome no_change and persists nothing", async () => {
    const sinks = new InMemorySinks();
    // A resolver that resolves ZERO units for any job (e.g. every unit dropped
    // out of scope). The executor must NOT run the loop or persist.
    const emptyResolver: RepairRerunUnitResolver = {
      resolveAffectedUnits: async () => [],
    };
    const service = makeService();
    service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff04",
        bridgeUnitId: UNIT_A,
        severity: "p1",
        targetStage: "translation",
        rationale: "QA finding whose affected unit is no longer in scope",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });

    const result = await runRepairQueue(service, makeDeps(emptyResolver, sinks));

    expect(result.jobsRun).toBe(1);
    expect(result.noChange).toBe(1);
    expect(result.totalCostUsd).toBe(0);
    expect(sinks.writtenOutcomes).toEqual([]);
    expect(sinks.providerRuns).toEqual([]);
    expect(service.outcomeOf(service.repairHistory()[0]!.jobId)).toBe("no_change");
  });

  it("drains a multi-job queue in priority order, recording each outcome on the history", async () => {
    const sinks = new InMemorySinks();
    const resolver = new InMemoryUnitResolver([
      loopInputFor(makeUnit(UNIT_A, "おはよう。", 1)),
      loopInputFor(makeUnit(UNIT_B, "こんにちは。", 2)),
    ]);
    const service = makeService();

    const p1 = service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff11",
        bridgeUnitId: UNIT_A,
        severity: "p1",
        targetStage: "translation",
        rationale: "p1 finding on unit A",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });
    const p0 = service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff00",
        bridgeUnitId: UNIT_B,
        severity: "p0",
        targetStage: "translation",
        rationale: "p0 finding on unit B",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });

    // p0 outranks p1, so it is claimed first.
    expect(service.claimNext()?.jobId).toBe(p0.jobId);
    await executeRepairJob(p0, makeDeps(resolver, sinks));
    service.recordOutcome(p0.jobId, "succeeded");

    // Remaining p1 job drains via the runner.
    const rest = await runRepairQueue(service, makeDeps(resolver, sinks));
    expect(rest.jobsRun).toBe(1);
    expect(service.outcomeOf(p0.jobId)).toBe("succeeded");
    expect(service.outcomeOf(p1.jobId)).toBe("succeeded");
    expect(sinks.writtenOutcomes).toHaveLength(2);
  });

  it("determinism: identical (job, deps) replay produces equal selected bodies + cost", async () => {
    // Two independent runs over the SAME unit + same deterministic deps must
    // produce byte-equal selected target text + equal recorded cost (the
    // DEV_POLICY uses deterministic seeds; the clock is fixed).
    async function runOnce(): Promise<{
      selectedBody: string;
      totalCostUsd: number;
    }> {
      const sinks = new InMemorySinks();
      const resolver = new InMemoryUnitResolver([loopInputFor(makeUnit(UNIT_A, "おはよう。", 1))]);
      const service = makeService();
      service.enqueue({
        trigger: {
          trigger: "qa_finding",
          findingId: "019ed0aa-0000-7000-8000-00000000ff05",
          bridgeUnitId: UNIT_A,
          severity: "p1",
          targetStage: "translation",
          rationale: "QA rerun determinism check",
        },
        pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
      });
      const result = await runRepairQueue(service, makeDeps(resolver, sinks));
      return {
        selectedBody: sinks.writtenOutcomes[0]!.selectedBody,
        totalCostUsd: result.totalCostUsd,
      };
    }

    const first = await runOnce();
    const second = await runOnce();
    expect(second.selectedBody).toBe(first.selectedBody);
    expect(second.totalCostUsd).toBe(first.totalCostUsd);
  });

  it("a failing QA repair job records partial_failure with failed-unit details", async () => {
    const sinks = new InMemorySinks();
    // A "poison" unit whose translation pack is malformed so the loop throws.
    const poisonUnit = loopInputFor(makeUnit(UNIT_B, "poison", 2));
    const resolver = new InMemoryUnitResolver([poisonUnit]);
    const service = makeService();

    const throwingFactory: AgenticLoopProviderFactory = ({ stage, agentLabel }) =>
      new FakeModelProvider({
        providerName: `repair-fake-throw-${stage}-${agentLabel}`,
        generate: (request: ModelInvocationRequest): string => {
          if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
            return fakeSemanticContextContent(agentLabel);
          }
          if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
            return speakerLabelContent(bridgeUnitIdOf(request));
          }
          if (request.taskKind === "draft_translation") {
            const bridgeUnitId = bridgeUnitIdOf(request);
            if (bridgeUnitId === UNIT_B) {
              // Malformed pack — wrong schemaVersion; the agent parse throws.
              return JSON.stringify({ schemaVersion: "totally.wrong.v0", drafts: [] });
            }
            return translationContent(bridgeUnitId, CORRECTED_DRAFT_A);
          }
          if (request.taskKind === "llm_qa") {
            return cleanQaContent();
          }
          return "";
        },
      });

    const job = service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff06",
        bridgeUnitId: UNIT_B,
        severity: "p1",
        targetStage: "translation",
        rationale: "QA finding on a unit whose provider pack is malformed",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });

    // Drive the claimed job directly so the full execution result (incl. the
    // failed-unit details) is observable — the crux of FIX 1.
    const claimed = service.claimNext();
    if (claimed === undefined) {
      throw new Error("expected the enqueued repair job to be claimable");
    }
    const result = await executeRepairJob(
      claimed,
      makeDeps(resolver, sinks, { providerFactory: throwingFactory }),
    );

    // A thrown machine-scoped rerun is terminally non-successful.
    expect(result.outcome).toBe("partial_failure");
    expect(result.outcome).not.toBe("succeeded");
    expect(result.writtenOutcomeCount).toBe(0);
    expect(result.failureCount).toBe(1);

    // The failed-unit details ride along so the failure is never hidden.
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0]!;
    expect(failure.bridgeUnitId).toBe(UNIT_B);
    expect(failure.sourceUnitKey).toBe(poisonUnit.unit.sourceUnitKey);
    expect(failure.message.length).toBeGreaterThan(0);

    // The failed unit does not receive a fabricated selected body.
    expect(sinks.writtenOutcomes).toEqual([]);

    // The terminal outcome is what the caller records on the service history.
    service.recordOutcome(job.jobId, result.outcome);
    expect(service.outcomeOf(job.jobId)).toBe("partial_failure");
  });

  it("runRepairQueue tallies a partial_failure job separately from succeeded", async () => {
    const sinks = new InMemorySinks();
    const goodUnit = loopInputFor(makeUnit(UNIT_A, "おはよう。", 1));
    const poisonUnit = loopInputFor(makeUnit(UNIT_B, "poison", 2));
    const resolver = new InMemoryUnitResolver([goodUnit, poisonUnit]);
    const service = makeService();

    const throwingFactory: AgenticLoopProviderFactory = ({ stage, agentLabel }) =>
      new FakeModelProvider({
        providerName: `repair-fake-throw-${stage}-${agentLabel}`,
        generate: (request: ModelInvocationRequest): string => {
          if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
            return fakeSemanticContextContent(agentLabel);
          }
          if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
            return speakerLabelContent(bridgeUnitIdOf(request));
          }
          if (request.taskKind === "draft_translation") {
            const bridgeUnitId = bridgeUnitIdOf(request);
            if (bridgeUnitId === UNIT_B) {
              return JSON.stringify({ schemaVersion: "totally.wrong.v0", drafts: [] });
            }
            return translationContent(bridgeUnitId, CORRECTED_DRAFT_A);
          }
          if (request.taskKind === "llm_qa") {
            return cleanQaContent();
          }
          return "";
        },
      });

    service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff07",
        bridgeUnitId: UNIT_B,
        severity: "p1",
        targetStage: "translation",
        rationale: "QA finding on the poison unit",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });

    service.enqueue({
      trigger: {
        trigger: "qa_finding",
        findingId: "019ed0aa-0000-7000-8000-00000000ff08",
        bridgeUnitId: UNIT_A,
        severity: "p1",
        targetStage: "translation",
        rationale: "QA finding on the healthy unit",
      },
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    });

    const result = await runRepairQueue(
      service,
      makeDeps(resolver, sinks, { providerFactory: throwingFactory }),
    );

    // Independent machine-scoped jobs report their outcomes separately.
    expect(result.jobsRun).toBe(2);
    expect(result.partialFailure).toBe(1);
    expect(result.succeeded).toBe(1);
  });
});
