import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SLASH_COMMENT_EXTENSIONS = new Set(["rs", "ts", "tsx", "js", "mjs", "cjs", "jsonc"]);

function supportsSlashComments(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  return SLASH_COMMENT_EXTENSIONS.has(path.slice(dot + 1));
}

// Blanks the comment portions of a line (preserving column positions) so a
// token match can be classified as code vs comment. Carries block-comment
// state across lines. Comments are historical/research "memory of real games"
// documentation and are allowed on any surface.
export function stripComments(line, inBlock) {
  const out = line.split("");
  const length = line.length;
  let index = 0;
  let stringDelimiter = null;
  let block = inBlock;

  while (index < length) {
    const char = line[index];
    const next = line[index + 1];

    if (block) {
      if (char === "*" && next === "/") {
        out[index] = " ";
        out[index + 1] = " ";
        block = false;
        index += 2;
        continue;
      }
      out[index] = " ";
      index += 1;
      continue;
    }

    if (stringDelimiter) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === stringDelimiter) {
        stringDelimiter = null;
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      stringDelimiter = char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      for (let blank = index; blank < length; blank += 1) {
        out[blank] = " ";
      }
      break;
    }

    if (char === "/" && next === "*") {
      out[index] = " ";
      out[index + 1] = " ";
      block = true;
      index += 2;
      continue;
    }

    index += 1;
  }

  return { code: out.join(""), inBlockNext: block };
}

export function buildMatchers(groups) {
  return groups.flatMap((group) =>
    group.tokens.map((token) => ({
      groupId: group.id,
      label: group.label,
      token,
      pattern: new RegExp(escapeRegExp(token), group.caseSensitive ? "gu" : "giu"),
    })),
  );
}

export function scanFiles({
  root,
  files,
  readFile = (path) => readFileSync(resolve(root, path), "utf8"),
  surfaces,
  forbiddenTokens,
  isEnvPath,
  classifySurface,
}) {
  const matchers = buildMatchers(forbiddenTokens);
  const active = [];
  const historical = [];
  let scannedFileCount = 0;
  let skippedEnvFileCount = 0;
  let historicalSurfaceFileCount = 0;

  for (const file of files) {
    if (isEnvPath(file)) {
      skippedEnvFileCount += 1;
      continue;
    }

    const surface = classifySurface(file, surfaces);
    if (surface) {
      historicalSurfaceFileCount += 1;
    }
    const record = (violation) => {
      if (surface) {
        historical.push({
          ...violation,
          classification: "historical-surface",
          reason: surface.reason,
        });
      } else if (violation.comment) {
        historical.push({
          ...violation,
          classification: "historical-comment",
          reason: "in-source comment",
        });
      } else {
        active.push({ ...violation, classification: "active-surface" });
      }
    };

    for (const match of matchesForText(file, matchers)) {
      record({
        path: file,
        location: "filename",
        line: null,
        label: match.label,
        token: match.token,
        excerpt: file,
        comment: false,
      });
    }

    let contents;
    try {
      contents = readFile(file);
    } catch {
      continue;
    }

    scannedFileCount += 1;
    const slashComments = supportsSlashComments(file);
    const lines = contents.split(/\r?\n/u);
    let inBlock = false;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      let codeLine = line;
      if (slashComments) {
        const stripped = stripComments(line, inBlock);
        codeLine = stripped.code;
        inBlock = stripped.inBlockNext;
      }
      for (const match of matchesForText(line, matchers)) {
        const isComment =
          slashComments &&
          codeLine.slice(match.start, match.end).trim() !==
            line.slice(match.start, match.end).trim();
        record({
          path: file,
          location: "content",
          line: lineIndex + 1,
          label: match.label,
          token: match.token,
          excerpt: line.trim().slice(0, 220),
          comment: isComment,
        });
      }
    }
  }

  return {
    active,
    historical,
    scannedFileCount,
    historicalSurfaceFileCount,
    skippedEnvFileCount,
  };
}

export function renderReport(result, { mode = "check" } = {}) {
  const lines = [];
  const activeCount = result.active.length;
  const historicalCount = result.historical.length;

  lines.push(
    `generalization-purge gate: ${activeCount} active-surface leak${activeCount === 1 ? "" : "s"} found`,
  );
  lines.push(
    `scanned ${result.scannedFileCount} tracked file${result.scannedFileCount === 1 ? "" : "s"}; classified ${historicalCount} historical/research reference${historicalCount === 1 ? "" : "s"} across ${result.historicalSurfaceFileCount} allowlisted surface file${result.historicalSurfaceFileCount === 1 ? "" : "s"}; skipped ${result.skippedEnvFileCount} env file${result.skippedEnvFileCount === 1 ? "" : "s"}`,
  );

  if (activeCount === 0) {
    lines.push("no active-surface title/vendor leaks found");
    return `${lines.join("\n")}\n`;
  }

  lines.push("");
  lines.push(
    "active-surface title references are generalization leaks: move the reference to a classified historical/research surface or remove it.",
  );

  const byPath = new Map();
  for (const violation of result.active) {
    const current = byPath.get(violation.path) ?? [];
    current.push(violation);
    byPath.set(violation.path, current);
  }

  for (const [path, pathViolations] of [...byPath.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push("");
    lines.push(path);
    for (const violation of pathViolations) {
      const location = violation.line === null ? violation.location : `line ${violation.line}`;
      lines.push(`  - ${location}: ${violation.label} (${violation.token})`);
      if (violation.excerpt) {
        lines.push(`    ${violation.excerpt}`);
      }
    }
  }

  if (mode === "check") {
    lines.push("");
    lines.push("gate FAILED: active-surface generalization leaks must be resolved");
  }

  return `${lines.join("\n")}\n`;
}

function matchesForText(text, matchers) {
  const matches = [];
  for (const matcher of matchers) {
    matcher.pattern.lastIndex = 0;
    for (const match of text.matchAll(matcher.pattern)) {
      matches.push({
        ...matcher,
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      });
    }
  }

  matches.sort((left, right) => {
    const lengthDelta = right.end - right.start - (left.end - left.start);
    return lengthDelta || left.start - right.start || left.token.localeCompare(right.token);
  });

  const selected = [];
  for (const match of matches) {
    if (selected.some((existing) => rangesOverlap(existing, match))) {
      continue;
    }
    selected.push(match);
  }

  return selected.sort((left, right) => left.start - right.start);
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}
