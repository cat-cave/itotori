# Hello World

> **Milestone framework (2026-06-24).** The four-tier framework
> (real-game-testing-ready → alpha → beta → full release) and per-tier
> acceptance criteria live in [`project-readiness.md`](project-readiness.md)
> (renamed from `alpha-localization-project-readiness.md` on 2026-06-24).
> "Alpha proof" in this document refers to the SHARED-025 manifest contract
> and the `ALPHA-009` workflow that originally supersedes the hello-world
> fixture gate — those mechanisms now support the **real-game-testing-ready**
> tier, not the new (stricter) alpha tier.

The hello world is the current baseline integration guardrail. It is a full
fixture localization loop that proves the monorepo wiring is real before the
alpha proof workflow exists.

```sh
just install
just db-up
just hello
```

The command runs:

1. `kaifuu extract` on `fixtures/hello-game`.
2. `itotori import`, `draft`, and `export-patch`.
3. `kaifuu patch`, `diff`, `apply`, and `verify`.
4. `utsushi trace`, `capture`, and `smoke`.
5. `itotori ingest-runtime` and final summary generation.
6. `itotori dashboard-status` reads the dashboard state from Postgres.

Expected final line:

```txt
status=hello_world_passed
```

The fixture source includes dialogue, speaker names, choices, UI labels,
tutorial text, database/glossary-like terms, image text, and metadata text. The
first dialogue unit remains `こんにちは、{player}。`; the fake provider outputs
`Hello, {player}.`, and deterministic checks preserve protected placeholders and
inline control markup across the expanded fixture.

## Graduation Path

The literal Hello World workflow is intentionally temporary. It should stay in
CI until `ALPHA-007` implements the suite public fixture vertical command and
`ALPHA-009` replaces the workflow with an alpha proof gate.

The stop condition is not "the scaffold feels old." The stop condition is that
the replacement alpha proof workflow is implemented, public-fixture-only, green
in CI, and checks the same or stronger cross-project contract. In particular,
CI should stop proving only that `status=hello_world_passed` printed and should
instead validate that bridge, patch, provider proof, benchmark, runtime
observation, dashboard/read-model ingestion, and the SHARED-025 alpha proof
manifest all refer to the same public fixture id, source revision, locale branch,
and content hashes.

After that point there should not be two independent integration truths. The
old GitHub Hello World workflow should be removed or renamed into the alpha
proof workflow. If `just hello` remains for compatibility, it should be a thin
alias for `just alpha-proof` and must not carry a divergent success-string-only
contract.
