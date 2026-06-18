# Hello World

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

The replacement must preserve the useful signal from this loop while removing
placeholder-specific assertions. In particular, CI should stop proving only that
`status=hello_world_passed` printed and should instead validate that bridge,
patch, provider proof, benchmark, runtime observation, dashboard/read-model
ingestion, and the SHARED-025 alpha proof manifest all refer to the same public
fixture id and source revision.
