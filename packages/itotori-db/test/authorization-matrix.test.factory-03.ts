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

export function principalGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriPrincipalRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriPrincipalRepository",
    sourceFile: "principal-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriPrincipalRepository(db)),
  });
}

export function principalExportGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (db: ItotoriDatabase) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriPrincipalRepositoryExports",
    sourceFile: "principal-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: run,
  });
}

export function authSsoSettingsGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuthSsoSettingsRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuthSsoSettingsRepository",
    sourceFile: "auth-sso-settings-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuthSsoSettingsRepository(db)),
  });
}

export function authMemberManagementGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuthMemberManagementRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuthMemberManagementRepository",
    sourceFile: "auth-member-management-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuthMemberManagementRepository(db)),
  });
}

export function authBillingSeatGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuthBillingSeatRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuthBillingSeatRepository",
    sourceFile: "auth-billing-seat-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuthBillingSeatRepository(db)),
  });
}

export function modelRoutingSettingsGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriModelRoutingSettingsRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriModelRoutingSettingsRepository",
    sourceFile: "model-routing-settings-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriModelRoutingSettingsRepository(db)),
  });
}

export function translationScopeSettingsGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTranslationScopeSettingsRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTranslationScopeSettingsRepository",
    sourceFile: "translation-scope-settings-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTranslationScopeSettingsRepository(db)),
  });
}

export function localizationPassRunConfigGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriLocalizationPassRunConfigRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriLocalizationPassRunConfigRepository",
    sourceFile: "localization-pass-run-config-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriLocalizationPassRunConfigRepository(db)),
  });
}

export function authSessionServiceGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuthSessionService) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuthSessionService",
    sourceFile: "auth-session-service.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuthSessionService(db)),
  });
}
