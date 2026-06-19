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
  styleGuideFixtureFlowSchemaVersion,
  styleGuideSuggestionArtifactSchemaVersion,
} from "../src/services/style-guide-fixture-flow.js";
import { artifacts, eventOutbox, styleGuideVersions } from "../src/schema.js";
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

      const result = await service.run({ transcript });

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

function affectedSurface(payload: Record<string, unknown>): string | null {
  const affectedWork = payload.affectedWork;
  if (affectedWork === null || typeof affectedWork !== "object" || Array.isArray(affectedWork)) {
    return null;
  }
  const surface = (affectedWork as Record<string, unknown>).surface;
  return typeof surface === "string" ? surface : null;
}
