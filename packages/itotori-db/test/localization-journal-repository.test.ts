import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  asNonBlankTargetText,
  type SpeakerLabel,
  type WrittenUnitOutcome,
} from "@itotori/localization-bridge-schema";
import { AuthorizationError, localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriLocalizationJournalRepository,
  type PersistLocalizationJournalAttemptInput,
} from "../src/repositories/localization-journal-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

const scope = {
  projectId: "project-localization-journal",
  localeBranchId: "locale-branch-localization-journal",
  sourceRevisionId: "source-revision-localization-journal",
  targetLocale: "en-US",
} as const;

describe("ItotoriLocalizationJournalRepository", () => {
  it("persists N physical attempts and a lossless written-outcome provenance projection", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const run = await repository.createRun(localActor, {
        runId: "journal-run-roundtrip",
        ...scope,
        createdAt: "2026-07-11T10:00:00.000Z",
      });
      expect(run).toMatchObject({ runId: "journal-run-roundtrip", ...scope });

      const attempts = attemptsFixture(run.runId, "raw-bridge-unit-1");
      // Failure-safe persistence happens before the terminal outcome. Repeating
      // the exact batch is idempotent rather than duplicating provider calls.
      expect(
        await repository.persistAttempts(localActor, {
          runId: run.runId,
          bridgeUnitId: "raw-bridge-unit-1",
          attempts,
        }),
      ).toHaveLength(3);

      const saved = await repository.persistUnit(localActor, {
        runId: run.runId,
        bridgeUnitId: "raw-bridge-unit-1",
        sourceUnitKey: "scene.001.line.001",
        outcome: outcomeFixture(),
        attempts,
        contextPacket: {
          structuredContext: { scene: "roof", relationship: "friends" },
          artifactRefs: ["scene:roof:v3"],
        },
        contextRefs: [
          {
            refKind: "context-artifact",
            refId: "scene:roof",
            versionRef: "scene:roof:v3",
            details: { category: "scene-summary" },
          },
          { refKind: "context-version", refId: "character:aya", versionRef: "aya:v7" },
        ],
        speakerLabels: [speakerLabelFixture("raw-bridge-unit-1")],
        qaDetails: {
          "finding-tone-1": {
            recommendation: "Use the established formal register.",
            agentRationale: "Aya speaks formally in the resolved scene context.",
            evidenceRefs: ["scene:roof:v3", "style:formal"],
            sourceSpan: { start: 0, end: 3 },
            draftSpan: { start: 0, end: 5 },
          },
        },
      });

      expect(saved.outcome.selectedCandidateId).toBe("candidate-repair");
      expect(saved.contextRefs).toHaveLength(2);
      expect(saved.speakerLabels).toEqual([speakerLabelFixture("raw-bridge-unit-1")]);

      const loadedAttempts = await repository.loadAttemptsForRun(localActor, run.runId);
      expect(loadedAttempts).toHaveLength(3);
      // This is deliberately beyond the old integer-micros precision. No
      // Number/toFixed/micros conversion occurs on either write or read.
      expect(
        loadedAttempts.find((attempt) => attempt.attemptId === "provider-run-context")?.costUsd,
      ).toBe("0.00000000000000000002");
      expect(loadedAttempts.map((attempt) => attempt.attemptId)).toEqual(
        expect.arrayContaining([
          "provider-run-context",
          "provider-run-primary",
          "provider-run-repair",
        ]),
      );
      expect(
        loadedAttempts.find((attempt) => attempt.attemptId === "provider-run-primary"),
      ).toMatchObject({ validationResult: "schema_invalid", retryDecision: "retry" });

      const loaded = await repository.loadRunOutcomes(localActor, run.runId);
      expect(loaded).toHaveLength(1);
      const outcome = loaded[0]!;
      expect(outcome.bridgeUnitId).toBe("raw-bridge-unit-1");
      expect(outcome.sourceUnitKey).toBe("scene.001.line.001");
      expect(outcome.outcome.candidates).toEqual(outcomeFixture().candidates);
      expect(outcome.outcome.findings).toEqual(outcomeFixture().findings);
      expect(outcome.outcome.qualityFlags).toEqual(["qa_unresolved", "repair_used"]);
      expect(outcome.outcome.provenance).toEqual({ origin: "agentic-loop", selected: "repair" });
      expect(outcome.contextPacket).toEqual({
        structuredContext: { scene: "roof", relationship: "friends" },
        artifactRefs: ["scene:roof:v3"],
      });
      expect(outcome.contextRefs).toEqual([
        {
          refKind: "context-artifact",
          refId: "scene:roof",
          versionRef: "scene:roof:v3",
          details: { category: "scene-summary" },
        },
        {
          refKind: "context-version",
          refId: "character:aya",
          versionRef: "aya:v7",
          details: null,
        },
      ]);
      expect(outcome.speakerLabels).toEqual([speakerLabelFixture("raw-bridge-unit-1")]);
      expect(outcome.qaDetails).toEqual({
        "finding-tone-1": {
          recommendation: "Use the established formal register.",
          agentRationale: "Aya speaks formally in the resolved scene context.",
          evidenceRefs: ["scene:roof:v3", "style:formal"],
          sourceSpan: { start: 0, end: 3 },
          draftSpan: { start: 0, end: 5 },
        },
      });

      // Candidate attempt ids are real provider-run ids and resolve through
      // the actual FK-backed physical attempts, not a legacy attempt table.
      expect(outcome.outcome.candidates.map((candidate) => candidate.attemptId)).toEqual([
        "provider-run-primary",
        "provider-run-repair",
      ]);
    } finally {
      await context.close();
    }
  });

  it("allows canonical outcome/candidate ids to recur in a later run without overwriting history", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const first = await repository.createRun(localActor, { runId: "journal-run-one", ...scope });
      const second = await repository.createRun(localActor, { runId: "journal-run-two", ...scope });

      await repository.persistUnit(localActor, unitInput(first.runId, "raw-bridge-unit-1", "one"));
      await repository.persistUnit(localActor, unitInput(second.runId, "raw-bridge-unit-1", "two"));

      const [firstOutcome] = await repository.loadRunOutcomes(localActor, first.runId);
      const [secondOutcome] = await repository.loadRunOutcomes(localActor, second.runId);
      expect(firstOutcome?.outcome.id).toBe(secondOutcome?.outcome.id);
      expect(firstOutcome?.outcome.candidates.map((candidate) => candidate.id)).toEqual(
        secondOutcome?.outcome.candidates.map((candidate) => candidate.id),
      );
      expect(firstOutcome?.journalOutcomeId).not.toBe(secondOutcome?.journalOutcomeId);
      expect(await repository.loadAttemptsForRun(localActor, first.runId)).toHaveLength(3);
      expect(await repository.loadAttemptsForRun(localActor, second.runId)).toHaveLength(3);
    } finally {
      await context.close();
    }
  });

  it("keeps provider/parser failures durable when no written outcome exists and rejects candidate provenance gaps", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const run = await repository.createRun(localActor, {
        runId: "journal-run-failure",
        ...scope,
      });
      const failureAttempt: PersistLocalizationJournalAttemptInput = {
        ...attemptsFixture(run.runId, "raw-bridge-unit-failure")[0]!,
        attemptId: "provider-run-parser-failure",
        providerRunId: "provider-run-parser-failure",
        logicalCallId: "parser-failure-logical-call",
        validationResult: "semantic_invalid",
        failureClass: "ParserFailure",
        retryDecision: "pause",
        errorClasses: ["ParserFailure"],
      };

      await repository.persistAttempts(localActor, {
        runId: run.runId,
        bridgeUnitId: "raw-bridge-unit-failure",
        attempts: [failureAttempt],
      });
      await repository.persistAttempts(localActor, {
        runId: run.runId,
        bridgeUnitId: "raw-bridge-unit-failure",
        attempts: [failureAttempt],
      });
      expect(await repository.loadAttemptsForRun(localActor, run.runId)).toHaveLength(1);
      expect(await repository.loadRunOutcomes(localActor, run.runId)).toEqual([]);

      const brokenOutcome = outcomeFixture("raw-bridge-unit-failure");
      brokenOutcome.candidates[0] = {
        ...brokenOutcome.candidates[0]!,
        attemptId: "provider-run-not-supplied",
      };
      await expect(
        repository.persistUnit(localActor, {
          runId: run.runId,
          bridgeUnitId: "raw-bridge-unit-failure",
          outcome: brokenOutcome,
          attempts: [failureAttempt],
          contextPacket: { preserved: true },
          contextRefs: [],
          speakerLabels: [],
          qaDetails: {
            "finding-tone-1": {
              recommendation: "Use the established formal register.",
              agentRationale: "QA evidence remains durable.",
              evidenceRefs: ["style:formal"],
            },
          },
        }),
      ).rejects.toMatchObject({
        name: "LocalizationJournalRepositoryError",
        code: "candidate_attempt_missing",
      });
    } finally {
      await context.close();
    }
  });

  it("enforces the draft.write/catalog.read authorization split", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      await expect(
        repository.createRun(deniedActor, { runId: "denied", ...scope }),
      ).rejects.toMatchObject(new AuthorizationError(deniedActor, "draft.write"));

      const run = await repository.createRun(localActor, { runId: "journal-run-auth", ...scope });
      const attempts = attemptsFixture(run.runId, "raw-bridge-unit-auth");
      await expect(
        repository.persistAttempts(deniedActor, {
          runId: run.runId,
          bridgeUnitId: "raw-bridge-unit-auth",
          attempts,
        }),
      ).rejects.toMatchObject(new AuthorizationError(deniedActor, "draft.write"));
      await expect(repository.loadRun(deniedActor, run.runId)).rejects.toMatchObject(
        new AuthorizationError(deniedActor, "catalog.read"),
      );
      await expect(repository.loadRunOutcomes(deniedActor, run.runId)).rejects.toMatchObject(
        new AuthorizationError(deniedActor, "catalog.read"),
      );
      await expect(repository.loadAttemptsForRun(deniedActor, run.runId)).rejects.toMatchObject(
        new AuthorizationError(deniedActor, "catalog.read"),
      );
    } finally {
      await context.close();
    }
  });
});

function unitInput(
  runId: string,
  bridgeUnitId: string,
  suffix: string,
): Parameters<ItotoriLocalizationJournalRepository["persistUnit"]>[1] {
  const attempts = attemptsFixture(runId, bridgeUnitId, suffix);
  return {
    runId,
    bridgeUnitId,
    outcome: outcomeFixture(bridgeUnitId, suffix),
    attempts,
    contextPacket: { run: suffix },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {
      "finding-tone-1": {
        recommendation: "Use the established formal register.",
        agentRationale: "QA evidence remains durable.",
        evidenceRefs: ["style:formal"],
      },
    },
  };
}

function attemptsFixture(
  runId: string,
  bridgeUnitId: string,
  suffix = "",
): PersistLocalizationJournalAttemptInput[] {
  const id = (base: string) => `${base}${suffix.length > 0 ? `-${suffix}` : ""}`;
  return [
    {
      attemptId: id("provider-run-context"),
      runId,
      bridgeUnitId,
      stage: "context",
      agentLabel: "scene-summary",
      logicalCallId: id("logical-context"),
      attemptIndex: 1,
      modelId: "model-context",
      providerId: "provider-a",
      providerRunId: id("provider-run-context"),
      costUsd: "0.00000000000000000002",
      tokensIn: 12,
      tokensOut: 8,
      zdr: true,
      finishState: "stop",
      refusalState: null,
      validationResult: "accepted",
      failureClass: null,
      retryDecision: "advance",
      retryDelayMs: null,
      artifactRef: `provider-run:${id("provider-run-context")}`,
      errorClasses: [],
      startedAt: "2026-07-11T10:01:00.000Z",
      completedAt: "2026-07-11T10:01:01.000Z",
    },
    {
      attemptId: id("provider-run-primary"),
      runId,
      bridgeUnitId,
      stage: "translation",
      agentLabel: "translator",
      logicalCallId: id("logical-translation"),
      attemptIndex: 1,
      modelId: "model-translate",
      providerId: "provider-a",
      providerRunId: id("provider-run-primary"),
      costUsd: "0.00000602",
      tokensIn: 21,
      tokensOut: 9,
      zdr: true,
      finishState: "stop",
      refusalState: null,
      validationResult: "schema_invalid",
      failureClass: "schema_validation",
      retryDecision: "retry",
      retryDelayMs: 25,
      artifactRef: `provider-run:${id("provider-run-primary")}`,
      errorClasses: ["schema_validation"],
      startedAt: "2026-07-11T10:02:00.000Z",
      completedAt: "2026-07-11T10:02:01.000Z",
    },
    {
      attemptId: id("provider-run-repair"),
      runId,
      bridgeUnitId,
      stage: "repair",
      agentLabel: "repair-translator",
      logicalCallId: id("logical-repair"),
      attemptIndex: 1,
      modelId: "model-repair",
      providerId: "provider-b",
      providerRunId: id("provider-run-repair"),
      costUsd: "0.00000000000000000003",
      tokensIn: 25,
      tokensOut: 10,
      zdr: true,
      finishState: "stop",
      refusalState: null,
      validationResult: "accepted",
      failureClass: null,
      retryDecision: "write",
      retryDelayMs: null,
      artifactRef: `provider-run:${id("provider-run-repair")}`,
      errorClasses: [],
      startedAt: "2026-07-11T10:03:00.000Z",
      completedAt: "2026-07-11T10:03:01.000Z",
    },
  ];
}

function outcomeFixture(bridgeUnitId = "raw-bridge-unit-1", suffix = ""): WrittenUnitOutcome {
  const providerRun = (base: string) => `${base}${suffix.length > 0 ? `-${suffix}` : ""}`;
  return {
    id: "written-outcome-deterministic",
    status: "written",
    unitId: bridgeUnitId,
    targetLocale: scope.targetLocale,
    selectedCandidateId: "candidate-repair",
    candidates: [
      {
        id: "candidate-primary",
        outcomeId: "written-outcome-deterministic",
        body: asNonBlankTargetText("Good evening."),
        producedBy: { modelId: "model-translate", providerId: "provider-a" },
        attemptId: providerRun("provider-run-primary"),
        kind: "primary",
      },
      {
        id: "candidate-repair",
        outcomeId: "written-outcome-deterministic",
        body: asNonBlankTargetText("Good evening, Aya."),
        producedBy: { modelId: "model-repair", providerId: "provider-b" },
        attemptId: providerRun("provider-run-repair"),
        kind: "repair",
      },
    ],
    findings: [
      {
        id: "finding-tone-1",
        outcomeId: "written-outcome-deterministic",
        candidateId: "candidate-repair",
        severity: "minor",
        category: "tone",
        note: "Register should remain formal.",
        contested: true,
        confidence: 0.75,
      },
    ],
    qualityFlags: ["qa_unresolved", "repair_used"],
    provenance: { origin: "agentic-loop", selected: "repair" },
    writtenAt: "2026-07-11T10:03:01.000Z",
  };
}

function speakerLabelFixture(bridgeUnitId: string): SpeakerLabel {
  return {
    bridgeUnitId,
    speakerId: { kind: "named", characterId: "aya", displayName: "Aya" },
    confidence: "high",
    evidenceRefs: ["scene:roof:v3", "character:aya:v7"],
    agentRationale: "The preceding named line and character card identify Aya.",
  };
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-localization-journal', 'Localization Journal Workspace')
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      ${scope.projectId}, 'workspace-localization-journal', 'localization-journal',
      'Localization Journal Project', 'ja-JP', 'imported'
    )
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${scope.sourceRevisionId}, ${scope.projectId}, 'bridge_revision', 'journal-v1')
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'source-bundle-localization-journal', ${scope.projectId}, ${scope.sourceRevisionId},
      'bridge-localization-journal', '0.2.0', 'hash:journal', 'ja-JP',
      'fixture-extractor', '1.0.0', 0, 0
    )
  `);
  await context.db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      ${scope.localeBranchId}, ${scope.projectId}, 'source-bundle-localization-journal',
      ${scope.targetLocale}, 'Journal branch', 'active'
    )
  `);
}
