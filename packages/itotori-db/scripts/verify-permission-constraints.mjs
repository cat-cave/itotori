#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSameValues,
  parseAllPermissions,
  parsePermissionValues,
  registeredMigrationFiles,
} from "./permission-constraint-source.mjs";
import { extractPermissionConstraintLists } from "./permission-constraint-sql.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const permissionConstraintName = "itotori_user_permission_grants_permission_check";
const permissionGrantsTableName = "itotori_user_permission_grants";

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  try {
    verifyPermissionConstraintDrift();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function verifyPermissionConstraintDrift(options = {}) {
  const paths = permissionVerifierPaths(options);
  const source = readFileSync(paths.authorizationPath, "utf8");
  const permissionValues = parsePermissionValues(source);
  const allPermissions = parseAllPermissions(source, permissionValues);
  const latestConstraint = latestMigrationPermissionConstraint(paths);
  if (latestConstraint === undefined) {
    throw new Error(
      `permission constraint drift: no registered ${permissionConstraintName} found for ${permissionGrantsTableName} in ${relativePath(paths.migrationsDir)}`,
    );
  }
  assertSameValues({
    expected: allPermissions.values,
    actual: latestConstraint.permissions,
    expectedLabel: "TypeScript allPermissions",
    actualLabel: `${latestConstraint.file}:${latestConstraint.line} permission constraint`,
  });
  console.log(
    `permission constraint drift check ok: ${latestConstraint.file} matches ${allPermissions.values.length} TypeScript permissions`,
  );
}

function permissionVerifierPaths({ authorizationPath, migrationsDir }) {
  return {
    authorizationPath:
      authorizationPath ??
      path.join(packageRoot, "src/authorization-permissions-and-local-user.ts"),
    migrationsDir: migrationsDir ?? path.join(packageRoot, "migrations"),
  };
}

function latestMigrationPermissionConstraint(paths) {
  const migrations = registeredMigrationFiles(paths.migrationsDir, relativePath);
  let latest;
  for (const file of migrations) {
    const sql = readFileSync(path.join(paths.migrationsDir, file), "utf8");
    for (const constraint of extractPermissionConstraintLists(sql, file)) {
      latest = { file, ...constraint };
    }
  }
  return latest;
}

function relativePath(filePath) {
  return path.relative(path.dirname(packageRoot), filePath);
}
