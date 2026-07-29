import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  contentHashForPolicy,
  ItotoriStyleGuideRepository,
} from "../src/repositories/style-guide-repository.js";
import { ItotoriStyleGuideService } from "../src/services/style-guide-service.js";
import {
  artifacts,
  eventOutbox,
  findings,
  localeBranchUnits,
  outboxEventTypeValues,
  styleGuides,
  styleGuideVersions,
  styleGuideVersionStatusValues,
  userPermissionGrants,
  users,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import {
  type StyleGuideFixture,
  type FixtureSubmitCase,
  type FixtureApproveCase,
  styleGuideFixture,
  readMigrationSql,
  projectFixture,
  seedProject,
  seedDraftWriteOnlyUser,
  seedStyleGuideApproverOnlyUser,
  seedUserWithoutPermissions,
  seedAffectedWorkForPriorPolicy,
  outboxEventCount,
  outboxEventCountByType,
  affectedSurface,
  affectedReferences,
  installStyleGuideOutboxFailureTrigger,
  installAffectedWorkOutboxFailureTrigger,
  expectForcedStyleGuideOutboxFailure,
  expectForcedAffectedWorkOutboxFailure,
  errorCauseMessage,
} from "./style-guide-repository.test.shared-01.js";

describe("ItotoriStyleGuideService", () => {
  it("emits StyleGuideVersionChanged payloads and rejects semantic stale/malformed cases", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideService(repository);
      const fixture = styleGuideFixture();

      const created = await service.submitVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.create.styleGuideVersionId,
        expectedPreviousVersionId: fixture.cases.create.expectedPreviousVersionId,
        policy: fixture.cases.create.policy,
      });
      expect(created.status).toBe("created");
      expect(created.outboxEvent?.payload).toMatchObject({
        eventName: "StyleGuideVersionChanged",
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        previousVersionId: null,
        newVersionId: fixture.cases.create.styleGuideVersionId,
        sourceRevisionReference: {
          sourceRevisionId: expect.any(String),
          revisionKind: expect.any(String),
          value: expect.any(String),
        },
      });

      const updated = await service.submitVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.update.styleGuideVersionId,
        expectedPreviousVersionId: fixture.cases.update.expectedPreviousVersionId,
        policy: fixture.cases.update.policy,
      });
      expect(updated).toMatchObject({
        status: "created",
        version: {
          previousVersionId: fixture.cases.create.styleGuideVersionId,
          styleGuideVersionId: fixture.cases.update.styleGuideVersionId,
        },
      });

      const approved = await service.approveVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.approve.styleGuideVersionId,
        expectedLatestVersionId: fixture.cases.approve.expectedLatestVersionId,
      });
      expect(approved).toMatchObject({
        status: "approved",
        version: {
          styleGuideVersionId: fixture.cases.approve.styleGuideVersionId,
          status: styleGuideVersionStatusValues.approved,
        },
      });
      expect(approved.outboxEvent?.payload).toMatchObject({
        eventName: "StyleGuideVersionChanged",
        changeKind: "version_approved",
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        previousVersionId: null,
        newVersionId: fixture.cases.approve.styleGuideVersionId,
        // Fanout-less approval (no prior approved version) is still audit-complete.
        approvalBoundary: {
          approverUserId: localUserId,
          localeBranchId: fixture.localeBranchId,
          priorVersionId: null,
          approvedVersionId: fixture.cases.approve.styleGuideVersionId,
          sourceRevisionBoundary: {
            prior: null,
            approved: { sourceRevisionId: expect.any(String) },
          },
        },
      });

      const stale = await service.approveVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.staleApproval.styleGuideVersionId,
        expectedLatestVersionId: fixture.cases.staleApproval.expectedLatestVersionId,
      });
      expect(stale).toMatchObject({
        status: "invalid",
        diagnostics: [
          expect.objectContaining({
            code: "style_guide.approval.stale_version",
            reasonCode: "stale_approval",
          }),
        ],
      });

      const missing = await service.submitVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.cases.missingLocaleBranch.localeBranchId,
        styleGuideVersionId: fixture.cases.missingLocaleBranch.styleGuideVersionId,
        policy: fixture.cases.create.policy,
      });
      expect(missing).toMatchObject({
        status: "invalid",
        diagnostics: [
          expect.objectContaining({
            code: "style_guide.locale_branch.missing",
            reasonCode: "missing_locale_branch",
          }),
        ],
      });

      const malformed = await service.submitVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.malformedPolicy.styleGuideVersionId,
        policy: fixture.cases.malformedPolicy.policy,
      });
      expect(malformed).toMatchObject({
        status: "invalid",
        diagnostics: [
          expect.objectContaining({
            code: "style_guide.policy_section.malformed",
            reasonCode: "malformed_policy_section",
            field: "$.sections.tone",
          }),
        ],
      });

      const outboxCounts = await context.db.execute(sql`
        select count(*)::int as style_guide_event_count
        from ${eventOutbox}
        where event_type = ${outboxEventTypeValues.styleGuideVersionChanged}
      `);
      expect(outboxCounts.rows[0]).toMatchObject({ style_guide_event_count: 3 });
    } finally {
      await context.close();
    }
  });

  it("approves style guide versions with affected-work invalidation fanout", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideService(repository);
      const fixture = styleGuideFixture();

      const createdV1 = await repository.createVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.create.styleGuideVersionId,
        status: styleGuideVersionStatusValues.approved,
        policy: fixture.cases.create.policy,
      });
      await repository.createVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.update.styleGuideVersionId,
        expectedPreviousVersionId: fixture.cases.update.expectedPreviousVersionId,
        policy: fixture.cases.update.policy,
      });
      await seedAffectedWorkForPriorPolicy(context.db, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        priorStyleGuideVersionId: createdV1.version.styleGuideVersionId,
        currentStyleGuideVersionId: fixture.cases.update.styleGuideVersionId,
      });

      const approved = await service.approveStyleGuideVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
        expectedLatestVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
      });

      expect(approved).toMatchObject({
        status: "approved",
        version: {
          approverUserId: localUserId,
          localeBranchId: fixture.localeBranchId,
          previousVersionId: fixture.outbox.approval.priorStyleGuideVersionId,
          styleGuideVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
        },
        outboxEvent: {
          eventType: outboxEventTypeValues.styleGuideVersionChanged,
        },
      });
      expect(approved.outboxEvent?.payload).toMatchObject({
        changeKind: "version_approved",
        approvalBoundary: {
          approverUserId: localUserId,
          localeBranchId: fixture.localeBranchId,
          priorVersionId: fixture.outbox.approval.priorStyleGuideVersionId,
          approvedVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
          sourceRevisionBoundary: {
            prior: { sourceRevisionId: expect.any(String) },
            approved: { sourceRevisionId: expect.any(String) },
          },
        },
      });
      expect(approved.invalidationOutboxEvents).toHaveLength(4);

      const invalidationRows = await context.db.execute(sql`
        select payload, causation_id, correlation_id
        from ${eventOutbox}
        where event_type = ${outboxEventTypeValues.affectedWorkInvalidated}
        order by payload->'affectedWork'->>'surface'
      `);
      expect(invalidationRows.rows).toHaveLength(4);
      const payloads = invalidationRows.rows.map((row) => row.payload as Record<string, unknown>);
      expect(new Set(payloads.map((payload) => affectedSurface(payload)))).toEqual(
        new Set(fixture.outbox.approval.expectedAffectedSurfaces),
      );
      for (const row of invalidationRows.rows) {
        expect(row.causation_id).toBe(approved.outboxEvent?.outboxEventId);
        expect(row.correlation_id).toBe(approved.outboxEvent?.correlationId);
      }
      for (const payload of payloads) {
        expect(payload).toMatchObject({
          eventName: "AffectedWorkInvalidated",
          projectId: fixture.projectId,
          localeBranchId: fixture.localeBranchId,
          approverUserId: localUserId,
          priorStyleGuideVersionId: fixture.outbox.approval.priorStyleGuideVersionId,
          approvedStyleGuideVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
          sourceRevisionBoundary: {
            prior: createdV1.version.sourceRevisionReference,
            approved: expect.objectContaining({
              sourceRevisionId: expect.any(String),
              revisionKind: expect.any(String),
              value: expect.any(String),
            }),
          },
        });
      }
      expect(affectedReferences(payloads, "drafts")).toEqual([
        expect.objectContaining({
          draftId: "locale-en-us:bridge-unit-test",
          bridgeUnitId: "bridge-unit-test",
        }),
      ]);
      expect(affectedReferences(payloads, "drafts")).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            draftId: "locale-en-us:bridge-unit-current-policy",
            bridgeUnitId: "bridge-unit-current-policy",
          }),
        ]),
      );
      expect(affectedReferences(payloads, "qa_findings")).toEqual([
        expect.objectContaining({ findingId: "finding-old-style-policy" }),
      ]);
      expect(affectedReferences(payloads, "exports")).toEqual([
        expect.objectContaining({ artifactId: "patch-export-old-style-policy" }),
      ]);
      expect(affectedReferences(payloads, "benchmarks")).toEqual([
        expect.objectContaining({ artifactId: "benchmark-old-style-policy" }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("migration 0057 attributes pre-provenance drafts to the approved version so the next approval flags them", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideService(repository);

      const priorVersionId = "sgv-preprov-v1";
      const nextVersionId = "sgv-preprov-v2";

      // V1 approved: this is the version "in force" when the pre-provenance
      // drafts were produced -- exactly what the backfill must attribute to.
      await repository.createVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: priorVersionId,
        status: styleGuideVersionStatusValues.approved,
        policy: { tone: "formal" },
      });
      await repository.createVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: nextVersionId,
        expectedPreviousVersionId: priorVersionId,
        policy: { tone: "casual" },
      });

      // Pre-provenance state: seedProject imported both en-US drafts with target
      // text and NULL provenance. Assert that is the starting condition -- these
      // are exactly the rows the first approval would silently miss.
      const preRows = await context.db.execute(sql`
        select bridge_unit_id, style_guide_version_id
        from ${localeBranchUnits}
        where locale_branch_id = 'locale-en-us' and target_text is not null
        order by bridge_unit_id
      `);
      expect(preRows.rows).toEqual([
        { bridge_unit_id: "bridge-unit-current-policy", style_guide_version_id: null },
        { bridge_unit_id: "bridge-unit-test", style_guide_version_id: null },
      ]);

      // Apply the REAL migration SQL against the seeded pre-provenance rows.
      await context.db.execute(
        sql.raw(readMigrationSql("0057_style_guide_draft_provenance_backfill.sql")),
      );

      // Backfill is deterministic: both drafts now carry the approved version.
      const backfilled = await context.db.execute(sql`
        select bridge_unit_id, style_guide_version_id
        from ${localeBranchUnits}
        where locale_branch_id = 'locale-en-us' and target_text is not null
        order by bridge_unit_id
      `);
      expect(backfilled.rows).toEqual([
        { bridge_unit_id: "bridge-unit-current-policy", style_guide_version_id: priorVersionId },
        { bridge_unit_id: "bridge-unit-test", style_guide_version_id: priorVersionId },
      ]);

      // The first approval after migration flags the once-pre-provenance drafts
      // instead of silently missing them.
      const approved = await service.approveStyleGuideVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: nextVersionId,
        expectedLatestVersionId: nextVersionId,
      });

      const draftRefs = affectedReferences(
        approved.invalidationOutboxEvents.map((event) => event.payload as Record<string, unknown>),
        "drafts",
      );
      expect(draftRefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bridgeUnitId: "bridge-unit-test" }),
          expect.objectContaining({ bridgeUnitId: "bridge-unit-current-policy" }),
        ]),
      );
      expect(draftRefs).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("flags unknown-provenance (NULL) drafts on approval instead of silently missing them", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideService(repository);

      const priorVersionId = "sgv-unknown-v1";
      const nextVersionId = "sgv-unknown-v2";

      await repository.createVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: priorVersionId,
        status: styleGuideVersionStatusValues.approved,
        policy: { tone: "formal" },
      });
      await repository.createVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: nextVersionId,
        expectedPreviousVersionId: priorVersionId,
        policy: { tone: "casual" },
      });

      // One draft has known prior provenance; the other has UNKNOWN provenance
      // (NULL) that no deterministic backfill reached.
      await context.db
        .update(localeBranchUnits)
        .set({ styleGuideVersionId: priorVersionId })
        .where(
          sql`${localeBranchUnits.localeBranchId} = 'locale-en-us'
            and ${localeBranchUnits.bridgeUnitId} = 'bridge-unit-test'`,
        );
      await context.db
        .update(localeBranchUnits)
        .set({ styleGuideVersionId: null })
        .where(
          sql`${localeBranchUnits.localeBranchId} = 'locale-en-us'
            and ${localeBranchUnits.bridgeUnitId} = 'bridge-unit-current-policy'`,
        );

      const approved = await service.approveStyleGuideVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: nextVersionId,
        expectedLatestVersionId: nextVersionId,
      });

      const draftRefs = affectedReferences(
        approved.invalidationOutboxEvents.map((event) => event.payload as Record<string, unknown>),
        "drafts",
      );
      // Both the known-prior draft AND the unknown-provenance draft are flagged.
      expect(draftRefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bridgeUnitId: "bridge-unit-test" }),
          expect.objectContaining({ bridgeUnitId: "bridge-unit-current-policy" }),
        ]),
      );
      expect(draftRefs).toHaveLength(2);
    } finally {
      await context.close();
    }
  });
});
