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
      ).rejects.toThrow(/missing permission draft\.write/);

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
  outbox: {
    approval: {
      priorStyleGuideVersionId: string;
      approvedStyleGuideVersionId: string;
      expectedAffectedSurfaces: string[];
    };
    rejection: FixtureApproveCase & { expectedDiagnosticCode: string };
    staleApproval: FixtureApproveCase & { expectedDiagnosticCode: string };
    rollback: FixtureApproveCase & { forcedEventType: string };
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
    drafts: {
      "bridge-unit-test": "Hello, {player}.",
      "bridge-unit-current-policy": "We should go now.",
    },
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
        {
          bridgeUnitId: "bridge-unit-current-policy",
          sourceUnitKey: "hello.scene.001.line.002",
          occurrenceId: "occurrence-2",
          sourceHash: "source-hash-current-policy",
          sourceLocale: "ja-JP",
          sourceText: "もう行こう。",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.002",
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

async function seedUserWithoutPermissions(db: ItotoriDatabase, userId: string): Promise<void> {
  await db.insert(users).values({ userId, displayName: "Style guide approval denied" });
}

async function seedAffectedWorkForPriorPolicy(
  db: ItotoriDatabase,
  input: {
    projectId: string;
    localeBranchId: string;
    priorStyleGuideVersionId: string;
    currentStyleGuideVersionId: string;
  },
): Promise<void> {
  await db
    .update(localeBranchUnits)
    .set({ styleGuideVersionId: input.priorStyleGuideVersionId })
    .where(
      sql`${localeBranchUnits.localeBranchId} = ${input.localeBranchId}
        and ${localeBranchUnits.bridgeUnitId} = 'bridge-unit-test'`,
    );
  await db
    .update(localeBranchUnits)
    .set({ styleGuideVersionId: input.currentStyleGuideVersionId })
    .where(
      sql`${localeBranchUnits.localeBranchId} = ${input.localeBranchId}
        and ${localeBranchUnits.bridgeUnitId} = 'bridge-unit-current-policy'`,
    );

  await db.insert(findings).values([
    {
      findingId: "finding-old-style-policy",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      findingKind: "style_guide_violation",
      severity: "medium",
      qualityCategory: "style",
      title: "Old style policy finding",
      description: "Finding tied to the prior style-guide version.",
      impact: "Draft review must be rerun against the newly approved style guide.",
      status: "open",
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      affectedRefs: [],
      evidence: [
        {
          provenanceKind: "style_guide",
          styleGuideVersionId: input.priorStyleGuideVersionId,
        },
      ],
      provenance: [],
      causalLinks: [],
    },
    {
      findingId: "finding-resolved-old-style-policy",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      findingKind: "style_guide_violation",
      severity: "low",
      qualityCategory: "style",
      title: "Resolved old style policy finding",
      description: "Resolved finding should not be invalidated again.",
      impact: "No open affected work remains.",
      status: "resolved",
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      affectedRefs: [],
      evidence: [
        {
          provenanceKind: "style_guide",
          styleGuideVersionId: input.priorStyleGuideVersionId,
        },
      ],
      provenance: [],
      causalLinks: [],
    },
  ]);

  await db.insert(artifacts).values([
    {
      artifactId: "patch-export-old-style-policy",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      artifactKind: "patch_export",
      metadata: {
        styleGuideVersionId: input.priorStyleGuideVersionId,
      },
    },
    {
      artifactId: "patch-export-current-style-policy",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      artifactKind: "patch_export",
      metadata: {
        styleGuideVersionId: "style-guide-version-current-not-invalidated",
      },
    },
    {
      artifactId: "benchmark-old-style-policy",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      artifactKind: "benchmark_report",
      metadata: {
        styleGuideVersionId: input.priorStyleGuideVersionId,
      },
    },
  ]);
}

async function outboxEventCount(db: ItotoriDatabase): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as count
    from ${eventOutbox}
  `);
  return Number((rows.rows[0] as { count: number }).count);
}

async function outboxEventCountByType(db: ItotoriDatabase, eventType: string): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as count
    from ${eventOutbox}
    where event_type = ${eventType}
  `);
  return Number((rows.rows[0] as { count: number }).count);
}

function affectedSurface(payload: Record<string, unknown>): string | null {
  const affectedWork = payload.affectedWork;
  if (typeof affectedWork !== "object" || affectedWork === null || Array.isArray(affectedWork)) {
    return null;
  }
  const surface = (affectedWork as Record<string, unknown>).surface;
  return typeof surface === "string" ? surface : null;
}

function affectedReferences(
  payloads: Record<string, unknown>[],
  surface: string,
): Record<string, unknown>[] {
  const payload = payloads.find((entry) => affectedSurface(entry) === surface);
  if (payload === undefined) {
    return [];
  }
  const affectedWork = payload.affectedWork as Record<string, unknown>;
  return Array.isArray(affectedWork.references)
    ? (affectedWork.references as Record<string, unknown>[])
    : [];
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

async function installAffectedWorkOutboxFailureTrigger(db: ItotoriDatabase): Promise<void> {
  await db.execute(sql`
    create or replace function itotori_fail_affected_work_outbox()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.event_type = 'affected_work_invalidated' then
        raise exception 'forced affected work outbox failure';
      end if;
      return new;
    end;
    $$;
  `);
  await db.execute(sql`
    create trigger itotori_fail_affected_work_outbox
    before insert on ${eventOutbox}
    for each row
    execute function itotori_fail_affected_work_outbox();
  `);
}

async function expectForcedStyleGuideOutboxFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(errorCauseMessage(error)).toContain("forced style guide outbox failure");
    return;
  }
  throw new Error("expected style guide outbox append to fail");
}

async function expectForcedAffectedWorkOutboxFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(errorCauseMessage(error)).toContain("forced affected work outbox failure");
    return;
  }
  throw new Error("expected affected work outbox append to fail");
}

function errorCauseMessage(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return cause.message;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return null;
}
