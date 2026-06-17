# Orchestration Operating Model

This document is the operating contract for central orchestrator agents working
from `roadmap/spec-dag.json`. It explains what the orchestrator owns, what it
must delegate, and how audit, CI, model-provider, cost, and worktree decisions
should be handled without relying on chat history.

## Source Of Truth

`roadmap/spec-dag.json` is the source of truth for roadmap state. The
orchestrator should derive ready work from the DAG instead of private notes,
chat context, local TODO files, or memory.

A spec is ready when it is `planned` and all `dependsOn` nodes are `complete`.
A spec can be marked `complete` only after its implementation has been merged
into `main` and:

- required local verification and CI are green;
- audits have no open P0 or P1 findings;
- acceptance criteria are satisfied by the merged implementation;
- the orchestrator trusts the merged result enough to record completion.

Do not mark a node `complete` because code exists, a worker says it is done, or
only a subset of verification passed. Completion is a product of merge evidence,
clear verification, and orchestrator trust, not activity.

## Central Orchestrator Responsibilities

The central orchestrator stays high-level. It owns the delivery loop:

1. Maintain the DAG and treat it as the canonical backlog.
2. Select ready specs according to priority, target, dependencies, and safe
   parallelism.
3. Create, name, track, and prune worktrees for active branches.
4. Delegate planning to a planning worker or subagent.
5. Delegate implementation to one or more implementation workers with explicit
   scopes.
6. Delegate audit to architecture, correctness, tests, performance, UX, or other
   focused audit workers where relevant.
7. Run or verify required local checks and CI.
8. Decide whether P0/P1 findings are cleared and whether P2/P3 findings belong
   in the active branch or the DAG.
9. Merge only when the gate is satisfied.
10. Update the DAG after merge and send milestone notifications for meaningful
    lifecycle events.

## Milestone Notifications

Send milestone notifications to ntfy topic `trevor-auto-ai-alerts`. Use the
literal topic URL; do not read `.env` or require secrets for ntfy:

```sh
curl -fsS -d "message" https://ntfy.sh/trevor-auto-ai-alerts
```

Notifications should be sparse and useful:

- node claimed;
- plan accepted;
- implementation sent to audit;
- merge blocked by P0/P1;
- node merged;
- node marked complete.

Avoid notifying for routine polling or noisy intermediate logs. If network or
ntfy delivery fails, record the missed notification and reason in a durable
record: a tracked and committed branch note file, audit report artifact, DAG
node/update, PR comment/description, or commit message. Then continue the
orchestration flow. A notification failure does not justify reading `.env`.

## Things The Orchestrator Must Not Do

The central orchestrator must not personally write feature code, fix bugs, or
implement specs. Its job is to route work, inspect evidence, and maintain the
state machine.

When an implementation is missing or broken, the orchestrator should create a
clear assignment for a worker instead of patching it directly. This keeps the
system honest: workers produce plans and diffs, audit workers evaluate them, and
the orchestrator decides based on evidence.

Small documentation, DAG bookkeeping, or roadmap metadata edits are acceptable
when they are part of orchestrator state management. Feature code, bug fixes,
test implementation, and spec implementation belong to workers.

## Spec Lifecycle

1. Read ready nodes with `just roadmap-ready` or
   `node scripts/spec-dag.mjs pop --json`.
2. Pick one node, considering P0/P1 priority, alpha readiness pressure,
   dependency unlocks, and worktree capacity.
3. Create a branch and worktree scoped to that node while the node is still
   `planned`.
4. Commit schema-valid `in_progress` metadata with `owner` plus `branch` or
   `worktree`, then push or merge the claim according to the coordination
   workflow before work starts.
5. Ask a planning worker for an implementation plan tied to the node's
   deliverables, acceptance criteria, verification, and audit focus.
6. Review the plan for scope, missing dependencies, test strategy, and unsafe
   assumptions.
7. Assign implementation to worker agents. Give each worker a narrow scope,
   expected commands, and artifact expectations.
8. Run the node's verification commands, `just check`, or the stronger CI gate
   required by the node.
9. Assign audit workers. Include the diff, plan, test evidence, known risks,
   and the node's `auditFocus`.
10. Resolve findings according to severity.
11. Merge into `main` only when verification is green, P0/P1 audit is clean,
    acceptance criteria are met, and the orchestrator trusts the result.
12. After merge, mark the DAG node `complete` when the completion criteria are
    met, then prune merged or abandoned worktrees.

## Audit Severity Loop

P0 and P1 findings block merge. The orchestrator does not fix them directly.
The required loop is:

1. Convert each P0/P1 finding into a concrete repair plan.
2. Assign the repair to an implementation worker.
3. Run the relevant verification after the worker returns changes.
4. Re-run the audit worker or an equivalent focused audit.
5. Repeat until no P0/P1 findings remain or the node is blocked with an explicit
   reason.

P2 and P3 findings do not normally block merge. Insert them into the DAG as new
planned nodes or attach them to an existing planned node with acceptance
criteria. A P2/P3 finding may be handled before merge only when it is cheap,
low-risk, and explicitly assigned to a worker as part of the active branch.
When a worker fixes a P2/P3 finding before merge, record the disposition
durably in at least one of: a tracked and committed branch note file, audit
report artifact, DAG node/update, PR comment/description, or commit message.

Do not let audit findings live only in chat. Findings either block the current
node, become worker assignments with durable disposition records, or become DAG
follow-up work.

## Merge Gate

The orchestrator should merge only when all of these are true:

- required local verification and CI are green;
- no P0/P1 audit findings remain;
- P2/P3 findings are either fixed before merge with a durable disposition
  record or represented in the DAG;
- acceptance criteria and deliverables match the merged diff;
- generated artifacts, credentials, and large local outputs are not committed;
- the orchestrator trusts the result after reviewing worker output and audit
  evidence.

If the evidence is inconsistent, stale, or too weak, treat the node as not ready
to merge even if commands pass.

## Provider And Model Policy

The detailed provider boundary, secret handling, OpenRouter routing, local
endpoint, prompt logging, structured-output fallback, and recorded-fixture rules
are defined in [ADR 0002](adrs/0002-provider-routing-and-recording.md). This
section is the operating summary for orchestrated work.

Live agent experiments may use provider keys already loaded into the process
environment by the user or invoking shell. Keys must never be committed,
printed, pasted into logs, or exposed in audit output. Do not read, print,
display, expose, or commit `.env`, and do not instruct agents to inspect `.env`
contents. If a needed secret is missing, ask the owner to export it or run the
command from an environment where it is already loaded.

Prefer cheap, light, modern models for Itotori agent experiments before using
frontier models. Good candidates include:

- `inclusionai/ring-2.6-1t`;
- `ibm-granite/granite-4.1-8b`;
- `deepseek/deepseek-v4-flash`;
- `deepseek/deepseek-v4-flash/pro`;
- `inclusionai/ling-2.6-flash`;
- `google/gemma-4-26b-a4b-it`;
- `google/gemma-4-31b-it`;
- `nvidia/nemotron-3-super-120b-a12b`;
- similar low-cost current models with documented capability and pricing.

The framework matters more than raw model status. Routing, retries, prompting,
structured output, deterministic tools, context construction, and evidence loops
should be improved before assuming a larger model is required. If cheap models
look unusably weak, first suspect provider routing, prompt shape, structured
output strategy, retry policy, missing tools, or orchestration design before
blaming model size.

CI must stay offline and fake-provider by default. Live provider calls must be
opt-in and recorded as non-committed artifacts.

## Cost Discipline

Treat live model credit as scarce. For every live run, record provider, model,
prompt preset, timestamp, token usage when available, estimated or billed cost,
router settings, OpenRouter account/workspace logging and privacy states when
OpenRouter is used, retry count, and the spec or experiment id that justified
the run.

Use recorded fixtures, fake providers, and deterministic tests for normal CI.
Do not require live keys for `just check`, `just ci`, unit tests, or routine
roadmap validation. If live output is useful for evidence, store only sanitized
summaries or ignored artifacts and keep raw provider logs out of git.

Provider fallback decisions must be auditable. If a run silently switches model
or provider, the run metadata is not trustworthy enough for benchmark or quality
claims.

## Worktree Hygiene

Worktrees are temporary execution environments, not archives. The orchestrator
should keep disk usage reasonable:

- create one worktree per active branch or clearly disjoint worker scope;
- name worktrees so the node id and owner are obvious;
- prune worktrees after merge, cancellation, or abandonment;
- remove large generated artifacts after their useful evidence has been
  summarized or moved to an ignored location;
- avoid keeping duplicate dependency caches or build outputs unless they are
  intentionally shared by the toolchain;
- inspect active worktrees before deleting anything that may contain unmerged
  worker changes.

When disk pressure appears, prune merged and abandoned worktrees before
discarding useful evidence. Never treat untracked files as disposable until the
owning worker or branch state has been checked.

The detailed branch naming, claim, repair, merge, blocked-state, and cleanup
checklists live in [worktree-lifecycle.md](worktree-lifecycle.md).

## DAG Follow-Up Policy

Use DAG nodes for real follow-up work. A good follow-up node has a stable id,
clear acceptance criteria, verification, dependencies, and audit focus. Avoid
creating vague nodes such as "clean up later" or "improve quality" without a
testable outcome.

Add a follow-up node when:

- a P2/P3 audit finding is real but not cheap enough for the active branch;
- an experiment reveals provider, prompt, cost, or framework work that should be
  reproducible;
- worktree, CI, audit, or merge process gaps need tooling support;
- a spec uncovers missing dependencies or sequencing that affects future
  agents.

Do not add a new DAG node when an existing planned node already covers the work.
In that case, update the planned node only if the finding changes acceptance
criteria or verification materially.
