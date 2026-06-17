# Audit Playbook

Spec audits produce one machine-ingestible JSON report that validates against
`roadmap/audit-report.schema.json`. The report also carries a human-readable
summary in `humanSummary.text`; chat prose can repeat the highlights, but the
JSON report is the canonical audit artifact.

Run:

```sh
just roadmap-validate
node scripts/spec-dag.mjs validate-audit-report path/to/audit-report.json
node scripts/spec-dag.mjs ingest-audit path/to/audit-report.json --json
```

`just roadmap-validate` validates the spec DAG, compiles the audit report
schema, validates committed audit report examples, and checks report-level
orchestration invariants. `validate-audit-report` applies the same schema and
semantic checks to actual audit artifacts before orchestration consumes them.
`ingest-audit` performs those checks and then renders the lifecycle effect as a
dry-run plan by default.

## Report Contract

An audit report has:

- `spec`: the audited DAG node, branch, and worktree.
- `auditor`: the review lane that produced the report.
- `humanSummary`: `pass`, `blocked`, or `follow_up_only` plus P0-P3 counts.
- `orchestration`: the completion decision and finding ids split into blocking
  and follow-up sets.
- `findings`: zero or more active findings.

Every finding must include concrete evidence, impact, and
`actionableAcceptanceCriteria`. If a reviewer cannot name acceptance criteria
that would close the finding, it is not an audit finding. Leave it as a note or
downgrade it to a follow-up only when it still describes useful future work.

## Severity Semantics

| Severity | Meaning                                                                                                                         | Orchestration consequence                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `P0`     | The spec cannot be trusted or merged because it violates a hard safety, data integrity, repository, or orchestration invariant. | `blocksCompletion: true`; `completionDecision: blocked`; repair in the active branch before completion. |
| `P1`     | The spec misses required alpha-readiness behavior, acceptance criteria, or verification for the owned node.                     | `blocksCompletion: true`; `completionDecision: blocked`; repair in the active branch before completion. |
| `P2`     | Important follow-up work that should be tracked, but the current spec can complete without it.                                  | `blocksCompletion: false`; convert to a new planned DAG node or append to an existing planned node.     |
| `P3`     | Exploratory, polish, training, or optional improvement.                                                                         | `blocksCompletion: false`; batch into a future node or append to an existing planned node.              |

Severity should describe consequence, not effort. Do not mark a finding P0 or
P1 unless the current node's acceptance criteria, verification, or repository
invariants are actually broken. A high-effort improvement is still P2 or P3 if
the current node can complete safely.

## Finding Examples

`P0`: audit output is prose-only, so the orchestrator cannot parse blocking
findings. Acceptance criteria should require a schema, a validating fixture, and
a command that fails on invalid reports.

`P1`: a required deliverable exists, but findings can omit actionable acceptance
criteria. Acceptance criteria should require the schema and playbook to reject
or forbid unactionable findings.

`P2`: an ingestion helper for arbitrary external audit files would reduce future
manual work, but committed fixtures are already validated. Convert it into a
planned node with command behavior and fixture expectations.

`P3`: reviewer training examples could include more edge cases. Append the
example requirement to an existing planned documentation node or batch it with
other reviewer guidance.

## Finding-to-DAG Conversion

P0 and P1 findings are not follow-up nodes. They block the active spec until the
implementation branch repairs them and a new audit no longer reports them.

P2 and P3 findings must be convertible:

1. Use `draft_new_dag_node` when the work is independent enough to be a
   PR-reviewable unit. The finding must include `proposedDagNode`.
2. Use `append_to_existing_dag_node` when an existing planned node is the right
   owner. The finding must include `existingDagNodeUpdate`, and the target node
   must exist, be `planned`, and be different from the audited spec.
3. Preserve severity as priority for new nodes: P2 findings propose P2 nodes,
   and P3 findings propose P3 nodes.
4. Include the current spec id in `proposedDagNode.dependsOn` when the follow-up
   relies on the current spec being complete.
5. Keep draft dependencies valid: every `proposedDagNode.dependsOn` entry must
   already exist in `roadmap/spec-dag.json`, and the proposed node cannot depend
   on a later target (`baseline` before `alpha` before `continuous`).
6. Copy or refine `actionableAcceptanceCriteria` into the proposed node's
   `acceptanceCriteria`.
7. Add verification strong enough for the new acceptance criteria.
8. Add audit focus that would catch the original issue if it regressed.

The orchestrator assigns the final node id, inserts the draft into
`roadmap/spec-dag.json`, and reruns `just roadmap-validate`.

`node scripts/spec-dag.mjs ingest-audit REPORT.json` automates the conversion
surface:

- P0/P1 findings produce a `blocked` repair-state patch for the audited node,
  with `blockedBy: "audit:<reportId>"` and a status reason naming the blocking
  finding ids.
- `draft_new_dag_node` P2/P3 findings produce planned node drafts with
  deterministic next ids for the requested prefix.
- `append_to_existing_dag_node` P2/P3 findings produce append payloads for the
  target planned node.
- `--follow-ups FILE` writes the generated follow-up payload as JSON.
- `--apply` updates the audited node's repair state; `--apply-follow-ups`
  explicitly also writes generated follow-up changes into `roadmap/spec-dag.json`.

Completion bookkeeping is separate:

```sh
node scripts/spec-dag.mjs complete UNIV-009 --audit path/to/audit-report.json --json
```

The command never merges git branches and never grants merge authority. It
refuses completion while P0/P1 findings remain. If the report has P2/P3
findings, `--apply` also requires `--follow-ups-recorded` so findings are not
lost outside the DAG or another durable artifact.

## Reviewer Checklist

- The report validates against `roadmap/audit-report.schema.json`.
- `humanSummary.counts` matches the findings array.
- All P0/P1 findings appear in `orchestration.blockingFindingIds`.
- All P2/P3 findings appear in `orchestration.followUpFindingIds`.
- Finding ids are unique within the report.
- No finding lacks evidence, impact, or actionable acceptance criteria.
- Severity is not inflated to force scheduling priority.
