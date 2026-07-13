// m1-wholegame-localize-to-patch-seam — tests.
//
// Proves the M1 keystone: a whole-game `itotori localize` run reaches an
// APPLYABLE, byte-correct patch via a SHIPPED path.
//
//   1. FAST (no DB) — the scope-token mapper + the kaifuu-cli invocation shape
//      + the executor-run draft-bundle loader over an in-memory durable journal
//      (production loader logic, no fixture bundle).
//   2. REAL POSTGRES — drive a full project through the whole-game command
//      (fake provider, real DB persistence of the attempt/outcome journal), THEN
//      run `runWholeGamePatchExportAndApply` over the run's REAL persisted
//      outcomes: the production loader reconstructs the DraftArtifactBundle
//      from the DB, the export-patch preflight passes honestly, and the kaifuu-patch
//      invocation MIRRORS the single-unit suite runner's phase 3
//      (`kaifuu patch --engine reallive --source ... --target ... --bundle
//      translated-bridge.json --scope ... --force`). A fake `runProcess`
//      captures the invocation so CI touches NO real bytes.
//   3. ENV-GATED real Sweetie — when ITOTORI_REAL_SWEETIE_ROOT + a writable
//      target are exported, actually apply the translated bridge via the real
//      kaifuu-cli and assert a patched Seen.txt landed under the target
//      (no retail bytes committed).

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asNonBlankTargetText,
  assertDraftArtifactBundle,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type WrittenUnitOutcome,
} from "@itotori/localization-bridge-schema";
import {
  ItotoriLocalizationJournalRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  localUserId,
  migrate,
  type AuthorizationActor,
  type ItotoriLocalizationJournalRepositoryPort,
  type LocalizationJournalAttemptRecord,
  type LocalizationJournalOutcomeRecord,
  type LocalizationJournalRunRecord,
} from "@itotori/db";
import {
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  DrivenJournalPersistenceAdapter,
  FsDrivenPatchExportSink,
} from "../src/orchestrator/project-driven-executor-sinks.js";
import { runLocalizeFullProjectCommand } from "../src/orchestrator/localize-fullproject-command.js";
import {
  applyKaifuuRealLivePatch,
  applyKaifuuRpgMakerPatch,
  buildDraftArtifactBundleFromExecutorRun,
  kaifuuScopeToken,
  mapV02SpanToProtectedSpan,
  runWholeGamePatchExportAndApply,
  WholeGamePatchExportPreflightError,
  type KaifuuProcessResult,
} from "../src/orchestrator/patch-apply-seam.js";
import {
  hashDraftedAgainstBridge,
  type DrivenPatchReport,
} from "../src/orchestrator/project-driven-executor.js";

// --- ids (UUID-ish so a shared DB never collides) ---------------------------
const PROJECT_ID = "019ed0ee-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed0ee-0000-7000-8000-000000000002";
const REVISION_ID = "019ed0ee-0000-7000-8000-000000000003";
const ASSET_ID = "019ed0ee-0000-7000-8000-000000000004";
const SPEAKER_ID = "019ed0ee-0000-7000-8000-000000000005";
const SOURCE_BUNDLE_ID = "019ed0ee-0000-7000-8000-000000000006";
const WORKSPACE_ID = "019ed0ee-0000-7000-8000-000000000007";

const UNIT_A = "019ed0ff-0000-7000-8000-0000000000a1"; // written
const UNIT_B = "019ed0ff-0000-7000-8000-0000000000b2"; // written
const UNIT_UI = "019ed0ff-0000-7000-8000-0000000000e5"; // ui_label -> OUT OF SCOPE

const SCENE_ID = 6010;
const SPEAKER_NAME = "和人";
const DRAFT = "Good morning.";

// ---------------------------------------------------------------------------
// (1) FAST unit tests — no DB
// ---------------------------------------------------------------------------

describe("kaifuuScopeToken (config scope -> kaifuu --scope)", () => {
  it("maps dialogue-only straight through and every broader scope to dialogue+choices", () => {
    expect(kaifuuScopeToken("dialogue-only")).toBe("dialogue-only");
    expect(kaifuuScopeToken("dialogue-and-choices")).toBe("dialogue+choices");
    expect(kaifuuScopeToken("dialogue-choices-ui")).toBe("dialogue+choices");
    expect(kaifuuScopeToken("all")).toBe("dialogue+choices");
  });
});

describe("mapV02SpanToProtectedSpan", () => {
  it("honors outOfBand for control-markup spans", () => {
    const span = mapV02SpanToProtectedSpan(
      {
        spanId: "span-oob",
        spanKind: "control_markup",
        raw: "<synthetic-control>",
        startByte: 0,
        endByte: "<synthetic-control>".length,
        outOfBand: true,
      },
      0,
      "<synthetic-control>本文",
    );
    expect(span.outOfBand).toBe(true);
  });

  it("does not let outOfBand vacate a variable-placeholder span", () => {
    const span = mapV02SpanToProtectedSpan(
      {
        spanId: "span-variable-oob",
        spanKind: "variable_placeholder",
        raw: "[name]",
        startByte: 0,
        endByte: "[name]".length,
        outOfBand: true,
      },
      0,
      "[name]本文",
    );
    expect(span.outOfBand).not.toBe(true);
    expect(span.kind).toBe("variable");
  });
});

describe("applyKaifuuRealLivePatch (invocation shape mirrors run.mjs phase 3)", () => {
  it("invokes kaifuu patch --engine reallive with the translated bundle + scope + force", () => {
    let captured: { command: string; args: string[] } | undefined;
    const runProcess = (command: string, args: string[]): KaifuuProcessResult => {
      captured = { command, args };
      return { status: 0, stdout: "ok", stderr: "" };
    };
    const res = applyKaifuuRealLivePatch({
      sourceRoot: "/src/game",
      targetRoot: "/out/patched",
      translatedBundlePath: "/run/translated-bridge.json",
      translationScope: "dialogue-only",
      // ITOTORI_KAIFUU_BIN unset here -> cargo fallback; runProcess is faked.
      env: {},
      runProcess,
    });
    expect(res.status).toBe(0);
    // The exact flag ordering the suite runner uses for phase 3.
    const a = captured!.args;
    const patchIdx = a.indexOf("patch");
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(a.slice(patchIdx)).toEqual([
      "patch",
      "--engine",
      "reallive",
      "--source",
      "/src/game",
      "--target",
      "/out/patched",
      "--bundle",
      "/run/translated-bridge.json",
      "--scope",
      "dialogue-only",
      "--force",
    ]);
  });

  it("throws a KaifuuPatchApplyError on a non-zero exit", () => {
    const runProcess = (): KaifuuProcessResult => ({
      status: 3,
      stdout: "",
      stderr: "patchback_target_nonempty: boom",
    });
    expect(() =>
      applyKaifuuRealLivePatch({
        sourceRoot: "/src",
        targetRoot: "/out",
        translatedBundlePath: "/run/translated-bridge.json",
        translationScope: "dialogue-only",
        env: {},
        runProcess,
      }),
    ).toThrow(/status 3.*patchback_target_nonempty/su);
  });
});

describe("applyKaifuuRpgMakerPatch (invocation shape mirrors kaifuu rpgmaker patch)", () => {
  it("invokes kaifuu patch --engine rpgmaker with source www + bundle + delta + patched-data outputs", () => {
    const root = rpgMakerApplyFixtureRoot();
    try {
      let captured: { command: string; args: string[] } | undefined;
      const runProcess = (command: string, args: string[]): KaifuuProcessResult => {
        captured = { command, args };
        materializeRpgMakerOutputs(args);
        return { status: 0, stdout: "kaifuu rpgmaker patch: changed_files=1", stderr: "" };
      };
      const sourceRoot = join(root, "www");
      const patchedDataOutputPath = join(root, "patched-data");
      const deltaOutputPath = join(root, "rpgmaker-delta.kaifuu");
      const translatedBundlePath = join(root, "translated-bridge.json");
      const res = applyKaifuuRpgMakerPatch({
        sourceRoot,
        patchedDataOutputPath,
        deltaOutputPath,
        translatedBundlePath,
        env: {},
        runProcess,
      });
      expect(res.status).toBe(0);
      const a = captured!.args;
      const patchIdx = a.indexOf("patch");
      expect(patchIdx).toBeGreaterThanOrEqual(0);
      expect(a.slice(patchIdx)).toEqual([
        "patch",
        "--engine",
        "rpgmaker",
        "--source",
        sourceRoot,
        "--bundle",
        translatedBundlePath,
        "--delta-output",
        deltaOutputPath,
        "--patched-data-output",
        patchedDataOutputPath,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-runs safely after a crash left complete target bytes but no outbox receipt", () => {
    const root = rpgMakerApplyFixtureRoot();
    try {
      const sourceRoot = join(root, "www");
      const patchedDataOutputPath = join(root, "patched-data");
      const deltaOutputPath = join(root, "rpgmaker-delta.kaifuu");
      const translatedBundlePath = join(root, "translated-bridge.json");
      let attempts = 0;
      const runProcess = (_command: string, processArgs: string[]): KaifuuProcessResult => {
        attempts += 1;
        materializeRpgMakerOutputs(processArgs);
        if (attempts === 1) throw new Error("simulated crash after kaifuu materialized outputs");
        return { status: 0, stdout: "recovered", stderr: "" };
      };
      const args = {
        sourceRoot,
        patchedDataOutputPath,
        deltaOutputPath,
        translatedBundlePath,
        env: {},
        runProcess,
      } as const;

      expect(() => applyKaifuuRpgMakerPatch(args)).toThrow(/simulated crash/u);
      const recovered = applyKaifuuRpgMakerPatch(args);
      expect(recovered.status).toBe(0);
      expect(recovered.stdout).toContain("rebuilt and verified crash output");
      expect(attempts).toBe(2);

      const replayed = applyKaifuuRpgMakerPatch(args);
      expect(replayed.stdout).toContain("verified existing receipt");
      expect(attempts).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws a KaifuuPatchApplyError on a non-zero exit", () => {
    const runProcess = (): KaifuuProcessResult => ({
      status: 4,
      stdout: "",
      stderr: "kaifuu.rpgmaker.stale_source: boom",
    });
    expect(() =>
      applyKaifuuRpgMakerPatch({
        sourceRoot: "/src/www",
        patchedDataOutputPath: "/out/patched-data",
        deltaOutputPath: "/run/rpgmaker-delta.kaifuu",
        translatedBundlePath: "/run/translated-bridge.json",
        env: {},
        runProcess,
      }),
    ).toThrow(/rpgmaker.*status 4.*stale_source/su);
  });
});

function rpgMakerApplyFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "itotori-rpgmaker-apply-"));
  mkdirSync(join(root, "www", "data"), { recursive: true });
  writeFileSync(join(root, "www", "data", "Map001.json"), '{"events":[]}');
  writeFileSync(join(root, "translated-bridge.json"), '{"schemaVersion":"0.2.0"}');
  return root;
}

function materializeRpgMakerOutputs(args: readonly string[]): void {
  const target = args[args.indexOf("--patched-data-output") + 1]!;
  const delta = args[args.indexOf("--delta-output") + 1]!;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "Map001.json"), '{"events":["translated"]}');
  writeFileSync(delta, "deterministic-delta");
}

describe("buildDraftArtifactBundleFromExecutorRun (production loader over durable journal)", () => {
  it("loads the exact persisted outcomes, all candidates, QA rationale, and full-precision attempts", async () => {
    const actor: AuthorizationActor = { userId: localUserId };
    const runId = "localization-journal-run:loader-fast";
    const { journal } = fakeJournal(
      [
        {
          unitId: UNIT_A,
          selectedBody: "Body A (repaired)",
          candidates: [
            { body: "Body A (primary)", kind: "primary", attemptId: "attempt-a-primary" },
            { body: "Body A (repaired)", kind: "repair", attemptId: "attempt-a-repair" },
          ],
          findings: [
            {
              severity: "major",
              category: "voice",
              note: "Use the more formal address.\nRecommendation: retain the repair.",
              contested: false,
              confidence: 0.91,
              recommendation: "retain the repair",
              agentRationale: "The repaired candidate preserves the established formal voice.",
            },
          ],
          attempts: [
            { attemptId: "attempt-a-primary", costUsd: "0.00000602", tokensIn: 10, tokensOut: 5 },
            { attemptId: "attempt-a-repair", costUsd: "0.00000602", tokensIn: 11, tokensOut: 6 },
          ],
        },
        {
          unitId: UNIT_B,
          selectedBody: "Body B",
          attempts: [
            { attemptId: "attempt-b-primary", costUsd: "0.00000602", tokensIn: 12, tokensOut: 7 },
          ],
        },
      ],
      { runId },
    );

    const bundle = await buildDraftArtifactBundleFromExecutorRun({
      actor,
      journal,
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: "wholegame-run:test",
      patchReport: {
        journalRunId: runId,
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        targetLocale: "en-US",
        writtenUnits: [
          {
            bridgeUnitId: UNIT_B,
            sourceUnitKey: "k-b",
            // The report is reconciled against, but the durable outcome is
            // what the loader actually projects.
            selectedBody: "Body B",
            qualityFlags: [],
          },
          {
            bridgeUnitId: UNIT_A,
            sourceUnitKey: "k-a",
            selectedBody: "Body A (repaired)",
            qualityFlags: [],
          },
        ],
        translationScope: "dialogue-only",
      },
      sourceBridgeHash: "sha256:deadbeef",
    });

    assertDraftArtifactBundle(bundle);
    expect(bundle.drafts.map((d) => d.sourceUnitId)).toEqual([UNIT_A, UNIT_B]);
    const a = bundle.drafts.find((d) => d.sourceUnitId === UNIT_A)!;
    const selectedCandidate = a.writtenOutcome.candidates.find(
      (candidate) => candidate.id === a.writtenOutcome.selectedCandidateId,
    );
    expect(selectedCandidate?.body).toBe("Body A (repaired)");
    expect(a.writtenOutcome.candidates.map((candidate) => candidate.kind)).toEqual([
      "primary",
      "repair",
    ]);
    expect(a.providerProofId).toBe("attempt-a-repair");
    expect(a.costLedgerEntryRef).toBe("llm-attempt:attempt-a-repair");
    expect(a.writtenOutcome.status).toBe("written");
    expect(a.writtenOutcome.findings).toMatchObject([
      {
        severity: "major",
        category: "voice",
        note: "Use the more formal address.\nRecommendation: retain the repair.",
      },
    ]);
    expect(a.writtenOutcome.provenance).toMatchObject({
      journal: {
        qaFindingDetails: [
          {
            recommendation: "retain the repair",
            agentRationale: "The repaired candidate preserves the established formal voice.",
          },
        ],
      },
    });
    // 0.00000602 * 3 proves the bundle sums persisted exact decimal strings,
    // rather than losing tails through a micro-USD or Number conversion.
    expect(bundle.ledgerSummary).toMatchObject({
      totalCost: "0.00001806",
      totalTokensIn: 33,
      totalTokensOut: 18,
      attemptCount: 3,
    });
    expect(bundle.ledgerSummary.providerProofIds.sort()).toEqual([
      "attempt-a-primary",
      "attempt-a-repair",
      "attempt-b-primary",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (1b) FAILURE-PATH proofs — the preflight is HONEST (no vacuous pass, no
// silent drop, no tautological integrity). These run over a fake journal (no DB):
// the loader reconciliation + the seam's source-view / integrity logic are DB
// independent, so a fast test proves each blocking failure THROWS.
// ---------------------------------------------------------------------------

const SEAM_ACTOR: AuthorizationActor = { userId: localUserId };

type FakeJournalCandidate = {
  body: string;
  kind: "primary" | "repair";
  attemptId: string;
};

type FakeJournalFinding = {
  severity: "info" | "minor" | "major" | "critical";
  category: string;
  note: string;
  contested: boolean;
  confidence: number;
  recommendation: string;
  agentRationale: string;
};

type FakeJournalAttempt = {
  attemptId: string;
  costUsd?: string;
  tokensIn?: number;
  tokensOut?: number;
  providerRunId?: string;
};

type FakeJournalUnit = {
  unitId: string;
  selectedBody: string;
  candidates?: readonly FakeJournalCandidate[];
  findings?: readonly FakeJournalFinding[];
  attempts?: readonly FakeJournalAttempt[];
  withOutcome?: boolean;
  withAttempt?: boolean;
};

type FakeJournalOptions = {
  runId?: string;
  missingRun?: boolean;
  projectId?: string;
  localeBranchId?: string;
  targetLocale?: string;
};

/**
 * A typed in-memory read model for the journal loader. The outcomes carry
 * canonical candidates/findings and their raw QA rationale in the outcome's
 * persisted journal provenance; attempts are physical provider dispatches,
 * not one synthesized aggregate row per unit.
 */
function fakeJournal(
  units: readonly FakeJournalUnit[],
  options: FakeJournalOptions = {},
): {
  journal: ItotoriLocalizationJournalRepositoryPort;
  outcomes: LocalizationJournalOutcomeRecord[];
  attempts: LocalizationJournalAttemptRecord[];
  run: LocalizationJournalRunRecord;
} {
  const runId = options.runId ?? "localization-journal-run:patch-seam-fixture";
  const run: LocalizationJournalRunRecord = {
    runId,
    projectId: options.projectId ?? PROJECT_ID,
    localeBranchId: options.localeBranchId ?? LOCALE_BRANCH_ID,
    sourceRevisionId: REVISION_ID,
    targetLocale: options.targetLocale ?? "en-US",
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
  };
  const attempts: LocalizationJournalAttemptRecord[] = units.flatMap((unit) => {
    if (unit.withAttempt === false) return [];
    const fixtureAttempts = unit.attempts ?? [
      { attemptId: `attempt:${unit.unitId}`, costUsd: "0", tokensIn: 0, tokensOut: 0 },
    ];
    return fixtureAttempts.map((attempt, index) => ({
      attemptId: attempt.attemptId,
      runId,
      bridgeUnitId: unit.unitId,
      stage: "translation",
      agentLabel: "translation-primary",
      logicalCallId: `logical:${unit.unitId}:${index}`,
      attemptIndex: index,
      modelId: "fixture-model",
      providerId: "fixture-provider",
      providerRunId: attempt.providerRunId ?? attempt.attemptId,
      costUsd: attempt.costUsd ?? "0",
      tokensIn: attempt.tokensIn ?? 0,
      tokensOut: attempt.tokensOut ?? 0,
      zdr: true,
      finishState: "stop",
      refusalState: null,
      validationResult: "accepted",
      failureClass: null,
      retryDecision: "write",
      retryDelayMs: null,
      artifactRef: null,
      errorClasses: [],
      startedAt: new Date("2026-07-11T00:00:00.000Z"),
      completedAt: new Date("2026-07-11T00:00:01.000Z"),
      createdAt: new Date("2026-07-11T00:00:01.000Z"),
    }));
  });
  const outcomes = units.flatMap((unit): LocalizationJournalOutcomeRecord[] => {
    if (unit.withOutcome === false) return [];
    const outcomeId = `outcome:${unit.unitId}`;
    const defaultAttemptId = unit.attempts?.[0]?.attemptId ?? `attempt:${unit.unitId}`;
    const candidates = (
      unit.candidates ?? [
        { body: unit.selectedBody, kind: "primary" as const, attemptId: defaultAttemptId },
      ]
    ).map((candidate, index) => ({
      id: `${outcomeId}:candidate:${index + 1}`,
      outcomeId,
      body: asNonBlankTargetText(candidate.body),
      producedBy: { modelId: "fixture-model", providerId: "fixture-provider" },
      attemptId: candidate.attemptId,
      kind: candidate.kind,
    }));
    const selectedCandidate = candidates.find((candidate) => candidate.body === unit.selectedBody);
    if (selectedCandidate === undefined) {
      throw new Error(`fake journal has no candidate for selected body ${unit.selectedBody}`);
    }
    const findings = (unit.findings ?? []).map((finding, index) => ({
      id: `${outcomeId}:finding:${index + 1}`,
      outcomeId,
      candidateId: selectedCandidate.id,
      severity: finding.severity,
      category: finding.category,
      note: finding.note,
      contested: finding.contested,
      confidence: finding.confidence,
    }));
    const qaFindingDetails = (unit.findings ?? []).map((finding, index) => ({
      findingId: findings[index]!.id,
      recommendation: finding.recommendation,
      agentRationale: finding.agentRationale,
      evidenceRefs: [`evidence:${unit.unitId}:${index + 1}`],
    }));
    const provenance = {
      journal: {
        resolvedContextPacket: { fixture: true, unitId: unit.unitId },
        contextArtifactIds: [`context:${unit.unitId}`],
        contextVersionRefs: [],
        selectedCandidateCitationRefs: [`citation:${unit.unitId}`],
        speakerLabels: [],
        qaFindingDetails,
      },
    };
    const outcome: WrittenUnitOutcome = {
      id: outcomeId,
      status: "written",
      unitId: unit.unitId,
      targetLocale: run.targetLocale,
      selectedCandidateId: selectedCandidate.id,
      candidates,
      findings,
      qualityFlags: [],
      provenance,
      writtenAt: "2026-07-11T00:00:01.000Z",
    };
    const qaDetails = Object.fromEntries(
      qaFindingDetails.map((detail) => [
        detail.findingId,
        {
          recommendation: detail.recommendation,
          agentRationale: detail.agentRationale,
          evidenceRefs: detail.evidenceRefs,
        },
      ]),
    );
    return [
      {
        journalOutcomeId: `journal-outcome:${runId}:${outcomeId}`,
        runId,
        bridgeUnitId: unit.unitId,
        sourceUnitKey: `k-${unit.unitId}`,
        outcome,
        candidates,
        findings,
        contextPacket: provenance.journal.resolvedContextPacket,
        contextRefs: [
          {
            refKind: "context_artifact",
            refId: `context:${unit.unitId}`,
            versionRef: null,
            details: null,
          },
        ],
        speakerLabels: [],
        qaDetails,
      },
    ];
  });
  const journal = {
    async loadRun(_actor: AuthorizationActor, requestedRunId: string) {
      return options.missingRun || requestedRunId !== runId ? null : run;
    },
    async loadRunOutcomes(_actor: AuthorizationActor, requestedRunId: string) {
      return requestedRunId === runId ? outcomes : [];
    },
    async loadAttemptsForRun(_actor: AuthorizationActor, requestedRunId: string) {
      return requestedRunId === runId ? attempts : [];
    },
  } as unknown as ItotoriLocalizationJournalRepositoryPort;
  return { journal, outcomes, attempts, run };
}

function fakeJournalForPatchReport(
  patchReport: DrivenPatchReport,
  options: Omit<FakeJournalOptions, "runId"> & {
    unitOverrides?: Readonly<Record<string, Partial<FakeJournalUnit>>>;
  } = {},
): ItotoriLocalizationJournalRepositoryPort {
  const units = patchReport.writtenUnits.map((written) => ({
    unitId: written.bridgeUnitId,
    selectedBody: written.selectedBody,
    ...options.unitOverrides?.[written.bridgeUnitId],
  }));
  return fakeJournal(units, { ...options, runId: patchReport.journalRunId }).journal;
}

type SeamBridgeUnit = {
  bridgeUnitId: string;
  sourceText: string;
  spans?: Array<Record<string, unknown>>;
  protectedSpans?: Array<Record<string, unknown>>;
  assetRefs?: Array<Record<string, unknown>>;
  /** The canonical v0.2 container ref: {assetId, assetKey?}. */
  sourceAssetRef?: Record<string, unknown>;
};

function seamBridge(
  units: ReadonlyArray<SeamBridgeUnit>,
  assets?: ReadonlyArray<Record<string, unknown>>,
): { units: SeamBridgeUnit[]; assets?: Record<string, unknown>[] } {
  return {
    units: [...units],
    ...(assets !== undefined ? { assets: [...assets] } : {}),
  };
}

function seamPatchReport(
  writtenUnits: ReadonlyArray<{ bridgeUnitId: string; selectedBody: string }>,
  sourceBridgeHash: string,
): DrivenPatchReport {
  return {
    schemaVersion: "itotori.project-driven-executor.patch-report.v0",
    journalRunId: "localization-journal-run:preflight-fixture",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    targetLocale: "en-US",
    pair: { modelId: "m", providerId: "p" },
    engineProfile: "reallive",
    translationScope: "dialogue-only",
    unitsEnumerated: writtenUnits.length,
    unitsInScope: writtenUnits.length,
    unitsRun: writtenUnits.length,
    writtenOutcomeCount: writtenUnits.length,
    failureCount: 0,
    totalUsageCostExactUsd: "0",
    totalUsageCostUsd: 0,
    zdrConfirmed: true,
    budgetStopped: false,
    coverageComplete: true,
    sourceBridgeHash,
    writtenUnits: writtenUnits.map((u) => ({
      bridgeUnitId: u.bridgeUnitId,
      sourceUnitKey: `k-${u.bridgeUnitId}`,
      selectedBody: u.selectedBody,
      qualityFlags: [],
    })),
  };
}

describe("runWholeGamePatchExportAndApply — the preflight is HONEST (P1 fixes)", () => {
  // (a) — P1 #1: a bridge that declares a protected span the written draft
  // does NOT contain makes protectedSpanCoverage BLOCK. The source view carries
  // the REAL span (not erased to []), so the check can throw.
  it("THROWS when a written draft LOST a declared protected span (not a vacuous pass)", async () => {
    const bridge = seamBridge([
      {
        bridgeUnitId: UNIT_A,
        sourceText: "Hello [ICON].",
        // A v0.2-style variable span whose raw literal MUST survive the draft.
        spans: [{ spanId: "s1", spanKind: "variable_placeholder", raw: "[ICON]" }],
      },
    ]);
    const hash = hashDraftedAgainstBridge(bridge);
    const patchReport = seamPatchReport([{ bridgeUnitId: UNIT_A, selectedBody: "Hello." }], hash);
    const journal = fakeJournalForPatchReport(patchReport);
    let applied = false;
    await expect(
      runWholeGamePatchExportAndApply({
        engineProfile: "reallive",
        actor: SEAM_ACTOR,
        journal,
        // The draft body DROPS the [ICON] span -> coverage must fail.
        patchReport,
        rawBridge: bridge,
        sourceRoot: "/src",
        targetRoot: "/out",
        translatedBundlePath: "/run/translated-bridge.json",
        requestedBy: localUserId,
        loadActiveDecisions: async () => [],
        runProcess: () => {
          applied = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toBeInstanceOf(WholeGamePatchExportPreflightError);
    // No patch was applied on the blocking preflight failure.
    expect(applied).toBe(false);
  });

  // (a') — P1 #1: an unresolved asset decision BLOCKS. The source view carries
  // the real assetRef (not erased to []), so noUnresolvedAssetDecisions throws.
  it("THROWS when a declared asset ref is UNRESOLVED (not a vacuous pass)", async () => {
    const bridge = seamBridge([
      {
        bridgeUnitId: UNIT_A,
        sourceText: "See the sign.",
        assetRefs: [{ kind: "image", ref: "sign.png", assetKind: "image_text" }],
      },
    ]);
    const hash = hashDraftedAgainstBridge(bridge);
    const patchReport = seamPatchReport(
      [{ bridgeUnitId: UNIT_A, selectedBody: "See the sign." }],
      hash,
    );
    const journal = fakeJournalForPatchReport(patchReport);
    await expect(
      runWholeGamePatchExportAndApply({
        engineProfile: "reallive",
        actor: SEAM_ACTOR,
        journal,
        patchReport,
        rawBridge: bridge,
        sourceRoot: "/src",
        targetRoot: "/out",
        translatedBundlePath: "/run/translated-bridge.json",
        requestedBy: localUserId,
        // No active decisions -> the referenced asset resolves 'unresolved'.
        loadActiveDecisions: async () => [],
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toBeInstanceOf(WholeGamePatchExportPreflightError);
  });

  // (a'') — P1 #1: the CANONICAL v0.2 asset ref (sourceAssetRef -> a
  // decision-bearing image asset resolved via the bundle assets[]) is projected,
  // NOT skipped. An undecided canonical image asset makes noUnresolvedAssetDecisions
  // BLOCK — the seam throws and NO patch is applied.
  it("THROWS when a CANONICAL v0.2 asset ref is UNRESOLVED (no explicit assetRefs[])", async () => {
    const IMAGE_ASSET_ID = "019ed0ff-0000-7000-8000-0000000000f9";
    const bridge = seamBridge(
      [
        {
          bridgeUnitId: UNIT_A,
          sourceText: "Read the poster.",
          // Only the canonical sourceAssetRef — NO explicit assetRefs[] array.
          sourceAssetRef: { assetId: IMAGE_ASSET_ID, assetKey: "poster" },
        },
      ],
      // The bundle assets[] declares the referenced asset as a localizable image.
      [{ assetId: IMAGE_ASSET_ID, assetKey: "poster", assetKind: "image" }],
    );
    const hash = hashDraftedAgainstBridge(bridge);
    const patchReport = seamPatchReport(
      [{ bridgeUnitId: UNIT_A, selectedBody: "Read the poster." }],
      hash,
    );
    const journal = fakeJournalForPatchReport(patchReport);
    let applied = false;
    await expect(
      runWholeGamePatchExportAndApply({
        engineProfile: "reallive",
        actor: SEAM_ACTOR,
        journal,
        patchReport,
        rawBridge: bridge,
        sourceRoot: "/src",
        targetRoot: "/out",
        translatedBundlePath: "/run/translated-bridge.json",
        requestedBy: localUserId,
        // No active decision for IMAGE_ASSET_ID -> resolves 'unresolved'.
        loadActiveDecisions: async () => [],
        runProcess: () => {
          applied = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toBeInstanceOf(WholeGamePatchExportPreflightError);
    expect(applied).toBe(false);
  });

  // A canonical SCRIPT-container ref (the thing dialogue lives in) needs NO
  // decision, so it is NOT projected and does NOT block — proves the canonical
  // projection is scoped to real localization surfaces, not every container.
  it("does NOT block on a canonical SCRIPT-container asset ref (no spurious unresolved)", async () => {
    const SCRIPT_ASSET_ID = "019ed0ff-0000-7000-8000-0000000000fa";
    const bridge = seamBridge(
      [
        {
          bridgeUnitId: UNIT_A,
          sourceText: "Just dialogue.",
          sourceAssetRef: { assetId: SCRIPT_ASSET_ID, assetKey: "Seen.txt" },
        },
      ],
      [{ assetId: SCRIPT_ASSET_ID, assetKey: "Seen.txt", assetKind: "script" }],
    );
    const hash = hashDraftedAgainstBridge(bridge);
    const patchReport = seamPatchReport(
      [{ bridgeUnitId: UNIT_A, selectedBody: "Localized dialogue." }],
      hash,
    );
    const journal = fakeJournalForPatchReport(patchReport);
    const seam = await runWholeGamePatchExportAndApply({
      engineProfile: "reallive",
      actor: SEAM_ACTOR,
      journal,
      patchReport,
      rawBridge: bridge,
      sourceRoot: "/src",
      targetRoot: "/out",
      translatedBundlePath: "/run/translated-bridge.json",
      requestedBy: localUserId,
      loadActiveDecisions: async () => [],
      runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    expect(seam.apply.status).toBe(0);
    // The script container produced no asset-decision entry (no decision needed).
    expect(seam.patchExportBundle.assetDecisions).toHaveLength(0);
  });

  // A span that DID survive + no assets -> preflight passes (the check is real,
  // not a hard-coded throw): proves the honest path still works.
  it("passes preflight + applies when the declared span survives the draft", async () => {
    const bridge = seamBridge([
      {
        bridgeUnitId: UNIT_A,
        sourceText: "Hello [ICON].",
        spans: [{ spanId: "s1", spanKind: "variable_placeholder", raw: "[ICON]" }],
      },
    ]);
    const hash = hashDraftedAgainstBridge(bridge);
    const patchReport = seamPatchReport(
      [{ bridgeUnitId: UNIT_A, selectedBody: "Hi [ICON]!" }],
      hash,
    );
    const journal = fakeJournalForPatchReport(patchReport);
    let capturedArgs: string[] | undefined;
    const seam = await runWholeGamePatchExportAndApply({
      engineProfile: "reallive",
      actor: SEAM_ACTOR,
      journal,
      patchReport,
      rawBridge: bridge,
      sourceRoot: "/src",
      targetRoot: "/out",
      translatedBundlePath: "/run/translated-bridge.json",
      requestedBy: localUserId,
      loadActiveDecisions: async () => [],
      runProcess: (_c, a) => {
        capturedArgs = a;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(seam.apply.status).toBe(0);
    expect(seam.patchExportBundle.drafts).toHaveLength(1);
    expect(capturedArgs?.includes("patch")).toBe(true);
  });

  // engineProfile dispatch: the SAME engine-agnostic preflight runs, but a
  // `rpg-maker-mv-mz` run applies via `kaifuu patch --engine rpgmaker`
  // (delta + patched-data outputs, NO --engine reallive / --scope / --force) and
  // SKIPS utsushi render validation even when one is requested (MV/MZ is a
  // delegation runtime with no VM oracle seam).
  it("dispatches rpg-maker-mv-mz to kaifuu patch --engine rpgmaker and skips render validation", async () => {
    const root = rpgMakerApplyFixtureRoot();
    try {
      const bridge = seamBridge([
        {
          bridgeUnitId: UNIT_A,
          sourceText: "Hello [ICON].",
          spans: [{ spanId: "s1", spanKind: "variable_placeholder", raw: "[ICON]" }],
        },
      ]);
      const hash = hashDraftedAgainstBridge(bridge);
      const patchReport = seamPatchReport(
        [{ bridgeUnitId: UNIT_A, selectedBody: "Hi [ICON]!" }],
        hash,
      );
      const journal = fakeJournalForPatchReport(patchReport);
      let capturedArgs: string[] | undefined;
      const sourceRoot = join(root, "www");
      const targetRoot = join(root, "patched-data");
      const deltaOutputPath = join(root, "rpgmaker-delta.kaifuu");
      const translatedBundlePath = join(root, "translated-bridge.json");
      const seam = await runWholeGamePatchExportAndApply({
        engineProfile: "rpg-maker-mv-mz",
        actor: SEAM_ACTOR,
        journal,
        patchReport,
        rawBridge: bridge,
        sourceRoot,
        targetRoot,
        rpgMakerDeltaOutputPath: deltaOutputPath,
        translatedBundlePath,
        requestedBy: localUserId,
        loadActiveDecisions: async () => [],
        // A render-validation request is present but MUST be ignored for MV/MZ.
        renderValidation: { artifactRoot: "/run/rv" },
        runProcess: (_c, a) => {
          capturedArgs = a;
          materializeRpgMakerOutputs(a);
          return { status: 0, stdout: "kaifuu rpgmaker patch: changed_files=1", stderr: "" };
        },
      });
      expect(seam.apply.status).toBe(0);
      expect(seam.patchExportBundle.drafts).toHaveLength(1);
      const a = capturedArgs!;
      const patchIdx = a.indexOf("patch");
      expect(a.slice(patchIdx)).toEqual([
        "patch",
        "--engine",
        "rpgmaker",
        "--source",
        sourceRoot,
        "--bundle",
        translatedBundlePath,
        "--delta-output",
        deltaOutputPath,
        "--patched-data-output",
        targetRoot,
      ]);
      // No reallive-only flags leaked in.
      expect(a).not.toContain("reallive");
      expect(a).not.toContain("--scope");
      expect(a).not.toContain("--force");
      // Render validation skipped despite the request.
      expect(seam.renderValidation).toBeUndefined();
      expect(seam.runtimeValidationAdmission).toBeUndefined();
      expect(seam.structuralValidation).toMatchObject({
        kind: "rpg-maker-structural",
        jsonFileCount: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a status-zero RPG Maker apply whose patched JSON is corrupt", async () => {
    const root = rpgMakerApplyFixtureRoot();
    try {
      const bridge = seamBridge([
        {
          bridgeUnitId: UNIT_A,
          sourceText: "Hello [ICON].",
          spans: [{ spanId: "s1", spanKind: "variable_placeholder", raw: "[ICON]" }],
        },
      ]);
      const patchReport = seamPatchReport(
        [{ bridgeUnitId: UNIT_A, selectedBody: "Hi [ICON]!" }],
        hashDraftedAgainstBridge(bridge),
      );
      await expect(
        runWholeGamePatchExportAndApply({
          engineProfile: "rpg-maker-mv-mz",
          actor: SEAM_ACTOR,
          journal: fakeJournalForPatchReport(patchReport),
          patchReport,
          rawBridge: bridge,
          sourceRoot: join(root, "www"),
          targetRoot: join(root, "patched-data"),
          rpgMakerDeltaOutputPath: join(root, "rpgmaker-delta.kaifuu"),
          translatedBundlePath: join(root, "translated-bridge.json"),
          requestedBy: localUserId,
          loadActiveDecisions: async () => [],
          runProcess: (_command, processArgs) => {
            materializeRpgMakerOutputs(processArgs);
            const target = processArgs[processArgs.indexOf("--patched-data-output") + 1]!;
            writeFileSync(join(target, "Map001.json"), '{"events": [broken}');
            return { status: 0, stdout: "reported success despite corrupt JSON", stderr: "" };
          },
        }),
      ).rejects.toThrow(/patched JSON is invalid/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // (b) — P1 #2: every selected candidate must have a real physical attempt,
  // and every report unit must have a persisted canonical outcome. The journal
  // loader refuses either gap; it never fabricates old draft/ledger evidence.
  it("FAILS LOUD when the selected persisted candidate has NO physical attempt", async () => {
    const patchReport = seamPatchReport(
      [{ bridgeUnitId: UNIT_A, selectedBody: "Body A" }],
      "sha256:deadbeef",
    );
    const journal = fakeJournalForPatchReport(patchReport, {
      unitOverrides: { [UNIT_A]: { withAttempt: false } },
    });
    await expect(
      buildDraftArtifactBundleFromExecutorRun({
        actor: SEAM_ACTOR,
        journal,
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        draftArtifactBundleId: "wholegame-run:missing-attempt",
        patchReport,
        sourceBridgeHash: "sha256:deadbeef",
      }),
    ).rejects.toMatchObject({ discrepancy: "selected-candidate-attempt-missing" });
  });

  it("FAILS LOUD when a report-written unit has NO persisted journal outcome", async () => {
    const patchReport = seamPatchReport(
      [{ bridgeUnitId: UNIT_A, selectedBody: "Body A" }],
      "sha256:deadbeef",
    );
    const journal = fakeJournalForPatchReport(patchReport, {
      unitOverrides: { [UNIT_A]: { withOutcome: false } },
    });
    await expect(
      buildDraftArtifactBundleFromExecutorRun({
        actor: SEAM_ACTOR,
        journal,
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        draftArtifactBundleId: "wholegame-run:missing-outcome",
        patchReport,
        sourceBridgeHash: "sha256:deadbeef",
      }),
    ).rejects.toMatchObject({ discrepancy: "no-persisted-written-outcome" });
  });

  it("FAILS LOUD when the patch report names no persisted journal run", async () => {
    const patchReport = seamPatchReport(
      [{ bridgeUnitId: UNIT_A, selectedBody: "Body A" }],
      "sha256:deadbeef",
    );
    const journal = fakeJournalForPatchReport(patchReport, { missingRun: true });
    await expect(
      buildDraftArtifactBundleFromExecutorRun({
        actor: SEAM_ACTOR,
        journal,
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        draftArtifactBundleId: "wholegame-run:missing-run",
        patchReport,
        sourceBridgeHash: "sha256:deadbeef",
      }),
    ).rejects.toMatchObject({ discrepancy: "no-persisted-journal-run" });
  });

  // (c) — P1 #3: an apply-time bridge that DIFFERS from the drafted-against
  // bridge fails sourceBridgeIntegrity (the check is NOT self-referential).
  it("THROWS on integrity when the apply-time bridge differs from the drafted-against hash", async () => {
    const draftedAgainst = seamBridge([{ bridgeUnitId: UNIT_A, sourceText: "Original source." }]);
    const applyTime = seamBridge([{ bridgeUnitId: UNIT_A, sourceText: "TAMPERED source." }]);
    const patchReport = seamPatchReport(
      [{ bridgeUnitId: UNIT_A, selectedBody: "Draft body." }],
      hashDraftedAgainstBridge(draftedAgainst),
    );
    const journal = fakeJournalForPatchReport(patchReport);
    let applied = false;
    await expect(
      runWholeGamePatchExportAndApply({
        engineProfile: "reallive",
        actor: SEAM_ACTOR,
        journal,
        // The report records the DRAFTED-AGAINST hash; the seam applies over the
        // TAMPERED apply-time bridge -> the two hashes differ -> integrity fails.
        patchReport,
        rawBridge: applyTime,
        sourceRoot: "/src",
        targetRoot: "/out",
        translatedBundlePath: "/run/translated-bridge.json",
        requestedBy: localUserId,
        loadActiveDecisions: async () => [],
        runProcess: () => {
          applied = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toBeInstanceOf(WholeGamePatchExportPreflightError);
    expect(applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures for the real-Postgres end-to-end test
// ---------------------------------------------------------------------------

function makeUnit(
  bridgeUnitId: string,
  sourceText: string,
  surfaceKind: LocalizationUnitV02["surfaceKind"],
  lineNo: number,
): LocalizationUnitV02 {
  const key = `scene-${SCENE_ID}/line-${String(lineNo).padStart(3, "0")}`;
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind,
    sourceUnitKey: key,
    occurrenceId: `occ-${lineNo}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `src-hash-${bridgeUnitId}`,
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "asset" },
    sourceLocation: { containerKey: "asset" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: SPEAKER_NAME },
    context: { route: { sceneId: String(SCENE_ID) } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: key,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeBridge(): BridgeBundleV02 {
  const units: LocalizationUnitV02[] = [
    makeUnit(UNIT_A, "おはよう、和人。", "dialogue", 1),
    makeUnit(UNIT_B, "いい天気だね。", "dialogue", 2),
    makeUnit(UNIT_UI, "設定", "ui_label", 3),
  ];
  return {
    schemaVersion: "0.2.0",
    bridgeId: "patch-seam-fixture",
    sourceLocale: "ja-JP",
    units,
  } as unknown as BridgeBundleV02;
}

function bridgeUnitIdOf(request: ModelInvocationRequest): string {
  const match = JSON.stringify(request).match(/019ed0ff-[0-9a-f]{4}-7000-8000-[0-9a-f]{12}/u);
  if (match === null) throw new Error("fake provider could not locate a bridge unit id");
  return match[0];
}

function fakeFactory(): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `patch-seam-fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return JSON.stringify({
            schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
            labels: [
              {
                bridgeUnitId: bridgeUnitIdOf(request),
                speakerId: { kind: "narration" },
                confidence: "high",
                evidenceRefs: [],
                agentRationale: "fake",
              },
            ],
          });
        }
        if (request.taskKind === "draft_translation") {
          return JSON.stringify({
            schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
            drafts: [
              {
                bridgeUnitId: bridgeUnitIdOf(request),
                sourceLocale: "ja-JP",
                targetLocale: "en-US",
                draftText: DRAFT,
                protectedSpanRefs: [],
                citationRefs: [],
                agentRationale: "fake",
                confidenceFloor: "medium",
              },
            ],
          });
        }
        if (request.taskKind === "llm_qa") {
          return JSON.stringify({
            schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
            findings: [],
          });
        }
        return "";
      },
    });
}

async function seedProjectScope(
  pool: import("@itotori/db").DatabaseContext["pool"],
): Promise<void> {
  await pool.query("delete from itotori_localization_journal_runs where project_id = $1", [
    PROJECT_ID,
  ]);
  await pool.query("delete from itotori_draft_jobs where project_id = $1", [PROJECT_ID]);
  await pool.query("delete from itotori_projects where project_id = $1", [PROJECT_ID]);
  await pool.query(
    `insert into itotori_workspaces (workspace_id, name) values ($1, $2)
     on conflict (workspace_id) do nothing`,
    [WORKSPACE_ID, "patch-seam pilot"],
  );
  await pool.query(
    `insert into itotori_projects (project_id, workspace_id, project_key, name, source_locale, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [PROJECT_ID, WORKSPACE_ID, "patch-seam-pilot", "Patch Seam Pilot", "ja-JP", "imported"],
  );
  await pool.query(
    `insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
     values ($1, $2, $3, $4)`,
    [REVISION_ID, PROJECT_ID, "bridge_revision", "patch-seam-v1"],
  );
  await pool.query(
    `insert into itotori_source_bundles (
       source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
       schema_version, source_bundle_hash, source_locale,
       extractor_name, extractor_version, unit_count, asset_count
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0)`,
    [
      SOURCE_BUNDLE_ID,
      PROJECT_ID,
      REVISION_ID,
      "bridge-patch-seam",
      "0.2.0",
      "hash:patch-seam",
      "ja-JP",
      "structure-export",
      "1.0.0",
    ],
  );
  await pool.query(
    `insert into itotori_locale_branches (
       locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
     ) values ($1, $2, $3, $4, $5, $6)`,
    [LOCALE_BRANCH_ID, PROJECT_ID, SOURCE_BUNDLE_ID, "en-US", "English", "active"],
  );
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 6, 8, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

// ---------------------------------------------------------------------------
// (2) REAL POSTGRES — whole-game run -> production loader -> preflight -> apply
// ---------------------------------------------------------------------------

describe("runWholeGamePatchExportAndApply (whole-game -> applyable patch, real DB)", () => {
  it.skipIf(!process.env.DATABASE_URL)(
    "consumes REAL persisted journal outcomes through the production loader, passes preflight, and applies via kaifuu patch",
    async () => {
      const databaseUrl = process.env.DATABASE_URL as string;
      await migrate(databaseUrl);
      const context = createDatabaseContext(databaseUrl);
      const actor: AuthorizationActor = { userId: localUserId };
      try {
        await bootstrapLocalUser(context.db);
        await seedProjectScope(context.pool);

        const workDir = mkdtempSync(join(tmpdir(), "itotori-patch-seam-"));
        const bridgePath = join(workDir, "bridge.json");
        const pairPolicyPath = join(workDir, "pair-policy.json");
        const configPath = join(workDir, "localize.config.json");
        writeFileSync(bridgePath, JSON.stringify(makeBridge()));
        writeFileSync(
          pairPolicyPath,
          readFileSync(
            new URL("./fixtures/agentic-loop-smoke-pair-policy.json", import.meta.url),
            "utf8",
          ),
        );
        writeFileSync(
          configPath,
          JSON.stringify({
            schemaVersion: "itotori.localize-fullproject.config.v0",
            projectId: PROJECT_ID,
            localeBranchId: LOCALE_BRANCH_ID,
            sourceRevisionId: REVISION_ID,
            engineProfile: "reallive",
            translationScope: "dialogue-only",
            targetLocale: "en-US",
            bridgePath,
            pairPolicyPath,
            maxRepairAttempts: 0,
          }),
        );

        const runDir = join(workDir, "run");
        mkdirSync(runDir, { recursive: true });

        const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
        const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor });
        const patchSink = new FsDrivenPatchExportSink(runDir);
        const io = {
          readJson: (p: string) => JSON.parse(readFileSync(p, "utf8")) as unknown,
          writeJson: (p: string, v: unknown) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`),
        };

        // --- Whole-game localize (fake provider, real DB persistence) ---
        const { result } = await runLocalizeFullProjectCommand({
          configPath,
          deps: {
            io,
            actor,
            providerFactory: fakeFactory(),
            sinks: { journal, patchExport: patchSink },
            now: deterministicClock(),
          },
        });
        expect(result.writtenOutcomeCount).toBe(2);
        expect(result.patchReport.coverageComplete).toBe(true);
        expect(result.patchReport.writtenUnits).toHaveLength(2);
        for (const written of result.patchReport.writtenUnits) {
          expect(written.selectedBody.trim()).not.toHaveLength(0);
          expect(written.qualityFlags).toEqual(expect.any(Array));
        }
        const translatedBundlePath = join(runDir, "translated-bridge.json");
        expect(existsSync(translatedBundlePath)).toBe(true);

        // The loader reads this exact run, not project-wide latest rows. The
        // normalized read model keeps canonical candidates, speaker labels,
        // resolved context refs, and every physical provider dispatch.
        const persistedOutcomes = await journalRepo.loadRunOutcomes(actor, result.journalRunId);
        const persistedAttempts = await journalRepo.loadAttemptsForRun(actor, result.journalRunId);
        expect(persistedOutcomes).toHaveLength(2);
        expect(persistedAttempts).toHaveLength(result.attemptsPersisted);
        expect(persistedAttempts.length).toBeGreaterThan(persistedOutcomes.length);
        for (const outcome of persistedOutcomes) {
          expect(outcome.outcome.candidates).toHaveLength(1);
          expect(outcome.speakerLabels).toHaveLength(1);
          expect(outcome.contextRefs.length).toBeGreaterThan(0);
        }

        // --- The seam: production loader + preflight + kaifuu apply ---
        let captured: { command: string; args: string[] } | undefined;
        const seam = await runWholeGamePatchExportAndApply({
          engineProfile: "reallive",
          actor,
          journal: journalRepo,
          patchReport: result.patchReport,
          rawBridge: JSON.parse(readFileSync(bridgePath, "utf8")),
          sourceRoot: "/scratch/fake-source-game",
          targetRoot: join(workDir, "patched-out"),
          translatedBundlePath,
          requestedBy: localUserId,
          loadActiveDecisions: async () => [],
          runProcess: (command, args) => {
            captured = { command, args };
            return { status: 0, stdout: "patched", stderr: "" };
          },
        });

        // The production loader built a real bundle from the PERSISTED outcomes
        // (2 written units), and preflight passed -> the current patch-export bundle.
        expect(seam.patchExportBundle.drafts.map((d) => d.sourceUnitId).sort()).toEqual(
          [UNIT_A, UNIT_B].sort(),
        );
        for (const draft of seam.patchExportBundle.drafts) {
          expect(draft.draftText).toBe(DRAFT);
          // Real canonical outcome id from the persisted journal, not a fixture.
          expect(draft.draftId).toContain("written-outcome:");
        }
        expect(
          seam.patchExportBundle.preflightResults.filter(
            (r) => r.status === "fail" && r.blockingExport,
          ),
        ).toHaveLength(0);

        // The apply step invoked kaifuu patch mirroring run.mjs phase 3.
        const a = captured!.args;
        const patchIdx = a.indexOf("patch");
        expect(a.slice(patchIdx)).toEqual([
          "patch",
          "--engine",
          "reallive",
          "--source",
          "/scratch/fake-source-game",
          "--target",
          join(workDir, "patched-out"),
          "--bundle",
          translatedBundlePath,
          "--scope",
          "dialogue-only",
          "--force",
        ]);
        expect(seam.apply.status).toBe(0);
      } finally {
        await context.close();
      }
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// (3) ENV-GATED real-Sweetie proof — actually apply via the real kaifuu-cli
// ---------------------------------------------------------------------------

describe("runWholeGamePatchExportAndApply (env-gated real-Sweetie byte proof)", () => {
  const realRoot = process.env.ITOTORI_REAL_SWEETIE_ROOT;
  it.skipIf(!realRoot || !process.env.DATABASE_URL)(
    "applies the translated bridge to the real Seen.txt and writes a patched target",
    async () => {
      // This path is only exercised on an operator machine with the real game
      // tree exported (never committed). It re-runs the whole-game localize then
      // the REAL kaifuu-cli patch (no faked runProcess) and asserts a patched
      // REALLIVEDATA/Seen.txt landed under a scratch target.
      const databaseUrl = process.env.DATABASE_URL as string;
      await migrate(databaseUrl);
      const context = createDatabaseContext(databaseUrl);
      const actor: AuthorizationActor = { userId: localUserId };
      try {
        await bootstrapLocalUser(context.db);
        await seedProjectScope(context.pool);

        const workDir = mkdtempSync(join(tmpdir(), "itotori-patch-seam-real-"));
        // Copy the source tree into a pristine read-only-ish source dir under
        // scratch so the test never mutates the operator's export.
        const sourceRoot = join(workDir, "source-game");
        cpSync(realRoot as string, sourceRoot, { recursive: true });
        const targetRoot = join(workDir, "patched-out");

        const bridgePath = join(workDir, "bridge.json");
        const pairPolicyPath = join(workDir, "pair-policy.json");
        const configPath = join(workDir, "localize.config.json");
        writeFileSync(bridgePath, JSON.stringify(makeBridge()));
        writeFileSync(
          pairPolicyPath,
          readFileSync(
            new URL("./fixtures/agentic-loop-smoke-pair-policy.json", import.meta.url),
            "utf8",
          ),
        );
        writeFileSync(
          configPath,
          JSON.stringify({
            schemaVersion: "itotori.localize-fullproject.config.v0",
            projectId: PROJECT_ID,
            localeBranchId: LOCALE_BRANCH_ID,
            sourceRevisionId: REVISION_ID,
            engineProfile: "reallive",
            translationScope: "dialogue-only",
            targetLocale: "en-US",
            bridgePath,
            pairPolicyPath,
            maxRepairAttempts: 0,
          }),
        );

        const runDir = join(workDir, "run");
        mkdirSync(runDir, { recursive: true });
        const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
        const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor });
        const patchSink = new FsDrivenPatchExportSink(runDir);
        const io = {
          readJson: (p: string) => JSON.parse(readFileSync(p, "utf8")) as unknown,
          writeJson: (p: string, v: unknown) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`),
        };
        const { result } = await runLocalizeFullProjectCommand({
          configPath,
          deps: {
            io,
            actor,
            providerFactory: fakeFactory(),
            sinks: { journal, patchExport: patchSink },
            now: deterministicClock(),
          },
        });

        const seam = await runWholeGamePatchExportAndApply({
          engineProfile: "reallive",
          actor,
          journal: journalRepo,
          patchReport: result.patchReport,
          rawBridge: JSON.parse(readFileSync(bridgePath, "utf8")),
          sourceRoot,
          targetRoot,
          translatedBundlePath: join(runDir, "translated-bridge.json"),
          requestedBy: localUserId,
          loadActiveDecisions: async () => [],
          // No faked runProcess -> the REAL kaifuu-cli runs.
        });
        expect(seam.apply.status).toBe(0);
        // A patched Seen.txt landed under the target (byte-correct output).
        expect(existsSync(join(targetRoot, "REALLIVEDATA", "Seen.txt"))).toBe(true);
      } finally {
        await context.close();
      }
    },
    600_000,
  );
});
