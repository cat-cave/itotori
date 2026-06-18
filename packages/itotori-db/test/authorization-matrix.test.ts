import { readdirSync, readFileSync } from "node:fs";
import * as ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  permissionValues,
  type AuthorizationActor,
  type Permission,
} from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
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
  catalogCrawlerGate(
    "getCheckpoint",
    "catalogRead",
    "catalog-crawler-repository.test.ts checkpoint read coverage",
    (repo) => repo.getCheckpoint(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "startCrawlerJob",
    "catalogWrite",
    "catalog-crawler-repository.test.ts crawler job start coverage",
    (repo) => repo.startCrawlerJob(deniedActor, "worker", undefined as never),
  ),
  catalogCrawlerGate(
    "recordFetchedStep",
    "catalogWrite",
    "catalog-crawler-repository.test.ts fetched step coverage",
    (repo) => repo.recordFetchedStep(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "commitStepImport",
    "catalogWrite",
    "catalog-crawler-repository.test.ts atomic step commit coverage",
    (repo) => repo.commitStepImport(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "markStepImported",
    "catalogWrite",
    "catalog-crawler-repository.test.ts imported marker coverage",
    (repo) => repo.markStepImported(deniedActor, "step", "worker"),
  ),
  catalogCrawlerGate(
    "markStepFailed",
    "catalogWrite",
    "catalog-crawler-repository.test.ts failed marker coverage",
    (repo) => repo.markStepFailed(deniedActor, "step", new Error("failed"), "worker"),
  ),
  catalogCrawlerGate(
    "saveCheckpoint",
    "catalogWrite",
    "catalog-crawler-repository.test.ts checkpoint write coverage",
    (repo) => repo.saveCheckpoint(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "saveRateLimit",
    "catalogWrite",
    "catalog-crawler-repository.test.ts rate-limit write coverage",
    (repo) => repo.saveRateLimit(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "completeCrawlerJob",
    "catalogWrite",
    "catalog-crawler-repository.test.ts crawler job completion coverage",
    (repo) => repo.completeCrawlerJob(deniedActor, "job", "worker", null),
  ),
  catalogCrawlerGate(
    "failCrawlerJob",
    "catalogWrite",
    "catalog-crawler-repository.test.ts crawler job failure coverage",
    (repo) => repo.failCrawlerJob(deniedActor, "job", "worker", new Error("failed")),
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
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.getCheckpoint",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-crawler-repository.test.ts checkpoint read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.startCrawlerJob",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts crawler job start coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.recordFetchedStep",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts fetched step coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.commitStepImport",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts atomic step commit coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.markStepImported",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts imported marker coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.markStepFailed",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts failed marker coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.saveCheckpoint",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts checkpoint write coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.saveRateLimit",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts rate-limit write coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.completeCrawlerJob",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts crawler job completion coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.failCrawlerJob",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts crawler job failure coverage",
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

function catalogCrawlerGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriCatalogCrawlerRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriCatalogCrawlerRepository",
    sourceFile: "catalog-crawler-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriCatalogCrawlerRepository(db)),
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
    const sourceUrl = new URL(sourceFile, repositorySourceDir);
    const source = readFileSync(sourceUrl, "utf8");
    const parsedSource = ts.createSourceFile(
      sourceUrl.pathname,
      source,
      ts.ScriptTarget.Latest,
      true,
    );

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        callExpressionName(node.expression) === "requirePermission"
      ) {
        const gateAnnotation = repositoryGateAnnotation(source, parsedSource, node);
        const permissionKey = permissionKeyFromRepositoryCall(node, gateAnnotation);
        const sourceMethod = enclosingRepositoryMethod(node);
        if (sourceMethod === undefined && gateAnnotation === undefined) {
          throw new Error(
            `repository permission call at ${sourceLocation(parsedSource, node)} must be inside a repository method or declare @repository-permission-gate <Repository>.<mutation> <permissionKey>`,
          );
        }
        gates.push({
          sourceFile,
          mutation: gateAnnotation?.mutation ?? requiredSourceMethod(sourceMethod).method,
          permissionKey,
        });
      }

      ts.forEachChild(node, visit);
    }

    visit(parsedSource);
  }

  return gates;
}

type RepositorySourceMethod = {
  repository: string;
  method: string;
};

type RepositoryGateAnnotation = {
  repository: string;
  mutation: string;
  permissionKey: PermissionKey;
};

function permissionKeyFromRepositoryCall(
  node: ts.CallExpression,
  annotation: RepositoryGateAnnotation | undefined,
): PermissionKey {
  const permissionArgument = node.arguments[2];
  const permissionKey =
    permissionArgument !== undefined && ts.isPropertyAccessExpression(permissionArgument)
      ? permissionArgument.name.text
      : undefined;

  if (permissionKey === undefined && annotation !== undefined) {
    return annotation.permissionKey;
  }
  if (permissionKey === undefined) {
    throw new Error(
      `repository permission call at ${sourceLocation(node.getSourceFile(), node)} must use permissionValues.<key> or declare @repository-permission-gate`,
    );
  }
  if (annotation !== undefined && annotation.permissionKey !== permissionKey) {
    throw new Error(
      `repository permission annotation at ${sourceLocation(node.getSourceFile(), node)} names ${annotation.permissionKey}, but the call uses ${permissionKey}`,
    );
  }
  return permissionKey as PermissionKey;
}

function repositoryGateAnnotation(
  source: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): RepositoryGateAnnotation | undefined {
  const comments = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
  const leadingComment = comments
    .map((comment) => source.slice(comment.pos, comment.end))
    .join("\n");
  const match =
    /@repository-permission-gate\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)/u.exec(
      leadingComment,
    );
  if (match === null) {
    return undefined;
  }
  const [, repository, mutation, permissionKey] = match;
  if (repository === undefined || mutation === undefined || permissionKey === undefined) {
    throw new Error(
      `invalid repository permission annotation at ${sourceLocation(sourceFile, node)}`,
    );
  }
  return {
    repository,
    mutation,
    permissionKey: permissionKey as PermissionKey,
  };
}

function enclosingRepositoryMethod(node: ts.Node): RepositorySourceMethod | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isMethodDeclaration(current)) {
      const methodName = current.name.getText();
      const parent = current.parent;
      if (ts.isClassDeclaration(parent) && parent.name !== undefined) {
        return { repository: parent.name.text, method: methodName };
      }
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function requiredSourceMethod(
  sourceMethod: RepositorySourceMethod | undefined,
): RepositorySourceMethod {
  if (sourceMethod === undefined) {
    throw new Error("repository source method is required");
  }
  return sourceMethod;
}

function callExpressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
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
