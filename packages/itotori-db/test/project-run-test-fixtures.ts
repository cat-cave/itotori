import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { type DatabaseContext } from "../src/connection.js";
import { ItotoriLlmSnapshotRepository } from "../src/repositories/llm-snapshot-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import {
  ItotoriProjectRunRepository,
  type ProjectRunLease,
} from "../src/repositories/project-run-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

export const actor: AuthorizationActor = { userId: localUserId };

export type RunFixture = Awaited<ReturnType<typeof runFixture>>;
export type RunBranch = Pick<RunFixture, "localeBranchId" | "snapshots">;

export async function runFixture(suffix: string) {
  const context = await isolatedMigratedContext();
  const projectId = `project-run-${suffix}`;
  const localeBranchId = `branch-run-${suffix}`;
  const projects = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
  await projects.ensureRunProjectScope(actor, {
    projectId,
    localeBranchId,
    sourceRevisionId: `revision-run-${suffix}`,
    targetLocale: "en-US",
    sourceLocale: "ja-JP",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/fixture/source",
    buildRoot: "/fixture/build",
    extractProfile: { fixture: suffix },
  });
  const snapshots = await snapshotPair(context, localeBranchId);
  return {
    context,
    suffix,
    projectId,
    localeBranchId,
    snapshots,
    runs: new ItotoriProjectRunRepository(context.db),
  };
}

export async function addRunBranch(fixture: RunFixture, suffix: string): Promise<RunBranch> {
  const localeBranchId = `branch-run-${suffix}`;
  const projects = new ItotoriProjectRepository(
    fixture.context.db,
    testProjectEngineFamilyRegistry,
  );
  await projects.ensureRunProjectScope(actor, {
    projectId: fixture.projectId,
    localeBranchId,
    sourceRevisionId: `revision-run-${fixture.suffix}`,
    targetLocale: "fr-FR",
    sourceLocale: "ja-JP",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/fixture/source",
    buildRoot: "/fixture/build",
    extractProfile: { fixture: suffix },
  });
  return { localeBranchId, snapshots: await snapshotPair(fixture.context, localeBranchId) };
}

export function runInput(
  fixture: RunFixture,
  runId: string,
  capMicrosUsd: number,
  branch: RunBranch = fixture,
) {
  return {
    projectId: fixture.projectId,
    runId,
    localeBranchId: branch.localeBranchId,
    contextSnapshotId: branch.snapshots.contextSnapshotId,
    localizationSnapshotId: branch.snapshots.localizationSnapshotId,
    capMicrosUsd,
  };
}

export function leaseInput(
  fixture: Awaited<ReturnType<typeof runFixture>>,
  runId: string,
  leaseOwnerId: string,
) {
  return { projectId: fixture.projectId, runId, leaseOwnerId, leaseDurationSeconds: 60 };
}

export function progressInput(
  lease: ProjectRunLease,
  bridgeUnitId: string,
  role: string,
  status: "decoded" | "drafted" | "QA" | "accepted" | "patched",
  costMicrosUsd: number,
  coveragePercent: number,
  blockers?: string[],
) {
  return {
    lease,
    bridgeUnitId,
    role,
    status,
    costMicrosUsd,
    coveragePercent,
    ...(blockers === undefined ? {} : { blockers }),
  };
}

async function snapshotPair(context: DatabaseContext, localeBranchId: string) {
  const snapshots = new ItotoriLlmSnapshotRepository(context.pool);
  const contextSnapshot = await snapshots.putContext({
    sourceLanguage: "ja-JP",
    decode: revision("a"),
    sourceUnits: [{ unitId: "unit-source", sourceHash: hash("b") }],
    facts: [{ factId: "unit:unit-source", playOrderIndex: 0, routeScope: { kind: "global" } }],
    structure: revision("c"),
    routeGraph: revision("d"),
    glossary: revision("e"),
    style: revision("f"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("0"),
    externalSources: null,
    contextScope: "whole-game",
  });
  const localizationSnapshot = await snapshots.putLocalization({
    contextSnapshotId: contextSnapshot.snapshotId,
    targetLocale: "en-US",
    localeBranchId,
    acceptedBibleHead: null,
    acceptedTargetOutputHead: null,
  });
  return {
    contextSnapshotId: contextSnapshot.snapshotId,
    localizationSnapshotId: localizationSnapshot.snapshotId,
  };
}

function revision(character: string) {
  return { revisionId: `revision-${character}`, contentHash: hash(character) };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
