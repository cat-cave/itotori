import {
  AUTH_ROLE_MAP_NAMES,
  AUTH_ROLE_NAMES,
  AUTH_SUBJECT_OBJECTS,
  LABELS,
  markerOnLineOrAbove,
} from "./audit-no-hardcoded-roles-shared.mjs";

const AUTH_ROLE_NAME_ALTERNATION = [...AUTH_ROLE_NAMES].join("|");
const RUST_AUTH_MAP_ALTERNATION = [...AUTH_ROLE_MAP_NAMES]
  .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
  .join("|");
const RUST_SUBJECT_ALTERNATION = [...AUTH_SUBJECT_OBJECTS].join("|");
const RUST_LINE_PATTERNS = [
  {
    label: LABELS.subject,
    regex: new RegExp(`\\b(?:${RUST_SUBJECT_ALTERNATION})\\.role\\b`, "iu"),
  },
  {
    label: LABELS.comparison,
    regex: new RegExp(
      `(?:(?:[\\w.]*\\.)?\\brole\\b\\s*(?:==|!=)\\s*"(?:${AUTH_ROLE_NAME_ALTERNATION})")` +
        `|(?:"(?:${AUTH_ROLE_NAME_ALTERNATION})"\\s*(?:==|!=)\\s*(?:[\\w.]*\\.)?\\brole\\b)`,
      "iu",
    ),
  },
  {
    label: LABELS.lookup,
    regex: new RegExp(`\\b(?:${RUST_AUTH_MAP_ALTERNATION})\\s*\\[\\s*[\\w.]*\\brole\\b`, "u"),
  },
  { label: LABELS.isAdmin, regex: /\bis_?[Aa]dmin\b/u },
  { label: LABELS.hasRole, regex: /\bhas_?[Rr]ole\s*\(/u },
];
const RUST_MATCH_REGEX = new RegExp(
  `match\\s+[\\w.()&*\\s]*\\brole\\b[^\\{]*\\{[\\s\\S]*?"(?:${AUTH_ROLE_NAME_ALTERNATION})"\\s*=>`,
  "u",
);

function isCommentLine(trimmed) {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("#")
  );
}

export function findRustViolations(path, contents, lines) {
  const found = [];
  const seen = new Set();
  const push = (lineIndex, label) => {
    if (markerOnLineOrAbove(lines, lineIndex)) return;
    const key = `${lineIndex}::${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      file: path,
      line: lineIndex + 1,
      pattern: label,
      excerpt: (lines[lineIndex] ?? "").trim().slice(0, 200),
    });
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (isCommentLine(line.trim())) continue;
    for (const pattern of RUST_LINE_PATTERNS) {
      if (pattern.regex.test(line)) push(lineIndex, pattern.label);
    }
  }
  if (RUST_MATCH_REGEX.test(contents)) {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (/\bmatch\s+[\w.()&*\s]*\brole\b/u.test(lines[lineIndex])) {
        push(lineIndex, LABELS.switch);
        break;
      }
    }
  }
  return found;
}
