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
  eventOutbox,
  outboxEventTypeValues,
  styleGuides,
  styleGuideVersions,
  styleGuideVersionStatusValues,
  userPermissionGrants,
  users,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

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
      await expect(
        service.submitVersion(draftActor, {
          projectId: fixture.projectId,
          localeBranchId: "locale-fr-fr",
          styleGuideVersionId: "style-guide-version-rollback",
          expectedPreviousVersionId: null,
          policy: fixture.cases.create.policy,
        }),
      ).rejects.toThrow(/forced style guide outbox failure/);

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
        projectId: fixture.projectId,
        localeBranchId: fixture.localeBranchId,
        previousVersionId: null,
        newVersionId: fixture.cases.approve.styleGuideVersionId,
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
});

type StyleGuideFixture = {
  schemaVersion: string;
  projectId: string;
  localeBranchId: string;
  cases: {
    create: FixtureSubmitCase & { expectedPreviousVersionId: string | null };
    update: FixtureSubmitCase & { expectedPreviousVersionId: string | null };
    approve: FixtureApproveCase;
    staleApproval: FixtureApproveCase;
    missingLocaleBranch: { localeBranchId: string; styleGuideVersionId: string };
    malformedPolicy: FixtureSubmitCase;
  };
};

type FixtureSubmitCase = {
  styleGuideVersionId: string;
  policy: Record<string, unknown>;
};

type FixtureApproveCase = {
  styleGuideVersionId: string;
  expectedLatestVersionId: string;
};

function styleGuideFixture(): StyleGuideFixture {
  return JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "fixtures",
        "itotori-style-guide",
        "locale-branch-style-guide.json",
      ),
      "utf8",
    ),
  ) as StyleGuideFixture;
}

function projectFixture(overrides: Partial<ItotoriProjectRecord> = {}): ItotoriProjectRecord {
  const project: ItotoriProjectRecord = {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: { "bridge-unit-test": "Hello, {player}." },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-test",
      sourceBundleHash: "hash-test",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  };
  return { ...project, ...overrides };
}

async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture());
  await repo.importSourceBundle(
    localActor,
    projectFixture({
      localeBranchId: "locale-fr-fr",
      targetLocale: "fr-FR",
      drafts: { "bridge-unit-test": "Bonjour, {player}." },
    }),
  );
}

async function seedDraftWriteOnlyUser(db: ItotoriDatabase, userId: string): Promise<void> {
  await db.insert(users).values({ userId, displayName: "Style guide draft writer" });
  await db.insert(userPermissionGrants).values({
    userId,
    permission: permissionValues.draftWrite,
  });
}

async function installStyleGuideOutboxFailureTrigger(db: ItotoriDatabase): Promise<void> {
  await db.execute(sql`
    create or replace function itotori_fail_style_guide_outbox()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.event_type = 'style_guide_version_changed' then
        raise exception 'forced style guide outbox failure';
      end if;
      return new;
    end;
    $$;
  `);
  await db.execute(sql`
    create trigger itotori_fail_style_guide_outbox
    before insert on ${eventOutbox}
    for each row
    execute function itotori_fail_style_guide_outbox();
  `);
}
