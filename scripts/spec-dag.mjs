#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoQdExportLifecycleApply,
  loadDag,
  normalizeDag,
  validateDag,
} from "./spec-dag-api.mjs";
import {
  validateFindingDagAction,
  validateAuditReportArtifacts,
  validateAuditReportFiles,
} from "./spec-dag-audit.mjs";
import { dagPath, loadJson } from "./spec-dag-shared.mjs";
import { readyNodes } from "./spec-dag-graph.mjs";
import {
  printAuditReportValidationSummary,
  printDotGraph,
  printIssueSync,
  printNodes,
  printPop,
  printShow,
  printValidationSummary,
} from "./spec-dag-display.mjs";
import {
  printAuditIngestion,
  printClaim,
  printCompletion,
  printUsageAndExit,
  printWorktree,
} from "./spec-dag-lifecycle-cli.mjs";

export {
  assertNoQdExportLifecycleApply,
  loadDag,
  normalizeDag,
  validateDag,
  validateFindingDagAction,
};

if (isMainModule()) {
  runCli(process.argv.slice(2));
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

function runCli(argv) {
  const [command = "validate", ...args] = argv;
  const rawDag = loadJson(dagPath);
  const dag = normalizeDag(rawDag);
  const validation = validateDag(rawDag);
  if (command === "validate") {
    const auditValidation = validateAuditReportArtifacts(dag);
    validation.errors.push(...auditValidation.errors);
    validation.auditReportExampleCount = auditValidation.exampleCount;
  } else if (command === "validate-audit-report") {
    const auditValidation = validateAuditReportFiles(args, dag);
    validation.errors.push(...auditValidation.errors);
    validation.auditReportCount = auditValidation.reportCount;
  }

  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      console.error(error);
    }
    process.exit(1);
  }

  try {
    assertNoQdExportLifecycleApply(command, args, rawDag);
    switch (command) {
      case "validate":
        printValidationSummary(dag, validation);
        break;
      case "validate-audit-report":
        printAuditReportValidationSummary(validation);
        break;
      case "ready":
        printNodes(readyNodes(dag), args);
        break;
      case "pop":
        printPop(dag, args);
        break;
      case "show":
        printShow(dag, args);
        break;
      case "graph":
        printDotGraph(dag);
        break;
      case "sync-issues":
        printIssueSync(dag, args);
        break;
      case "claim":
        printClaim(dag, args);
        break;
      case "worktree":
        printWorktree(dag, args);
        break;
      case "ingest-audit":
        printAuditIngestion(dag, args);
        break;
      case "complete":
        printCompletion(dag, args);
        break;
      default:
        printUsageAndExit();
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
