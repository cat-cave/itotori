import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";

import {
  artifacts,
  eventOutbox,
  findings,
  localeBranchUnits,
  userPermissionGrants,
  users,
} from "../src/schema.js";
import { currentProjectFixture } from "./current-project-fixture.js";

const localActor: AuthorizationActor = { userId: localUserId };
const styleGuideProject = currentProjectFixture({
  seed: "style-guide-primary",
  projectId: "project-test",
  localeBranchId: "locale-en-us",
  units: [
    {
      sourceUnitKey: "hello.scene.001.line.001",
      occurrenceId: "occurrence-1",
      sourceText: "こんにちは、{player}。",
      targetText: "Hello, {player}.",
      spans: [{ raw: "{player}" }],
    },
    {
      sourceUnitKey: "hello.scene.001.line.002",
      occurrenceId: "occurrence-2",
      sourceText: "もう行こう。",
      targetText: "We should go now.",
    },
  ],
});
const [priorPolicyUnit, currentPolicyUnit] = styleGuideProject.bridge.units;
if (priorPolicyUnit === undefined || currentPolicyUnit === undefined) {
  throw new Error("style-guide fixture requires two units");
}
export const styleGuideUnitIds = {
  priorPolicy: priorPolicyUnit.bridgeUnitId,
  currentPolicy: currentPolicyUnit.bridgeUnitId,
};
export const orderedStyleGuideUnitIds = [
  styleGuideUnitIds.priorPolicy,
  styleGuideUnitIds.currentPolicy,
].sort();

export type StyleGuideFixture = {
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

export type FixtureSubmitCase = {
  styleGuideVersionId: string;
  policy: Record<string, unknown>;
};

export type FixtureApproveCase = {
  styleGuideVersionId: string;
  expectedLatestVersionId: string;
};

export function styleGuideFixture(): StyleGuideFixture {
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

export function readMigrationSql(file: string): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", file),
    "utf8",
  );
}

export function projectFixture(
  overrides: Partial<ItotoriProjectRecord> = {},
): ItotoriProjectRecord {
  return { ...structuredClone(styleGuideProject), ...overrides };
}

export async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db, testProjectEngineFamilyRegistry);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture());
  await repo.importSourceBundle(
    localActor,
    projectFixture({
      localeBranchId: "locale-fr-fr",
      targetLocale: "fr-FR",
      drafts: { [styleGuideUnitIds.priorPolicy]: "Bonjour, {player}." },
    }),
  );
}

export async function seedDraftWriteOnlyUser(db: ItotoriDatabase, userId: string): Promise<void> {
  await db.insert(users).values({ userId, displayName: "Style guide draft writer" });
  await db.insert(userPermissionGrants).values({
    userId,
    permission: permissionValues.draftWrite,
  });
}

export async function seedStyleGuideApproverOnlyUser(
  db: ItotoriDatabase,
  userId: string,
): Promise<void> {
  await db.insert(users).values({ userId, displayName: "Style guide approver" });
  await db.insert(userPermissionGrants).values({
    userId,
    permission: permissionValues.styleGuideApprove,
  });
}

export async function seedUserWithoutPermissions(
  db: ItotoriDatabase,
  userId: string,
): Promise<void> {
  await db.insert(users).values({ userId, displayName: "Style guide approval denied" });
}

export async function seedAffectedWorkForPriorPolicy(
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
        and ${localeBranchUnits.bridgeUnitId} = ${styleGuideUnitIds.priorPolicy}`,
    );
  await db
    .update(localeBranchUnits)
    .set({ styleGuideVersionId: input.currentStyleGuideVersionId })
    .where(
      sql`${localeBranchUnits.localeBranchId} = ${input.localeBranchId}
        and ${localeBranchUnits.bridgeUnitId} = ${styleGuideUnitIds.currentPolicy}`,
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

export async function outboxEventCount(db: ItotoriDatabase): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as count
    from ${eventOutbox}
  `);
  return Number((rows.rows[0] as { count: number }).count);
}

export async function outboxEventCountByType(
  db: ItotoriDatabase,
  eventType: string,
): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as count
    from ${eventOutbox}
    where event_type = ${eventType}
  `);
  return Number((rows.rows[0] as { count: number }).count);
}

export function affectedSurface(payload: Record<string, unknown>): string | null {
  const affectedWork = payload.affectedWork;
  if (typeof affectedWork !== "object" || affectedWork === null || Array.isArray(affectedWork)) {
    return null;
  }
  const surface = (affectedWork as Record<string, unknown>).surface;
  return typeof surface === "string" ? surface : null;
}

export function affectedReferences(
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

export async function installStyleGuideOutboxFailureTrigger(db: ItotoriDatabase): Promise<void> {
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

export async function installAffectedWorkOutboxFailureTrigger(db: ItotoriDatabase): Promise<void> {
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

export async function expectForcedStyleGuideOutboxFailure(
  promise: Promise<unknown>,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(errorCauseMessage(error)).toContain("forced style guide outbox failure");
    return;
  }
  throw new Error("expected style guide outbox append to fail");
}

export async function expectForcedAffectedWorkOutboxFailure(
  promise: Promise<unknown>,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(errorCauseMessage(error)).toContain("forced affected work outbox failure");
    return;
  }
  throw new Error("expected affected work outbox append to fail");
}

export function errorCauseMessage(error: unknown): string | null {
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
