import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";

import {
  contentHashForPolicy,
  ItotoriStyleGuideRepository,
} from "../src/repositories/style-guide-repository.js";
import { ItotoriStyleGuideService } from "../src/services/style-guide-service.js";
import {
  outboxEventTypeValues,
  styleGuides,
  styleGuideVersions,
  styleGuideVersionStatusValues,
  userPermissionGrants,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import {
  styleGuideFixture,
  seedProject,
  seedDraftWriteOnlyUser,
  installStyleGuideOutboxFailureTrigger,
  expectForcedStyleGuideOutboxFailure,
} from "./style-guide-repository.test.support.js";

describe("ItotoriStyleGuideRepository", () => {
  it("persists locale-branch keyed versions with stable ordering and no branch fallback", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const fixture = styleGuideFixture();

      const createdV1 = await repository.createVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.create.styleGuideVersionId,
        policy: fixture.cases.create.policy,
      });
      const createdV2 = await repository.createVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.update.styleGuideVersionId,
        status: styleGuideVersionStatusValues.approved,
        contentHash: "sha256:fixture-approved-version",
        policy: fixture.cases.update.policy,
      });
      const v1 = createdV1.version;
      const v2 = createdV2.version;

      expect(v1).toMatchObject({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: "style-guide-version-en-us-001",
        authorUserId: localUserId,
        status: styleGuideVersionStatusValues.draft,
        versionSequence: 1,
        contentHash: contentHashForPolicy(fixture.cases.create.policy),
      });
      expect(v2).toMatchObject({
        previousVersionId: "style-guide-version-en-us-001",
        status: styleGuideVersionStatusValues.approved,
        versionSequence: 2,
        contentHash: "sha256:fixture-approved-version",
      });

      const rows = await context.db
        .select()
        .from(styleGuideVersions)
        .where(eq(styleGuideVersions.localeBranchId, fixture.localeBranchId));
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: "style-guide-version-en-us-002",
        authorUserId: localUserId,
        status: styleGuideVersionStatusValues.approved,
        contentHash: "sha256:fixture-approved-version",
      });

      await expect(
        repository.listVersionsByLocaleBranchId(fixture.localeBranchId),
      ).resolves.toEqual([
        expect.objectContaining({
          styleGuideVersionId: v1.styleGuideVersionId,
          versionSequence: 1,
        }),
        expect.objectContaining({
          styleGuideVersionId: v2.styleGuideVersionId,
          versionSequence: 2,
        }),
      ]);
      await expect(repository.getLatestVersionByLocaleBranchId("locale-fr-fr")).resolves.toBeNull();
      await expect(
        repository.getApprovedVersionByLocaleBranchId("locale-fr-fr"),
      ).resolves.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("rejects stale direct repository approval inside the approval transaction", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const fixture = styleGuideFixture();

      const createdV1 = await repository.createVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.create.styleGuideVersionId,
        policy: fixture.cases.create.policy,
      });
      const createdV2 = await repository.createVersion(localActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: fixture.cases.update.styleGuideVersionId,
        policy: fixture.cases.update.policy,
      });

      await expect(
        repository.approveVersion(localActor, {
          projectId: fixture.projectId,
          localeBranchId: fixture.localeBranchId,
          styleGuideVersionId: createdV1.version.styleGuideVersionId,
          expectedLatestVersionId: createdV1.version.styleGuideVersionId,
        }),
      ).rejects.toThrow(/expected latest version/);

      await expect(
        repository.getLatestVersionByLocaleBranchId(fixture.localeBranchId),
      ).resolves.toMatchObject({
        styleGuideVersionId: createdV2.version.styleGuideVersionId,
        status: styleGuideVersionStatusValues.draft,
      });
      await expect(
        repository.getApprovedVersionByLocaleBranchId(fixture.localeBranchId),
      ).resolves.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("commits versions and outbox events atomically for draft-write-only actors", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const draftActor: AuthorizationActor = { userId: "style-guide-draft-only-user" };
      await seedDraftWriteOnlyUser(context.db, draftActor.userId);
      const repository = new ItotoriStyleGuideRepository(context.db);
      const service = new ItotoriStyleGuideService(repository);
      const fixture = styleGuideFixture();

      const created = await service.submitVersion(draftActor, {
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        styleGuideVersionId: "style-guide-version-draft-only",
        expectedPreviousVersionId: null,
        policy: fixture.cases.create.policy,
      });
      expect(created).toMatchObject({
        status: "created",
        version: {
          styleGuideVersionId: "style-guide-version-draft-only",
          authorUserId: draftActor.userId,
        },
        outboxEvent: {
          eventType: outboxEventTypeValues.styleGuideVersionChanged,
        },
      });

      const draftActorPermissions = await context.db
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.userId, draftActor.userId));
      expect(draftActorPermissions.map((entry) => entry.permission).sort()).toEqual([
        permissionValues.draftWrite,
      ]);

      await installStyleGuideOutboxFailureTrigger(context.db);
      await expectForcedStyleGuideOutboxFailure(
        service.submitVersion(draftActor, {
          projectId: fixture.projectId,
          localeBranchId: "locale-fr-fr",
          styleGuideVersionId: "style-guide-version-rollback",
          expectedPreviousVersionId: null,
          policy: fixture.cases.create.policy,
        }),
      );

      const rollbackVersions = await context.db
        .select()
        .from(styleGuideVersions)
        .where(eq(styleGuideVersions.styleGuideVersionId, "style-guide-version-rollback"));
      expect(rollbackVersions).toHaveLength(0);
      const rolledBackGuide = await context.db
        .select()
        .from(styleGuides)
        .where(eq(styleGuides.localeBranchId, "locale-fr-fr"));
      expect(rolledBackGuide).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
