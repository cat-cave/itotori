import { readFileSync } from "node:fs";

const STEP_PREFIX = /^\s*(Given|When|Then|And|But|\*)\s+(.+)$/u;
const SCENARIO_HEADER = /^\s*(?:Scenario(?: Outline| Template)?|Example):/u;
const EXAMPLES_HEADER = /^\s*(Examples|Scenarios):/u;
const BACKGROUND_HEADER = /^\s*Background:/u;
const DOC_STRING_MARKER = /^\s*(?:"""|```)/u;
const LANGUAGE_DIRECTIVE = /^\s*#\s*language\s*:/iu;
const INTERNAL_CLAIM =
  /\b(crates?|modules?|registr(?:y|ies)|structs?|enums?|private helpers?|internal calls?|source files?|(?:private|internal|implementation)\s+(?:functions?|methods?|types?|schemas?|tables?|handlers?|adapters?))\b/iu;
const REPOSITORY_PATH =
  /(?:^|\s)(?:apps|crates|packages|scripts|docs)\/|(?:\.rs|\.ts|\.tsx|\.js|\.mjs)\b/iu;
const CAPABILITY_TOKEN = /\b(?:decode|runtime|localization|quality|product|platform)\.[a-z0-9]/iu;

export function namesImplementationInternal(value) {
  return INTERNAL_CLAIM.test(value) || REPOSITORY_PATH.test(value) || CAPABILITY_TOKEN.test(value);
}

function splitTableRow(line) {
  return line
    .trim()
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

export function parseFeature(path, errors) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  const scenarios = [];
  const scenarioLines = lines
    .map((line, index) => (SCENARIO_HEADER.test(line) ? index : -1))
    .filter((index) => index >= 0);
  for (const [index, line] of lines.entries()) {
    if (LANGUAGE_DIRECTIVE.test(line)) {
      errors.push(
        `${path}:${index + 1}: language directives are not allowed; catalog is English-only`,
      );
    }
    if (BACKGROUND_HEADER.test(line)) {
      errors.push(`${path}:${index + 1}: Background is not allowed in the portable catalog`);
    }
    if (DOC_STRING_MARKER.test(line)) {
      errors.push(`${path}:${index + 1}: step doc strings are not allowed in the portable catalog`);
    }
  }
  for (const [index, line] of lines.entries()) {
    if (!SCENARIO_HEADER.test(line)) continue;
    let preceding = index - 1;
    while (preceding >= 0 && lines[preceding].trim() === "") preceding -= 1;
    if (preceding < 0 || !/^\s*@behavior-\S+\s*$/u.test(lines[preceding])) {
      errors.push(`${path}:${index + 1}: every scenario must follow an @behavior tag`);
    }
  }
  const admittedStepLines = new Set();
  for (const [position, scenarioAt] of scenarioLines.entries()) {
    const nextScenario = scenarioLines[position + 1] ?? lines.length;
    let end = nextScenario;
    for (let cursor = scenarioAt + 1; cursor < end; cursor += 1) {
      if (/^\s*@behavior-\S+\s*$/u.test(lines[cursor]) || BACKGROUND_HEADER.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    const examplesAt = lines.findIndex(
      (line, index) => index > scenarioAt && index < end && EXAMPLES_HEADER.test(line),
    );
    const stepEnd = examplesAt >= 0 ? examplesAt : end;
    for (let cursor = scenarioAt + 1; cursor < stepEnd; cursor += 1) {
      if (STEP_PREFIX.test(lines[cursor])) admittedStepLines.add(cursor);
    }
  }
  for (const [index, line] of lines.entries()) {
    if (STEP_PREFIX.test(line) && !admittedStepLines.has(index)) {
      errors.push(
        `${path}:${index + 1}: every step must belong to one tagged Scenario Outline body`,
      );
    }
  }
  const admittedTableLines = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const tag = /^\s*@behavior-(\S+)\s*$/u.exec(lines[index]);
    if (!tag) continue;
    let end = index + 1;
    while (end < lines.length && !/^\s*@behavior-\S+\s*$/u.test(lines[end])) end += 1;
    const block = lines.slice(index + 1, end);
    const scenarioLine = block.findIndex((line) => SCENARIO_HEADER.test(line));
    if (scenarioLine < 0) {
      errors.push(`${path}:${index + 1}: ${tag[1]} has no scenario`);
      continue;
    }
    const titleMatch = /^\s*Scenario Outline:\s*(.+)$/u.exec(block[scenarioLine]);
    if (!titleMatch) {
      errors.push(`${path}:${index + scenarioLine + 2}: ${tag[1]} must use Scenario Outline`);
      continue;
    }
    const steps = [];
    const placeholders = new Set();
    for (const [offset, line] of block.entries()) {
      const step = STEP_PREFIX.exec(line);
      if (!step) continue;
      steps.push({ keyword: step[1], text: step[2], line: index + offset + 2 });
      for (const slot of step[2].matchAll(/<([a-z][a-z0-9_]*)>/gu)) placeholders.add(slot[1]);
    }
    const exampleHeaders = block
      .map((line, offset) => (EXAMPLES_HEADER.test(line) ? offset : -1))
      .filter((offset) => offset >= 0);
    const examplesAt = block.findIndex((line) => /^\s*Examples:/u.test(line));
    let columns = [];
    const exampleRows = [];
    if (exampleHeaders.length !== 1) {
      errors.push(
        `${path}:${index + 1}: ${tag[1]} must have exactly one Examples table, found ${exampleHeaders.length}`,
      );
    }
    if (exampleHeaders.some((offset) => /^\s*Scenarios:/u.test(block[offset]))) {
      errors.push(`${path}:${index + 1}: ${tag[1]} must use the Examples keyword`);
    }
    if (examplesAt < 0) {
      errors.push(`${path}:${index + 1}: ${tag[1]} has no Examples table`);
    } else {
      const tableLines = [];
      for (let cursor = examplesAt + 1; cursor < block.length; cursor += 1) {
        const line = block[cursor];
        if (/^\s*\|/u.test(line)) {
          tableLines.push({ line, offset: cursor });
          admittedTableLines.add(index + cursor + 1);
        } else if (line.trim() !== "" && !/^\s*#/u.test(line)) {
          errors.push(
            `${path}:${index + cursor + 2}: ${tag[1]} has unexpected content after Examples`,
          );
        }
      }
      if (tableLines.length < 2) {
        errors.push(`${path}:${index + examplesAt + 2}: ${tag[1]} needs a header and data row`);
      } else {
        columns = splitTableRow(tableLines[0].line);
        for (const tableLine of tableLines.slice(1)) {
          const cells = splitTableRow(tableLine.line);
          if (cells.length !== columns.length || cells.some((cell) => cell === "")) {
            errors.push(
              `${path}:${index + tableLine.offset + 2}: ${tag[1]} has a malformed Examples row`,
            );
            continue;
          }
          if (cells.some((cell) => namesImplementationInternal(cell))) {
            errors.push(
              `${path}:${index + tableLine.offset + 2}: ${tag[1]} Examples name implementation internals`,
            );
          }
          exampleRows.push(
            Object.fromEntries(columns.map((column, cell) => [column, cells[cell]])),
          );
        }
      }
    }
    scenarios.push({
      id: tag[1],
      title: titleMatch[1],
      path,
      steps,
      placeholders: [...placeholders],
      columns,
      exampleRows,
    });
    index = end - 1;
  }
  for (const [index, line] of lines.entries()) {
    if (/^\s*\|/u.test(line) && !admittedTableLines.has(index)) {
      errors.push(`${path}:${index + 1}: data tables are allowed only in the Examples table`);
    }
  }
  return scenarios;
}
