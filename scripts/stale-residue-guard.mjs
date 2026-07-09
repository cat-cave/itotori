#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const checkedSourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".rs"]);
const checkedTextExtensions = new Set([".md"]);
const historicalMarkdownPrefixes = [
  ".plan/",
  "docs/audits/",
  "docs/proposals/",
  "docs/research/",
  "roadmap/",
];

const stalePremiseRules = [
  {
    id: "reallive-new-game-undecoded",
    pattern: /\bNew-Game routine (?:does not|does NOT|doesn't) decode\b/u,
    reason: "scene 9996 now decodes cleanly; do not preserve the old undecoded premise",
  },
  {
    id: "resolved-malformed-expression-offset",
    pattern: /\bMalformedExpression\s*@~?offset\s*271\b|\bMalformedExpression@271\b/u,
    reason:
      "the scene-9996 MalformedExpression lead is resolved and must not appear as active guidance",
    allowWhen: /\b(?:stale|resolved|historical|snapshot|superseded)\b/iu,
  },
  {
    id: "retired-localize-sweetie-hd-preset",
    pattern: /\bpresets\/localize-sweetie-hd\.pair-policy\.json\b/u,
    reason:
      "generic localize-project target data replaced the retired Sweetie-specific preset path",
    allowWhen: /\b(?:retired|superseded|historical|removed|stale|repair|no longer)\b/iu,
  },
  {
    id: "deleted-qd-wrapper-test",
    pattern: /\bscripts\/qd-wrapper\.test\.mjs\b/u,
    reason:
      "qd-wrapper-era tests were removed; active roadmap text must point at surviving qdcli-native evidence",
    allowWhen: /\b(?:removed|stale|historical|repair|no such file|returns 0|missing)\b/iu,
  },
];

const datedTracePattern =
  /\b(?:Traced|INVESTIGATION|REAL-BYTES GAP|GAP)\b[^.\n]{0,120}\b20\d\d-\d\d-\d\d\b|\b20\d\d-\d\d-\d\d\b[^.\n]{0,120}\b(?:Traced|INVESTIGATION|REAL-BYTES GAP|GAP)\b/u;
const datedTraceMarkers =
  /\b(?:snapshot|point-in-time|historical|as of|observed|traced|audit|preserved|resolved|landed|current)\b/iu;

export function parseArgs(argv) {
  const options = {
    mode: "check",
    root: repoRoot,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      index += 1;
      options.mode = argv[index];
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--root") {
      index += 1;
      options.root = resolve(argv[index]);
    } else if (arg.startsWith("--root=")) {
      options.root = resolve(arg.slice("--root=".length));
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!["report", "check"].includes(options.mode)) {
    throw new Error(`--mode must be report or check, got: ${options.mode}`);
  }

  return options;
}

export function listTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || "git ls-files failed").trim());
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function scanStaleResidue({
  root,
  files,
  readFile = (path) => readFileSync(resolve(root, path), "utf8"),
  pathExists = (path) => existsSync(resolve(root, path)),
}) {
  const violations = [];
  const exportedSymbols = collectExportedSymbols({ files, readFile });

  for (const file of files) {
    const extension = extname(file);
    if (checkedTextExtensions.has(extension)) {
      const text = readFile(file);
      scanTextForStalePremises(violations, file, text, "doc");
      if (isActiveMarkdownFile(file)) {
        scanMarkdownLinks(violations, root, file, text, pathExists);
      }
    } else if (checkedSourceExtensions.has(extension)) {
      const comments = extractComments(readFile(file), extension);
      scanTextForStalePremises(violations, file, comments, "comment");
    }
  }

  scanUtsushiFacadeDocSymbols({ violations, files, readFile, exportedSymbols });
  scanRoadmapQdText({ violations, files, readFile });

  return {
    violations,
    scannedFiles: files.length,
  };
}

function collectExportedSymbols({ files, readFile }) {
  const symbols = new Set();
  for (const file of files) {
    const extension = extname(file);
    if (!checkedSourceExtensions.has(extension)) {
      continue;
    }
    const text = readFile(file);
    if (extension === ".rs") {
      for (const match of text.matchAll(
        /\bpub\s+(?:struct|enum|trait|fn|const|type)\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
      )) {
        symbols.add(match[1]);
      }
      for (const match of text.matchAll(/\bpub\s+use\s+[^;{]+::\{([^}]+)\}/gu)) {
        for (const raw of match[1].split(",")) {
          const symbol = raw
            .trim()
            .split(/\s+as\s+/u)
            .pop()
            ?.trim();
          if (symbol !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(symbol)) {
            symbols.add(symbol);
          }
        }
      }
    } else {
      for (const match of text.matchAll(
        /\bexport\s+(?:declare\s+)?(?:const|class|function|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
      )) {
        symbols.add(match[1]);
      }
      for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/gu)) {
        for (const raw of match[1].split(",")) {
          const symbol = raw
            .trim()
            .split(/\s+as\s+/u)
            .pop()
            ?.trim();
          if (symbol !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(symbol)) {
            symbols.add(symbol);
          }
        }
      }
    }
  }
  return symbols;
}

function extractComments(text, extension) {
  if (!checkedSourceExtensions.has(extension)) {
    return "";
  }
  const chunks = [];
  for (const line of text.split(/\r?\n/u)) {
    const lineComment = line.match(/^\s*(?:\/\/!|\/\/\/|\/\/)\s?(.*)$/u);
    if (lineComment !== null) {
      chunks.push(lineComment[1]);
      continue;
    }
    const blockLine = line.match(/^\s*\*\s?(.*)$/u);
    if (blockLine !== null) {
      chunks.push(blockLine[1]);
    }
  }
  for (const match of text.matchAll(/\/\*+([\s\S]*?)\*\//gu)) {
    chunks.push(match[1]);
  }
  return chunks.join("\n");
}

function scanTextForStalePremises(violations, file, text, surface) {
  for (const rule of stalePremiseRules) {
    if (rule.pattern.test(text) && !(rule.allowWhen?.test(text) ?? false)) {
      violations.push({
        file,
        surface,
        rule: rule.id,
        reason: rule.reason,
      });
    }
  }

  for (const match of text.matchAll(new RegExp(datedTracePattern.source, "gu"))) {
    const context = text.slice(
      Math.max(0, match.index - 80),
      Math.min(text.length, match.index + match[0].length + 80),
    );
    if (!datedTraceMarkers.test(context)) {
      violations.push({
        file,
        surface,
        rule: "dated-trace-without-snapshot-marker",
        reason:
          "dated investigation traces must be marked as snapshots, historical, observed, or resolved",
      });
    }
  }
}

function scanMarkdownLinks(violations, root, file, text, pathExists) {
  const linkText = stripFencedCodeBlocks(text);
  for (const match of linkText.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    const rawTarget = match[1].trim().split(/\s+/u)[0];
    if (rawTarget === "" || isExternalTarget(rawTarget) || rawTarget.startsWith("#")) {
      continue;
    }
    const target = stripAnchor(rawTarget);
    if (target === "") {
      continue;
    }
    const repoPath = normalizeRepoPath(file, dirname(file), target);
    if (repoPath !== null && !pathExists(repoPath)) {
      violations.push({
        file,
        surface: "doc-link",
        rule: "missing-doc-link-target",
        reason: `markdown link target does not exist: ${target} -> ${repoPath}`,
      });
    }
  }
}

function stripFencedCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/gu, "");
}

function scanUtsushiFacadeDocSymbols({ violations, files, readFile, exportedSymbols }) {
  const docPath = "docs/utsushi-substrate-facade.md";
  if (!files.includes(docPath)) {
    return;
  }
  const text = readFile(docPath);
  const section = text.split("## 2. Subsystem entry points")[1]?.split("## 3.")[0] ?? "";
  const citedSymbols = new Set();
  for (const line of section.split(/\r?\n/u)) {
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line.split("|").map((cell) => cell.trim());
    const canonicalCell = cells[3] ?? "";
    for (const match of canonicalCell.matchAll(/`([^`]+)`/gu)) {
      const symbol = match[1].trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(symbol)) {
        citedSymbols.add(symbol);
      }
    }
  }
  for (const symbol of citedSymbols) {
    if (!exportedSymbols.has(symbol)) {
      violations.push({
        file: docPath,
        surface: "doc-symbol",
        rule: "missing-exported-symbol",
        reason: `documented Utsushi facade symbol is not exported anywhere in tracked source: ${symbol}`,
      });
    }
  }
}

function scanRoadmapQdText({ violations, files, readFile }) {
  if (!files.includes("roadmap/spec-dag.json")) {
    return;
  }
  let dag;
  try {
    dag = JSON.parse(readFile("roadmap/spec-dag.json"));
  } catch (error) {
    violations.push({
      file: "roadmap/spec-dag.json",
      surface: "qd-text",
      rule: "roadmap-json-unreadable",
      reason: `cannot parse roadmap/spec-dag.json: ${error.message}`,
    });
    return;
  }
  const nodesById = new Map((dag.nodes ?? []).map((node) => [node.id, node]));
  for (const node of dag.nodes ?? []) {
    if (["done", "cancelled"].includes(node.status)) {
      continue;
    }
    const fields = [
      ["spec", node.spec],
      ["acceptance", node.acceptance],
      ["status_reason", node.status_reason],
      ...(Array.isArray(node.verification)
        ? node.verification.map((entry, index) => [`verification[${index}]`, entry?.value])
        : []),
    ];
    for (const [field, value] of fields) {
      scanQdTextValue(violations, node.id, field, value);
    }
  }
  for (const note of dag.node_notes ?? []) {
    const node = nodesById.get(note.node_id);
    if (node !== undefined && ["done", "cancelled"].includes(node.status)) {
      continue;
    }
    scanQdTextValue(violations, note.node_id, "node_note", note.text);
  }
}

function scanQdTextValue(violations, nodeId, field, value) {
  if (typeof value !== "string" || value.length === 0) {
    return;
  }
  for (const rule of stalePremiseRules) {
    if (rule.pattern.test(value) && !(rule.allowWhen?.test(value) ?? false)) {
      violations.push({
        file: "roadmap/spec-dag.json",
        surface: "qd-text",
        rule: rule.id,
        reason: `${nodeId} ${field}: ${rule.reason}`,
      });
    }
  }
}

function isExternalTarget(target) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(target) || /^[a-z][a-z0-9+.-]*:/iu.test(target);
}

function stripAnchor(path) {
  return path.split("#")[0];
}

function stripLineSuffix(path) {
  return path.replace(/:\d+(?::\d+)?$/u, "");
}

function normalizeRepoPath(file, fromDir, target) {
  const cleaned = stripLineSuffix(target);
  if (isAbsolute(cleaned)) {
    return null;
  }
  const normalized = normalize(resolvePathPosix(fromDir, cleaned));
  if (normalized.startsWith(`..${sep}`) || normalized === "..") {
    return null;
  }
  if (file.startsWith("docs/") && normalized.startsWith("docs/docs/")) {
    return normalized.slice("docs/".length);
  }
  return normalized.split(sep).join("/");
}

function isActiveMarkdownFile(file) {
  return !historicalMarkdownPrefixes.some((prefix) => file.startsWith(prefix));
}

function resolvePathPosix(fromDir, target) {
  return normalize(`${fromDir}/${target}`);
}

export function renderReport(result) {
  const lines = [];
  const count = result.violations.length;
  lines.push(`stale residue guard: ${count} violation${count === 1 ? "" : "s"} found`);
  lines.push(`tracked files scanned: ${result.scannedFiles}`);
  if (count === 0) {
    lines.push("");
    lines.push("no stale residue violations found");
    return `${lines.join("\n")}\n`;
  }
  lines.push("");
  lines.push("violations:");
  for (const violation of result.violations) {
    lines.push(`  - ${violation.file} [${violation.surface}/${violation.rule}]`);
    lines.push(`    ${violation.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "usage: node scripts/stale-residue-guard.mjs [--mode check|report] [--root <DIR>]",
    "",
    "Fails on high-risk stale comments/docs/qd text, missing doc path targets, and stale documented facade symbols.",
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = scanStaleResidue({
    root: options.root,
    files: listTrackedFiles(options.root),
  });
  process.stdout.write(renderReport(result));
  if (options.mode === "check" && result.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[stale-residue-guard] FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
