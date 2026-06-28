# qd Wishlist

This document captures orchestration feedback from using qd as the live DAG
driver for a multi-agent repository. It is written from the perspective of an
orchestrator that is trying to keep qd as the source of truth while delegating
implementation, audit, repair, and verification work to independent workers in
separate worktrees.

The goal is not to make qd a Codex, Claude, or agent-runtime product. The goal
is the opposite: qd should remain the agent-agnostic state machine for work,
evidence, gates, and lifecycle. Any harness should be able to use it: humans,
Codex, Claude, shell scripts, CI jobs, GitHub bots, local IDE tools, or custom
internal runners.

The ideal endpoint is that a repository does not need a wrapper script around
qd. qd should provide enough native hooks, lifecycle primitives, status
surfaces, and explainer guidance that the repo can call `qd` directly and still
preserve all of its process invariants.

## Executive Summary

The current repo wrapper around qd exists because qd is already the right
backlog and lifecycle authority, but several repo-critical behaviors are not
first-class qd features yet:

- canonical formatting after `qd export --out roadmap/spec-dag.json`;
- audit-run lifecycle handling beyond findings alone;
- gate behavior that blocks on running audits;
- recovery from a node being marked `blocked` after a failed check when a later
  check passes;
- clean, discoverable help for lifecycle subcommands;
- agent/worktree assignment metadata that is agent-agnostic;
- wave-level orchestration metadata;
- precise, compact status summaries for milestones and filtered node sets;
- guidance that explains the intended qd workflow without requiring local
  wrapper scripts or tribal knowledge.

The largest product direction I would recommend is: make qd own orchestration
state, but never own execution. qd should track assignments, branches,
worktrees, checks, audits, findings, gates, and evidence. It should not launch
Codex, Claude, editors, shells, or proprietary agent harnesses.

## Design Principles

### qd Is The State Machine, Not The Agent Harness

qd should answer:

- what work exists;
- what is ready;
- what is claimed;
- who or what owns it;
- what branch and worktree are associated with it;
- what evidence has been produced;
- what checks and audits have passed;
- what blocks merge or completion;
- what should happen next.

qd should not decide:

- which AI agent implementation to use;
- how to spawn that agent;
- what model vendor or editor runtime is active;
- what chat UI owns the conversation;
- what local shell tool launches implementation work.

The correct abstraction is assignment tracking, not agent launching.

### qd Should Be Useful From Any Harness

Every qd feature should be operable from:

- a human terminal;
- a CI job;
- a GitHub action;
- an IDE extension;
- Codex;
- Claude;
- a local shell runner;
- a custom company-specific orchestrator.

That means the protocol should be command-line and JSON friendly, with stable
machine-readable outputs. It should not require a long-running daemon or an
agent-specific plugin to be useful.

### qd Should Prefer Policy Hooks Over Repo Wrappers

Repositories often need local policy:

- export formatting;
- secret/path hygiene;
- clean worktree requirements;
- required audit/run states;
- branch naming conventions;
- worktree naming conventions;
- merge gates;
- local check/CI commands.

These should be configured in `.qd/config.toml` as hooks or policies. A repo
should not have to replace `qd` with `bin/qd` just to enforce them.

### qd Should Make The Correct Next Step Obvious

When qd refuses an action, it should explain:

- the exact state that caused the refusal;
- the evidence qd used;
- the next command to run if the condition has been fixed.

For an agentic workflow, terse errors create unnecessary loops. qd can reduce
mistakes by making refusal messages operational.

## Current Workarounds Observed In This Repo

### Repo Wrapper Entrypoint

The repo currently has:

- `bin/qd`, which delegates to
- `scripts/qd-wrapper.mjs`, which finds and forwards to the real system qd.

That wrapper is not the desired long-term shape. It exists because the repo
needs extra behavior that is not yet native to qd.

### Export Canonicalization

The wrapper detects:

```sh
qd export --out roadmap/spec-dag.json
```

and then runs the repo formatter over the export. Without this, the committed
export can churn or fail repository formatting expectations.

Desired qd behavior: native export hooks.

### Audit Lifecycle Gate

The wrapper adds local behavior around running audit runs. In this repo,
`qd gate` must not pass if a node still has an open audit run, even if there are
no open findings. A running audit is unfinished evidence.

Desired qd behavior: first-class audit run lifecycle and gate integration.

### Audit Dispose/Cancel/Supersede Helpers

The wrapper supports audit lifecycle commands that close stale or superseded
audit runs with rationale. It currently does this through export/import-style
state mutation.

Desired qd behavior: native transactional audit-run mutation commands.

### Blocked State Recovery After Check Repair

One node hit this concrete sequence:

1. `qd check run NODE` failed on formatting.
2. qd marked the node `blocked`.
3. A worker repaired formatting.
4. `qd check run NODE` passed.
5. `qd gate NODE` returned clean.
6. The node still remained `blocked` until another lifecycle transition was
   discovered and run.

Desired qd behavior: either auto-recover from blocked when a newer required
check passes, or expose a clear `qd unblock` transition.

### Help Output For Lifecycle Commands

Several attempted help calls returned required-argument failures instead of
usage:

```sh
qd complete --help
qd advance --help
qd audit pass --help
qd ci --help
```

Desired qd behavior: every command and subcommand should display help before
argument validation.

### Manual Worktree Discipline

The repo has a detailed worktree playbook because qd does not yet own enough
branch/worktree safety:

- one spec branch per node;
- one primary worktree per active spec branch;
- disjoint worker/repair/audit worktrees;
- no duplicate checkout of the same branch;
- inspect dirty/untracked state before cleanup;
- never read or display `.env` files;
- commit claim/export state durably.

Desired qd behavior: native worktree and branch association checks, plus safe
status and cleanup commands.

### Read-Only Or Temporary DB Mode For Audit Worktrees

Detached audit worktrees often need qd status, gate, and node inspection while
remaining read-only and without initializing or writing their own `.qd`
database. The current accepted repo-side fallback is to read committed
`roadmap/spec-dag.json` in the audit worktree and run read-only qd commands
against an initialized main checkout:

```sh
qd --root <main-checkout> node show NODE --full
qd --root <main-checkout> gate NODE
```

Desired qd behavior: native read-only mode, or an isolated temporary database
mode rebuilt from the committed export, so audit workers can inspect qd state
without writable `.qd` state in the audit lane and without repo-specific wrapper
requirements.

## Feature Requests

### 1. Native Export Canonicalization Hooks

Motivation: qd is the source of truth, but many repositories commit a formatted
export artifact. If qd produces valid JSON that violates local formatting, every
export creates review noise or fails checks.

Suggested config:

```toml
[export]
default_out = "roadmap/spec-dag.json"
canonicalize_command = "pnpm exec vp check --fix --no-lint {out}"
```

Desired behavior:

- run the canonicalization command after successful export;
- fail the export if canonicalization fails;
- make the failure transactional where practical;
- show the exact command and exit code;
- support `{out}`, `{root}`, and maybe `{tmp}` placeholders;
- support `--no-hooks` for emergency/debug use.

This would remove the repo wrapper's export special case.

### 2. First-Class Audit Run Lifecycle

Motivation: findings are not the whole audit state. A node with an audit run in
progress is not ready to merge, even if no findings have been recorded yet.

Requested commands:

```sh
qd audit start <node> --kind acceptance|security|tests|architecture|general
qd audit pass <node> --from-report <audit-report.json>
qd audit fail <node> --from-report <audit-report.json>
qd audit dispose <node> --run-id <id> --rationale <text>
qd audit cancel <node> --run-id <id> --rationale <text>
qd audit supersede <node> --run-id <id> --rationale <text>
qd audit list [--node <node>] [--status running,passed,failed,cancelled]
```

Desired model:

- audit runs have ids, status, started_at, finished_at, auditor, kind, report,
  summary, and rationale;
- audit pass/fail can ingest report schema and findings;
- cancelling/superseding stale runs requires rationale;
- qd gate understands running audit runs as blockers.

### 3. Gate Blocking On Running Audits

Motivation: an audit that is still open means the completion evidence is not
finished. The gate should not rely only on open P0/P1 findings.

`qd gate <node>` should block on:

- open P0/P1 findings;
- running audit runs;
- required check missing or failed;
- required CI missing or failed;
- required verification missing;
- dirty/unsafe merge state if qd is configured to enforce it.

Example output:

```text
blocked: NODE has running audit run AUDIT_RUN_ID started 2026-06-27T20:00:00Z
next: qd audit dispose NODE --run-id AUDIT_RUN_ID --rationale "superseded by AUDIT-..."
```

### 4. Native Blocked-State Recovery

Motivation: if a check fails and marks the node blocked, then a later check
passes, qd should make recovery explicit and easy.

Preferred command:

```sh
qd unblock <node> --from-run <run-id> --summary <text>
```

Validation qd should perform:

- node is currently blocked;
- the referenced run belongs to the node;
- the referenced run passed;
- the run is newer than the blocking failed run or explicitly supersedes it;
- no P0/P1 findings are open;
- no audit run is still running.

Alternative behavior:

- automatically restore the node to its prior lifecycle state when a required
  newer check passes and gate is otherwise clean.

In either case, `qd gate` and `qd merge` should explain the recovery path if the
node remains blocked.

### 5. Lifecycle Commands With Complete Help

Motivation: agents and humans discover command syntax by asking for help. Help
should not require valid positional arguments first.

Commands that should show help cleanly:

```sh
qd complete --help
qd complete <node> --help
qd advance --help
qd audit pass --help
qd check --help
qd check run --help
qd ci --help
qd ci run --help
qd merge --help
```

Expected behavior:

- `--help` wins before required argument validation;
- help includes examples;
- help states the state transition and prerequisites;
- help states whether the command mutates qd state;
- help states how check/CI logs are recorded.

### 6. Agent-Agnostic Assignment Tracking

Motivation: multi-agent orchestration needs durable records of who owns what
without qd coupling itself to any agent runtime.

This should not launch agents. It should only record assignments.

Suggested commands:

```sh
qd assignment add <node> \
  --role worker \
  --owner "codex:019f..." \
  --branch worker/node-scope \
  --worktree /scratch/worktrees/repo-worker-node-scope \
  --scope "scripts/foo.ts"

qd assignment complete <assignment-id> \
  --commit abc123 \
  --summary "Implemented tests and verifier"

qd assignment fail <assignment-id> \
  --summary "Blocked on missing fixture"

qd assignment list [--node <node>] [--status open,complete,failed]
```

Assignment fields:

- node id;
- role: planner, worker, auditor, repair, reviewer, explorer;
- owner string;
- branch;
- worktree;
- read/write scope;
- status;
- started_at/finished_at;
- produced commits;
- verification evidence;
- summary.

Owner strings should be opaque. qd should not parse or enforce vendor-specific
identity formats. Examples may include:

- `human:trevor`;
- `codex:<id>`;
- `claude:<id>`;
- `github-actions:<run-id>`;
- `shell:<hostname>:<pid>`;
- `external:<opaque>`.

### 7. Worktree And Branch Management

Motivation: the repo playbook spends a lot of effort avoiding branch/worktree
collisions. qd already owns claims, so it is the right place to associate a node
with branches and worktrees.

Suggested commands:

```sh
qd worktree create <node> --kind spec
qd worktree create <node> --kind worker --scope docs
qd worktree create <node> --kind repair --finding <finding-id>
qd worktree status [<node>]
qd worktree list
qd worktree cleanup <node> --merged-only
```

Config:

```toml
[worktrees]
root = "/scratch/worktrees"
spec = "{root}/{repo}-spec-{node_slug}"
worker = "{root}/{repo}-worker-{node_slug}-{scope}"
repair = "{root}/{repo}-repair-{node_slug}-{finding_slug}"
audit = "{root}/{repo}-audit-{node_slug}-{scope}"
```

Safety checks:

- refuse duplicate branch checkout;
- refuse random suffixes unless explicitly requested;
- detect dirty/untracked state before cleanup;
- never print `.env` or `.env.*` paths by default;
- require stale-state rationale before deleting or reusing ambiguous worktrees;
- record branch/worktree association on the node or assignment.

### 8. Wave Tracking

Motivation: the long-running goal for this repo uses waves of subagents. Every
three feature-merge waves should trigger a broad audit. Every nine waves should
trigger a deeper alignment audit. That policy should be recordable in qd without
requiring chat memory.

Suggested commands:

```sh
qd wave start --kind implementation --summary "generalization cleanup wave"
qd wave add-node <wave-id> <node>
qd wave add-assignment <wave-id> <assignment-id>
qd wave complete <wave-id> --summary "merged 3 feature nodes"
qd wave status
```

Policy config:

```toml
[waves]
broad_audit_every = 3
deep_audit_every = 9
```

Desired behavior:

- qd can say how many waves since the last broad audit;
- qd can say how many waves since the last deep audit;
- `qd gate` or `qd ready` can surface audit-due reminders;
- qd can create or recommend an audit node when thresholds are crossed.

Again, qd should not launch the audit agent. It should record that the audit is
due, claimed, assigned, passed, failed, or converted into findings.

### 9. Better Filtered Node Listing

Motivation: `qd ready --json` can be very large. Orchestrators need compact,
filtered views without piping through repository-specific JSON tools.

Suggested commands:

```sh
qd node list --milestone alpha --status ready,claimed,blocked \
  --fields priority,status,id,title

qd node list --project itotori --priority P0,P1 --status ready
qd node list --kind audit-fix --status ready --json
```

Output should support:

- table;
- compact JSON;
- TSV-like stable format;
- field selection;
- sorting.

### 10. Milestone Status Commands

Motivation: users ask milestone questions directly: how many alpha nodes remain,
what blocks alpha, what is the critical path, what is ready next. qd should
answer these without requiring export parsing.

Suggested commands:

```sh
qd milestone status alpha
qd milestone remaining alpha --json
qd milestone blockers alpha
qd milestone critical-path alpha
qd milestone next alpha --limit 10
```

The output should include:

- total nodes;
- done/ready/claimed/blocked/cancelled counts;
- remaining points;
- critical path;
- open blocking findings;
- active claims;
- due wave audits;
- suggested next ready nodes.

### 11. Better Check And CI Run Semantics

Motivation: check and CI runs are lifecycle evidence. They should be first-class
objects that can be inspected, superseded, cancelled, and used for gates.

Run fields:

- run id;
- node id;
- kind: check, ci, verification, audit, implement;
- command;
- provider: local, github, buildkite, external;
- status: running, passed, failed, cancelled, timed_out, superseded;
- started_at;
- finished_at;
- exit code;
- git sha;
- worktree path;
- log path or URL;
- summary.

Requested commands:

```sh
qd run list --node <node>
qd run show <run-id>
qd run cancel <run-id> --rationale <text>
qd run supersede <run-id> --by <run-id> --rationale <text>
```

If a local run is interrupted, qd should record a cancelled/interrupted status
instead of leaving ambiguous state.

### 12. Timeouts And No-Output Handling

Motivation: long local CI runs can hang or go quiet. qd should provide clear
timeouts and heartbeat behavior.

Config:

```toml
[check]
timeout = "20m"
no_output_timeout = "5m"

[ci]
timeout = "60m"
no_output_timeout = "10m"
```

Desired behavior:

- qd terminates timed-out local commands cleanly;
- qd records `timed_out`;
- qd prints the last log path;
- qd explains whether the node was moved to blocked;
- qd suggests the next repair command.

### 13. Native Verification Evidence

Motivation: node specs often list targeted verification commands. qd should be
able to run and record those independently of full check/CI.

Suggested commands:

```sh
qd verification run <node>
qd verification run <node> --only "node --test scripts/foo.test.mjs"
qd verification sign-off <node> --type manual --note <text> --evidence <path>
qd verification list <node>
```

Gate policy should define whether targeted verification is required before
review, merge, or completion.

### 14. P2/P3 Finding Disposition

Motivation: P0/P1 findings block. P2/P3 findings often do not block, but they
must not be lost in chat.

Suggested commands:

```sh
qd finding dispose <finding-id> \
  --disposition follow-up-node \
  --node <new-or-existing-node> \
  --rationale <text>

qd finding promote <finding-id> \
  --title <title> \
  --acceptance <text> \
  --verification command="..."
```

Gate policy:

- P0/P1 open findings block;
- P2/P3 findings must either be fixed, promoted, appended to an existing node,
  or explicitly accepted as risk with rationale;
- qd should report undisposed P2/P3 findings before completion.

### 15. Transactional State Repair And Reconciliation

Motivation: in a repo with committed qd exports and a local qd DB, state drift
can happen. qd should make repair explicit.

Suggested commands:

```sh
qd doctor --json
qd doctor --repair
qd state diff --against-export roadmap/spec-dag.json
qd state rebuild --from-export roadmap/spec-dag.json
qd state reconcile --prefer live|export
```

Desired behavior:

- identify live-vs-export drift;
- identify missing tables or corrupt local DB;
- rebuild state without hand-deleting `.qd/qd.db`;
- explain exactly what changed.

### 16. Secret And Path Hygiene

Motivation: qd is often used by agents. Agents must not accidentally reveal
secret-bearing paths or env contents. The repository playbook explicitly forbids
reading or printing `.env` and `.env.*`.

Suggested features:

```sh
qd env check --required OPENROUTER_API_KEY,OPENROUTER_ZDR_ACCOUNT_ASSERTED --mask
qd worktree status --safe
qd diff <node> --safe
```

Policy config:

```toml
[secrets]
forbidden_path_globs = [".env", ".env.*", "**/.env", "**/.env.*"]
masked_env = ["OPENROUTER_API_KEY", "DATABASE_URL"]
```

Desired behavior:

- qd can check presence/absence of required env vars without printing values;
- qd status/diff helpers filter forbidden path names;
- qd refuses to stage/export/print secret-bearing files unless explicitly
  overridden by a human.

### 17. Project Policy Hooks

Motivation: each repository has local invariants. Hooks allow qd to stay
generic while making those invariants enforceable.

Suggested config:

```toml
[hooks]
pre_claim = "..."
post_claim = "..."
pre_check = "..."
post_check = "..."
pre_gate = "..."
post_export = "..."
pre_merge = "..."
post_merge = "..."
```

Hook requirements:

- hooks are visible in `qd config show`;
- hook output is logged;
- hook failure is reported as policy failure;
- `--no-hooks` exists for emergency/debug use;
- hooks receive structured env vars: node id, branch, worktree, run id, output
  path, repo root.

### 18. Merge And Completion Gate Clarity

Motivation: qd should be the place that tells an orchestrator whether merge or
completion is allowed.

Suggested commands:

```sh
qd merge-ready <node> --json
qd completion-ready <node> --json
```

These should validate:

- implementation is merged or mergeable;
- required checks passed;
- required CI passed or is waived with rationale;
- required audits passed;
- no P0/P1 findings are open;
- P2/P3 dispositions are recorded if policy requires;
- node acceptance is addressed by recorded evidence;
- branch/worktree state is consistent.

### 19. Exact Next-Step Recommendations

Motivation: agentic workflows are more reliable when tools provide precise next
actions.

Examples:

```text
Cannot merge NODE because status is blocked.
Latest check run 1af68904 passed after failed run 0209daf3.
Next: qd unblock NODE --from-run 1af68904 --summary "formatter repair verified"
```

```text
Cannot complete NODE because audit run AUDIT123 is still running.
Next: qd audit pass NODE --from-report roadmap/audits/AUDIT-NODE.json
or:   qd audit dispose NODE --run-id AUDIT123 --rationale "superseded"
```

### 20. Native Report Schemas

Motivation: audit, verification, and assignment reports should be machine
validated before ingestion.

Requested schemas:

- audit report;
- finding import;
- assignment report;
- verification report;
- external CI report;
- wave report.

Commands:

```sh
qd schema list
qd schema print audit-report
qd audit validate <file>
qd assignment validate <file>
qd verification validate <file>
```

### 21. Skills And Explainer Guides

Motivation: qd will be used by humans and agents. The best CLI cannot prevent
misuse if the workflow is not clearly taught.

Ideal built-in guides:

```sh
qd help lifecycle
qd help audits
qd help worktrees
qd help assignments
qd help waves
qd help gates
qd help export
qd help agent-agnostic-orchestration
```

Each guide should include:

- concept overview;
- state diagram;
- happy path commands;
- repair path commands;
- common errors;
- machine-readable command alternatives;
- examples for human, CI, and agent harnesses.

Ideal skill package contents:

- "How to claim a node safely";
- "How to split work across worker branches";
- "How to record an external agent assignment";
- "How to audit a node";
- "How to dispose or promote findings";
- "How to recover from a failed check";
- "How to export and commit state";
- "How to keep qd live state and committed export aligned";
- "What qd does not do: it does not launch or manage your agent runtime."

These guides should be agent-agnostic. They can say "your agent harness" or
"external worker", but should not assume Codex, Claude, or any particular
provider.

### 22. Agent-Agnostic Integration Contract

Motivation: external tools should integrate with qd through a stable contract.

qd should define a small protocol:

- claim work;
- record assignment;
- attach branch/worktree;
- record produced commit;
- record verification evidence;
- record audit evidence;
- ask gate status;
- mark complete/merge.

This can be CLI-first, with JSON inputs:

```sh
qd assignment add --from-json assignment.json
qd assignment complete --from-json assignment-result.json
qd verification record --from-json verification.json
```

The protocol should not include "spawn an AI agent." That belongs outside qd.

### 23. Durable Notes With Types

Motivation: qd notes currently carry important context. They would be more
useful if typed.

Suggested note kinds:

- blocker;
- retry;
- external dependency;
- operator instruction;
- audit disposition;
- live-run attempt;
- environment preflight;
- risk acceptance;
- migration note.

Command:

```sh
qd note add <node> --kind blocker --text "..." --evidence <path-or-url>
qd note list <node> --kind blocker,retry
```

### 24. Local And Remote CI Parity

Motivation: some nodes use local `just check`; others need full CI or GitHub
Actions. qd should abstract the evidence, not the execution environment.

Desired support:

- local command provider;
- GitHub Actions provider;
- manually recorded external provider;
- poll by commit SHA;
- store URL/log path;
- gate on required provider status.

Example:

```sh
qd ci run <node> --provider local
qd ci poll <node> --provider github --sha <sha>
qd ci record-pass <node> --external-id buildkite-123 --url <url> --summary <text>
```

### 25. Safer Defaults For Large Output

Motivation: agents have context limits and large output can obscure the signal.

Commands should offer:

- `--summary`;
- `--fields`;
- `--limit`;
- `--compact`;
- `--json`;
- `--no-big-text`;
- `--include spec,acceptance,findings` style toggles.

For example:

```sh
qd ready --json --fields id,title,priority,milestone,status --limit 50
qd node show <node> --summary
qd export --milestone alpha --status ready --fields id,title,priority
```

## Suggested Ideal Lifecycle

An ideal qd-driven workflow should look like this:

```sh
qd status --json
qd milestone next alpha --limit 10

qd claim NODE --agent orchestrator --branch spec/node
qd worktree create NODE --kind spec

qd assignment add NODE \
  --role worker \
  --owner "external:worker-1" \
  --branch worker/node-scope \
  --worktree /scratch/worktrees/repo-worker-node-scope \
  --scope "owned files or module"

qd assignment complete ASSIGNMENT_ID \
  --commit abc123 \
  --summary "Implemented requested slice"

qd verification run NODE
qd check run NODE

qd audit start NODE --kind acceptance
qd audit pass NODE --from-report roadmap/audits/AUDIT-NODE.json

qd gate NODE
qd merge NODE --use-existing-commit MERGE_SHA
qd complete NODE --summary "Merged and verified"
qd export --out roadmap/spec-dag.json
```

Everything above is compatible with any executor. The worker could be a person,
Codex, Claude, a script, a CI job, or an internal tool.

## Minimum Set Needed To Remove This Repo's Wrapper

The smallest high-impact set:

1. Export canonicalization hook.
2. Native audit run lifecycle: start/pass/fail/dispose/cancel/supersede.
3. `qd gate` blocks on running audits.
4. `qd unblock` or automatic blocked-state recovery after a passing run.
5. Help output that works for lifecycle subcommands.
6. Worktree/branch association and collision checks.
7. Compact filtered node/milestone listing.
8. Native P2/P3 finding disposition or promotion.
9. State repair/reconcile commands for live DB vs committed export.
10. Read-only or temporary DB mode for detached audit worktrees.
11. Agent-agnostic assignment records.

With those, this repository would have little reason to keep a local qd wrapper.

## Non-Goals

qd should not:

- launch Codex;
- launch Claude;
- choose AI models;
- know chat thread state;
- know vendor-specific agent protocols;
- read `.env`;
- own project-specific implementation logic;
- replace CI systems;
- replace human review.

qd should remain the durable coordination layer: DAG, state, claims,
assignments, evidence, gates, audits, findings, and exports.

## Why This Matters

The difference between a good qd and a great qd is whether the orchestrator can
trust it as the single operational surface.

When qd lacks lifecycle primitives, repositories grow wrappers. When wrappers
grow, each repo teaches agents a slightly different truth. That weakens qd's
central purpose.

If qd provides the primitives above, the repo-specific pieces shrink to config
and policy. The same qd CLI can then support human teams, AI-agent teams,
hybrid teams, local-only projects, and CI-heavy projects without coupling itself
to any one implementation harness.
