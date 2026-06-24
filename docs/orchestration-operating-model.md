# Orchestration Operating Model

This document is the operating contract for central orchestrator agents working
from `roadmap/spec-dag.json`. It explains what the orchestrator owns, what it
must delegate, and how audit, CI, model-provider, cost, and worktree decisions
should be handled without relying on chat history.

## Alpha Milestone Definition (2026-06-24)

This project has **no external timeline**. Eng-month/week/year cost framing
is off-shape and must not appear in orchestrator outputs (audit reports,
acceptance criteria, summary docs).

**Alpha-ready** is defined in `docs/alpha-localization-project-readiness.md`
as: the architecture proven on synthetic + real-bytes smoke, with enough of
the claimed engines exercised to **dogfood the suite on a first localization
project**. Alpha is not "complete product"; it is the point at which the
suite is usable enough to discover what the next pass of nodes should be.
Dogfood failures fuel the DAG; they are not a failure of the milestone.

The native RealLive runtime port lives at continuous tier as the 22-node
decomposition (`docs/research/reallive-engine-dag-proposal.md`,
UTSUSHI-200..UTSUSHI-221 in the DAG). Only the scaffolding node
(UTSUSHI-200, = the proposal's 146a) is alpha; the rest are continuous and
land post-alpha on no external schedule.

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
criteria. A P2/P3 finding may be handled before merge only when it is already
inside the active node's deliverables, acceptance criteria, and verification
scope, and is explicitly assigned to a worker as part of the active branch.
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

- a P2/P3 audit finding is real and is outside the active node's deliverables,
  acceptance criteria, or verification scope;
- an experiment reveals provider, prompt, cost, or framework work that should be
  reproducible;
- worktree, CI, audit, or merge process gaps need tooling support;
- a spec uncovers missing dependencies or sequencing that affects future
  agents.

Do not add a new DAG node when an existing planned node already covers the work.
In that case, update the planned node only if the finding changes acceptance
criteria or verification materially.

## DAG Anti-Patterns The Orchestrator And Audit Workers Must Reject

The 2026-06-23 audit batch (see `docs/audits/dag-critique.md` for the full
findings) surfaced recurring patterns that produce "complete" specs the
codebase cannot honestly support. These patterns must be rejected by the
orchestrator at claim time and by audit workers at completion time.

### Single-node engine ports

A spec titled "engine port" or "runtime port" whose acceptance criteria fit a
single PR is structurally infeasible. A real engine port (RealLive, RPG Maker,
KiriKiri runtime, etc.) is many thousands of lines of code across opcode VM,
variable system, asset pipeline, save/load, system-call dispatch, and so on.

If a planning subagent or audit worker encounters a single node whose
"deliverables" claim a full runtime port, the orchestrator must:

1. Stop the claim or refuse completion.
2. Demand a decomposition document (see
   `docs/research/reallive-engine-dag-proposal.md` for the canonical example —
   it splits UTSUSHI-146 into 22 sub-nodes with concrete behaviours).
3. Re-enter the planning loop with the decomposition's sub-nodes.

### Acceptance criteria that name no observable artifact

A criterion like "the adapter inventories text surfaces" is unverifiable. A
criterion like "running `cargo run -p kaifuu-cli detect <path>` against
`/scratch/itotori-research/sweetie-hd/extracted/.../REALLIVEDATA/` returns
`detected: true` with `engine_family = reallive` and `confidence != null`" is
verifiable.

Every alpha-target acceptance criterion must name at least one of:

- A specific file path (real or fixture) whose content the code must produce.
- A specific command whose `stdout`/exit code is observable.
- A specific byte range whose parsing must succeed.
- A specific schema-validated JSON shape and the validator command.

Audit workers must reject completion when an acceptance criterion is
unfalsifiable.

### "Smoke" tests that delegate to author-generated fixtures only

A "smoke" test that runs the code only against a fixture the same worker
authored does not prove generality. The
`crates/kaifuu-reallive/tests/fixtures/smoke-scene-001/SEEN.TXT` is 47 bytes;
the real RealLive `Seen.txt` for Oshioki Sweetie HD is 3,876,496 bytes with a
10,000-slot fixed directory the synthetic fixture does not exercise.

When a spec claims generality across an engine family or asset class, the
acceptance criteria must include at least one test against bytes the spec
author did not generate: real owned-game bytes (read-only from
`/scratch/itotori-research/...` or `/archive/vault/...`), a third-party
public fixture, or a corpus-sampled fixture documented as
"author-independent."

### Tests that mirror implementation instead of contracts

A test that asserts the structure of the implementation (e.g. that
`buildPrompt(input) === buildPrompt(input)`, that `encode_then_decode(x) ==
x`, or that a builder builds) is tautological. Such tests pass after any
refactor and do not predict consumer failures.

Audit workers must categorise each test as: contract / smoke /
implementation-mirror / tautology. A spec whose test count is dominated
(>40%) by tautological or implementation-mirror tests must be rejected at
audit until contract tests are added.

### Substrate types with no production consumer

A substrate trait or type that compiles and tests but is never imported by a
production crate is scaffolding without load. When a substrate spec lands,
the audit must demonstrate at least one non-test consumer or attach a
follow-up node whose acceptance criteria includes wiring at least one
real-engine adapter to consume the new surface.

The current substrate (UTSUSHI-020..120) is in a deferred state: zero
non-test consumers exist outside `utsushi-core`. New substrate work must
not extend this pattern.

### Database migration shipped without TypeScript registration

Any spec that adds a `.sql` file under `packages/itotori-db/migrations/` must
also add the matching entry to `packages/itotori-db/src/migrations.ts` in the
same commit. Audit workers must grep both paths and reject completion if the
two are out of sync.

A migration-parity test
(`packages/itotori-db/test/migrations-parity.test.ts`) enforces this in CI.
Specs that add migrations must not bypass that test by using only in-memory
repository test doubles.

### Research-reference nodes that produce no DAG output

A spec that names "rlvm as research anchor" or "siglus_rs as research
anchor" without surfacing concrete findings (opcode lists, format invariants,
sub-format key requirements, etc.) into the DAG as follow-up nodes leaves an
unbounded scope hole. Research-anchor specs must produce a deliverable that
populates the DAG with concrete sub-nodes whose acceptance criteria cite the
research.

`docs/research/reallive-engine.md` and `docs/research/reallive-engine-dag-proposal.md`
are the canonical shape for a research-anchor deliverable.

### Claimed-support framings the implementation does not satisfy

The orchestrator brief lists "claimed alpha engines." The
`docs/subprojects-kaifuu.md` definition of "claimed support" requires the
complete detect → extract → decrypt → decompile → patch → verify →
delta-apply chain. A "claimed-support" framing for an engine whose chain
does not round-trip real game bytes is a forbidden-state violation.

Audit workers must verify the claimed chain end-to-end on at least one
non-author byte stream before allowing any "claimed-support" status. If the
chain cannot, the framing must be demoted from "claimed-support" to
"readiness-record" with no completion-level claim.

### Legacy-path preservation in greenfield code (2026-06-24)

The 2026-06-23 audit batch confirmed that large parts of the codebase are
fixture-shaped, never-touched-by-a-real-engine scaffolding. Specs that
re-architect or extend any subsystem must **remove the legacy path
entirely**. Backwards-compatibility shims, `#[deprecated]` markers, dual
v0/v1 plumbing, "wrapper that calls the old impl", and "alias for
back-compat" patterns are forbidden in this codebase because:

- There are no external consumers — nothing pins us to old APIs.
- The legacy paths are themselves fixture-shaped; preserving them
  preserves the bug.
- Dual paths multiply audit surface and let "the wrong path silently keeps
  working" become a regression vector.

When a spec changes a substrate trait, an engine-port surface, a sink
contract, an envelope size class, or any other type that has a sibling
"old" version, the old version must be deleted in the same change, not
flagged for follow-up removal. Acceptance criteria must include a `git
grep` invariant proving the old symbol is gone. Audit workers must reject
completion when the legacy symbol still exists.

This rule applies to substrate extensions M.1–M.5
(`UTSUSHI-222`–`UTSUSHI-226`), the UTSUSHI-200..221 RealLive runtime
decomposition, and to every greenfield engine port. The only exceptions
are externally-defined wire formats (e.g. the published
`localization-bridge-schema` v0.2 JSON shape) where a documented
versioning policy applies.

### Single-game validation passing as "claimed support"

A parser, decoder, or runtime port that works on game X but breaks on game
Y is fixture-shaped against game X. The 2026-06-24 audit batch made this
concrete: `kaifuu-reallive::parse_archive` parses synthetic 47-byte
fixtures it authored, returns silent zero-state on the real 3.87 MB
Sweetie HD `Seen.txt`.

When a spec claims support for an **engine family** (RealLive, RPG Maker
MV/MZ, KiriKiri KAG, etc.), acceptance criteria must include validation
against **at least two real-world games of that engine**, not just one.
Single-game validation may produce a confident-looking pass that is in
fact specific to that one title's compiler version, key, or asset layout.

Where the second real-world game is not yet sourced (e.g. only Sweetie HD
is staged for RealLive), the node's status remains `planned` with a
sourcing-required note in the summary; the orchestrator does not claim
the node ready until the second corpus is available. Audit workers must
not approve completion of an engine-claiming node whose verification only
exercises one real corpus.

The exception is **substrate-level** work that is genuinely
cross-engine (e.g. a generic asset resolver, a generic snapshot envelope)
— multiple real-world games means multiple engine families, not multiple
titles of the same engine.

### Process: planning subagent checklist

When the orchestrator spawns a planning subagent, the prompt must require
the subagent to verify and document each of the above patterns it does NOT
introduce. The plan file must include a "DAG anti-pattern self-check"
section that states, for each pattern, whether the planned spec is
susceptible and how it avoids the pattern.

When the orchestrator spawns an audit subagent, the prompt must require the
audit to explicitly check each pattern against the merged code and call out
any violations as P0 or P1 findings.
