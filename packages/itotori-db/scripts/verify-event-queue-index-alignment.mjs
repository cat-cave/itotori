#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const guardedTables = new Map([
  ["eventOutbox", "itotori_event_outbox"],
  ["jobQueue", "itotori_jobs"],
]);

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  try {
    verifyEventQueueIndexAlignment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function verifyEventQueueIndexAlignment(options = {}) {
  const paths = verifierPaths(options);
  const schemaSource = readFileSync(paths.schemaPath, "utf8");
  const migrationSources = readMigrationSources(paths.migrationsDir);
  const schemaIndexes = extractSchemaIndexes(schemaSource);
  const migrationIndexes = extractMigrationIndexes(migrationSources);

  assertAlignedIndexes(schemaIndexes, migrationIndexes);

  console.log(
    `event queue index drift check ok: ${schemaIndexes.length} schema indexes match SQL migrations`,
  );
}

export function assertAlignedIndexes(schemaIndexes, migrationIndexes) {
  const schemaByName = indexByName(schemaIndexes, "Drizzle schema");
  const migrationByName = indexByName(migrationIndexes, "SQL migrations");
  const diagnostics = [];

  for (const index of schemaIndexes) {
    const migrationIndex = migrationByName.get(index.name);
    if (migrationIndex === undefined) {
      diagnostics.push(`schema-only index ${formatIndex(index)}`);
      continue;
    }

    if (signature(index) !== signature(migrationIndex)) {
      diagnostics.push(
        `index ${index.name} differs:\n` +
          `  Drizzle schema: ${formatIndex(index)}\n` +
          `  SQL migration:  ${formatIndex(migrationIndex)}`,
      );
    }
  }

  for (const index of migrationIndexes) {
    if (!schemaByName.has(index.name)) {
      diagnostics.push(`migration-only index ${formatIndex(index)}`);
    }
  }

  if (diagnostics.length > 0) {
    throw new Error(`event queue index drift detected:\n${diagnostics.join("\n")}`);
  }
}

export function extractSchemaIndexes(source) {
  const indexes = [];
  for (const [exportName, tableName] of guardedTables) {
    const tableCall = extractPgTableCall(source, exportName);
    const tableLiteral = parseFirstStringArgument(tableCall.body);
    if (tableLiteral !== tableName) {
      throw new Error(
        `event queue index drift: ${exportName} maps to ${tableLiteral}, expected ${tableName}`,
      );
    }

    const columnByProperty = parseColumnPropertyMap(tableCall.body);
    const indexArrayBody = extractIndexArrayBody(tableCall.body);
    indexes.push(...parseSchemaIndexDeclarations(indexArrayBody, tableName, columnByProperty));
  }

  return indexes.sort(compareIndexNames);
}

export function extractMigrationIndexes(migrationSources) {
  const indexes = [];
  const createIndexPattern =
    /\bcreate\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?("?[\w]+"?)\s+on\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*(?:using\s+(\w+)\s*)?\(([\s\S]*?)\)\s*;/giu;

  for (const { file, source } of migrationSources) {
    const sql = stripSqlComments(source);
    for (const match of sql.matchAll(createIndexPattern)) {
      const [, uniqueKeyword, rawName, rawTable, rawMethod, rawColumns] = match;
      const tableName = normalizeSqlIdentifier(rawTable?.split(".").at(-1) ?? "");
      if (![...guardedTables.values()].includes(tableName)) {
        continue;
      }

      indexes.push({
        name: normalizeSqlIdentifier(requiredMatch(rawName, "index name")),
        table: tableName,
        method: rawMethod?.toLowerCase() ?? "btree",
        unique: uniqueKeyword !== undefined,
        columns: parseSqlIndexColumns(requiredMatch(rawColumns, "index columns")),
        source: file,
      });
    }
  }

  return indexes.sort(compareIndexNames);
}

function verifierPaths({ schemaPath, migrationsDir } = {}) {
  return {
    schemaPath: schemaPath ?? path.join(packageRoot, "src/schema.ts"),
    migrationsDir: migrationsDir ?? path.join(packageRoot, "migrations"),
  };
}

function readMigrationSources(migrationsDir) {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      source: readFileSync(path.join(migrationsDir, file), "utf8"),
    }));
}

function extractPgTableCall(source, exportName) {
  const declarationPattern = new RegExp(
    `\\bexport\\s+const\\s+${escapeRegExp(exportName)}\\s*=\\s*pgTable\\s*\\(`,
    "u",
  );
  const match = declarationPattern.exec(source);
  if (match === null) {
    throw new Error(`event queue index drift: missing pgTable export ${exportName}`);
  }

  const openIndex = match.index + match[0].lastIndexOf("(");
  const closeIndex = findMatchingDelimiter(source, openIndex, "(", ")");
  if (closeIndex === -1) {
    throw new Error(`event queue index drift: unclosed pgTable export ${exportName}`);
  }

  return {
    body: source.slice(openIndex + 1, closeIndex),
  };
}

function parseFirstStringArgument(tableCallBody) {
  const match = /^\s*"([^"]+)"/u.exec(tableCallBody);
  if (match === null || match[1] === undefined) {
    throw new Error("event queue index drift: pgTable call must start with a string table name");
  }
  return match[1];
}

function parseColumnPropertyMap(tableCallBody) {
  const firstObjectStart = tableCallBody.indexOf("{");
  if (firstObjectStart === -1) {
    throw new Error("event queue index drift: pgTable call is missing the column object");
  }
  const firstObjectEnd = findMatchingDelimiter(tableCallBody, firstObjectStart, "{", "}");
  if (firstObjectEnd === -1) {
    throw new Error("event queue index drift: pgTable column object is not closed");
  }

  const columnBody = tableCallBody.slice(firstObjectStart + 1, firstObjectEnd);
  const columnByProperty = new Map();
  const columnPattern = /^\s*([A-Za-z0-9_]+):\s*[A-Za-z0-9_]+\("([^"]+)"/gmu;
  for (const match of columnBody.matchAll(columnPattern)) {
    const property = requiredMatch(match[1], "column property");
    const column = requiredMatch(match[2], "column name");
    columnByProperty.set(property, column);
  }

  if (columnByProperty.size === 0) {
    throw new Error("event queue index drift: pgTable column object yielded no columns");
  }

  return columnByProperty;
}

function extractIndexArrayBody(tableCallBody) {
  const lastArrayStart = tableCallBody.lastIndexOf("[");
  if (lastArrayStart === -1) {
    throw new Error("event queue index drift: pgTable call is missing its index array");
  }
  const lastArrayEnd = findMatchingDelimiter(tableCallBody, lastArrayStart, "[", "]");
  if (lastArrayEnd === -1) {
    throw new Error("event queue index drift: pgTable index array is not closed");
  }

  return tableCallBody.slice(lastArrayStart + 1, lastArrayEnd);
}

function parseSchemaIndexDeclarations(indexArrayBody, tableName, columnByProperty) {
  const indexes = [];
  const indexPattern = /\b(uniqueIndex|index)\("([^"]+)"\)/gu;

  for (const match of indexArrayBody.matchAll(indexPattern)) {
    const kind = requiredMatch(match[1], "index kind");
    const name = requiredMatch(match[2], "index name");
    const afterIndex = (match.index ?? 0) + match[0].length;
    const call = findIndexColumnCall(indexArrayBody, afterIndex);
    if (call === undefined) {
      throw new Error(
        `event queue index drift: schema index ${name} is missing .on(...) or .using(...)`,
      );
    }
    const columnsStart = call.start + call.method.length + 1;
    const columnsEnd = findMatchingDelimiter(indexArrayBody, columnsStart, "(", ")");
    if (columnsEnd === -1) {
      throw new Error(
        `event queue index drift: schema index ${name} has an unclosed .${call.method}(...)`,
      );
    }
    const columnArgs = splitTopLevelComma(indexArrayBody.slice(columnsStart + 1, columnsEnd));
    const accessMethod =
      call.method === "using" ? parseSchemaAccessMethod(columnArgs.shift(), name) : "btree";

    indexes.push({
      name,
      table: tableName,
      method: accessMethod,
      unique: kind === "uniqueIndex",
      columns: parseSchemaIndexColumns(columnArgs, columnByProperty, name),
      source: "schema.ts",
    });
  }

  return indexes;
}

function findIndexColumnCall(source, afterIndex) {
  const onStart = source.indexOf(".on(", afterIndex);
  const usingStart = source.indexOf(".using(", afterIndex);
  if (onStart === -1 && usingStart === -1) {
    return undefined;
  }
  if (onStart !== -1 && (usingStart === -1 || onStart < usingStart)) {
    return { method: "on", start: onStart };
  }
  return { method: "using", start: usingStart };
}

function parseSchemaAccessMethod(rawMethod, indexName) {
  const match = /^"([A-Za-z0-9_]+)"$/u.exec(rawMethod?.trim() ?? "");
  if (match === null || match[1] === undefined) {
    throw new Error(
      `event queue index drift: schema index ${indexName} .using(...) must start with a string access method`,
    );
  }
  return match[1].toLowerCase();
}

function parseSchemaIndexColumns(rawColumns, columnByProperty, indexName) {
  return rawColumns.map((rawColumn) => {
    const column = rawColumn.trim();
    const match = /^table\.([A-Za-z0-9_]+)(?:\.(asc|desc)\(\))?$/u.exec(column);
    if (match === null || match[1] === undefined) {
      throw new Error(
        `event queue index drift: schema index ${indexName} contains unsupported column expression ${column}`,
      );
    }

    const columnName = columnByProperty.get(match[1]);
    if (columnName === undefined) {
      throw new Error(
        `event queue index drift: schema index ${indexName} references unknown column property ${match[1]}`,
      );
    }

    return { name: columnName, direction: match[2]?.toLowerCase() ?? "asc" };
  });
}

function parseSqlIndexColumns(columnsBody) {
  return splitTopLevelComma(columnsBody).map((rawColumn) => {
    const normalized = rawColumn.trim().replace(/\s+/gu, " ");
    const match = /^"?([\w]+)"?(?:\s+(asc|desc))?(?:\s+nulls\s+(?:first|last))?$/iu.exec(
      normalized,
    );
    if (match === null || match[1] === undefined) {
      throw new Error(
        `event queue index drift: unsupported SQL index column expression ${normalized}`,
      );
    }
    return {
      name: normalizeSqlIdentifier(match[1]),
      direction: match[2]?.toLowerCase() ?? "asc",
    };
  });
}

function splitTopLevelComma(source) {
  const parts = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let stringQuote;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (stringQuote !== undefined) {
      if (char === "\\" && stringQuote !== "`") {
        index += 1;
      } else if (char === stringQuote) {
        stringQuote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      stringQuote = char;
    } else if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth -= 1;
    } else if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth -= 1;
    } else if (char === "{") {
      braceDepth += 1;
    } else if (char === "}") {
      braceDepth -= 1;
    } else if (
      char === "," &&
      next !== undefined &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }

  const finalPart = source.slice(start).trim();
  if (finalPart.length > 0) {
    parts.push(finalPart);
  }
  return parts;
}

function findMatchingDelimiter(source, openIndex, openDelimiter, closeDelimiter) {
  let depth = 0;
  let stringQuote;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (stringQuote !== undefined) {
      if (char === "\\" && stringQuote !== "`") {
        index += 1;
      } else if (char === stringQuote) {
        stringQuote = undefined;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      stringQuote = char;
    } else if (char === openDelimiter) {
      depth += 1;
    } else if (char === closeDelimiter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function stripSqlComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/--[^\n\r]*/gu, "");
}

function signature(index) {
  return JSON.stringify({
    table: index.table,
    method: index.method,
    unique: index.unique,
    columns: index.columns,
  });
}

function formatIndex(index) {
  const unique = index.unique ? "unique " : "";
  const columns = index.columns
    .map((column) => `${column.name}${column.direction === "desc" ? " desc" : ""}`)
    .join(", ");
  const method = index.method === "btree" ? "" : ` using ${index.method}`;
  return `${unique}${index.name} on ${index.table}${method}(${columns})`;
}

function indexByName(indexes, label) {
  const byName = new Map();
  for (const index of indexes) {
    if (byName.has(index.name)) {
      throw new Error(`event queue index drift: duplicate ${label} index ${index.name}`);
    }
    byName.set(index.name, index);
  }
  return byName;
}

function compareIndexNames(left, right) {
  return left.name.localeCompare(right.name);
}

function normalizeSqlIdentifier(identifier) {
  return identifier.trim().replace(/^"|"$/gu, "").toLowerCase();
}

function requiredMatch(value, label) {
  if (value === undefined) {
    throw new Error(`event queue index drift: missing ${label}`);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
