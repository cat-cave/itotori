import {
  applyAuditIngestionPlan,
  applyClaim,
  applyClaimRelease,
  applyCompletionPlan,
  applyWorktreePlan,
  createAuditIngestionPlan,
  createClaimPlan,
  createClaimReleasePlan,
  createCompletionPlan,
  createWorktreePlan,
  defaultBranchForNode,
  defaultClaimLockDir,
  defaultWorktreeForNode,
} from "./spec-dag-lifecycle.mjs";
import { loadValidatedAuditReport } from "./spec-dag-audit.mjs";
import { validateDag } from "./spec-dag-api.mjs";
import { dagPath, root } from "./spec-dag-shared.mjs";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function printClaim(value, args) {
  const options = parseClaimArgs(args);
  if (options.help) {
    printClaimUsage();
    return;
  }

  const plan = options.release
    ? options.apply
      ? applyClaimRelease({
          dagPath,
          lockDir: options.lockDir,
          nodeId: options.nodeId,
          owner: options.owner,
          branch: options.branch,
          worktree: options.worktree,
        })
      : createClaimReleasePlan(value, options.nodeId, options)
    : options.apply
      ? applyClaim({
          dagPath,
          lockDir: options.lockDir,
          nodeId: options.nodeId,
          owner: options.owner,
          branch: options.branch,
          worktree: options.worktree,
          forceStale: options.forceStale,
          staleAfterHours: options.staleAfterHours,
        })
      : createClaimPlan(value, options.nodeId, options);
  printLifecyclePlan(plan, options);
}

export function parseClaimArgs(args) {
  validateArgs(args, {
    commandName: "claim",
    booleanFlags: new Set([
      "--apply",
      "--dry-run",
      "--json",
      "--help",
      "--release",
      "--force-stale",
    ]),
    valueFlags: new Set(["--owner", "--branch", "--worktree", "--lock-dir", "--stale-after-hours"]),
    positionalCount: 1,
  });
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("claim accepts either --dry-run or --apply, not both");
  }
  if (args.includes("--release") && args.includes("--force-stale")) {
    throw new Error("claim accepts either --release or --force-stale, not both");
  }
  const nodeId = positionalArgs(args)[0];
  if (!nodeId && !args.includes("--help")) {
    throw new Error("usage: spec-dag claim NODE-ID --owner OWNER [--apply]");
  }
  const staleAfterHours = numberFlag(args, "--stale-after-hours", 24);
  if (staleAfterHours <= 0) {
    throw new Error("--stale-after-hours must be greater than 0");
  }
  return {
    apply: args.includes("--apply"),
    branch: flag(args, "--branch") ?? (nodeId ? defaultBranchForNode(nodeId) : undefined),
    forceStale: args.includes("--force-stale"),
    help: args.includes("--help"),
    json: args.includes("--json"),
    lockDir: flag(args, "--lock-dir") ?? defaultClaimLockDir(root),
    nodeId,
    owner: flag(args, "--owner"),
    release: args.includes("--release"),
    staleAfterHours,
    worktree: flag(args, "--worktree") ?? (nodeId ? defaultWorktreeForNode(nodeId) : undefined),
  };
}

export function printClaimUsage() {
  console.log(`usage: spec-dag claim NODE-ID --owner OWNER [--apply] [--json]

Atomically claims a ready planned node by creating a local claim lock and, only
with --apply, updating roadmap/spec-dag.json to in_progress. Without --apply it
prints a dry-run plan and creates no lock. Lock recovery is explicit: --release
removes a lock only when --owner matches the lock metadata and clears matching
in_progress DAG ownership; --force-stale may remove a lock only after its
claimedAt age exceeds staleAfterHours, then reacquires the lock atomically.
Completion --apply retires the completed node's lock after the DAG write.

Options:
  --owner OWNER       required stable owner string
  --branch BRANCH     default: spec/<node-id-lower>
  --worktree PATH     default: /scratch/worktrees/itotori-spec-<node-id-lower>
  --lock-dir DIR      default: /tmp/itotori-spec-dag-claims/<repo-hash>
  --release           explicitly release a matching claim lock and DAG claim
  --force-stale       recover an expired stale lock before claiming
  --stale-after-hours HOURS
                      default: 24; lock age required for --force-stale
  --dry-run           explicit non-mutating mode
  --apply             create the atomic lock and update DAG metadata
  --json              render machine-readable output`);
}

export function printWorktree(value, args) {
  const options = parseWorktreeArgs(args);
  if (options.help) {
    printWorktreeUsage();
    return;
  }
  const plan = createWorktreePlan(value, options.nodeId, options);
  const result = options.apply ? applyWorktreePlan(plan) : plan;
  printLifecyclePlan(result, options);
}

export function parseWorktreeArgs(args) {
  validateArgs(args, {
    commandName: "worktree",
    booleanFlags: new Set(["--apply", "--dry-run", "--json", "--help"]),
    valueFlags: new Set(["--base", "--branch", "--worktree"]),
    positionalCount: 1,
  });
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("worktree accepts either --dry-run or --apply, not both");
  }
  const nodeId = positionalArgs(args)[0];
  if (!nodeId && !args.includes("--help")) {
    throw new Error("usage: spec-dag worktree NODE-ID [--apply]");
  }
  return {
    apply: args.includes("--apply"),
    base: flag(args, "--base") ?? "main",
    branch: flag(args, "--branch") ?? (nodeId ? defaultBranchForNode(nodeId) : undefined),
    help: args.includes("--help"),
    json: args.includes("--json"),
    nodeId,
    worktree: flag(args, "--worktree") ?? (nodeId ? defaultWorktreeForNode(nodeId) : undefined),
  };
}

export function printWorktreeUsage() {
  console.log(`usage: spec-dag worktree NODE-ID [--apply] [--json]

Prepares the canonical git worktree command for a DAG node. Without --apply it
prints the command sequence only. With --apply it runs git worktree add only for
legacy native DAG fixtures; canonical qd export state refuses --apply.

Options:
  --base REF           default: main
  --branch BRANCH      default: spec/<node-id-lower>
  --worktree PATH      default: /scratch/worktrees/itotori-spec-<node-id-lower>
  --dry-run            explicit non-mutating mode
  --apply              run git worktree add
  --json               render machine-readable output`);
}

export function printAuditIngestion(value, args) {
  const options = parseAuditIngestionArgs(args);
  if (options.help) {
    printAuditIngestionUsage();
    return;
  }
  const report = loadValidatedAuditReport(options.reportPath, value);
  let plan = createAuditIngestionPlan(value, report, options);
  if (options.apply) {
    plan = applyAuditIngestionPlan({
      dagPath,
      plan,
      applyFollowUps: options.applyFollowUps,
    });
  }
  if (options.followUpsPath) {
    writeFileSync(
      resolve(process.cwd(), options.followUpsPath),
      `${JSON.stringify(plan.followUps, null, 2)}\n`,
    );
  }
  printLifecyclePlan(plan, options);
}

export function parseAuditIngestionArgs(args) {
  validateArgs(args, {
    commandName: "ingest-audit",
    booleanFlags: new Set(["--apply", "--apply-follow-ups", "--dry-run", "--json", "--help"]),
    valueFlags: new Set(["--follow-ups"]),
    positionalCount: 1,
  });
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("ingest-audit accepts either --dry-run or --apply, not both");
  }
  const reportPath = positionalArgs(args)[0];
  if (!reportPath && !args.includes("--help")) {
    throw new Error("usage: spec-dag ingest-audit REPORT.json [--apply]");
  }
  if (args.includes("--apply-follow-ups") && !args.includes("--apply")) {
    throw new Error("ingest-audit --apply-follow-ups requires --apply");
  }
  return {
    apply: args.includes("--apply"),
    applyFollowUps: args.includes("--apply-follow-ups"),
    followUpsPath: flag(args, "--follow-ups"),
    help: args.includes("--help"),
    json: args.includes("--json"),
    reportPath,
  };
}

export function printAuditIngestionUsage() {
  console.log(`usage: spec-dag ingest-audit REPORT.json [--apply] [--json]

Validates and ingests an audit report. Default mode is dry-run. P0/P1 findings
produce a schema-valid blocked repair patch for the audited node. P2/P3 findings
produce draft DAG node payloads or append updates without hand-copying.

Options:
  --follow-ups FILE       write generated P2/P3 follow-up payload JSON
  --dry-run               explicit non-mutating mode
  --apply                 apply the P0/P1 repair-state patch to roadmap/spec-dag.json
  --apply-follow-ups      also append generated P2/P3 follow-up changes to the DAG
  --json                  render machine-readable output`);
}

export function printCompletion(value, args) {
  const options = parseCompletionArgs(args);
  if (options.help) {
    printCompletionUsage();
    return;
  }
  const report = options.auditPath ? loadValidatedAuditReport(options.auditPath, value) : undefined;
  let plan = createCompletionPlan(value, options.nodeId, {
    apply: options.apply,
    followUpsRecorded: options.followUpsRecorded,
    lockDir: options.lockDir,
    report,
  });
  if (options.apply) {
    plan = applyCompletionPlan({ dagPath, plan, validateDag });
  }
  printLifecyclePlan(plan, options);
  if (!plan.canApply && options.apply) {
    process.exit(1);
  }
}

export function parseCompletionArgs(args) {
  validateArgs(args, {
    commandName: "complete",
    booleanFlags: new Set(["--apply", "--dry-run", "--follow-ups-recorded", "--json", "--help"]),
    valueFlags: new Set(["--audit", "--lock-dir"]),
    positionalCount: 1,
  });
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("complete accepts either --dry-run or --apply, not both");
  }
  const nodeId = positionalArgs(args)[0];
  if (!nodeId && !args.includes("--help")) {
    throw new Error("usage: spec-dag complete NODE-ID --audit REPORT.json [--apply]");
  }
  if (!flag(args, "--audit") && !args.includes("--help")) {
    throw new Error("complete requires --audit REPORT.json");
  }
  return {
    apply: args.includes("--apply"),
    auditPath: flag(args, "--audit"),
    followUpsRecorded: args.includes("--follow-ups-recorded"),
    help: args.includes("--help"),
    json: args.includes("--json"),
    lockDir: flag(args, "--lock-dir") ?? defaultClaimLockDir(root),
    nodeId,
  };
}

export function printCompletionUsage() {
  console.log(`usage: spec-dag complete NODE-ID --audit REPORT.json [--apply] [--json]

Prepares DAG completion bookkeeping only. It never runs git merge and does not
grant merge authority. With an audit report, completion is refused while P0/P1
findings are open; P2/P3 findings require --follow-ups-recorded before --apply.

Options:
  --audit REPORT.json       validated audit report for the node
  --follow-ups-recorded     assert P2/P3 findings are already in DAG or durable artifacts
  --lock-dir DIR            default: /tmp/itotori-spec-dag-claims/<repo-hash>
  --dry-run                 explicit non-mutating mode
  --apply                   update roadmap/spec-dag.json to complete
  --json                    render machine-readable output`);
}

export function printLifecyclePlan(plan, options) {
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`${plan.action} ${plan.mode}`);
  console.log(`defaultMutating=${plan.defaultMutating}`);
  if (plan.nodeId) {
    console.log(`node=${plan.nodeId}`);
  }
  if (plan.specId) {
    console.log(`spec=${plan.specId}`);
  }
  if (plan.reportId) {
    console.log(`report=${plan.reportId}`);
  }
  if (plan.lockPath) {
    console.log(`lock=${plan.lockPath}`);
  }
  if (plan.releaseOwner) {
    console.log(`releaseOwner=${plan.releaseOwner}`);
  }
  if (plan.lockRecovery) {
    console.log(`lockRecovery=${JSON.stringify(plan.lockRecovery)}`);
  }
  if (plan.branch) {
    console.log(`branch=${plan.branch}`);
  }
  if (plan.worktree) {
    console.log(`worktree=${plan.worktree}`);
  }
  if (plan.repairState) {
    console.log(`repairState=${plan.repairState}`);
  }
  if (plan.nodePatch) {
    console.log(`nodePatch=${JSON.stringify(plan.nodePatch)}`);
  }
  if (plan.followUps) {
    console.log(`blockingFindings=${plan.blockingFindingIds.join(",") || "none"}`);
    console.log(`followUpFindings=${plan.followUpFindingIds.join(",") || "none"}`);
    console.log(
      `draftNodes=${plan.followUps.draftNodes.map((draft) => draft.node.id).join(",") || "none"}`,
    );
    console.log(
      `existingNodeUpdates=${plan.followUps.existingNodeUpdates.map((update) => update.targetNodeId).join(",") || "none"}`,
    );
  }
  if (plan.canApply === false) {
    console.log(`refusalReason=${plan.refusalReason}`);
  }
  if (plan.commands) {
    for (const commandParts of plan.commands) {
      console.log(`command=${commandParts.join(" ")}`);
    }
  }
  if (plan.mergeAuthority) {
    console.log(`mergeAuthority=${plan.mergeAuthority}`);
  }
  if (plan.gitMergeAttempted === false) {
    console.log("gitMergeAttempted=false");
  }
}

export function validateArgs(args, options) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    if (options.booleanFlags.has(arg)) {
      continue;
    }
    if (options.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown ${options.commandName} option ${arg}`);
  }
  const positional = positionalArgs(args);
  if (positional.length > options.positionalCount) {
    throw new Error(`too many ${options.commandName} arguments: ${positional.join(" ")}`);
  }
}

export function positionalArgs(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      values.push(arg);
      continue;
    }
    if (
      [
        "--owner",
        "--branch",
        "--worktree",
        "--lock-dir",
        "--base",
        "--follow-ups",
        "--audit",
        "--stale-after-hours",
      ].includes(arg)
    ) {
      index += 1;
    }
  }
  return values;
}

export function numberFlag(args, name, defaultValue) {
  const value = flag(args, name);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

export function printUsageAndExit() {
  console.error(
    "usage: spec-dag <validate|validate-audit-report|ready|pop|show|graph|sync-issues|claim|worktree|ingest-audit|complete> [options]",
  );
  process.exit(1);
}
