import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const LINE_LIMIT = 500;

function normalizeReason(value) {
  return value.replaceAll("`", "").replace(/\s+/gu, " ").trim();
}

function sameStrings(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function parseDropLedger(path, errors) {
  const rows = [];
  let current;
  for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/u).entries()) {
    const start = /^- `([^`]+)` — (.+)$/u.exec(line);
    if (start) {
      if (current) rows.push(current);
      current = { capability: start[1], reason: start[2], line: index + 1 };
    } else if (current && /^\s{2}\S/u.test(line)) {
      current.reason += ` ${line.trim()}`;
    } else if (line.trim() === "" || line.startsWith("#")) {
      if (current) rows.push(current);
      current = undefined;
    }
  }
  if (current) rows.push(current);
  const duplicates = rows
    .map((row) => row.capability)
    .filter((capability, index, all) => all.indexOf(capability) !== index);
  if (duplicates.length > 0) errors.push(`drop ledger has duplicates: ${duplicates.join(", ")}`);
  return rows;
}

function validateDropLedger(root, mappings, errors) {
  const path = join(root, "docs", "behaviors", "dropped-capabilities.md");
  const rows = parseDropLedger(path, errors);
  const expected = mappings.filter((row) => row.disposition === "dropped");
  if (
    !sameStrings(
      rows.map((row) => row.capability),
      expected.map((row) => row.capability),
    )
  ) {
    errors.push(`drop ledger does not contain the exact ${expected.length} dropped capabilities`);
  }
  const expectedById = new Map(expected.map((row) => [row.capability, row.reason]));
  for (const row of rows) {
    const reason = expectedById.get(row.capability);
    if (reason && normalizeReason(row.reason) !== normalizeReason(reason)) {
      errors.push(`${path}:${row.line}: drop reason differs for ${row.capability}`);
    }
  }
}

function countLines(contents) {
  if (contents.length === 0) return 0;
  const pieces = contents.split(/\r?\n/u);
  return pieces.length - (pieces.at(-1) === "" ? 1 : 0);
}

function validateOverviewLineCaps(root, errors) {
  for (const path of [join(root, "docs", "README.md"), join(root, "docs", "action-plan.md")]) {
    if (!existsSync(path)) continue;
    const lines = countLines(readFileSync(path, "utf8"));
    if (lines > LINE_LIMIT) {
      errors.push(
        `${relative(root, path)}: ${lines} lines exceeds absolute ${LINE_LIMIT}-line cap`,
      );
    }
  }
}

export function validateHumanViews(root, _sources, mappings, errors) {
  validateDropLedger(root, mappings, errors);
  validateOverviewLineCaps(root, errors);
}
