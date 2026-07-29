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

export function translationMemoryGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTranslationMemoryRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTranslationMemoryRepository",
    sourceFile: "translation-memory-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTranslationMemoryRepository(db)),
  });
}

export function exactSearchGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriExactSearchDocumentRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriExactSearchDocumentRepository",
    sourceFile: "exact-search-document-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriExactSearchDocumentRepository(db)),
  });
}

export function sourceUnitGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriSourceUnitRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriSourceUnitRepository",
    sourceFile: "source-unit-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriSourceUnitRepository(db)),
  });
}

export function translationBatchGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTranslationBatchRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTranslationBatchRepository",
    sourceFile: "translation-batch-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTranslationBatchRepository(db)),
  });
}

export function conformanceGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriConformanceRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriConformanceRepository",
    sourceFile: "conformance-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriConformanceRepository(db)),
  });
}

export function engineCapabilityReportGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: EngineCapabilityReportRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "EngineCapabilityReportRepository",
    sourceFile: "engine-capability-report-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new EngineCapabilityReportRepository(db)),
  });
}

export function draftJobGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriDraftJobRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriDraftJobRepository",
    sourceFile: "draft-job-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriDraftJobRepository(db)),
  });
}

export function assetLocalizationDecisionGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAssetLocalizationDecisionRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAssetLocalizationDecisionRepository",
    sourceFile: "asset-localization-decision-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAssetLocalizationDecisionRepository(db)),
  });
}

export function auditFindingGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuditFindingRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuditFindingRepository",
    sourceFile: "audit-finding-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuditFindingRepository(db)),
  });
}
