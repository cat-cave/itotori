import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { parseTypeScript, walk } from "../../../scripts/stable-ts-ast.mjs";

import { repositoryPermissionGateMatrix } from "./authorization-matrix.test.core.js";
import {
  sourcePermissionGatesFromSource,
  type RepositoryPermissionGateCase,
} from "./authorization-matrix.test.helpers.js";

type SourceGate = Pick<
  RepositoryPermissionGateCase,
  "repository" | "sourceFile" | "mutation" | "permissionKey"
>;

const repositorySourceDirectory = new URL("../src/repositories/", import.meta.url).pathname;

/**
 * Finds gates reachable from every audited repository façade. A split may use
 * re-exports, delegates, or mixins; following relative module edges keeps the
 * source gate check aligned with the public façade rather than a file name.
 */
export function sourcePermissionGatesFromRepositoryModuleGraphs(): SourceGate[] {
  const sourceFiles = new Set(repositoryPermissionGateMatrix.map(({ sourceFile }) => sourceFile));
  return [...sourceFiles].flatMap((sourceFile) => sourcePermissionGatesFromModuleGraph(sourceFile));
}

function sourcePermissionGatesFromModuleGraph(sourceFile: string): SourceGate[] {
  const façadePath = resolve(repositorySourceDirectory, sourceFile);
  const repositoryFamily = sourceFile.replace(/\.ts$/u, "");
  const sourcePaths = reachableRepositorySourcePaths(façadePath, repositoryFamily);
  const matrixEntries = repositoryPermissionGateMatrix.filter(
    (entry) => entry.sourceFile === sourceFile,
  );
  return sourcePaths.flatMap((sourcePath) =>
    sourcePermissionGatesFromSource(sourceFile, readFileSync(sourcePath, "utf8"), sourcePath).map(
      (gate) => ({
        ...gate,
        repository: repositoryForFacadeGate(gate, matrixEntries),
      }),
    ),
  );
}

function reachableRepositorySourcePaths(façadePath: string, repositoryFamily: string): string[] {
  const pending = [façadePath];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (sourcePath === undefined || visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    const parsedSource = parseTypeScript(readFileSync(sourcePath, "utf8"), sourcePath);
    walk(parsedSource, (node) => {
      const specifier = moduleSpecifier(node);
      if (specifier === undefined) return;
      const importedPath = resolveRepositorySourcePath(sourcePath, specifier, repositoryFamily);
      if (importedPath !== undefined && !visited.has(importedPath)) pending.push(importedPath);
    });
  }
  return [...visited];
}

function moduleSpecifier(node: { type: string }): string | undefined {
  if (
    node.type !== "ImportDeclaration" &&
    node.type !== "ExportAllDeclaration" &&
    node.type !== "ExportNamedDeclaration"
  ) {
    return undefined;
  }
  const source = "source" in node ? node.source : undefined;
  if (source === undefined || source === null || !("value" in source)) return undefined;
  return typeof source.value === "string" ? source.value : undefined;
}

function resolveRepositorySourcePath(
  sourcePath: string,
  specifier: string,
  repositoryFamily: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const importedPath = resolve(dirname(sourcePath), specifier);
  const candidates = [
    importedPath.replace(/\.js$/u, ".ts"),
    `${importedPath}.ts`,
    resolve(importedPath, "index.ts"),
  ];
  return candidates.find(
    (candidate) => isRepositorySourcePath(candidate, repositoryFamily) && existsSync(candidate),
  );
}

function isRepositorySourcePath(sourcePath: string, repositoryFamily: string): boolean {
  const relativePath = relative(repositorySourceDirectory, sourcePath);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath) &&
    (basename(sourcePath).startsWith(repositoryFamily) ||
      relativePath.startsWith(`${repositoryFamily}/`))
  );
}

function repositoryForFacadeGate(gate: SourceGate, matrixEntries: readonly SourceGate[]): string {
  const matchingRepositories = [
    ...new Set(
      matrixEntries
        .filter((entry) => entry.mutation === gate.mutation)
        .map((entry) => entry.repository),
    ),
  ];
  if (matchingRepositories.length === 1) return matchingRepositories[0] ?? gate.repository;
  if (matchingRepositories.includes(gate.repository)) return gate.repository;
  return gate.repository;
}
