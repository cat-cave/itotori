# Spec DAG

> **Alpha definition (2026-06-24).** The redefined alpha gates live at the top
> of [`alpha-localization-project-readiness.md`](project-readiness.md).
> References to the "alpha proof workflow" in this doc describe the
> `ALPHA-007`/`ALPHA-009` workflow command and its hello-world succession —
> mechanisms that support the redefined dogfood point. The alpha gate itself
> is the 6-item list at the top of the readiness doc, not the totality of
> nodes labelled `ALPHA-*` in the DAG.

The implementation roadmap is a directed acyclic graph of PR-sized specs in
`roadmap/spec-dag.json`. The graph is intentionally machine-readable because the
expected development mode is orchestration by an agent that can claim ready
nodes, launch planning and implementation workers, run audits, and merge only
when the spec is actually complete. The central orchestrator operating contract
is documented in [orchestration-operating-model.md](orchestration-operating-model.md).

## Commands

```sh
just roadmap-validate
just roadmap-ready
just roadmap-pop
node scripts/spec-dag.mjs show ITOTORI-019
node scripts/spec-dag.mjs ready --project kaifuu --target alpha --json
node scripts/spec-dag.mjs sync-issues --dry-run
node scripts/spec-dag.mjs claim UNIV-009 --owner orchestrator --json
node scripts/spec-dag.mjs worktree UNIV-009 --json
node scripts/spec-dag.mjs ingest-audit roadmap/examples/audit-report.example.json --json
node scripts/spec-dag.mjs complete UNIV-009 --audit path/to/audit-report.json --json
node scripts/spec-dag.mjs graph > .tmp/spec-dag.dot
```

`just check` also runs `node scripts/spec-dag.mjs validate`, so broken node ids,
missing dependencies, invalid priorities, and cycles fail CI.

## GitHub Issue Sync

`node scripts/spec-dag.mjs sync-issues` renders a deterministic GitHub issue
sync plan from `roadmap/spec-dag.json`. The command is non-mutating by default:
running it without flags is equivalent to `--dry-run`, and it performs no
GitHub reads or writes. `--apply` is reserved for a future live writer and
currently refuses safely after validation.

Useful local modes:

```sh
node scripts/spec-dag.mjs sync-issues --dry-run
node scripts/spec-dag.mjs sync-issues --dry-run --node UNIV-002 --include-body
node scripts/spec-dag.mjs sync-issues --dry-run --json
node scripts/spec-dag.mjs sync-issues --dry-run --existing-issues .tmp/github-issues.json
```

The optional `--existing-issues` file must be local JSON, either an array of
issue objects or an object with an `issues` array. It is used only for
deterministic matching. The matcher updates instead of creates when an existing
issue has the hidden body marker `<!-- spec-dag-node: NODE-ID -->` or a title
that starts with `[NODE-ID]`. Duplicate markers in that local export fail the
dry run because a live writer would not know which issue to update.

Every rendered issue body starts with:

```md
<!-- spec-dag-node: UNIV-002 -->
<!-- spec-dag-sync-version: 1 -->
```

The visible body includes the node summary, status, priority, target, projects,
parallel group, dependencies, deliverables, acceptance criteria, verification,
and audit focus. Completed nodes render acceptance criteria as checked boxes;
all other statuses render unchecked boxes.

The managed label taxonomy is:

| Label form                | Meaning                        |
| ------------------------- | ------------------------------ |
| `spec-dag`                | Issue is managed from the DAG. |
| `dag/priority:P1`         | Node priority.                 |
| `dag/status:planned`      | Node lifecycle status.         |
| `dag/target:alpha`        | Delivery target.               |
| `dag/project:universal`   | Owning project or surface.     |
| `dag/group:roadmap-infra` | Scheduler parallel group lane. |

A future live writer must manage only the `spec-dag` label and labels with the
`dag/priority:`, `dag/status:`, `dag/target:`, `dag/project:`, and `dag/group:`
prefixes. Human labels outside that taxonomy must be preserved.

## Node Shape

Each node is a single PR-reviewable unit. A good node is large enough to justify
planning, implementation, and audit, but small enough that a reviewer can reason
about the diff without accepting a vague epic.

Nodes are execution specs, not decision records. Product, strategy, and priority
decisions are made before a node enters the DAG. A node must therefore produce a
concrete implementation artifact such as code, schema, fixtures, generated
reports, validators, dashboards, adapters, commands, docs tied to executable
behavior, or tests. Avoid nodes whose main output is a feasibility report,
recommendation, risk register, future DAG split, or choice between alternatives.
If a report is necessary, the node should build the generator, schema,
validation rules, and fixture inputs that make the report reproducible.

Spec nodes must be implementable, PR-reviewable work. They are not decision
makers, feasibility reports, or meta follow-up packs that only say more planning
is needed. If follow-up work is real, split it into concrete nodes with owned
artifacts and verification.

Integration nodes must name the exact composed surfaces, artifacts, and commands
they prove. Placeholder deliverables such as only "implementation", "fixtures",
or "tests" are not enough, and acceptance criteria cannot stop at generic claims
like "has concrete executable behavior" or "has schema validation." The node
must say which behavior runs, which schemas or artifacts are produced, and which
command or manual review proves the composed path.

Baseline placeholder checks may exist only as temporary scaffolding. They should
not be removed until a stronger integration proof exists, and their replacement
node must name the exact artifact graph that becomes the new CI signal. For this
suite, `ALPHA-009` is the handoff from the current DB-backed Hello World
workflow to an alpha proof workflow that validates bridge, patch, provider,
benchmark, runtime, dashboard/read-model, and SHARED-025 manifest linkage.
After that handoff, the old Hello World workflow should be removed or collapsed
into a compatibility alias for the alpha proof command so the suite has one
required integration truth.

Every node includes:

- `id`: stable id such as `KAIFUU-007`.
- `status`: `complete`, `planned`, `in_progress`, `blocked`, or `cancelled`.
- `priority`: `P0` through `P3`.
- `target`: `baseline`, `alpha`, or `continuous`.
- `projects`: one or more of `universal`, `shared`, `itotori`, `kaifuu`,
  `utsushi`, or `suite`.
- `parallelGroup`: coarse work lane for scheduling.
- `dependsOn`: node ids that must be complete first.
- `deliverables`, `acceptanceCriteria`, typed `verification`, and `auditFocus`.

Verification entries are objects so an orchestrator can distinguish runnable
commands from manual review:

```json
{ "type": "command", "value": "just ci" }
{ "type": "manual", "value": "Docs audit" }
```

Planned, in-progress, and blocked implementation nodes need at least one
`command` verification entry unless the node is truly docs-only. Manual review
can supplement a command, but it cannot be the only evidence for tests, fixture
loops, or smoke behavior. Roadmap nodes also do not carry time estimates; use
dependencies, priority, target, and runnable verification to express scheduling
and readiness.

The validator derives readiness from graph state: a `planned` node is ready when
all dependencies are `complete`.

`parallelGroup` is an enum rather than free text. Add a new group only when it
represents a meaningful scheduler lane, then update both the schema and this doc.

## Priority Semantics

`target` is the delivery horizon. `priority` is the blocking strength. A node
with `target: alpha` and `priority: P2` is alpha-adjacent work that should stay
visible near the milestone, but it does not block alpha readiness unless a
separate `P1` milestone node depends on it. All non-complete `P1` alpha nodes
must be ancestors of the final alpha readiness node so the graph cannot hide a
required blocker off to the side.

`P0` means the current work cannot merge if it fails. These are core
orchestration, data integrity, or hard alpha-readiness blocker issues.

`P1` means required for alpha readiness or required by the owning spec's
acceptance criteria. P1 audit findings block the owning spec until fixed.

`P2` means important but not alpha-blocking. P2 audit findings should become new
DAG nodes or be merged into an existing planned node.

`P3` means exploratory. P3 findings are batched unless they uncover a real P0 or
P1 risk.

## Orchestration Lifecycle

The short lifecycle below is a summary. Use
[orchestration-operating-model.md](orchestration-operating-model.md) as the
authoritative operating model for orchestrator responsibilities, delegation,
provider policy, cost discipline, and worktree hygiene.

1. Run `just roadmap-ready` or `node scripts/spec-dag.mjs pop --json`.
2. Create the branch and worktree with
   `node scripts/spec-dag.mjs worktree NODE-ID`. The default is a dry run;
   `--apply` runs `git worktree add`.
3. In the new worktree, claim the node with
   `node scripts/spec-dag.mjs claim NODE-ID --owner OWNER`. The default is a dry
   run. `--apply` creates an atomic claim lock in the shared `/tmp`
   repo-derived lock namespace and updates the node to schema-valid
   `in_progress` metadata with `owner`, `branch`, and `worktree`.
4. Launch a spec-planning agent to turn the node into an implementation plan.
5. Launch one or more implementation agents in separate worktrees only when
   their write scopes are disjoint.
6. Run local checks required by the node's `verification` list.
7. Launch audit agents for architecture, correctness, tests, performance, and
   UX where relevant.
8. Ingest audit JSON with `node scripts/spec-dag.mjs ingest-audit REPORT.json`.
   P0/P1 findings produce a blocked repair patch; P2/P3 findings produce draft
   DAG nodes or append payloads.
9. Convert P2/P3 findings into new DAG nodes or add them to existing planned
   nodes unless the finding is already inside the active node's deliverables,
   acceptance criteria, and verification scope; is explicitly assigned to a
   worker before merge; and is recorded durably in a tracked and committed
   branch note file, audit report artifact, DAG node/update, PR
   comment/description, or commit message.
10. Prepare completion bookkeeping with
    `node scripts/spec-dag.mjs complete NODE-ID --audit REPORT.json`, but merge
    only after CI is green, P0/P1 findings are gone, acceptance criteria
    are met, and the orchestrator trusts the result.
11. After the implementation is merged into `main`, mark the node `complete`
    only when the merged result is verified and audit-clean for P0/P1.

The lifecycle commands are default-safe: they print dry-run plans unless
`--apply` is supplied. They never grant merge authority or run a git merge.
Humans or an orchestrator still merge only after CI and audit gates.

## Parallelism

The graph exposes ready parallel lanes derived from node dependencies:

- `baseline`: already-completed scaffold and roadmap foundation nodes.
- `roadmap-infra`: issue sync, worktree lifecycle, and audit templates.
- `tooling`: toolchain, affected detection, CI, and cache work.
- `contracts`: shared schemas and cross-language contract validation.
- `quality-foundation`: fixtures, testing standards, corpora, quality taxonomy,
  and scale harnesses.
- `kaifuu-core`: adapter traits, round-trip harnesses, profiles, and deltas.
- `itotori-core`: persistence, repositories, eventing, and APIs.
- `dashboard`: web surfaces and human decision workflows.
- `policy`: style, glossary, and asset decision policy workflows.
- `feedback`: playtest and community feedback intake.
- `benchmarks`: cost, quality, MTL baseline, and QA-agent evaluation.
- `catalog`: cross-source work identity, local corpus inventory,
  translation-completeness intelligence, edition mapping, and readiness-aware
  opportunity ranking.
- `qa`: deterministic QA, LLM QA, triage, and runtime-evidence QA.
- `agent-runtime`: provider abstraction, model registry, agent/tool registry,
  batch planning, and drafting.
- `translation-loop`: drafting, patch export, repair, and rerun mechanics.
- `context-agents`: focused context-producing agents.
- `engine-adapters`: real extraction and patching adapters.
- `engine-research`: fixture-backed format, profile, helper-boundary, and
  parser-spike proof work that prepares engine adapters without becoming
  notes-only research.
- `utsushi-core`: runtime adapter traits, evidence ingestion, and artifacts.
- `runtime-adapters`: pragmatic validation probes and future VM work.
- `alpha-integration`: vertical slices that prove the suite is ready to start a
  first real localization project.
- `milestone`: alpha readiness definition and readiness hardening.

Ready nodes from different groups are good candidates for parallel work. Ready
nodes in the same group may still be parallel if their write sets are disjoint,
but the orchestrator should be stricter.

## Updating The DAG

When adding a node:

1. Use a stable id with the owning prefix.
2. Keep it PR-reviewable.
3. Make it implementable; do not use the DAG node to decide whether work should
   exist.
4. Do not add decision-maker, feasibility-report, or meta follow-up-pack nodes.
5. For integration nodes, name exact composed surfaces, artifacts, commands, and
   review evidence instead of placeholder deliverables or generic acceptance
   wording.
6. Add only real dependencies; avoid using dependencies as vague sequencing.
7. Include concrete verification commands or tests.
8. Do not add estimated hours, days, points, or sizing fields.
9. Include audit focus areas specific enough for a reviewer to find bugs.
10. Run `just roadmap-validate`.

When an audit finds issues:

- P0/P1: create a repair plan, assign worker implementation in the active spec
  branch, then re-audit.
- P2/P3: add a new planned node or amend an existing planned node with the
  finding's acceptance criteria unless the finding is already inside the active
  node's deliverables, acceptance criteria, and verification scope and is
  explicitly assigned to a worker before merge with a durable disposition record
  in an audit report artifact, DAG node/update, tracked and committed branch
  note file, PR comment/description, or commit message.

Do not mark a node complete because the code was written. Mark it complete only
after the implementation is merged into `main`, verified, and audit-clean for
P0/P1.
