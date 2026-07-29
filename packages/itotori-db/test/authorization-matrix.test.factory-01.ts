import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { readdirSync, readFileSync } from "node:fs";
import type { Node } from "@babel/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isCallExpression,
  isMemberExpression,
  leadingCommentText,
  memberPropertyName,
  nameOf,
  parseTypeScript,
  permissionHelperAliases,
  permissionHelperCallName,
  sourceLocation,
  walk,
} from "../../../scripts/stable-ts-ast.mjs";
import {
  permissionValues,
  type AuthorizationActor,
  type Permission,
} from "../src/authorization.js";
import { ItotoriAuthMemberManagementRepository } from "../src/repositories/auth-member-management-repository.js";
import { ItotoriAuthBillingSeatRepository } from "../src/repositories/auth-billing-seat-repository.js";
import { ItotoriAuthSessionService } from "../src/repositories/auth-session-service.js";
import { ItotoriAssetLocalizationDecisionRepository } from "../src/repositories/asset-localization-decision-repository.js";
import { ItotoriAuditFindingRepository } from "../src/repositories/audit-finding-repository.js";
import { ItotoriAuthSsoSettingsRepository } from "../src/repositories/auth-sso-settings-repository.js";
import { ItotoriBranchReferenceRepository } from "../src/repositories/branch-reference-repository.js";
import { ItotoriConformanceRepository } from "../src/repositories/conformance-repository.js";
import { EngineCapabilityReportRepository } from "../src/repositories/engine-capability-report-repository.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import { ItotoriDraftJobRepository } from "../src/repositories/draft-job-repository.js";
import { ItotoriEventQueueRepository } from "../src/repositories/event-queue-repository.js";
import { ItotoriExactSearchDocumentRepository } from "../src/repositories/exact-search-document-repository.js";
import { ItotoriFeedbackRepository } from "../src/repositories/feedback-repository.js";
import { ItotoriModelLedgerRepository } from "../src/repositories/model-ledger-repository.js";
import { ItotoriModelRoutingSettingsRepository } from "../src/repositories/model-routing-settings-repository.js";
import {
  type ItotoriPrincipalRepositoryPort,
  ItotoriPrincipalRepository,
  listAccountPermissionSets,
  loadPermissionSetAccountId,
} from "../src/repositories/principal-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { ItotoriStyleGuideRepository } from "../src/repositories/style-guide-repository.js";
import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import { ItotoriTranslationBatchRepository } from "../src/repositories/translation-batch-repository.js";
import { ItotoriSourceUnitRepository } from "../src/repositories/source-unit-repository.js";
import { ItotoriTranslationMemoryRepository } from "../src/repositories/translation-memory-repository.js";
import { ItotoriTranslationScopeSettingsRepository } from "../src/repositories/translation-scope-settings-repository.js";
import { ItotoriLocalizationPassRunConfigRepository } from "../src/repositories/localization-pass-run-config-repository.js";
import type { DatabaseContext, ItotoriDatabase } from "../src/connection.js";
import { assertDeniedRepositoryMutation } from "./authorization-test-helpers.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import type {
  PermissionKey,
  RepositoryPermissionGateCase,
} from "./authorization-matrix.test.helpers.js";
import { repositoryGate } from "./authorization-matrix.test.factory-00.js";

export function projectGate(
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
    runDeniedMutation: (db) =>
      run(new ItotoriProjectRepository(db, testProjectEngineFamilyRegistry)),
  });
}

export function feedbackGate(
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

export function modelLedgerGate(
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

export function queueGate(
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

export function catalogGate(
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

export function catalogCrawlerGate(
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

export function branchReferenceGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriBranchReferenceRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriBranchReferenceRepository",
    sourceFile: "branch-reference-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriBranchReferenceRepository(db)),
  });
}

export function styleGuideGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriStyleGuideRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriStyleGuideRepository",
    sourceFile: "style-guide-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriStyleGuideRepository(db)),
  });
}

export function terminologyGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTerminologyRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTerminologyRepository",
    sourceFile: "terminology-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTerminologyRepository(db)),
  });
}
