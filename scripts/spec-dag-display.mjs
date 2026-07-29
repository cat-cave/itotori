import {
  createIssueSyncPlan,
  issueSyncLabelTaxonomy,
  issueSyncManagedLabelPrefixes,
  normalizeExistingIssues,
  renderIssueSyncDryRun,
} from "./spec-dag-issues.mjs";
import { readyNodes } from "./spec-dag-graph.mjs";
import { filterNodes, flag, loadExistingIssues } from "./spec-dag-cli-utils.mjs";

export function printValidationSummary(value, validation) {
  const ready = readyNodes(value);
  const auditSummary =
    typeof validation.auditReportExampleCount === "number"
      ? `, ${validation.auditReportExampleCount} audit report example valid`
      : "";
  console.log(`spec DAG valid: ${value.nodes.length} nodes, ${ready.length} ready${auditSummary}`);
}

export function printAuditReportValidationSummary(validation) {
  const count = validation.auditReportCount ?? 0;
  const noun = count === 1 ? "report" : "reports";
  console.log(`audit report valid: ${count} ${noun}`);
}

export function printNodes(nodes, args) {
  const filtered = filterNodes(nodes, args);
  if (args.includes("--json")) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  for (const node of filtered) {
    console.log(
      `${node.id}\t${node.priority}\t${node.target}\t${node.projects.join(",")}\t${node.title}`,
    );
  }
}

export function printPop(value, args) {
  const [node] = filterNodes(readyNodes(value), args);
  if (!node) {
    console.error("no ready nodes match the requested filters");
    process.exit(1);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(node, null, 2));
    return;
  }
  console.log(`${node.id}: ${node.title}`);
  console.log(
    `priority=${node.priority} target=${node.target} projects=${node.projects.join(",")}`,
  );
  console.log(`dependsOn=${node.dependsOn.join(",") || "none"}`);
}

export function printShow(value, args) {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error("usage: spec-dag show NODE-ID [--json]");
    process.exit(1);
  }
  const node = value.nodes.find((candidate) => candidate.id === id);
  if (!node) {
    console.error(`unknown node ${id}`);
    process.exit(1);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(node, null, 2));
    return;
  }
  console.log(`${node.id}: ${node.title}`);
  console.log(node.summary);
  console.log(`status=${node.status} priority=${node.priority} target=${node.target}`);
  console.log(`projects=${node.projects.join(",")} parallelGroup=${node.parallelGroup}`);
  console.log(`dependsOn=${node.dependsOn.join(",") || "none"}`);
}

export function printDotGraph(value) {
  console.log("digraph itotori_spec_dag {");
  console.log("  rankdir=LR;");
  for (const node of value.nodes) {
    const label = `${node.id}\\n${node.priority} ${node.title.replaceAll('"', "'")}`;
    console.log(`  "${node.id}" [label="${label}"];`);
    for (const dependency of node.dependsOn) {
      console.log(`  "${dependency}" -> "${node.id}";`);
    }
  }
  console.log("}");
}

export function printIssueSync(value, args) {
  const options = parseIssueSyncArgs(args);
  if (options.help) {
    printIssueSyncUsage();
    return;
  }
  if (options.apply && options.dryRun) {
    console.error("sync-issues accepts either --dry-run or --apply, not both");
    process.exit(1);
  }
  if (options.apply) {
    console.error(
      "sync-issues --apply is intentionally not implemented in this offline-safe command.",
    );
    console.error(
      "No GitHub writes were attempted. Future apply support must require --apply and a repository target.",
    );
    process.exit(2);
  }

  let nodes = filterNodes(value.nodes, args);
  if (options.nodeId) {
    nodes = nodes.filter((node) => node.id === options.nodeId);
    if (nodes.length === 0) {
      console.error(`unknown node ${options.nodeId}`);
      process.exit(1);
    }
  }

  const existingIssues = loadExistingIssues(options.existingIssuesPath);
  const normalizedExistingIssues = normalizeExistingIssues(existingIssues);
  if (normalizedExistingIssues.duplicateNodeIds.length > 0) {
    console.error(
      `existing issue export contains duplicate DAG node markers: ${normalizedExistingIssues.duplicateNodeIds.join(", ")}`,
    );
    process.exit(1);
  }

  const plan = createIssueSyncPlan({ ...value, nodes }, { existingIssues });
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          writes: 0,
          defaultMutating: false,
          labelTaxonomy: issueSyncLabelTaxonomy,
          managedLabelPrefixes: issueSyncManagedLabelPrefixes,
          plan,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(renderIssueSyncDryRun(plan, { includeBody: options.includeBody }));
}

export function parseIssueSyncArgs(args) {
  const booleanFlags = new Set(["--dry-run", "--apply", "--json", "--include-body", "--help"]);
  const valueFlags = new Set([
    "--existing-issues",
    "--node",
    "--project",
    "--target",
    "--priority",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (booleanFlags.has(arg)) {
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        console.error(`${arg} requires a value`);
        process.exit(1);
      }
      index += 1;
      continue;
    }
    console.error(`unknown sync-issues option ${arg}`);
    process.exit(1);
  }

  return {
    apply: args.includes("--apply"),
    dryRun: args.includes("--dry-run"),
    existingIssuesPath: flag(args, "--existing-issues"),
    help: args.includes("--help"),
    includeBody: args.includes("--include-body"),
    json: args.includes("--json"),
    nodeId: flag(args, "--node"),
  };
}

export function printIssueSyncUsage() {
  console.log(`usage: spec-dag sync-issues [--dry-run] [--json] [--include-body] [filters]

Creates a deterministic local GitHub issue sync plan from roadmap/spec-dag.json.
The default mode is dry-run and performs no GitHub writes.

Options:
  --dry-run                 render the non-mutating plan explicitly
  --apply                   reserved explicit write mode; currently refuses safely
  --json                    render a machine-readable plan including issue bodies
  --include-body            include rendered issue bodies in text dry-run output
  --existing-issues FILE    local JSON issue export used to update instead of create
  --node NODE-ID            restrict output to one DAG node
  --project NAME            restrict by project
  --target NAME             restrict by target
  --priority NAME           restrict by priority`);
}
