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
  it("saveDrafts persists style_guide_version_id equal to the in-force approved style-guide version", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );

      const approvedVersionId = "sgv-normal-write-v1";
      // Approve V1: the style-guide version "in force" at draft-write time. This
      // is what a normal saveDrafts write must stamp onto every draft it writes.
      await repository.createVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: approvedVersionId,
        status: styleGuideVersionStatusValues.approved,
        policy: { tone: "formal" },
      });

      // Normal repository write path -- NOT a manual UPDATE and NOT
      // importSourceBundle (which leaves provenance NULL, the pre-provenance case).
      await projectRepository.saveDrafts(localActor, projectFixture());

      const rows = await context.db.execute(sql`
        select bridge_unit_id, style_guide_version_id
        from ${localeBranchUnits}
        where locale_branch_id = 'locale-en-us' and target_text is not null
        order by bridge_unit_id
      `);
      // Every normally-written draft carries the in-force approved provenance.
      expect(rows.rows).toEqual([
        {
          bridge_unit_id: "bridge-unit-current-policy",
          style_guide_version_id: approvedVersionId,
        },
        { bridge_unit_id: "bridge-unit-test", style_guide_version_id: approvedVersionId },
      ]);
    } finally {
      await context.close();
    }
  });

  it("targets saveDrafts-written drafts on the matching approval and excludes them once their normal-write provenance predates the approval prior", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideService(repository);
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );

      const v1 = "sgv-normal-invalidation-v1";
      const v2 = "sgv-normal-invalidation-v2";
      const v3 = "sgv-normal-invalidation-v3";

      // V1 approved (in force). saveDrafts then stamps the drafts with V1 via the
      // normal write path -- no manual provenance seeding anywhere in this test.
      await repository.createVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: v1,
        status: styleGuideVersionStatusValues.approved,
        policy: { tone: "formal" },
      });
      await projectRepository.saveDrafts(localActor, projectFixture());

      // Provenance sanity: it came from the normal write, not a seeded row.
      const stamped = await context.db.execute(sql`
        select bridge_unit_id, style_guide_version_id
        from ${localeBranchUnits}
        where locale_branch_id = 'locale-en-us' and target_text is not null
        order by bridge_unit_id
      `);
      expect(stamped.rows).toEqual([
        { bridge_unit_id: "bridge-unit-current-policy", style_guide_version_id: v1 },
        { bridge_unit_id: "bridge-unit-test", style_guide_version_id: v1 },
      ]);

      // Approve V2 (prior = V1): the normally-written drafts (provenance V1) are
      // targeted by approval invalidation.
      await repository.createVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: v2,
        expectedPreviousVersionId: v1,
        policy: { tone: "casual" },
      });
      const approvedV2 = await service.approveStyleGuideVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: v2,
        expectedLatestVersionId: v2,
      });
      const flaggedV2 = affectedReferences(
        approvedV2.invalidationOutboxEvents.map(
          (event) => event.payload as Record<string, unknown>,
        ),
        "drafts",
      );
      expect(flaggedV2).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bridgeUnitId: "bridge-unit-test" }),
          expect.objectContaining({ bridgeUnitId: "bridge-unit-current-policy" }),
        ]),
      );
      expect(flaggedV2).toHaveLength(2);

      // The drafts are NOT re-saved, so their normal-write provenance stays V1.
      // Approve V3 (prior = V2): the drafts predate the prior version and must
      // NOT be flagged. A NULL-provenance draft would be over-flagged here, so
      // this is the mutation-check for the saveDrafts stamping.
      await repository.createVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: v3,
        expectedPreviousVersionId: v2,
        policy: { tone: "playful" },
      });
      const approvedV3 = await service.approveStyleGuideVersion(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: v3,
        expectedLatestVersionId: v3,
      });
      const flaggedV3 = affectedReferences(
        approvedV3.invalidationOutboxEvents.map(
          (event) => event.payload as Record<string, unknown>,
        ),
        "drafts",
      );
      expect(flaggedV3).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("rejects unauthorized, stale, missing-branch, and rejected approvals before writing events", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideService(repository);
      const fixture = styleGuideFixture();
      const deniedActor: AuthorizationActor = { userId: "style-guide-approval-denied" };
      await seedUserWithoutPermissions(context.db, deniedActor.userId);

      await repository.createVersion(localActor, {
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
      const outboxCountBeforeFailures = await outboxEventCount(context.db);

      await expect(
        service.approveStyleGuideVersion(deniedActor, {
          projectId: fixture.projectId,
          localeBranchId: fixture.localeBranchId,
          styleGuideVersionId: fixture.cases.approve.styleGuideVersionId,
          expectedLatestVersionId: fixture.cases.approve.expectedLatestVersionId,
        }),
      ).rejects.toThrow(/missing permission style_guide\.approve/);

      const stale = await service.approveStyleGuideVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.outbox.staleApproval.styleGuideVersionId,
        expectedLatestVersionId: fixture.outbox.staleApproval.expectedLatestVersionId,
      });
      expect(stale).toMatchObject({
        status: "invalid",
        diagnostics: [
          expect.objectContaining({ code: fixture.outbox.staleApproval.expectedDiagnosticCode }),
        ],
      });

      const rejected = await service.approveStyleGuideVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.outbox.rejection.styleGuideVersionId,
        expectedLatestVersionId: fixture.outbox.rejection.expectedLatestVersionId,
      });
      expect(rejected).toMatchObject({
        status: "invalid",
        diagnostics: [
          expect.objectContaining({ code: fixture.outbox.rejection.expectedDiagnosticCode }),
        ],
      });

      const missing = await service.approveStyleGuideVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.cases.missingLocaleBranch.localeBranchId,
        styleGuideVersionId: fixture.cases.missingLocaleBranch.styleGuideVersionId,
        expectedLatestVersionId: fixture.cases.missingLocaleBranch.styleGuideVersionId,
      });
      expect(missing).toMatchObject({
        status: "invalid",
        diagnostics: [expect.objectContaining({ code: "style_guide.locale_branch.missing" })],
      });

      await expect(outboxEventCount(context.db)).resolves.toBe(outboxCountBeforeFailures);
    } finally {
      await context.close();
    }
  });

  it("requires the dedicated style_guide.approve permission and fails closed before reading state", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideService(repository);
      const fixture = styleGuideFixture();

      const draftWriteOnlyActor: AuthorizationActor = { userId: "style-guide-draft-write-only" };
      await seedDraftWriteOnlyUser(context.db, draftWriteOnlyActor.userId);
      const approverOnlyActor: AuthorizationActor = { userId: "style-guide-approver-only" };
      await seedStyleGuideApproverOnlyUser(context.db, approverOnlyActor.userId);
      const deniedActor: AuthorizationActor = { userId: "style-guide-no-permissions" };
      await seedUserWithoutPermissions(context.db, deniedActor.userId);

      await repository.createVersion(localActor, {
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
      const outboxCountBeforeApproval = await outboxEventCount(context.db);

      // draft.write alone no longer authorizes approval -- it needs the
      // dedicated style_guide.approve permission.
      await expect(
        service.approveStyleGuideVersion(draftWriteOnlyActor, {
          projectId: fixture.projectId,
          localeBranchId: fixture.localeBranchId,
          styleGuideVersionId: fixture.cases.approve.styleGuideVersionId,
          expectedLatestVersionId: fixture.cases.approve.expectedLatestVersionId,
        }),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        actor: draftWriteOnlyActor,
        permission: permissionValues.styleGuideApprove,
      });

      // Fail-closed: an unauthorized caller that passes a STALE version is
      // denied by the authorization check BEFORE any branch/version state is
      // read, so the service never returns a stale/branch diagnostic that would
      // leak latest-version state to the caller.
      await expect(
        service.approveStyleGuideVersion(deniedActor, {
          projectId: fixture.projectId,
          localeBranchId: fixture.localeBranchId,
          styleGuideVersionId: fixture.outbox.staleApproval.styleGuideVersionId,
          expectedLatestVersionId: fixture.outbox.staleApproval.expectedLatestVersionId,
        }),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        actor: deniedActor,
        permission: permissionValues.styleGuideApprove,
      });

      // No approval read or write happened for either denied caller.
      await expect(outboxEventCount(context.db)).resolves.toBe(outboxCountBeforeApproval);

      // The dedicated permission (and only it) authorizes a successful approval.
      const approverPermissions = await context.db
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.userId, approverOnlyActor.userId));
      expect(approverPermissions.map((entry) => entry.permission).sort()).toEqual([
        permissionValues.styleGuideApprove,
      ]);

      const approved = await service.approveStyleGuideVersion(approverOnlyActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
        expectedLatestVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
      });
      expect(approved).toMatchObject({
        status: "approved",
        version: {
          approverUserId: approverOnlyActor.userId,
          styleGuideVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
        },
      });
      await expect(
        repository.getApprovedVersionByLocaleBranchId(fixture.localeBranchId),
      ).resolves.toMatchObject({
        styleGuideVersionId: fixture.outbox.approval.approvedStyleGuideVersionId,
        status: styleGuideVersionStatusValues.approved,
      });
    } finally {
      await context.close();
    }
  });

  it("rolls back approval state and all approval outbox writes when invalidation fanout fails", async () => {
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

      await installAffectedWorkOutboxFailureTrigger(context.db);
      await expectForcedAffectedWorkOutboxFailure(
        service.approveStyleGuideVersion(localActor, {
          projectId: fixture.projectId,
          localeBranchId: fixture.localeBranchId,
          styleGuideVersionId: fixture.outbox.rollback.styleGuideVersionId,
          expectedLatestVersionId: fixture.outbox.rollback.expectedLatestVersionId,
        }),
      );

      await expect(
        repository.getApprovedVersionByLocaleBranchId(fixture.localeBranchId),
      ).resolves.toMatchObject({
        styleGuideVersionId: fixture.outbox.approval.priorStyleGuideVersionId,
        status: styleGuideVersionStatusValues.approved,
      });
      await expect(
        repository.getLatestVersionByLocaleBranchId(fixture.localeBranchId),
      ).resolves.toMatchObject({
        styleGuideVersionId: fixture.outbox.rollback.styleGuideVersionId,
        status: styleGuideVersionStatusValues.draft,
        approverUserId: null,
        approvedAt: null,
      });
      await expect(
        outboxEventCountByType(context.db, outboxEventTypeValues.affectedWorkInvalidated),
      ).resolves.toBe(0);
      const approvedChangeRows = await context.db.execute(sql`
        select count(*)::int as count
        from ${eventOutbox}
        where event_type = ${outboxEventTypeValues.styleGuideVersionChanged}
          and payload->>'changeKind' = 'version_approved'
      `);
      expect(approvedChangeRows.rows[0]).toMatchObject({ count: 0 });
    } finally {
      await context.close();
    }
  });
});
