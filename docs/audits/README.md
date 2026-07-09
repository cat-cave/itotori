# Audits Index

Finding aid for the 2026-06-24 audit batch. Each entry names the question the
doc answers, its headline finding, and the situation in which an orchestrator
should consult it. For the historical cold-start snapshot that points at this
index, see [`../current-state-2026-06-24.md`](../current-state-2026-06-24.md) —
that doc is bannered as a **point-in-time snapshot** preserved as the
historical record of the audit batch; the **live cold-start orientation** lives
in [`../dev/spec-dag.md`](../dev/spec-dag.md) (the committed
`roadmap/spec-dag.json` is the source of truth).

> **Post-audit-batch rename note (2026-06-24).** After this audit batch
> landed, the maintainer redefined the milestone framework into a four-tier
> structure: **real-game-testing-ready → alpha → beta → full release**.
> What the audits below (especially `alpha-scope-honesty.md` §D) call
> "alpha" is the dogfood/architecture-proven milestone now renamed to
> **real-game-testing-ready**. The new "alpha" names a stricter Sweetie HD
> end-to-end milestone with live LLM, full agentic loop, real patchback,
> and Linux replay. The audit docs are preserved as the historical record
> of the redefinition that prompted the rename; read them with the new
> vocabulary in mind. Authoritative tier definitions:
> [`../project-readiness.md`](../project-readiness.md). DAG re-tier
> proposal: [`../proposals/dag-retier-2026-06-24.md`](../proposals/dag-retier-2026-06-24.md).

## `alpha-scope-honesty.md`

Asks whether the alpha milestone description honestly matches what the
toolchain can do today, against the committed code and DAG. The headline
finding is that the previous "end-to-end Sweetie HD via complete native
RealLive port" framing collapsed a ~20–35 KLoC effort spanning ~22 sub-nodes
into a single DAG node, making alpha unreachable as a dogfood point; §D
sketches the 6-gate redefinition that landed. Consult when the orchestrator
needs to defend the redefined alpha against scope drift or when reviewing
proposed `target: alpha` node additions.

## `ci-state-2026-06-24.md`

Diagnostic snapshot of `just check` / `just test` / `just ci` / `just hello`
and their substeps on 2026-06-24, with exact commands and observed status.
The headline finding is that all four top-level commands are now green after
the unblock commit `f3734ce`; individual substeps (clippy, fmt, ts:typecheck,
spec-dag validate) are also green. Consult before any "is CI healthy?" claim,
when reproducing a substep failure locally, or when picking a starting point
for a hygiene-focused change.

## `code-criticism.md`

Reads every claimed-complete alpha-tier capability the user flagged as
potentially aspirational and grades each as load-bearing,
honest-prototype, minimal-pass-test, or aspirational, with `file:line` cites
and real-bytes runs against Sweetie HD. The headline tally for the focus set
is 4 load-bearing / 9 honest-prototype / 13 minimal-pass-test / 8
aspirational, concentrated on the RealLive chain and the workflow agents.
Consult when evaluating whether a "complete" node actually defends behavior
against real inputs, or when scoping a re-implementation pass.

## `dag-critique.md`

Reviews `roadmap/spec-dag.json` for nodes whose scope or acceptance criteria
are loose enough that a thin wrapper could legitimately pass. The headline
finding is that `UTSUSHI-146` ("the entire RealLive runtime port" as one
node) was the most extreme instance and is now decomposed into 22 sub-nodes
(`UTSUSHI-200..221`); the proposed-actions summary at the bottom lists every
other split/tightening recommendation. Consult before adding or claiming any
coarse infrastructure node.

## `non-reallive-fixture-needs-2026-06-24.md`

Maps what code, fixtures, and DAG nodes exist today for the two non-RealLive
engines named as claimed-alpha (RPG Maker MV/MZ, plain XP3 + KAG) and which
real-game fixtures would exercise each parser/patchback/runtime path. The
headline finding is that both engines have substrate-level parser coverage
but no end-to-end real-game vertical, and the document names the specific
fixture-shape gaps the maintainer should match owned archives to. Consult
when sourcing a second multi-game corpus or planning fixture-replacement
work for `KAIFUU-200..209` / `UTSUSHI-179..182`.

## `real-bytes-validation-2026-06-24.md`

Runs every `kaifuu-*` and `utsushi-*` CLI entry point and public library
surface against the real Sweetie HD bytes and records exact commands, exit
status, and upstream cause of each failure. The headline finding is that
`kaifuu-cli detect` returns false, `parse_archive` silently returns an empty
entry list on the real 3.87 MB `Seen.txt`, and 98.7% of Gameexe keys come
back Unknown — feeding the `KAIFUU-188` / `KAIFUU-189` / `KAIFUU-190`
follow-up nodes. Consult when implementing those nodes, or when proposing
any new node whose acceptance criteria touch real Sweetie HD bytes.

## `silenced-2026-06-24.md`

Scans `crates/`, `apps/`, `packages/`, `scripts/` for silenced tests,
ignored failures, and disabled lints, with reproducible ripgrep queries.
The headline finding is that current silences are overwhelmingly legitimate
(subprocess-fixture `#[ignore]`s, test-helper `#![allow]`s, validated-upstream
`unreachable!()` markers); only a handful of crate-level `#[allow(...)]` items
are flagged as cruft worth removing. Consult to confirm the alpha-gate
repo-hygiene line ("no silenced tests representing real outstanding work")
or before adding a new silence.

## `substrate-honesty.md`

Audits the `UTSUSHI-020..120` substrate cascade against a hypothetical
RealLive engine port for Sweetie HD, asking whether the substrate factors
the right traits and surfaces. The headline finding is that the substrate is
architecturally credible (right factoring, right traits) but is missing five
specific extensions M.1–M.5 needed before a real engine port can land;
M.1–M.3 (`UTSUSHI-222/223/224`) are alpha gates, M.4/M.5
(`UTSUSHI-225/226`) are RealLive-specific continuous-tier. Consult before
touching the substrate cascade or when sizing a new engine port crate.

## `test-quality.md`

Grades the test suites of the currently-`complete` DAG nodes (≈2,000 tests
across TS/Rust) on contract-vs-tautology, with focus on the workflow agents,
the RealLive chain, vault-source, and catalog adapters. The headline finding
is that the kaifuu-reallive suite is essentially an author-fixture
round-trip (the parser cannot read the real 3.87 MB `Seen.txt`), the
workflow-agent suites gate on a `FakeModelProvider` echo, and the
`migrations.ts` registration bug for ITOTORI-015/016 is exactly the class of
defect a contract test should catch. Consult when adding or replacing tests
on those node families, especially the synthetic-smoke replacement in
Wave A.
