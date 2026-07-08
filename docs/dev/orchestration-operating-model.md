# Orchestration Operating Model

We use **qdcli** (`https://github.com/cat-cave/qdcli`, executable `qd`) for all
orchestration. qd is the live orchestration ledger and quality gate; the
committed source of truth is `roadmap/spec-dag.json` (qd export shape, must pass
`just roadmap-validate`).

**For how to use qd, read qdcli's own docs — do not duplicate qd mechanics
here:**

- `docs/llms.md` — orchestrator bootstrap and the full delegate → audit → CI →
  merge loop.
- `docs/agents.md` — the 16-step agent protocol.

Generic qd mechanics (the orchestrator loop, `qd claim`/`audit`/`check`/`ci`/
`merge`, assignments, waves, worktree/branch lifecycle, P0–P3 severity policy,
gate and policy evaluation) live in those docs and are authoritative. This
document keeps ONLY the itotori-specific operating rules that qd does not
encode.

## Milestone Framework

Authoritative tier definitions and per-tier acceptance criteria live in
[`docs/project-readiness.md`](../project-readiness.md). This project has **no
external timeline**; eng-month/week/year cost framing is off-shape and must not
appear in orchestrator outputs.

The one itotori fact the orchestrator must hold: **alpha = the configured
alpha target corpus localized end-to-end on this Linux machine** — real-bytes
extraction, a live LLM call via OpenRouter with an explicit (model, provider)
pair, the FULL agentic loop, real patchback, `utsushi-reallive` Linux replay,
and verifiable patch evidence. The alpha target is one configured real RealLive
corpus (a specific game is config/input, never a built-in rule). Single-game by
definition; beta requires ≥2 games per engine.

## Provider And Model Policy

The detailed provider boundary, secret handling, OpenRouter routing, local
endpoint, prompt logging, structured-output fallback, and recorded-fixture rules
are defined in [ADR 0002](../adrs/0002-provider-routing-and-recording.md).
itotori-specific rules:

- Every model invocation declares an explicit **(model id, provider id) pair** —
  OpenRouter is a marketplace and providers are not equivalent.
- Privacy is gated by **account-wide ZDR** on the OpenRouter account; leverage
  OR's routing/policy infra rather than an itotori-side capabilities registry.
- Prefer **cheap, light, modern models** before frontier models. Good
  candidates: `inclusionai/ring-2.6-1t`, `ibm-granite/granite-4.1-8b`,
  `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash/pro`,
  `inclusionai/ling-2.6-flash`, `google/gemma-4-26b-a4b-it`,
  `google/gemma-4-31b-it`, `nvidia/nemotron-3-super-120b-a12b`, or similar
  low-cost current models with documented capability and pricing. If cheap
  models look weak, suspect provider routing, prompt shape, structured-output
  strategy, retry policy, missing tools, or orchestration design before model
  size.
- CI stays offline and fake-provider by default. Live provider calls are opt-in
  and recorded as non-committed artifacts.

## Cost Discipline

Treat live model credit as scarce. **Cost is read from real calls, never
approximated.** For every live run, record provider, model, prompt preset,
timestamp, token usage when available, billed cost, router settings, OpenRouter
account/workspace logging and privacy states, retry count, and the spec or
experiment id that justified the run.

Use recorded fixtures, fake providers, and deterministic tests for normal CI.
Do not require live keys for `just check`, `just ci`, unit tests, or routine
roadmap validation. If live output is useful for evidence, store only sanitized
summaries or ignored artifacts and keep raw provider logs out of git.

Provider fallback decisions must be auditable. If a run silently switches model
or provider, the run metadata is not trustworthy enough for benchmark or quality
claims.

## Milestone Notifications

Send milestone notifications to ntfy topic `trevor-auto-ai-alerts`. Use the
literal topic URL; do not read `.env` or require secrets for ntfy:

```sh
curl -fsS -d "message" https://ntfy.sh/trevor-auto-ai-alerts
```

Notifications should be sparse and useful: node claimed; plan accepted;
implementation sent to audit; merge blocked by P0/P1; node merged; node marked
complete. Avoid notifying for routine polling or noisy intermediate logs. If
delivery fails, record the missed notification and reason in a durable record (a
tracked branch note, audit report artifact, DAG node/update, PR comment, or
commit message), then continue. A notification failure does not justify reading
`.env`.

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
criterion like "running `cargo run -p kaifuu-cli detect <path>` against the
configured target corpus root's `REALLIVEDATA/` (the alpha corpus's extracted
game tree) returns `detected: true` with `engine_family = reallive` and
`confidence != null`" is verifiable.

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
the real RealLive `Seen.txt` for the configured alpha corpus is multiple
megabytes (~3.87 MB) with a 10,000-slot fixed directory the synthetic fixture
does not exercise.

When a spec claims generality across an engine family or asset class, the
acceptance criteria must include at least one test against bytes the spec
author did not generate: real owned-game bytes (read-only from the configured
target corpus root / corpus vault), a third-party public fixture, or a
corpus-sampled fixture documented as "author-independent."

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

The substrate (UTSUSHI-020..120) is **partially consumed**, not wholly
deferred. The port, sink, snapshot, VFS, input, and redaction slices each
have at least one production (non-test) consumer in a real-engine crate,
while the embed, recorder, and conformance slices remain deferred with
no non-test consumers outside `utsushi-core`. Concretely (rg-verified;
representative import sites):

- **Port** (UTSUSHI-025/056/224 — `EnginePort`, `PortManifest`,
  `PortRequest`, `EnginePortError`, `LifecycleStage`, `PortCapability`,
  `REQUIRED_LIFECYCLE_STAGES`): all three real-engine ports —
  `utsushi-reallive/src/engine_port.rs:45`,
  `utsushi-siglus/src/lib.rs:98`, `utsushi-rpgmaker-mv/src/port.rs:27`.
- **Sink** (UTSUSHI-022 — `SinkSet`, `TextSurfaceSink`,
  `FrameArtifactSink`, `AudioEventSink`, `TextLine`, `FrameArtifact`):
  `utsushi-reallive/src/engine_port.rs:45`,
  `utsushi-reallive/src/render_pipeline.rs:86`,
  `utsushi-reallive/src/rlop/module_msg.rs:51`,
  `utsushi-siglus/src/vm.rs:46`, `utsushi-rpgmaker-mv/src/port.rs:27`.
- **Snapshot** (UTSUSHI-023 — `Inspectable`, `Restorable`, `Snapshot`,
  `SnapshotError`, `StateTree`, `take_snapshot`, `restore_snapshot`):
  `utsushi-reallive/src/vm.rs:45`,
  `utsushi-reallive/src/var_banks.rs:42`,
  `utsushi-reallive/src/save.rs:71`,
  `utsushi-reallive/src/replay.rs:42`, `utsushi-siglus/src/vm.rs:46`,
  `utsushi-rpgmaker-mv/src/port.rs:27`.
- **VFS** (UTSUSHI-020 — `AssetPackage`, `AssetId`, `RuntimeVfs`):
  `utsushi-reallive/src/engine_port.rs:46`,
  `utsushi-reallive/src/rlop/module_obj.rs:44`,
  `utsushi-siglus/src/lib.rs:99`, `utsushi-rpgmaker-mv/src/port.rs:28`,
  `utsushi-kirikiri/src/xp3_vfs_replay.rs:42`.
- **Input** (UTSUSHI-021 — `InputEvent`, `ChoiceIndex`):
  `utsushi-reallive/src/syscall.rs:72`,
  `utsushi-reallive/src/rlop/module_sel.rs:109`.
- **Redaction** (UTSUSHI-056 — `reject_unredacted_local_paths`):
  `utsushi-siglus/src/runtime_profile.rs:53`,
  `utsushi-siglus/src/opcode_profile.rs:49`.

Still deferred (no non-test consumers outside `utsushi-core`,
scaffolding-only): the **embed** capability surface (UTSUSHI-024), the
**recorder / reference-trace** surface (UTSUSHI-060/062), and the
**conformance** manifest/check surface (UTSUSHI-025..030). New substrate
work must wire a real-engine consumer for these slices, not extend the
scaffolding-only pattern.

Keep this list current — the anti-pattern audit gate above keys off it, so
a stale premise makes the gate mis-classify which slices are scaffolding
vs consumed. Re-verify with `rg -lw EnginePort crates/utsushi-reallive/src`
(must be non-empty) and `rg -n 'use utsushi_core::substrate' crates/*/src`
whenever a slice gains or loses a production consumer.

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
fixtures it authored, returns silent zero-state on the real ~3.87 MB
alpha corpus `Seen.txt`.

When a spec claims support for an **engine family** (RealLive, RPG Maker
MV/MZ, KiriKiri KAG, etc.), acceptance criteria must include validation
against **at least two real-world games of that engine**, not just one.
Single-game validation may produce a confident-looking pass that is in
fact specific to that one title's compiler version, key, or asset layout.

Where the second real-world game is not yet sourced (e.g. only one corpus
is staged for RealLive), the node's status remains `planned` with a
sourcing-required note in the summary; the orchestrator does not claim
the node ready until the second corpus is available. Audit workers must
not approve completion of an engine-claiming node whose verification only
exercises one real corpus.

The exception is **substrate-level** work that is genuinely
cross-engine (e.g. a generic asset resolver, a generic snapshot envelope)
— multiple real-world games means multiple engine families, not multiple
titles of the same engine.

### Investigation as a DAG node (2026-06-24)

Research and investigation happen **interactively** between the user and
the orchestrator/subagents — probing real bytes at the configured target
corpus root, reading source, consulting docs, running
one-shot probes. Concrete implementation nodes are written **from** the
research output, not as scaffolding for it. A node whose deliverable is
"figure out whether X" instead of "ship X" is not a DAG node; it is a
conversation that has not happened yet.

The footgun is precise: UTSUSHI-146's original "rlvm as research anchor"
framing collapsed an unknown-scope research effort into a single DAG node
that never bottomed out and was only made visible by the 2026-06-23 audit
batch. UTSUSHI-219 ("alpha-corpus XOR-2 key resolution (research-only)")
is the same shape — a research bench whose outcome ("either key off, or
key recovered, or follow-up path") cannot be committed to up front — and
is cancelled in this change. Resolution of the XOR-2 question happens
interactively (see the encryption-mechanism probe under
`docs/research/`); whatever falls out of that probe gets written as
concrete nodes (a `xor_2_key = None` ship, a key constant + test, or a
specific recovery node), not as a planning ticket.

Signals an audit worker or orchestrator must reject at claim time:

- Title contains "research-only", "investigation-only", "spike", "POC",
  or "research phase".
- Summary frames the work as "determine whether X" with conditional
  outcomes ("if A then X, if B then Y") instead of a committed
  deliverable.
- Acceptance criteria boil down to "the question is resolved" or "either
  outcome is acceptable" rather than naming a runnable artifact.
- The work product is a doc that says **what to build next** rather than
  the thing being built.

This rule is the sibling of the "Research-reference nodes that produce no
DAG output" anti-pattern above. That rule covers research anchors that
must produce concrete sub-nodes when they are admitted; this rule says
raw "do research" nodes should not be admitted to the DAG in the first
place. Together they close both shapes: research that gets deferred
forever as an anchor, and research that gets deferred forever as a
standalone planning ticket.

### Process: planning subagent checklist

When the orchestrator spawns a planning subagent, the prompt must require
the subagent to verify and document each of the above patterns it does NOT
introduce. The plan file must include a "DAG anti-pattern self-check"
section that states, for each pattern, whether the planned spec is
susceptible and how it avoids the pattern.

When the orchestrator spawns an audit subagent, the prompt must require the
audit to explicitly check each pattern against the merged code and call out
any violations as P0 or P1 findings.
