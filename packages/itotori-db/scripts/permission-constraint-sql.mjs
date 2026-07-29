export function extractPermissionConstraintLists(sql, file) {
  const constraints = [];
  const searchableSql = stripSqlComments(sql);
  const namedConstraintPattern =
    /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?itotori_user_permission_grants\s+add\s+constraint\s+itotori_user_permission_grants_permission_check\s+check\s*\(\s*permission\s+in\s*\(([\s\S]*?)\)\s*\)\s*;/giu;
  for (const match of searchableSql.matchAll(namedConstraintPattern)) {
    const list = match[1];
    if (list === undefined) {
      continue;
    }
    const line = lineNumberAt(searchableSql, match.index);
    constraints.push({
      line,
      permissions: extractSqlStrings(list, `${file}:${line} permission constraint`),
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

function extractSqlStrings(sqlList, sourceLabel) {
  const values = [];
  let index = 0;
  let needsValue = true;
  while (index < sqlList.length) {
    index = skipSqlListWhitespace(sqlList, index);
    if (index >= sqlList.length) {
      break;
    }
    if (!needsValue) {
      if (sqlList[index] !== ",") {
        throw invalidSqlStringListError(sqlList, sourceLabel);
      }
      index += 1;
      needsValue = true;
      continue;
    }
    if (sqlList[index] !== "'") {
      throw invalidSqlStringListError(sqlList, sourceLabel);
    }
    const literalEnd = sqlSingleQuotedStringLiteralEnd(sqlList, index);
    if (literalEnd === undefined) {
      throw invalidSqlStringListError(sqlList, sourceLabel);
    }
    values.push(sqlList.slice(index + 1, literalEnd - 1).replaceAll("''", "'"));
    index = literalEnd;
    needsValue = false;
  }
  if (needsValue && values.length > 0) {
    throw invalidSqlStringListError(sqlList, sourceLabel);
  }
  if (values.length === 0) {
    throw new Error(
      `permission constraint drift: ${sourceLabel} permission in (...) list contains no SQL string values`,
    );
  }
  return values;
}

function skipSqlListWhitespace(source, index) {
  let current = index;
  while (/\s/u.test(source[current] ?? "")) {
    current += 1;
  }
  return current;
}

function sqlSingleQuotedStringLiteralEnd(source, index) {
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
  return undefined;
}

function invalidSqlStringListError(sqlList, sourceLabel) {
  return new Error(
    [
      `permission constraint drift: ${sourceLabel} permission in (...) list must contain only SQL string literals separated by commas`,
      `invalid permission in (...) list: ${formatSqlSnippet(sqlList)}`,
    ].join("\n"),
  );
}

function formatSqlSnippet(value) {
  return value.trim().replaceAll(/\s+/gu, " ");
}
