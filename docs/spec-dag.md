# Spec DAG

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
node scripts/spec-dag.mjs ready --project kaifuu --target mvp --json
node scripts/spec-dag.mjs graph > .tmp/spec-dag.dot
```

`just check` also runs `node scripts/spec-dag.mjs validate`, so broken node ids,
missing dependencies, invalid priorities, and cycles fail CI.

## Node Shape

Each node is a single PR-reviewable unit. A good node is large enough to justify
planning, implementation, and audit, but small enough that a reviewer can reason
about the diff without accepting a vague epic.

Every node includes:

- `id`: stable id such as `KAIFUU-007`.
- `status`: `complete`, `planned`, `in_progress`, `blocked`, or `cancelled`.
- `priority`: `P0` through `P3`.
- `target`: `baseline`, `mvp`, or `post_mvp`.
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

The validator derives readiness from graph state: a `planned` node is ready when
all dependencies are `complete`.

`parallelGroup` is an enum rather than free text. Add a new group only when it
represents a meaningful scheduler lane, then update both the schema and this doc.

## Priority Semantics

`P0` means the current work cannot merge if it fails. These are core
orchestration, data integrity, or MVP blocker issues.

`P1` means required for MVP. P1 audit findings block the owning spec until
fixed.

`P2` means important but not MVP-blocking. P2 audit findings should become new
DAG nodes or be merged into an existing planned node.

`P3` means exploratory. P3 findings are batched unless they uncover a real P0 or
P1 risk.

## Orchestration Lifecycle

The short lifecycle below is a summary. Use
[orchestration-operating-model.md](orchestration-operating-model.md) as the
authoritative operating model for orchestrator responsibilities, delegation,
provider policy, cost discipline, and worktree hygiene.

1. Run `just roadmap-ready` or `node scripts/spec-dag.mjs pop --json`.
2. Create the branch and worktree using the node id before editing the node out
   of `planned`.
3. Claim the node by committing schema-valid `in_progress` metadata with
   `owner` plus `branch` or `worktree`; push or merge the claim according to the
   coordination workflow before delegation.
4. Launch a spec-planning agent to turn the node into an implementation plan.
5. Launch one or more implementation agents in separate worktrees only when
   their write scopes are disjoint.
6. Run local checks required by the node's `verification` list.
7. Launch audit agents for architecture, correctness, tests, performance, and
   UX where relevant.
8. For P0/P1 audit findings, create a repair plan, assign worker
   implementation, and re-audit.
9. Convert P2/P3 findings into new DAG nodes or add them to existing planned
   nodes unless they are cheap, explicitly assigned to a worker before merge,
   and recorded durably in a tracked and committed branch note file, audit
   report artifact, DAG node/update, PR comment/description, or commit message.
10. Merge only after CI is green, P0/P1 findings are gone, acceptance criteria
    are met, and the orchestrator trusts the result.
11. After the implementation is merged into `main`, mark the node `complete`
    only when the merged result is verified and audit-clean for P0/P1.

## Parallelism

The graph intentionally exposes early parallel lanes:

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
- `qa`: deterministic QA, LLM QA, triage, and runtime-evidence QA.
- `agent-runtime`: provider abstraction, model registry, agent/tool registry,
  batch planning, and drafting.
- `translation-loop`: drafting, patch export, repair, and rerun mechanics.
- `context-agents`: focused context-producing agents.
- `engine-adapters`: real extraction and patching adapters.
- `engine-research`: format, VM, and future adapter research.
- `utsushi-core`: runtime adapter traits, evidence ingestion, and artifacts.
- `runtime-adapters`: pragmatic validation probes and future VM work.
- `mvp-integration`: vertical slices that prove the suite works as a system.
- `release`: MVP definition of done and release hardening.

Ready nodes from different groups are good candidates for parallel work. Ready
nodes in the same group may still be parallel if their write sets are disjoint,
but the orchestrator should be stricter.

## Updating The DAG

When adding a node:

1. Use a stable id with the owning prefix.
2. Keep it PR-reviewable.
3. Add only real dependencies; avoid using dependencies as vague sequencing.
4. Include concrete verification commands or tests.
5. Include audit focus areas specific enough for a reviewer to find bugs.
6. Run `just roadmap-validate`.

When an audit finds issues:

- P0/P1: create a repair plan, assign worker implementation in the active spec
  branch, then re-audit.
- P2/P3: add a new planned node or amend an existing planned node with the
  finding's acceptance criteria unless the finding is cheap and explicitly
  assigned to a worker before merge with a durable disposition record in an
  audit report artifact, DAG node/update, tracked and committed branch note
  file, PR comment/description, or commit message.

Do not mark a node complete because the code was written. Mark it complete only
after the implementation is merged into `main`, verified, and audit-clean for
P0/P1.
