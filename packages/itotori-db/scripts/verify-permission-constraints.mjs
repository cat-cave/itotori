#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authorizationPath =
  process.env.ITOTORI_DB_PERMISSION_AUTHORIZATION_PATH ??
  path.join(packageRoot, "src/authorization.ts");
const migrationsDir =
  process.env.ITOTORI_DB_PERMISSION_MIGRATIONS_DIR ?? path.join(packageRoot, "migrations");
const migrationsSourcePath =
  process.env.ITOTORI_DB_PERMISSION_MIGRATIONS_SOURCE_PATH ??
  path.join(packageRoot, "src/migrations.ts");
const permissionConstraintName = "itotori_user_permission_grants_permission_check";
const permissionGrantsTableName = "itotori_user_permission_grants";

try {
  verifyPermissionConstraintDrift();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function verifyPermissionConstraintDrift() {
  const source = readFileSync(authorizationPath, "utf8");
  const permissionValues = parsePermissionValues(source);
  const allPermissions = parseAllPermissions(source, permissionValues);
  const latestConstraint = latestMigrationPermissionConstraint();

  if (latestConstraint === undefined) {
    throw new Error(
      `permission constraint drift: no registered ${permissionConstraintName} found for ${permissionGrantsTableName} in ${relativePath(migrationsDir)}`,
    );
  }

  assertSameValues({
    expected: allPermissions.values,
    actual: latestConstraint.permissions,
    expectedLabel: "TypeScript allPermissions",
    actualLabel: `${latestConstraint.file} permission constraint`,
  });

  console.log(
    `permission constraint drift check ok: ${latestConstraint.file} matches ${allPermissions.values.length} TypeScript permissions`,
  );
}

function parsePermissionValues(source) {
  const body = requiredExportLiteralBody(source, "permissionValues", "{", "}");

  const values = [];
  const keys = new Set();
  const propertyPattern = /^\s*([A-Za-z0-9_]+):\s*"([^"]+)",?\s*$/gmu;
  for (const property of body.matchAll(propertyPattern)) {
    const [, key, value] = property;
    if (key === undefined || value === undefined) {
      continue;
    }
    if (keys.has(key)) {
      throw new Error(`permission constraint drift: duplicate permission key ${key}`);
    }
    keys.add(key);
    values.push({ key, value });
  }

  const parsedSource = body.replaceAll(propertyPattern, "").trim();
  if (parsedSource.length > 0 || values.length === 0) {
    throw new Error(
      "permission constraint drift: permissionValues must contain only string literal properties",
    );
  }

  const duplicateValues = duplicates(values.map(({ value }) => value));
  if (duplicateValues.length > 0) {
    throw new Error(
      `permission constraint drift: duplicate permission values in TypeScript: ${duplicateValues.join(", ")}`,
    );
  }

  return values;
}

function parseAllPermissions(source, permissionValues) {
  const body = requiredExportLiteralBody(source, "allPermissions", "[", "]");

  const permissionByKey = new Map(permissionValues.map(({ key, value }) => [key, value]));
  const keys = [];
  const values = [];
  const entryPattern = /^\s*permissionValues\.([A-Za-z0-9_]+),?\s*$/gmu;
  for (const element of body.matchAll(entryPattern)) {
    const key = element[1];
    if (key === undefined) {
      continue;
    }
    const value = permissionByKey.get(key);
    if (value === undefined) {
      throw new Error(`permission constraint drift: allPermissions references unknown key ${key}`);
    }
    keys.push(key);
    values.push(value);
  }

  const parsedSource = body.replaceAll(entryPattern, "").trim();
  if (parsedSource.length > 0 || values.length === 0) {
    throw new Error(
      "permission constraint drift: allPermissions entries must use permissionValues.<key>",
    );
  }

  assertSameValues({
    expected: permissionValues.map(({ key }) => key),
    actual: keys,
    expectedLabel: "permissionValues keys",
    actualLabel: "allPermissions keys",
  });

  return { keys, values };
}

function latestMigrationPermissionConstraint() {
  const migrations = registeredMigrationFiles();
  let latest;

  for (const file of migrations) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const permissions of extractPermissionConstraintLists(sql)) {
      latest = { file, permissions };
    }
  }

  return latest;
}

function registeredMigrationFiles() {
  const source = readFileSync(migrationsSourcePath, "utf8");
  const migrationListPattern = /\bconst\s+migrations\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/u;
  const match = migrationListPattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(
      `permission constraint drift: missing migrations registry in ${relativePath(migrationsSourcePath)}`,
    );
  }

  const files = [];
  for (const fileMatch of body.matchAll(/\bfile:\s*"([^"]+\.sql)"/gu)) {
    const file = fileMatch[1];
    if (file !== undefined) {
      files.push(file);
    }
  }

  if (files.length === 0) {
    throw new Error(
      `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} contains no SQL files`,
    );
  }

  const invalidFiles = files.filter((file) => !/^[0-9]{4}_.+\.sql$/u.test(file));
  if (invalidFiles.length > 0) {
    throw new Error(
      `permission constraint drift: migrations registry contains invalid SQL filenames: ${invalidFiles.join(", ")}`,
    );
  }

  const duplicateFiles = duplicates(files);
  if (duplicateFiles.length > 0) {
    throw new Error(
      `permission constraint drift: migrations registry contains duplicate SQL files: ${duplicateFiles.join(", ")}`,
    );
  }

  return files;
}

function extractPermissionConstraintLists(sql) {
  const constraints = [];
  const namedConstraintPattern =
    /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?itotori_user_permission_grants\s+add\s+constraint\s+itotori_user_permission_grants_permission_check\s+check\s*\(\s*permission\s+in\s*\(([\s\S]*?)\)\s*\)\s*;/giu;
  for (const match of sql.matchAll(namedConstraintPattern)) {
    const list = match[1];
    if (list === undefined) {
      continue;
    }
    constraints.push(extractSqlStrings(list));
  }
  return constraints;
}

function extractSqlStrings(sqlList) {
  const values = [];
  for (const match of sqlList.matchAll(/'((?:''|[^'])*)'/gu)) {
    const value = match[1];
    if (value !== undefined) {
      values.push(value.replaceAll("''", "'"));
    }
  }
  if (values.length === 0) {
    throw new Error("permission constraint drift: permission check contains no SQL string values");
  }
  return values;
}

function requiredExportLiteralBody(source, variableName, open, close) {
  const declarationPattern = new RegExp(
    `export\\s+const\\s+${escapeRegExp(variableName)}\\s*=\\s*\\${open}`,
    "u",
  );
  const match = declarationPattern.exec(source);
  if (match === null) {
    throw new Error(`permission constraint drift: missing ${variableName} declaration`);
  }
  const bodyStart = match.index + match[0].length;
  const bodyEnd = source.indexOf(close, bodyStart);
  if (bodyEnd === -1) {
    throw new Error(`permission constraint drift: ${variableName} literal is not closed`);
  }
  return source.slice(bodyStart, bodyEnd);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertSameValues({ expected, actual, expectedLabel, actualLabel }) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  const duplicateActual = duplicates(actual);
  const duplicateExpected = duplicates(expected);

  if (
    missing.length > 0 ||
    extra.length > 0 ||
    duplicateActual.length > 0 ||
    duplicateExpected.length > 0
  ) {
    throw new Error(
      [
        "permission constraint drift detected",
        `${expectedLabel}: ${formatValues(expected)}`,
        `${actualLabel}: ${formatValues(actual)}`,
        missing.length > 0 ? `missing from ${actualLabel}: ${formatValues(missing)}` : undefined,
        extra.length > 0 ? `extra in ${actualLabel}: ${formatValues(extra)}` : undefined,
        duplicateExpected.length > 0
          ? `duplicates in ${expectedLabel}: ${formatValues(duplicateExpected)}`
          : undefined,
        duplicateActual.length > 0
          ? `duplicates in ${actualLabel}: ${formatValues(duplicateActual)}`
          : undefined,
        "Add, rename, or retire permissions in packages/itotori-db/src/authorization.ts, then add a new migration that replaces itotori_user_permission_grants_permission_check with the same permission set.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function duplicates(values) {
  const seen = new Set();
  const duplicated = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicated.add(value);
    }
    seen.add(value);
  }
  return [...duplicated].sort();
}

function formatValues(values) {
  return values.map((value) => `'${value}'`).join(", ");
}

function relativePath(filePath) {
  return path.relative(path.dirname(packageRoot), filePath);
}
