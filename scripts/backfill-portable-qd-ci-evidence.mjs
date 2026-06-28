#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateDag } from "./spec-dag.mjs";

const defaultRoadmapPath = "roadmap/spec-dag.json";
const localQdLogPathPattern =
  /(?:^|[\s=])(?<path>\.qd\/logs\/|\/[^\s]*\/\.qd\/logs\/|[A-Za-z]:[\\/][^\s]*[\\/]\.qd[\\/]logs[\\/])(?<tail>[^\s]*)/u;
const evidenceLogPathLinePattern = /^Evidence:\s*log_path=(?<path>\S+)\s*$/imu;
const ciLogBasenamePattern =
  /^ci-(?<slug>.+)-(?<date>\d{4}-\d{2}-\d{2})T(?<time>\d{2})-(?<minute>\d{2})-(?<second>\d{2})(?:-\d{3})?Z\.log$/u;
const qdCiReuseSummaryPattern =
  /\b(?:covered by|covered-by|reused|reuse|record-pass|integrated .*?\bci\b|integrated .*?\bqd-full-ci\b)\b/iu;

function main(argv) {
  const options = parseArgs(argv);
  const inputPath = path.resolve(process.cwd(), options.input);
  const outputPath = path.resolve(process.cwd(), options.output ?? options.input);
  const original = readFileSync(inputPath, "utf8");
  const dag = JSON.parse(original);
  const result = backfillPortableQdCiEvidence(dag);

  if (result.changed.length === 0) {
    console.log("No qd CI reuse evidence records required backfill.");
    return;
  }

  const validation = validateDag(dag);
  if (validation.errors.length > 0) {
    throw new Error(
      `backfilled export failed spec-dag validation:\n${validation.errors.join("\n")}`,
    );
  }

  for (const change of result.changed) {
    console.log(`${change.node_id}: ${change.log_path} -> external_id=${change.external_id}`);
  }

  if (!options.apply) {
    console.log(
      `Dry run only. Re-run with --apply to write ${path.relative(process.cwd(), outputPath)}.`,
    );
    return;
  }

  const repaired = applyBackfillToExportText(original, result.changed);
  const repairedValidation = validateDag(JSON.parse(repaired));
  if (repairedValidation.errors.length > 0) {
    throw new Error(
      `text-preserved backfilled export failed spec-dag validation:\n${repairedValidation.errors.join("\n")}`,
    );
  }
  writeFileSync(outputPath, repaired, "utf8");
  console.log(`Backfilled ${result.changed.length} qd CI reuse evidence record(s).`);
}

export function backfillPortableQdCiEvidence(dag) {
  const changed = [];
  if (!Array.isArray(dag.runs)) {
    return { changed };
  }

  for (const [index, run] of dag.runs.entries()) {
    if (!isRecord(run) || !isBackfillableRun(run)) {
      continue;
    }
    const logPath = exportedLogPath(run);
    if (!logPath || !isLocalQdLogPath(logPath)) {
      continue;
    }
    const summary = run.summary;
    const externalId = externalIdForLogPath(logPath);
    run.summary = rewriteEvidenceLine(run.summary, externalId);
    run.log_path = null;
    changed.push({
      index,
      id: run.id,
      node_id: run.node_id,
      old_summary: summary,
      new_summary: run.summary,
      log_path: logPath,
      external_id: externalId,
    });
  }

  return { changed };
}

export function applyBackfillToExportText(jsonText, changes) {
  let output = jsonText;
  for (const change of changes) {
    const summarySearch = JSON.stringify(change.old_summary);
    const summaryReplacement = JSON.stringify(change.new_summary);
    const summaryIndex = output.indexOf(summarySearch);
    if (summaryIndex < 0) {
      throw new Error(`backfill replacement target not found: ${summarySearch}`);
    }
    output = replaceAt(output, summaryIndex, summarySearch.length, summaryReplacement);
    const afterSummaryIndex = summaryIndex + summaryReplacement.length;
    output = replacePatternOnceAfter(
      output,
      new RegExp(`("log_path"\\s*:\\s*)${escapeRegExp(JSON.stringify(change.log_path))}`, "u"),
      (match) => `${match[1]}null`,
      afterSummaryIndex,
    );
  }
  return output;
}

function parseArgs(argv) {
  const options = { input: defaultRoadmapPath, output: null, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--input" || arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--input=")) {
      options.input = arg.slice("--input=".length);
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  return options;
}

function isBackfillableRun(run) {
  return (
    run.kind === "ci" &&
    run.status === "passed" &&
    typeof run.summary === "string" &&
    qdCiReuseSummaryPattern.test(run.summary)
  );
}

function exportedLogPath(run) {
  if (typeof run.log_path === "string" && run.log_path.length > 0) {
    return run.log_path;
  }
  return run.summary.match(evidenceLogPathLinePattern)?.groups?.path ?? null;
}

function rewriteEvidenceLine(summary, externalId) {
  const replacement = `Evidence: external_id=${externalId}`;
  if (evidenceLogPathLinePattern.test(summary)) {
    return summary.replace(evidenceLogPathLinePattern, replacement);
  }
  return `${summary.trimEnd()}\n${replacement}`;
}

function externalIdForLogPath(logPath) {
  const basename = path.basename(logPath.replaceAll("\\", "/"));
  const match = basename.match(ciLogBasenamePattern);
  if (!match?.groups) {
    return `local-qdfullci:${basename.replace(/\.log$/u, "")}`;
  }
  const timestamp = `${match.groups.date}T${match.groups.time}-${match.groups.minute}-${match.groups.second}Z`;
  return `local-qdfullci:${match.groups.slug}:${timestamp}`;
}

function isLocalQdLogPath(value) {
  return localQdLogPathPattern.test(` ${value}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceAt(value, index, length, replacement) {
  return `${value.slice(0, index)}${replacement}${value.slice(index + length)}`;
}

function replacePatternOnceAfter(value, pattern, replacement, startIndex) {
  const suffix = value.slice(startIndex);
  const match = pattern.exec(suffix);
  if (!match) {
    throw new Error(`backfill replacement target not found: ${pattern}`);
  }
  const replacementText = typeof replacement === "function" ? replacement(match) : replacement;
  const index = startIndex + match.index;
  return replaceAt(value, index, match[0].length, replacementText);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
