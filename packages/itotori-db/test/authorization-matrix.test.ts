import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  permissionValues,
  type AuthorizationActor,
  type Permission,
} from "../src/authorization.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import { ItotoriEventQueueRepository } from "../src/repositories/event-queue-repository.js";
import { ItotoriFeedbackRepository } from "../src/repositories/feedback-repository.js";
import { ItotoriModelLedgerRepository } from "../src/repositories/model-ledger-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import type { DatabaseContext, ItotoriDatabase } from "../src/connection.js";
import { assertDeniedRepositoryMutation } from "./authorization-test-helpers.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

type PermissionKey = keyof typeof permissionValues;

type RepositoryPermissionGateCase = {
  repository: string;
  sourceFile: string;
  mutation: string;
  permissionKey: PermissionKey;
  requiredPermission: Permission;
  successFixture: string;
  denialFixture: string;
  runDeniedMutation: (db: ItotoriDatabase) => Promise<unknown>;
};

const repositoryPermissionGateMatrix = [
  projectGate("reset", "systemReset", "repository.test.ts reset coverage", (repo) =>
    repo.reset(deniedActor),
  ),
  projectGate("importSourceBundle", "projectImport", "repository.test.ts import coverage", (repo) =>
    repo.importSourceBundle(deniedActor, undefined as never),
  ),
  projectGate("saveDrafts", "draftWrite", "repository.test.ts draft persistence coverage", (repo) =>
    repo.saveDrafts(deniedActor, undefined as never),
  ),
  projectGate(
    "savePatchExport",
    "patchExport",
    "repository.test.ts patch export persistence coverage",
    (repo) => repo.savePatchExport(deniedActor, undefined as never, undefined as never),
  ),
  projectGate(
    "saveRuntimeReport",
    "runtimeIngest",
    "repository.test.ts runtime report persistence coverage",
    (repo) =>
      repo.saveRuntimeReport(deniedActor, undefined as never, undefined as never, "patch-result"),
  ),
  projectGate("appendEvent", "runtimeIngest", "repository.test.ts event coverage", (repo) =>
    repo.appendEvent(deniedActor, undefined as never),
  ),
  projectGate("recordFinding", "runtimeIngest", "repository.test.ts finding coverage", (repo) =>
    repo.recordFinding(deniedActor, undefined as never),
  ),
  projectGate("linkArtifact", "runtimeIngest", "repository.test.ts artifact coverage", (repo) =>
    repo.linkArtifact(deniedActor, undefined as never),
  ),
  feedbackGate(
    "importManualFeedback",
    "feedbackImport",
    "repository.test.ts manual feedback coverage",
    (repo) => repo.importManualFeedback(deniedActor, undefined as never),
  ),
  modelLedgerGate(
    "recordProviderRun",
    "runtimeIngest",
    "model-ledger-repository.test.ts provider run coverage",
    (repo) => repo.recordProviderRun(deniedActor, undefined as never),
  ),
  queueGate(
    "appendOutboxEvent",
    "queueManage",
    "event-queue-repository.test.ts outbox event coverage",
    (repo) => repo.appendOutboxEvent(deniedActor, undefined as never),
  ),
  queueGate("enqueueJob", "queueManage", "event-queue-repository.test.ts job coverage", (repo) =>
    repo.enqueueJob(deniedActor, undefined as never),
  ),
  queueGate(
    "appendOutboxEventWithJobs",
    "queueManage",
    "event-queue-repository.test.ts outbox plus jobs coverage",
    (repo) => repo.appendOutboxEventWithJobs(deniedActor, undefined as never),
  ),
  queueGate(
    "claimOutboxEvents",
    "queueManage",
    "event-queue-repository.test.ts outbox claim coverage",
    (repo) => repo.claimOutboxEvents(deniedActor, "worker"),
  ),
  queueGate(
    "markOutboxEventPublished",
    "queueManage",
    "event-queue-repository.test.ts outbox publish coverage",
    (repo) => repo.markOutboxEventPublished(deniedActor, "outbox", "worker"),
  ),
  queueGate(
    "markOutboxEventFailed",
    "queueManage",
    "event-queue-repository.test.ts outbox failure coverage",
    (repo) => repo.markOutboxEventFailed(deniedActor, "outbox", "worker", undefined as never),
  ),
  queueGate(
    "recoverExpiredOutboxLeases",
    "queueManage",
    "event-queue-repository.test.ts outbox lease recovery coverage",
    (repo) => repo.recoverExpiredOutboxLeases(deniedActor),
  ),
  queueGate(
    "claimJobs",
    "queueManage",
    "event-queue-repository.test.ts job claim coverage",
    (repo) => repo.claimJobs(deniedActor, "worker"),
  ),
  queueGate(
    "completeJob",
    "queueManage",
    "event-queue-repository.test.ts job completion coverage",
    (repo) => repo.completeJob(deniedActor, "job", "worker"),
  ),
  queueGate(
    "failJob",
    "queueManage",
    "event-queue-repository.test.ts job failure coverage",
    (repo) => repo.failJob(deniedActor, "job", "worker", undefined as never),
  ),
  queueGate(
    "recoverExpiredJobLeases",
    "queueManage",
    "event-queue-repository.test.ts job lease recovery coverage",
    (repo) => repo.recoverExpiredJobLeases(deniedActor),
  ),
  catalogGate(
    "recordSourceProvenance",
    "catalogWrite",
    "catalog-repository.test.ts source provenance coverage",
    (repo) => repo.recordSourceProvenance(deniedActor, undefined as never),
  ),
  catalogGate("upsertWork", "catalogWrite", "catalog-repository.test.ts work coverage", (repo) =>
    repo.upsertWork(deniedActor, undefined as never),
  ),
  catalogGate(
    "recordLocalScan",
    "catalogWrite",
    "catalog-repository.test.ts local scan coverage",
    (repo) => repo.recordLocalScan(deniedActor, undefined as never),
  ),
  catalogGate(
    "recordSeedTarget",
    "catalogWrite",
    "catalog-repository.test.ts seed target coverage",
    (repo) => repo.recordSeedTarget(deniedActor, undefined as never),
  ),
  catalogGate(
    "getWorkSnapshot",
    "catalogRead",
    "catalog-repository.test.ts work read coverage",
    (repo) => repo.getWorkSnapshot(deniedActor, "work"),
  ),
  catalogGate(
    "getWorkByExternalId",
    "catalogRead",
    "catalog-repository.test.ts external id read coverage",
    (repo) => repo.getWorkByExternalId(deniedActor, undefined as never, "source"),
  ),
  catalogGate(
    "listSeedTargets",
    "catalogRead",
    "catalog-repository.test.ts seed target read coverage",
    (repo) => repo.listSeedTargets(deniedActor),
  ),
  catalogGate(
    "listCatalogCandidateTargetWorks",
    "catalogRead",
    "catalog-repository.test.ts candidate target read coverage",
    (repo) => repo.listCatalogCandidateTargetWorks(deniedActor),
  ),
  catalogGate(
    "recordCatalogCandidateMatch",
    "catalogWrite",
    "catalog-repository.test.ts candidate match coverage",
    (repo) => repo.recordCatalogCandidateMatch(deniedActor, undefined as never),
  ),
  catalogGate(
    "listCatalogCandidateMatches",
    "catalogRead",
    "catalog-repository.test.ts candidate match read coverage",
    (repo) => repo.listCatalogCandidateMatches(deniedActor),
  ),
] as const satisfies readonly RepositoryPermissionGateCase[];

describe("repository permission gate matrix", () => {
  it("names each permission-gated repository/API-adjacent mutation with fixtures", () => {
    expect(
      repositoryPermissionGateMatrix.map(
        ({ repository, mutation, requiredPermission, successFixture, denialFixture }) => ({
          mutation: `${repository}.${mutation}`,
          requiredPermission,
          successFixture,
          denialFixture,
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.reset",
          "requiredPermission": "system.reset",
          "successFixture": "repository.test.ts reset coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.importSourceBundle",
          "requiredPermission": "project.import",
          "successFixture": "repository.test.ts import coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.saveDrafts",
          "requiredPermission": "draft.write",
          "successFixture": "repository.test.ts draft persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.savePatchExport",
          "requiredPermission": "patch.export",
          "successFixture": "repository.test.ts patch export persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.saveRuntimeReport",
          "requiredPermission": "runtime.ingest",
          "successFixture": "repository.test.ts runtime report persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.appendEvent",
          "requiredPermission": "runtime.ingest",
          "successFixture": "repository.test.ts event coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.recordFinding",
          "requiredPermission": "runtime.ingest",
          "successFixture": "repository.test.ts finding coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.linkArtifact",
          "requiredPermission": "runtime.ingest",
          "successFixture": "repository.test.ts artifact coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriFeedbackRepository.importManualFeedback",
          "requiredPermission": "feedback.import",
          "successFixture": "repository.test.ts manual feedback coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelLedgerRepository.recordProviderRun",
          "requiredPermission": "runtime.ingest",
          "successFixture": "model-ledger-repository.test.ts provider run coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.appendOutboxEvent",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox event coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.enqueueJob",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.appendOutboxEventWithJobs",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox plus jobs coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.claimOutboxEvents",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox claim coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.markOutboxEventPublished",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox publish coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.markOutboxEventFailed",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox failure coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.recoverExpiredOutboxLeases",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox lease recovery coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.claimJobs",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job claim coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.completeJob",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job completion coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.failJob",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job failure coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.recoverExpiredJobLeases",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job lease recovery coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.recordSourceProvenance",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts source provenance coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.upsertWork",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts work coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.recordLocalScan",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts local scan coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.recordSeedTarget",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts seed target coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.getWorkSnapshot",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts work read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.getWorkByExternalId",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts external id read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.listSeedTargets",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts seed target read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.listCatalogCandidateTargetWorks",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts candidate target read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.recordCatalogCandidateMatch",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts candidate match coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.listCatalogCandidateMatches",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts candidate match read coverage",
        },
      ]
    `);
  });

  it("matches every repository source permission gate", () => {
    expect(repositoryPermissionGateMatrix.map(sourceGateKey).sort()).toEqual(
      sourcePermissionGates().map(sourceGateKey).sort(),
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("repository permission denial fixtures", () => {
  let context: DatabaseContext | undefined;

  beforeAll(async () => {
    context = await isolatedMigratedContext();
  });

  afterAll(async () => {
    await context?.close();
  });

  it.each(repositoryPermissionGateMatrix)(
    "denies $repository.$mutation without $requiredPermission",
    async ({ requiredPermission, runDeniedMutation }) => {
      await assertDeniedRepositoryMutation({
        actor: deniedActor,
        permission: requiredPermission,
        run: () => runDeniedMutation(requiredContext(context).db),
      });
    },
  );
});

function projectGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriProjectRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriProjectRepository",
    sourceFile: "project-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriProjectRepository(db)),
  });
}

function feedbackGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriFeedbackRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriFeedbackRepository",
    sourceFile: "feedback-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriFeedbackRepository(db)),
  });
}

function modelLedgerGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriModelLedgerRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriModelLedgerRepository",
    sourceFile: "model-ledger-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriModelLedgerRepository(db)),
  });
}

function queueGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriEventQueueRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriEventQueueRepository",
    sourceFile: "event-queue-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriEventQueueRepository(db)),
  });
}

function catalogGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriCatalogRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriCatalogRepository",
    sourceFile: "catalog-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriCatalogRepository(db)),
  });
}

function repositoryGate(
  input: Omit<RepositoryPermissionGateCase, "requiredPermission" | "denialFixture">,
): RepositoryPermissionGateCase {
  return {
    ...input,
    requiredPermission: permissionValues[input.permissionKey],
    denialFixture: `missing permission actor ${deniedActor.userId}`,
  };
}

function sourcePermissionGates(): Pick<
  RepositoryPermissionGateCase,
  "sourceFile" | "mutation" | "permissionKey"
>[] {
  const gates: Pick<RepositoryPermissionGateCase, "sourceFile" | "mutation" | "permissionKey">[] =
    [];
  const repositorySourceDir = new URL("../src/repositories/", import.meta.url);

  for (const sourceFile of readdirSync(repositorySourceDir).filter((file) =>
    file.endsWith(".ts"),
  )) {
    const source = readFileSync(new URL(sourceFile, repositorySourceDir), "utf8");
    let currentMethod: string | undefined;
    for (const line of source.split("\n")) {
      const methodMatch = /^\s{2}async\s+([A-Za-z0-9_]+)\b/u.exec(line);
      if (methodMatch?.[1]) {
        currentMethod = methodMatch[1];
      }

      const permissionMatch =
        /requirePermission\(this\.db,\s*actor,\s*permissionValues\.([A-Za-z0-9_]+)\)/u.exec(line);
      if (permissionMatch?.[1]) {
        if (currentMethod === undefined) {
          throw new Error(`source gate in ${sourceFile} is not inside an async repository method`);
        }
        gates.push({
          sourceFile,
          mutation: currentMethod,
          permissionKey: permissionMatch[1] as PermissionKey,
        });
      }
    }
  }

  return gates;
}

function sourceGateKey({
  sourceFile,
  mutation,
  permissionKey,
}: Pick<RepositoryPermissionGateCase, "sourceFile" | "mutation" | "permissionKey">): string {
  return `${sourceFile}:${mutation}:${permissionKey}`;
}

function requiredContext(context: DatabaseContext | undefined): DatabaseContext {
  if (context === undefined) {
    throw new Error("database context was not initialized");
  }
  return context;
}
