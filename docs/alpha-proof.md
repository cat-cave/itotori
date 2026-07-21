# Alpha Proof (Public-Fixture Vertical)

> **Milestone framework (2026-06-24).** The four-tier framework
> (real-game-testing-ready → alpha → beta → full release) and per-tier
> acceptance criteria live in [`project-readiness.md`](project-readiness.md)
> (renamed on 2026-06-24).
> "Alpha proof" in this document refers to the public-fixture manifest contract
> and its workflow. Those mechanisms support the **real-game-testing-ready**
> tier, not the new (stricter) alpha tier.

The **alpha proof** is the required cross-project integration guardrail. It is
the public-fixture vertical promoted into CI. It proves schema-valid,
hash-addressed linkage of cross-project artifacts rather than a fixture-specific
success string.

```sh
just install
just alpha-proof
```

`just alpha-proof` runs two stages, both of which fail the build on any broken
linkage:

1. `pnpm exec vp run alpha:public-fixture` — composes the public-fixture
   artifacts across Itotori, Kaifuu, and Utsushi, runs the benchmark harness
   fresh, and emits a hash-addressed vertical manifest under
   `artifacts/alpha/public-fixture/`.
2. `pnpm exec vp run alpha:public-fixture-validate` — re-proves linkage
   independently from the emitted artifacts (schema validity + hash-addressing +
   cross-artifact agreement), so the gate never trusts a printed success string.

The gate is **public-fixture-only and deterministic**: no database, no live
credentials, no private corpora, no raw provider payloads, and no private local
paths. The composed surface uses the committed synthetic public fixture (dialogue,
speaker names, choices, UI labels, tutorial text, database/glossary terms, image
text, and metadata); the proof is artifact linkage rather than a simulated
translation result.

## What the proof checks

The vertical and its linkage validator fail unless the following all agree on
the same public fixture id, source revision, locale branch, and content hashes:

- Itotori bridge bundle + patch export
- Kaifuu PatchResult + delta package
- Utsushi runtime observation proof
- Provider proof (recorded, sanitized)
- Benchmark report
- Dashboard / read-model ingestion
- Alpha-proof manifest

Any disagreement is emitted as a structured finding and a blocking finding sets
`verdict=broken`, which exits non-zero.

## Canonical integration command

Use `just alpha-proof` plus its artifact-linkage validator. CI runs the same
proof as its `alpha` job in
[`.github/workflows/_tier1.yml`](../.github/workflows/_tier1.yml)
(`just ci-tier1-alpha` → `alpha-proof`).
