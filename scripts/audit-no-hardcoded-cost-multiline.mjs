// Shared line classification and multiline scanners for the cost audit.

// The per-line comment prefixes that mark a line as commentary rather than
// real code/data. Shared by the per-line pass and the block scanners.
export function isCommentLine(trimmed) {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("#")
  );
}

// The per-line audit-allow escape hatch: `// cost-audit-allow: <reason>`
// with a non-empty reason. Shared by all passes.
export function hasAuditAllowMarker(line) {
  return /cost-audit-allow:\s*\S/u.test(line);
}

// Multi-line-aware scan for keyed numeric cost literals.
//
// The per-line loop cannot see a formatter-split property like:
//     amountMicrosUsd:
//       12_500,
// or:
//     cost:
//       0.0125,
// because the key and numeric literal live on different physical lines. For
// these value forms we locate the key opener, join a small continuation window
// into one logical line, then apply the same regex the per-line pass used.
// This subsumes the single-line case, so keyed-value patterns are removed from
// the per-line loop via `keyValueForm` to avoid double-reporting. Reported
// against the line the key opens on.
export function findKeyedValueViolations(path, lines, pattern, costLiteralAllowed) {
  if (costLiteralAllowed) return [];
  const found = [];
  const openRe = pattern.keyOpenRegex;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (isCommentLine(trimmed)) continue;
    const opener = openRe.exec(lines[i]);
    if (!opener) continue;

    let markerSeen = false;
    let joined = "";
    for (let j = i; j < lines.length && j <= i + 4; j += 1) {
      if (hasAuditAllowMarker(lines[j])) markerSeen = true;
      const seg = j === i ? lines[j].slice(opener.index) : lines[j];
      if (j > i && isCommentLine(seg.trim())) continue;
      joined += ` ${seg}`;
      if (j > i && /\S/u.test(seg)) break;
    }

    if (markerSeen) continue;
    if (pattern.regex.test(joined)) {
      found.push({
        file: path,
        line: i + 1,
        pattern: pattern.label,
        excerpt: trimmed.slice(0, 200),
      });
    }
  }
  return found;
}

// Multi-line-aware scan for object-form `costUsd` cost literals.
//
// Prettier can split a large `costUsd: { unit: "usd", amount: "0.0125" }`
// object across several lines, in which case the `amount:` line stands alone
// with no `cost` token and the per-line pass matches NOTHING. Here we locate
// each `costUsd: {` opener, walk forward accumulating lines until the object's
// braces balance, JOIN the block into one logical line, and apply the same
// costUsd-object regex. Because we anchor on `costUsd: {` and only join up to
// its matching `}`, an unrelated `amount:` outside a costUsd object is never
// considered — no false positives on token counts / versions / UI dimensions.
//
// This subsumes the single-line case too (the object simply balances on its
// opening line), so the pattern is removed from the per-line loop via its
// `objectForm` flag to avoid double-reporting. Reported against the line the
// object opens on.
export function findCostUsdObjectViolations(path, lines, pattern, costLiteralAllowed) {
  if (costLiteralAllowed) return [];
  const found = [];
  const openRe = /["'`]?costUsd["'`]?\s*:\s*\{/u;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (isCommentLine(trimmed)) continue;
    const opener = openRe.exec(lines[i]);
    if (!opener) continue;
    // Walk forward from the matched `{`, balancing braces, until the object
    // closes; join the block (newlines flattened to spaces) for matching.
    let depth = 0;
    let started = false;
    let markerSeen = false;
    let joined = "";
    for (let j = i; j < lines.length; j += 1) {
      if (hasAuditAllowMarker(lines[j])) markerSeen = true;
      const seg = j === i ? lines[j].slice(opener.index) : lines[j];
      joined += ` ${seg}`;
      for (const ch of seg) {
        if (ch === "{") {
          depth += 1;
          started = true;
        } else if (ch === "}") {
          depth -= 1;
        }
      }
      if (started && depth <= 0) break;
    }
    // A per-line audit-allow marker anywhere in the object block opts it out,
    // matching the per-line pass's single-line behaviour.
    if (markerSeen) continue;
    if (pattern.regex.test(joined)) {
      found.push({
        file: path,
        line: i + 1,
        pattern: pattern.label,
        excerpt: trimmed.slice(0, 200),
      });
    }
  }
  return found;
}
