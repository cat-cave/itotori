import { readdirSync } from "node:fs";

export function parsePermissionValues(source) {
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

export function parseAllPermissions(source, permissionValues) {
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

/**
 * Discover migration SQL filenames from the migrations directory.
 *
 * Apply order and membership are filesystem-derived (lexicographic). Accepted
 * shapes: legacy `NNNN_slug.sql` or stamp `YYYYMMDDHHmmssxxxx_slug.sql`.
 */
export function registeredMigrationFiles(migrationsDir, relativePath) {
  let files;
  try {
    files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  } catch {
    throw new Error(
      `permission constraint drift: migrations directory missing: ${relativePath(migrationsDir)}`,
    );
  }
  if (files.length === 0) {
    throw new Error(
      `permission constraint drift: no SQL migrations in ${relativePath(migrationsDir)}`,
    );
  }

  const filenamePattern = /^(?:\d{4}|\d{14}[0-9a-f]{4})_[a-z][a-z0-9_]*\.sql$/u;
  const invalidFiles = files.filter((file) => !filenamePattern.test(file));
  if (invalidFiles.length > 0) {
    throw new Error(
      `permission constraint drift: invalid SQL filenames: ${invalidFiles.join(", ")}`,
    );
  }

  const byOrdinal = new Map();
  for (const file of files) {
    const ordinal = file.slice(0, file.indexOf("_"));
    const bucket = byOrdinal.get(ordinal);
    if (bucket === undefined) byOrdinal.set(ordinal, [file]);
    else bucket.push(file);
  }
  const duplicateOrdinals = [...byOrdinal.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([ordinal, names]) => `${ordinal} (${names.join(", ")})`);
  if (duplicateOrdinals.length > 0) {
    throw new Error(
      `permission constraint drift: duplicate migration ordinals: ${duplicateOrdinals.join("; ")}`,
    );
  }
  return files;
}

export function assertSameValues({ expected, actual, expectedLabel, actualLabel }) {
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
