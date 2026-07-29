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
import { repositoryPermissionGateMatrix } from "./authorization-matrix.test.core.js";

export type PermissionKey = keyof typeof permissionValues;

export type RepositoryPermissionGateCase = {
  repository: string;
  sourceFile: string;
  mutation: string;
  permissionKey: PermissionKey;
  requiredPermission: Permission;
  successFixture: string;
  denialFixture: string;
  runDeniedMutation: (db: ItotoriDatabase) => Promise<unknown>;
};

export type RepositorySourceMethod = {
  repository: string;
  method: string;
};

export type RepositoryGateAnnotation = {
  repository: string;
  mutation: string;
  permissionKey: PermissionKey;
};

export type ParentNode = Node & { parent?: Node | null };

export function sourcePermissionGates(): Pick<
  RepositoryPermissionGateCase,
  "repository" | "sourceFile" | "mutation" | "permissionKey"
>[] {
  const gates: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >[] = [];
  const repositorySourceDir = new URL("../src/repositories/", import.meta.url);
  const activeSourceFiles = new Set(
    repositoryPermissionGateMatrix.map(({ sourceFile }) => sourceFile),
  );

  for (const relativeSourceFile of readdirSync(repositorySourceDir, { recursive: true }).filter(
    (file) => file.endsWith(".ts"),
  )) {
    const sourceFile = relativeSourceFile.replace(/\/.*$/u, ".ts");
    if (!activeSourceFiles.has(sourceFile)) continue;
    const sourceUrl = new URL(relativeSourceFile, repositorySourceDir);
    gates.push(
      ...sourcePermissionGatesFromSource(
        sourceFile,
        readFileSync(sourceUrl, "utf8"),
        sourceUrl.pathname,
      ),
    );
  }

  return gates;
}

export function sourcePermissionGatesFromSource(
  sourceFileName: string,
  source: string,
  parsedSourceFileName = sourceFileName,
): Pick<
  RepositoryPermissionGateCase,
  "repository" | "sourceFile" | "mutation" | "permissionKey"
>[] {
  const parsedSource = parseTypeScript(source, parsedSourceFileName);
  const requirePermissionAliases = permissionHelperAliases(parsedSource, "requirePermission");
  const gates: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >[] = [];

  walk(parsedSource, (node) => {
    if (
      isCallExpression(node) &&
      permissionHelperCallName(node.callee, requirePermissionAliases) !== undefined
    ) {
      const gateAnnotation = repositoryGateAnnotation(node);
      const permissionKey = permissionKeyFromRepositoryCall(
        node,
        gateAnnotation,
        parsedSourceFileName,
      );
      const sourceMethod = enclosingRepositoryMethod(node);
      if (sourceMethod === undefined && gateAnnotation === undefined) {
        throw new Error(
          `repository permission call at ${sourceLocation(parsedSourceFileName, node)} must be inside a repository method or declare @repository-permission-gate <Repository>.<mutation> <permissionKey>`,
        );
      }
      gates.push({
        repository:
          gateAnnotation?.repository ??
          (sourceFileName === "catalog-repository.ts"
            ? "ItotoriCatalogRepository"
            : requiredSourceMethod(sourceMethod).repository),
        sourceFile: sourceFileName,
        mutation: gateAnnotation?.mutation ?? requiredSourceMethod(sourceMethod).method,
        permissionKey,
      });
    }
  });

  return gates;
}

export function expectRepositoryPermissionGateMatrixMatches(
  matrix: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >[],
  sourceGates: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >[],
): void {
  const matrixKeys = matrix.map(sourceGateKey).sort();
  const sourceKeys = sourceGates.map(sourceGateKey).sort();
  if (JSON.stringify(matrixKeys) === JSON.stringify(sourceKeys)) {
    return;
  }
  // Set-equality failed. Produce a repository-identity-naming diff (SHARED-029)
  // so the diagnostic calls out WHICH repository is missing or extra instead of
  // only dumping the two key lists.
  const matrixByKey = new Map(matrix.map((gate) => [sourceGateKey(gate), gate]));
  const sourceByKey = new Map(sourceGates.map((gate) => [sourceGateKey(gate), gate]));
  const missingMatrixEntries = sourceKeys
    .filter((key, index) => sourceKeys.indexOf(key) === index && !matrixByKey.has(key))
    .sort();
  const extraMatrixEntries = matrixKeys
    .filter((key, index) => matrixKeys.indexOf(key) === index && !sourceByKey.has(key))
    .sort();
  const duplicateMatrixEntries = matrixKeys.filter(
    (key, index) => matrixKeys.indexOf(key) !== index,
  );
  const duplicateSourceEntries = sourceKeys.filter(
    (key, index) => sourceKeys.indexOf(key) !== index,
  );
  throw new Error(
    [
      "repository permission matrix does not match source gates",
      ...missingMatrixEntries.map(
        (key) =>
          `missing matrix entry for source gate — ${describeRepositoryGate(sourceByKey.get(key)!)} [${key}]`,
      ),
      ...extraMatrixEntries.map(
        (key) =>
          `extra matrix entry without source gate — ${describeRepositoryGate(matrixByKey.get(key)!)} [${key}]`,
      ),
      ...duplicateMatrixEntries.map((key) => `duplicate matrix entry — ${key}`),
      ...duplicateSourceEntries.map((key) => `duplicate source gate — ${key}`),
    ].join("\n"),
  );
}

export function permissionKeyFromRepositoryCall(
  node: Node,
  annotation: RepositoryGateAnnotation | undefined,
  fileName: string,
): PermissionKey {
  if (!isCallExpression(node)) {
    throw new Error(
      `repository permission call at ${sourceLocation(fileName, node)} is not a call expression`,
    );
  }
  const permissionArgument = node.arguments[2];
  // Static `permissionValues.draftWrite` and literal-computed
  // `permissionValues?.["draftWrite"]` are equivalent gate identities.
  const permissionKey =
    permissionArgument !== undefined && isMemberExpression(permissionArgument)
      ? memberPropertyName(permissionArgument)
      : undefined;

  if (permissionKey === undefined && annotation !== undefined) {
    return annotation.permissionKey;
  }
  if (permissionKey === undefined) {
    throw new Error(
      `repository permission call at ${sourceLocation(fileName, node)} must use permissionValues.<key> or declare @repository-permission-gate`,
    );
  }
  if (annotation !== undefined && annotation.permissionKey !== permissionKey) {
    throw new Error(
      `repository permission annotation at ${sourceLocation(fileName, node)} names ${annotation.permissionKey}, but the call uses ${permissionKey}`,
    );
  }
  return permissionKey as PermissionKey;
}

export function repositoryGateAnnotation(node: Node): RepositoryGateAnnotation | undefined {
  const parentNode = node as ParentNode;
  const candidateNodes = [node, parentNode.parent, parentNode.parent?.parent].filter(
    (candidate): candidate is Node => candidate !== undefined && candidate !== null,
  );
  for (const candidate of candidateNodes) {
    const annotation = repositoryGateAnnotationOnNode(candidate);
    if (annotation !== undefined) {
      return annotation;
    }
  }
  return undefined;
}

export function repositoryGateAnnotationOnNode(node: Node): RepositoryGateAnnotation | undefined {
  const leadingComment = leadingCommentText(node);
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
      `invalid repository permission annotation at ${sourceLocation("<source>", node)}`,
    );
  }
  return {
    repository,
    mutation,
    permissionKey: permissionKey as PermissionKey,
  };
}

export function enclosingRepositoryMethod(node: Node): RepositorySourceMethod | undefined {
  let current: ParentNode | null | undefined = (node as ParentNode).parent;
  while (current !== undefined && current !== null) {
    if (current.type === "ClassMethod" || current.type === "ClassPrivateMethod") {
      const methodName = nameOf(current.key) ?? "";
      // Babel: ClassDeclaration -> ClassBody -> ClassMethod
      const classBody = current.parent;
      const classDecl = classBody?.type === "ClassBody" ? classBody.parent : classBody;
      if (
        classDecl?.type === "ClassDeclaration" &&
        classDecl.id !== null &&
        classDecl.id !== undefined
      ) {
        return { repository: classDecl.id.name, method: methodName };
      }
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

export function requiredSourceMethod(
  sourceMethod: RepositorySourceMethod | undefined,
): RepositorySourceMethod {
  if (sourceMethod === undefined) {
    throw new Error("repository source method is required");
  }
  return sourceMethod;
}

export function sourceGateKey({
  repository,
  sourceFile,
  mutation,
  permissionKey,
}: Pick<
  RepositoryPermissionGateCase,
  "repository" | "sourceFile" | "mutation" | "permissionKey"
>): string {
  return `${repository}:${sourceFile}:${mutation}:${permissionKey}`;
}

export function describeRepositoryGate(
  gate: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >,
): string {
  return `repository ${gate.repository} method ${gate.mutation} (${gate.sourceFile}) requires ${gate.permissionKey}`;
}

export function requiredContext(context: DatabaseContext | undefined): DatabaseContext {
  if (context === undefined) {
    throw new Error("database context was not initialized");
  }
  return context;
}

export function principalRepositoryPublicMethods(): string[] {
  const repositorySourceDir = new URL("../src/repositories/", import.meta.url);
  const sourcePath = new URL("principal-repository.ts", repositorySourceDir);
  const source = readFileSync(sourcePath, "utf8");
  const sourceFile = parseTypeScript(source, sourcePath.pathname);
  const methods: string[] = [];
  walk(sourceFile, (node) => {
    if (node.type !== "ClassDeclaration" || node.id?.name !== "ItotoriPrincipalRepository") {
      return;
    }
    for (const member of node.body.body) {
      // Mirror ts.isMethodDeclaration: constructors are ConstructorDeclaration,
      // not methods, so Babel ClassMethod kind:"constructor" must be excluded.
      if (member.type !== "ClassMethod" || member.kind === "constructor") {
        continue;
      }
      if (member.accessibility === "private" || member.accessibility === "protected") {
        continue;
      }
      const methodName = nameOf(member.key);
      if (methodName !== undefined) {
        methods.push(methodName);
      }
    }
  });
  return methods.sort();
}
