# Alpha Proof (Public-Fixture Vertical)

> **Milestone framework (2026-06-24).** The four-tier framework
> (real-game-testing-ready → alpha → beta → full release) and per-tier
> acceptance criteria live in [`project-readiness.md`](project-readiness.md)
> (renamed from `alpha-localization-project-readiness.md` on 2026-06-24).
> "Alpha proof" in this document refers to the SHARED-025 manifest contract and
> the `ALPHA-009` workflow that superseded the literal hello-world fixture gate
> — those mechanisms support the **real-game-testing-ready** tier, not the new
> (stricter) alpha tier.

The **alpha proof** is the required cross-project integration guardrail. It is
the public-fixture vertical implemented by `ALPHA-007` and promoted into CI by
`ALPHA-009`. It replaced the retired literal "Hello World" workflow: the proof
is now the schema-valid, hash-addressed linkage of real cross-project artifacts,
not a `status=hello_world_passed` success string.

```sh
just install
just alpha-proof
```

`just alpha-proof` runs two stages, both of which fail the build on any broken
linkage:

1. `pnpm exec vp run alpha:public-fixture` — composes the public-fixture
   artifacts across Itotori, Kaifuu, and Utsushi, runs the ITOTORI-026 benchmark
   harness fresh, and emits a hash-addressed vertical manifest under
   `artifacts/alpha/public-fixture/`.
2. `pnpm exec vp run alpha:public-fixture-validate` — re-proves linkage
   independently from the emitted artifacts (schema validity + hash-addressing +
   cross-artifact agreement), so the gate never trusts a printed success string.

The gate is **public-fixture-only and deterministic**: no database, no live
credentials, no private corpora, no raw provider payloads, and no private local
paths. The composed surface still uses the synthetic `fixtures/hello-game`
corpus (dialogue, speaker names, choices, UI labels, tutorial text,
database/glossary terms, image text, and metadata), but the proof is the
artifact linkage rather than the literal output line.

## What the proof checks

The vertical and its linkage validator fail unless the following all agree on
the same public fixture id, source revision, locale branch, and content hashes:

- Itotori bridge bundle + patch export
- Kaifuu PatchResult + delta package
- Utsushi runtime observation proof
- Provider proof (recorded, sanitized)
- ITOTORI-026 benchmark report
- Dashboard / read-model ingestion
- SHARED-025 alpha proof manifest

Any disagreement is emitted as a structured finding and a blocking finding sets
`verdict=broken`, which exits non-zero.

## No second source of truth

`ALPHA-009` removed the GitHub "Hello World" workflow and the literal
`hello`-recipe loop. The required integration command is now `just alpha-proof`
plus the artifact-linkage validator; CI runs it in
[`.github/workflows/alpha-proof.yml`](../.github/workflows/alpha-proof.yml).

`just hello` is retained **only** as a compatibility alias because several
roadmap nodes still declare it as a verification command. It delegates directly
to `just alpha-proof` (`hello: alpha-proof` in the root `justfile`) and cannot
diverge from it: there is no separate Hello World gate and no
success-string-only contract.
