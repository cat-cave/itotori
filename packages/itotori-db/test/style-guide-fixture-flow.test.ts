import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bootstrapLocalUser, localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { ItotoriStyleGuideRepository } from "../src/repositories/style-guide-repository.js";
import {
  ItotoriStyleGuideFixtureFlowService,
  StyleGuideFixtureFlowRerunError,
  StyleGuideFixtureSeedWorkError,
  styleGuideFixtureFlowRerunRejectedCode,
  styleGuideFixtureFlowSchemaVersion,
  styleGuideSuggestionArtifactSchemaVersion,
  type StyleGuideFixtureSeedWork,
} from "../src/services/style-guide-fixture-flow.js";
import {
  artifacts,
  eventOutbox,
  localeBranchUnits,
  sourceUnits,
  styleGuideVersions,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriStyleGuideFixtureFlowService", () => {
  it("persists the recorded conversational style-guide flow through real DB repositories", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      const projectRepository = new ItotoriProjectRepository(context.db);
      const styleGuideRepository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideFixtureFlowService(
        projectRepository,
        styleGuideRepository,
        localActor,
      );
      const transcript = styleGuideConversationFixture();
      const seedWork = styleGuideFixtureSeedWork();

      const result = await service.run({ transcript, seedWork });

      expect(result).toMatchObject({
        schemaVersion: styleGuideFixtureFlowSchemaVersion,
        fixtureId: "style-guide-conversation-accepted",
        projectId: "019ed063-0000-7000-8000-000000000001",
        localeBranchId: "019ed063-0000-7000-8000-000000000010",
        baseStyleGuideVersionId: "019ed063-0000-7000-8000-000000000020",
        projectedStyleGuideVersionId: "019ed063-0000-7000-8000-000000000030",
        suggestionArtifactId: "style-guide-suggestions:style-guide-conversation-accepted",
        policyRuleCounts: {
          tone: 1,
          terminology: 1,
          honorifics: 1,
          formatting: 1,
          protectedSpans: 1,
        },
        dashboard: {
          selectedLocaleBranchId: "019ed063-0000-7000-8000-000000000010",
          currentStyleGuidePolicyVersionId: "019ed063-0000-7000-8000-000000000030",
          branchCount: 1,
          artifactCount: 3,
        },
      });
      expect(result.acceptedProposalIds).toEqual([
        "019ed063-0000-7000-8000-000000000201",
        "019ed063-0000-7000-8000-000000000202",
        "019ed063-0000-7000-8000-000000000203",
        "019ed063-0000-7000-8000-000000000204",
        "019ed063-0000-7000-8000-000000000205",
      ]);
      expect(result.outbox.styleGuideVersionChangedEventIds).toHaveLength(4);
      expect(new Set(result.outbox.affectedSurfaces)).toEqual(
        new Set(["drafts", "qa_findings", "exports", "benchmarks"]),
      );
      expect(result.outbox.affectedWorkInvalidatedEventIds).toHaveLength(4);

      const persistedVersions = await context.db
        .select()
        .from(styleGuideVersions)
        .orderBy(styleGuideVersions.versionSequence);
      expect(persistedVersions.map((version) => version.styleGuideVersionId)).toEqual([
        "019ed063-0000-7000-8000-000000000020",
        "019ed063-0000-7000-8000-000000000030",
      ]);
      expect(persistedVersions[0]).toMatchObject({
        status: "superseded",
        approverUserId: localUserId,
      });
      expect(persistedVersions[1]).toMatchObject({
        status: "approved",
        previousVersionId: "019ed063-0000-7000-8000-000000000020",
        approverUserId: localUserId,
      });
      expect(persistedVersions[1]?.policy).toMatchObject({
        schemaVersion: "style-guide-policy.v0",
        sections: {
          tone: [
            expect.objectContaining({
              ruleId: "tone-player-address-warm-direct",
            }),
          ],
          protectedSpans: [
            expect.objectContaining({
              ruleId: "protected-placeholder-exact",
            }),
          ],
        },
      });

      const suggestionArtifacts = await context.db
        .select()
        .from(artifacts)
        .where(sql`${artifacts.artifactKind} = 'style_guide_suggestions'`);
      expect(suggestionArtifacts).toHaveLength(1);
      expect(suggestionArtifacts[0]).toMatchObject({
        artifactId: "style-guide-suggestions:style-guide-conversation-accepted",
        localeBranchId: "019ed063-0000-7000-8000-000000000010",
      });
      expect(suggestionArtifacts[0]?.metadata).toMatchObject({
        schemaVersion: styleGuideSuggestionArtifactSchemaVersion,
        acceptedProposalIds: result.acceptedProposalIds,
        projectedStyleGuideVersionId: "019ed063-0000-7000-8000-000000000030",
        transcript: {
          transcriptId: "style-guide-conversation-accepted",
          recordingMode: "public_fixture",
        },
      });

      const invalidationRows = await context.db.execute(sql`
        select payload
        from ${eventOutbox}
        where event_type = 'affected_work_invalidated'
        order by payload->'affectedWork'->>'surface'
      `);
      expect(invalidationRows.rows).toHaveLength(4);
      expect(
        invalidationRows.rows.map((row) =>
          affectedSurface((row as { payload: Record<string, unknown> }).payload),
        ),
      ).toEqual(["benchmarks", "drafts", "exports", "qa_findings"]);
    } finally {
      await context.close();
    }
  });

  it("rejects a rerun with a typed diagnostic and leaves no partial-duplicated state", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      const projectRepository = new ItotoriProjectRepository(context.db);
      const styleGuideRepository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideFixtureFlowService(
        projectRepository,
        styleGuideRepository,
        localActor,
      );
      const transcript = styleGuideConversationFixture();
      const seedWork = styleGuideFixtureSeedWork();

      // First run seeds the deterministic version chain.
      await service.run({ transcript, seedWork });

      // Snapshot every table the flow mutates so we can prove the rejected
      // rerun performs NO write (no duplicate versions/artifacts/outbox events).
      const snapshot = async () => ({
        versions: (
          await context.db
            .select()
            .from(styleGuideVersions)
            .orderBy(styleGuideVersions.versionSequence)
        ).map((version) => ({
          styleGuideVersionId: version.styleGuideVersionId,
          status: version.status,
          versionSequence: version.versionSequence,
        })),
        artifactCount: (await context.db.select().from(artifacts)).length,
        outboxCount: (await context.db.select().from(eventOutbox)).length,
      });
      const before = await snapshot();

      // Second run: seed-once flow must reject BEFORE mutating anything.
      await expect(service.run({ transcript, seedWork })).rejects.toBeInstanceOf(
        StyleGuideFixtureFlowRerunError,
      );
      let rerunError: StyleGuideFixtureFlowRerunError | undefined;
      try {
        await service.run({ transcript, seedWork });
      } catch (error) {
        rerunError = error as StyleGuideFixtureFlowRerunError;
      }
      expect(rerunError).toBeInstanceOf(StyleGuideFixtureFlowRerunError);
      expect(rerunError?.code).toBe(styleGuideFixtureFlowRerunRejectedCode);
      expect(rerunError?.detail).toMatchObject({
        projectId: "019ed063-0000-7000-8000-000000000001",
        localeBranchId: "019ed063-0000-7000-8000-000000000010",
        fixtureId: "style-guide-conversation-accepted",
        existingLatestVersionId: "019ed063-0000-7000-8000-000000000030",
      });

      // No partial-duplicated state: every mutated table is byte-for-byte
      // unchanged after the two rejected reruns.
      const after = await snapshot();
      expect(after).toEqual(before);
      expect(after.versions.map((version) => version.styleGuideVersionId)).toEqual([
        "019ed063-0000-7000-8000-000000000020",
        "019ed063-0000-7000-8000-000000000030",
      ]);

      // Invalidation outbox stays coherent + auditable: exactly the four
      // affected-work events from the single successful seed, none orphaned or
      // duplicated by the rejected reruns.
      const invalidationRows = await context.db.execute(sql`
        select payload
        from ${eventOutbox}
        where event_type = 'affected_work_invalidated'
        order by payload->'affectedWork'->>'surface'
      `);
      expect(invalidationRows.rows).toHaveLength(4);
      expect(
        invalidationRows.rows.map((row) =>
          affectedSurface((row as { payload: Record<string, unknown> }).payload),
        ),
      ).toEqual(["benchmarks", "drafts", "exports", "qa_findings"]);
    } finally {
      await context.close();
    }
  });

  it("replays the fixture flow from recorded seed-work DATA: editing seed text changes persisted output, not service code", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      const projectRepository = new ItotoriProjectRepository(context.db);
      const styleGuideRepository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideFixtureFlowService(
        projectRepository,
        styleGuideRepository,
        localActor,
      );
      const transcript = styleGuideConversationFixture();
      // DATA edit: change the first bridge source text + draft text. This is a
      // pure data change (the service code is untouched) and must flow through
      // to the persisted source unit + draft rows. The protected-span byte
      // range is updated to stay coherent with the new source text.
      const seedWork = styleGuideFixtureSeedWork();
      const editedSeedWork: StyleGuideFixtureSeedWork = {
        ...seedWork,
        bridge: {
          ...seedWork.bridge,
          units: seedWork.bridge.units.map((unit, index) =>
            index === 0
              ? {
                  ...unit,
                  sourceText: "Greetings, {player}.",
                  protectedSpans: [
                    {
                      kind: "placeholder",
                      raw: "{player}",
                      start: 11,
                      end: 19,
                      preserveMode: "exact",
                    },
                  ],
                  draft: "Hello again, {player}.",
                }
              : unit,
          ),
        },
      };

      await service.run({ transcript, seedWork: editedSeedWork });

      const persistedSource = await context.db
        .select({ bridgeUnitId: sourceUnits.bridgeUnitId, sourceText: sourceUnits.sourceText })
        .from(sourceUnits)
        .orderBy(sourceUnits.sourceUnitKey);
      expect(persistedSource.map((unit) => unit.sourceText)).toEqual([
        "Greetings, {player}.",
        "We should go now.",
      ]);

      const persistedDrafts = await context.db
        .select({
          bridgeUnitId: localeBranchUnits.bridgeUnitId,
          targetText: localeBranchUnits.targetText,
        })
        .from(localeBranchUnits)
        .orderBy(localeBranchUnits.bridgeUnitId);
      expect(persistedDrafts.map((draft) => draft.targetText)).toEqual([
        "Hello again, {player}.",
        "We should go now.",
      ]);
    } finally {
      await context.close();
    }
  });

  it("rejects seed work that is incoherent with the transcript before any write", async () => {
    const context = await isolatedMigratedContext();
    try {
      await bootstrapLocalUser(context.db);
      const projectRepository = new ItotoriProjectRepository(context.db);
      const styleGuideRepository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideFixtureFlowService(
        projectRepository,
        styleGuideRepository,
        localActor,
      );
      const transcript = styleGuideConversationFixture();
      const seedWork = styleGuideFixtureSeedWork();
      // Point provenance at a different locale branch -> incoherent with transcript.
      const incoherent: StyleGuideFixtureSeedWork = {
        ...seedWork,
        finding: {
          ...seedWork.finding,
          provenance: seedWork.finding.provenance.map((entry) =>
            entry.provenanceKind === "style_guide"
              ? { ...entry, styleGuideId: "style-guide:019ed063-0000-7000-8000-000000000099" }
              : entry,
          ),
        },
      };

      await expect(service.run({ transcript, seedWork: incoherent })).rejects.toBeInstanceOf(
        StyleGuideFixtureSeedWorkError,
      );
      // No partial state: nothing persisted by the rejected run.
      expect((await context.db.select().from(styleGuideVersions)).length).toBe(0);
      expect((await context.db.select().from(artifacts)).length).toBe(0);
    } finally {
      await context.close();
    }
  });
});

function styleGuideConversationFixture(): unknown {
  return JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "fixtures",
        "itotori-style-guide",
        "conversations",
        "accepted.json",
      ),
      "utf8",
    ),
  );
}

function styleGuideFixtureSeedWork(): StyleGuideFixtureSeedWork {
  return JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "fixtures",
        "itotori-style-guide",
        "seed-work.json",
      ),
      "utf8",
    ),
  );
}

function affectedSurface(payload: Record<string, unknown>): string | null {
  const affectedWork = payload.affectedWork;
  if (affectedWork === null || typeof affectedWork !== "object" || Array.isArray(affectedWork)) {
    return null;
  }
  const surface = (affectedWork as Record<string, unknown>).surface;
  return typeof surface === "string" ? surface : null;
}
