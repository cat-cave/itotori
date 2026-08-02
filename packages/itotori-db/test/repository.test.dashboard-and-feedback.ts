import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { eq } from "drizzle-orm";

import { describe, expect, it } from "vitest";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  feedbackContextStatusValues,
  feedbackReportStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  ItotoriFeedbackRepository,
  parseManualFeedbackImportInput,
} from "../src/repositories/feedback-repository.js";
import {
  artifacts,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  localeBranches,
  sourceBundles,
} from "../src/schema.js";

import {
  failedRuntimeEvidenceReportFixture,
  localActor,
  manualFeedbackFixture,
  projectFixture,
  projectFixtureBridgeId,
  projectFixtureUnitId,
  runtimeEvidenceReportFixture,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("reads dashboard pending decisions without inferring across finding sources", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      await repo.recordFinding(localActor, {
        projectId: "project-test",
        finding: {
          findingId: "finding-project-level",
          findingKind: "terminology_consistency",
          severity: "P2",
          qualityCategory: "terminology",
          title: "Project terminology review",
          description: "A glossary-level term needs human confirmation.",
          impact: "All locale branches could drift on a named term.",
          createdAt: "2026-06-17T00:00:00.000Z",
          affectedRefs: [{ subjectKind: "project", subjectId: "project-test" }],
          evidence: [],
          provenance: [],
          causalLinks: [],
        },
      });

      await repo.recordFinding(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        finding: {
          findingId: "finding-locale-branch",
          findingKind: "protected_span_issue",
          severity: "P1",
          qualityCategory: "protected_content",
          title: "Protected span moved",
          description: "A placeholder was not preserved.",
          impact: "Patch output could break runtime substitution.",
          createdAt: "2026-06-17T00:01:00.000Z",
          affectedRefs: [{ subjectKind: "bridge_unit", subjectId: projectFixtureUnitId }],
          evidence: [],
          provenance: [],
          causalLinks: [],
        },
      });

      await repo.saveRuntimeReport(
        localActor,
        project,
        failedRuntimeEvidenceReportFixture({
          runtimeReportId: "019ed003-0000-7000-8000-000000000999",
          createdAt: "2026-06-17T00:02:00.000Z",
          validationFindings: [
            {
              findingId: "019ed003-0000-7000-8000-000000000997",
              findingKind: "text_mismatch",
              severity: "P2",
              bridgeUnitRef: {
                bridgeUnitId: projectFixtureUnitId,
                sourceUnitKey: "hello.scene.001.line.001",
              },
              message: "Observed runtime text differed from the drafted locale branch text.",
              evidenceTier: "E1",
            },
          ],
        }),
        "019ed003-0000-7000-8000-000000000998",
      );

      await expect(repo.getDashboardDecisions()).resolves.toMatchObject({
        projectId: "project-test",
        counts: {
          pendingDecisionCount: 3,
          projectFindingDecisionCount: 1,
          localeBranchFindingDecisionCount: 1,
          runtimeValidationDecisionCount: 1,
        },
        pendingDecisions: [
          {
            decisionKind: "project_finding",
            findingId: "finding-project-level",
            localeBranchId: null,
            targetLocale: null,
            runtimeRunId: null,
          },
          {
            decisionKind: "locale_branch_finding",
            findingId: "finding-locale-branch",
            localeBranchId: "locale-en-us",
            targetLocale: "en-US",
            runtimeRunId: null,
          },
          {
            decisionKind: "runtime_validation",
            findingId: "019ed003-0000-7000-8000-000000000999:019ed003-0000-7000-8000-000000000997",
            localeBranchId: "locale-en-us",
            targetLocale: "en-US",
            runtimeRunId: "019ed003-0000-7000-8000-000000000999",
            runtimeStatus: "failed",
          },
        ],
      });

      const status = await repo.getDashboardStatus();
      expect(status.findingCount).toBe(3);
      expect(status.localeBranches[0]?.openFindingCount).toBe(1);
    } finally {
      await context.close();
    }
  });
  it("imports contextual manual feedback with line, screenshot, save context, and note", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const result = await feedbackRepo.importManualFeedback(localActor, manualFeedbackFixture());

      expect(result).toMatchObject({
        duplicate: false,
        reportCount: 1,
        triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
        reportStatus: feedbackReportStatusValues.open,
        contextStatus: feedbackContextStatusValues.contextualized,
      });

      const report = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.feedbackReportId, result.feedbackReportId))
        .limit(1);
      expect(report[0]).toMatchObject({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        targetLocale: "en-US",
        bridgeUnitId: projectFixtureUnitId,
        feedbackType: feedbackTypeValues.stylePreference,
        reporterRole: "playtester",
        reporterNote: "The protagonist sounds too formal in this line.",
        reportCount: 1,
      });
      expect(report[0]?.lineReference).toMatchObject({
        sourceUnitKey: "hello.scene.001.line.001",
        path: "source.json",
        line: 1,
      });
      expect(report[0]?.attachmentSummary).toMatchObject({
        counts: {
          screenshot: 1,
          save_context: 1,
        },
        artifactIds: ["feedback-screenshot-1"],
      });

      const source = await context.db
        .select()
        .from(feedbackSources)
        .where(eq(feedbackSources.feedbackSourceId, result.feedbackSourceId))
        .limit(1);
      expect(source[0]).toMatchObject({
        projectId: "project-test",
        sourceKind: "manual_playtest",
        label: "Manual playtest fixture",
      });

      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, result.feedbackReportId));
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.attachments).toHaveLength(2);
      expect(evidence[0]?.contextSignals).toMatchObject({
        lineReference: { bridgeUnitId: projectFixtureUnitId },
      });

      const linkedArtifact = await context.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.artifactId, "feedback-screenshot-1"))
        .limit(1);
      expect(linkedArtifact[0]).toMatchObject({
        artifactKind: "feedback_screenshot",
        bridgeUnitId: projectFixtureUnitId,
      });
      expect(linkedArtifact[0]?.metadata).toMatchObject({
        feedbackReportId: result.feedbackReportId,
        feedbackEvidenceId: result.feedbackEvidenceId,
      });

      const importedEvent = await context.db
        .select()
        .from(events)
        .where(eq(events.eventKind, "feedback_report_imported"))
        .limit(1);
      expect(importedEvent[0]?.payload).toMatchObject({
        duplicate: false,
        triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
        reportCount: 1,
      });
    } finally {
      await context.close();
    }
  });
  it("loads persisted correction context for contextual feedback from the imported source bundle", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const result = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          suggestedEdit: "The protagonist speaks naturally here.",
          lineReference: {
            bridgeUnitId: projectFixtureUnitId,
            sourceUnitKey: "hello.scene.001.line.001",
            path: "/private/tmp/source.json",
            line: 1,
            sourceLocation: {
              fileUri: "file:///private/tmp/source.json",
              localPath: "/private/tmp/source.json",
            },
            quotedText: "raw captured line",
          },
          attachments: [
            {
              attachmentKind: "screenshot",
              artifactId: "feedback-private-screenshot",
              uri: "private://captures/formal-tone.png",
              hash: "sha256:private-screenshot",
              caption: "message window with formal protagonist line",
              capturePosition: "hello.scene.001:frame001",
              evidenceTier: "E2",
              metadata: { localPath: "/private/tmp/formal-tone.png" },
            },
            {
              attachmentKind: "save_context",
              contextToken: "fixture-save-before-line",
              routeRef: "hello-route",
              sceneRef: "hello.scene.001",
              uri: "private://saves/formal-tone.sav",
            },
          ],
        }),
      );

      const bundle = await context.db
        .select({ sourceRevisionId: sourceBundles.sourceBundleRevisionId })
        .from(sourceBundles)
        .where(eq(sourceBundles.sourceBundleId, projectFixtureBridgeId))
        .limit(1);
      const correctionContext = await feedbackRepo.loadManualFeedbackCorrectionContext(
        localActor,
        result.feedbackReportId,
        result.feedbackEvidenceId,
      );

      expect(correctionContext).toMatchObject({
        feedbackReportId: result.feedbackReportId,
        feedbackEvidenceId: result.feedbackEvidenceId,
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        sourceRevisionId: bundle[0]?.sourceRevisionId,
        feedbackType: feedbackTypeValues.stylePreference,
        triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
        contextStatus: feedbackContextStatusValues.contextualized,
        reporterNote: "The protagonist sounds too formal in this line.",
        suggestedEdit: "The protagonist speaks naturally here.",
        affectedUnitIds: [projectFixtureUnitId],
      });
      expect(correctionContext).not.toHaveProperty("attachments");
      expect(correctionContext).not.toHaveProperty("context");
    } finally {
      await context.close();
    }
  });
  it("resolves the current branch source revision when a play flag omits sourceBundleId", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const result = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          sourceBundleId: undefined,
          metadata: { sourceRevisionId: "caller-supplied-stale-revision" },
        }),
      );
      const correctionContext = await feedbackRepo.loadManualFeedbackCorrectionContext(
        localActor,
        result.feedbackReportId,
        result.feedbackEvidenceId,
      );
      const [branch] = await context.db
        .select({ sourceRevisionId: sourceBundles.sourceBundleRevisionId })
        .from(localeBranches)
        .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
        .where(eq(localeBranches.localeBranchId, "locale-en-us"))
        .limit(1);

      expect(correctionContext).toMatchObject({
        sourceRevisionId: branch?.sourceRevisionId,
        affectedUnitIds: [projectFixtureUnitId],
      });
      expect(correctionContext?.sourceRevisionId).not.toBe("caller-supplied-stale-revision");
    } finally {
      await context.close();
    }
  });
  it("rejects feedback without a canonical branch and bridge-unit target", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      expect(() =>
        parseManualFeedbackImportInput({
          projectId: "project-test",
          feedbackType: feedbackTypeValues.objectiveDefect,
          reporter: { role: "playtester" },
          reporterNote: "Something looked wrong, but I forgot where.",
          reportedAt: "2026-06-17T00:00:00.000Z",
        }),
      ).toThrow(/localeBranchId must be a non-empty string/);

      expect(() =>
        parseManualFeedbackImportInput({
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          targetLocale: "fr-FR",
          feedbackType: feedbackTypeValues.objectiveDefect,
          reporter: { role: "playtester" },
          reporterNote: "The server must derive this from the branch.",
          lineReference: { bridgeUnitId: projectFixtureUnitId },
        }),
      ).toThrow(/targetLocale is server-owned/i);

      expect(await context.db.select().from(feedbackReports)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
  it("rejects an empty bridge-unit reference instead of parking a screenshot", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      expect(() =>
        parseManualFeedbackImportInput({
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          feedbackType: feedbackTypeValues.objectiveDefect,
          reporter: { role: "playtester" },
          reporterNote: "Something looked wrong in a screenshot, but no location was exported.",
          lineReference: {},
          attachments: [{ attachmentKind: "screenshot" }],
        }),
      ).toThrow(/lineReference\.bridgeUnitId must be a non-empty string/);

      expect(await context.db.select().from(feedbackReports)).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
