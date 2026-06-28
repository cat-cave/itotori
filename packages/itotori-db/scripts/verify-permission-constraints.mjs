#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function permissionVerifierPaths({ authorizationPath, migrationsDir, migrationsSourcePath }) {
  return {
    authorizationPath:
      authorizationPath ??
      process.env.ITOTORI_DB_PERMISSION_AUTHORIZATION_PATH ??
      path.join(packageRoot, "src/authorization.ts"),
    migrationsDir:
      migrationsDir ??
      process.env.ITOTORI_DB_PERMISSION_MIGRATIONS_DIR ??
      path.join(packageRoot, "migrations"),
    migrationsSourcePath:
      migrationsSourcePath ??
      process.env.ITOTORI_DB_PERMISSION_MIGRATIONS_SOURCE_PATH ??
      path.join(packageRoot, "src/migrations.ts"),
  };
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

function latestMigrationPermissionConstraint(paths) {
  const migrations = registeredMigrationFiles(paths.migrationsSourcePath);
  let latest;

  for (const file of migrations) {
    const sql = readFileSync(path.join(paths.migrationsDir, file), "utf8");
    for (const constraint of extractPermissionConstraintLists(sql)) {
      latest = { file, ...constraint };
    }
  }

  return latest;
}

function registeredMigrationFiles(migrationsSourcePath) {
  const source = readFileSync(migrationsSourcePath, "utf8");
  const body = requiredConstArrayBody(source, "migrations", migrationsSourcePath);
  const entries = migrationEntryBodies(body, migrationsSourcePath);

  if (entries.length === 0) {
    throw new Error(
      `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} contains no SQL files`,
    );
  }

  const files = entries.map((entry) => {
    const file = migrationEntryFile(entry);
    if (file === undefined) {
      throw new Error(
        `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} contains an entry without a string file property`,
      );
    }
    return file;
  });

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

function requiredConstArrayBody(source, variableName, migrationsSourcePath) {
  const declarationPattern = new RegExp(
    `\\bconst\\s+${escapeRegExp(variableName)}\\s*=\\s*\\[`,
    "gu",
  );
  let match;
  while ((match = declarationPattern.exec(source)) !== null) {
    if (!isIgnoredJavaScriptPosition(source, match.index)) {
      break;
    }
  }
  if (match === null) {
    throw new Error(
      `permission constraint drift: missing migrations registry in ${relativePath(migrationsSourcePath)}`,
    );
  }

  const bodyStart = match.index + match[0].length;
  const openIndex = bodyStart - 1;
  const closeIndex = findMatchingDelimiter(source, openIndex, "[", "]");
  if (closeIndex === -1) {
    throw new Error(
      `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} is not closed`,
    );
  }

  const afterArray = source.slice(closeIndex + 1);
  if (!/^\s*as\s+const\s*;/u.test(afterArray)) {
    throw new Error(
      `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} must be a const assertion`,
    );
  }

  return source.slice(bodyStart, closeIndex);
}

function isIgnoredJavaScriptPosition(source, position) {
  let index = 0;

  while (index < position) {
    const nextIndex = skipIgnoredJavaScript(source, index);
    if (nextIndex !== index) {
      if (nextIndex > position) {
        return true;
      }
      index = nextIndex;
    } else {
      index += 1;
    }
  }

  return false;
}

function migrationEntryBodies(body, migrationsSourcePath) {
  const entries = [];
  let index = 0;

  while (index < body.length) {
    index = skipWhitespaceAndComments(body, index);
    if (index >= body.length) {
      break;
    }
    if (body[index] === ",") {
      index += 1;
      continue;
    }
    if (body[index] !== "{") {
      throw new Error(
        `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} must contain only object entries`,
      );
    }

    const closeIndex = findMatchingDelimiter(body, index, "{", "}");
    if (closeIndex === -1) {
      throw new Error(
        `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} contains an unclosed object entry`,
      );
    }

    entries.push(body.slice(index + 1, closeIndex));
    index = closeIndex + 1;
  }

  return entries;
}

function migrationEntryFile(entry) {
  for (const property of splitTopLevel(entry, ",")) {
    const source = stripJavaScriptComments(property).trim();
    const match = /^(?:file|"file"|'file')\s*:\s*(["'])([^"'\\]+\.sql)\1\s*$/u.exec(source);
    if (match?.[2] !== undefined) {
      return match[2];
    }
  }
  return undefined;
}

function splitTopLevel(source, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let index = 0;

  while (index < source.length) {
    const nextIndex = skipIgnoredJavaScript(source, index);
    if (nextIndex !== index) {
      index = nextIndex;
      continue;
    }

    const char = source[index];
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
    } else if (char === separator && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }

  parts.push(source.slice(start));
  return parts;
}

function findMatchingDelimiter(source, openIndex, open, close) {
  let depth = 0;
  let index = openIndex;

  while (index < source.length) {
    const nextIndex = skipIgnoredJavaScript(source, index);
    if (nextIndex !== index) {
      index = nextIndex;
      continue;
    }

    const char = source[index];
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }

  return -1;
}

function skipWhitespaceAndComments(source, index) {
  let current = index;

  while (current < source.length) {
    const char = source[current];
    const next = source[current + 1];
    if (/\s/u.test(char ?? "")) {
      current += 1;
    } else if (char === "/" && next === "/") {
      current = skipLineComment(source, current);
    } else if (char === "/" && next === "*") {
      current = skipBlockComment(source, current);
    } else {
      break;
    }
  }

  return current;
}

function skipIgnoredJavaScript(source, index) {
  const char = source[index];
  const next = source[index + 1];

  if (char === "/" && next === "/") {
    return skipLineComment(source, index);
  }
  if (char === "/" && next === "*") {
    return skipBlockComment(source, index);
  }
  if (char === '"' || char === "'" || char === "`") {
    return skipStringLiteral(source, index, char);
  }
  return index;
}

function skipLineComment(source, index) {
  const lineEnd = source.indexOf("\n", index + 2);
  return lineEnd === -1 ? source.length : lineEnd + 1;
}

function skipBlockComment(source, index) {
  const commentEnd = source.indexOf("*/", index + 2);
  return commentEnd === -1 ? source.length : commentEnd + 2;
}

function skipStringLiteral(source, index, quote) {
  let current = index + 1;

  while (current < source.length) {
    const char = source[current];
    if (char === "\\") {
      current += 2;
    } else if (char === quote) {
      return current + 1;
    } else {
      current += 1;
    }
  }

  return source.length;
}

function stripJavaScriptComments(source) {
  let stripped = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const commentEnd = skipLineComment(source, index);
      stripped += " ".repeat(commentEnd - index);
      index = commentEnd;
    } else if (char === "/" && next === "*") {
      const commentEnd = skipBlockComment(source, index);
      stripped += " ".repeat(commentEnd - index);
      index = commentEnd;
    } else if (char === '"' || char === "'" || char === "`") {
      const literalEnd = skipStringLiteral(source, index, char);
      stripped += source.slice(index, literalEnd);
      index = literalEnd;
    } else {
      stripped += char;
      index += 1;
    }
  }

  return stripped;
}

function extractPermissionConstraintLists(sql) {
  const constraints = [];
  const searchableSql = stripSqlComments(sql);
  const namedConstraintPattern =
    /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?itotori_user_permission_grants\s+add\s+constraint\s+itotori_user_permission_grants_permission_check\s+check\s*\(\s*permission\s+in\s*\(([\s\S]*?)\)\s*\)\s*;/giu;
  for (const match of searchableSql.matchAll(namedConstraintPattern)) {
    const list = match[1];
    if (list === undefined) {
      continue;
    }
    constraints.push({
      line: lineNumberAt(searchableSql, match.index),
      permissions: extractSqlStrings(list),
    });
  }
  return constraints;
}

function stripSqlComments(source) {
  let stripped = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "-" && next === "-") {
      const commentEnd = skipSqlLineComment(source, index);
      stripped += maskComment(source.slice(index, commentEnd));
      index = commentEnd;
    } else if (char === "/" && next === "*") {
      const commentEnd = skipSqlBlockComment(source, index);
      stripped += maskComment(source.slice(index, commentEnd));
      index = commentEnd;
    } else if (char === "'") {
      const literalEnd = skipSqlSingleQuotedString(source, index);
      stripped += source.slice(index, literalEnd);
      index = literalEnd;
    } else if (char === '"') {
      const literalEnd = skipSqlDoubleQuotedString(source, index);
      stripped += source.slice(index, literalEnd);
      index = literalEnd;
    } else {
      const dollarQuote = sqlDollarQuoteDelimiterAt(source, index);
      if (dollarQuote !== undefined) {
        const literalEnd = skipSqlDollarQuotedString(source, index, dollarQuote);
        stripped += source.slice(index, literalEnd);
        index = literalEnd;
      } else {
        stripped += char;
        index += 1;
      }
    }
  }

  return stripped;
}

function skipSqlLineComment(source, index) {
  const lineEnd = source.indexOf("\n", index + 2);
  return lineEnd === -1 ? source.length : lineEnd;
}

function skipSqlBlockComment(source, index) {
  const commentEnd = source.indexOf("*/", index + 2);
  return commentEnd === -1 ? source.length : commentEnd + 2;
}

function skipSqlSingleQuotedString(source, index) {
  let current = index + 1;

  while (current < source.length) {
    const char = source[current];
    if (char === "'" && source[current + 1] === "'") {
      current += 2;
    } else if (char === "'") {
      return current + 1;
    } else {
      current += 1;
    }
  }

  return source.length;
}

function skipSqlDoubleQuotedString(source, index) {
  let current = index + 1;

  while (current < source.length) {
    const char = source[current];
    if (char === '"' && source[current + 1] === '"') {
      current += 2;
    } else if (char === '"') {
      return current + 1;
    } else {
      current += 1;
    }
  }

  return source.length;
}

function sqlDollarQuoteDelimiterAt(source, index) {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(source.slice(index));
  return match?.[0];
}

function skipSqlDollarQuotedString(source, index, delimiter) {
  const literalEnd = source.indexOf(delimiter, index + delimiter.length);
  return literalEnd === -1 ? source.length : literalEnd + delimiter.length;
}

function maskComment(comment) {
  return comment.replace(/[^\n]/gu, " ");
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let current = 0; current < index; current += 1) {
    if (source[current] === "\n") {
      line += 1;
    }
  }
  return line;
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
