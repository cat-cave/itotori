import { readFileSync } from "node:fs";
import path from "node:path";

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

export function registeredMigrationFiles(migrationsSourcePath, relativePath) {
  const source = readFileSync(migrationsSourcePath, "utf8");
  const entries = migrationRegistryEntries(source, migrationsSourcePath, relativePath);
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

function migrationRegistryEntries(source, migrationsSourcePath, relativePath) {
  const body = requiredConstArrayBody(source, "migrations", migrationsSourcePath, relativePath);
  if (!body.includes("...")) {
    return migrationEntryBodies(body, migrationsSourcePath, relativePath);
  }

  const importedEntryLists = [
    ...source.matchAll(
      /import\s+\{\s*(\w+MigrationEntries)\s*\}\s+from\s+"(\.\/migration-entries-[\w-]+\.js)";/gu,
    ),
  ];
  if (importedEntryLists.length === 0) {
    return migrationEntryBodies(body, migrationsSourcePath, relativePath);
  }
  return importedEntryLists.flatMap(([, exportName, modulePath]) => {
    const entryPath = path.join(
      path.dirname(migrationsSourcePath),
      modulePath.replace(/\.js$/u, ".ts"),
    );
    const entrySource = readFileSync(entryPath, "utf8");
    return migrationEntryBodies(
      requiredConstArrayBody(entrySource, exportName, entryPath, relativePath),
      entryPath,
      relativePath,
    );
  });
}

function requiredConstArrayBody(source, variableName, migrationsSourcePath, relativePath) {
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
  const closeIndex = findMatchingDelimiter(source, bodyStart - 1, "[", "]");
  if (closeIndex === -1) {
    throw new Error(
      `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} is not closed`,
    );
  }
  if (!/^\s*as\s+const\s*;/u.test(source.slice(closeIndex + 1))) {
    throw new Error(
      `permission constraint drift: migrations registry in ${relativePath(migrationsSourcePath)} must be a const assertion`,
    );
  }
  return source.slice(bodyStart, closeIndex);
}

function migrationEntryBodies(body, migrationsSourcePath, relativePath) {
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
