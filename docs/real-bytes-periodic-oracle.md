# Real-bytes periodic ground-truth oracle

The strict-proof **anchor** for the synthetic-CI collapse.

## Why it exists

The synthetic-CI collapse moves per-gate CI onto fast synthetic fixtures — the
coverage manifest (`fixtures/synthetic/coverage-manifest.v0.json`) plus
differentially-validated synthetic archives — so a per-gate run no longer
re-parses whole real games (~30-45 min). That speed is only **safe** while the
synthetic still faithfully mirrors reality.

This oracle is the safety net. It is a **periodic** run — nightly + on-demand,
invoked **outside** the per-gate `qd-full-ci` path — that keeps the real
archives as ground truth and **fails loud** the moment the synthetic drifts away
from what the real bytes exercise. Paying the slow real-bytes cost periodically
(instead of per-gate) is the entire trade the collapse makes; this oracle is
what makes that trade honest.

## What it does

Two stages, run by `scripts/real-bytes-oracle.mjs`. Either failing fails the
whole run (nonzero exit):

- **(A) Ground truth** — re-runs the full real-bytes suite (`just
ci-real-bytes`) against the real corpora (Sweetie HD + Kanon RealLive,
  LustMemory RPG Maker MV/MZ, and the vault-materialized Siglus installs),
  read-only, never copying copyrighted bytes. Passing proves the
  source-of-truth catalogues (`REAL_CATALOG`, `NamedOpcode`, `classify()`, the
  g00 type matrix, the cipher cases, the decoder-parity counts, …) still match
  the real bytes — the 100%-decompilation / 0-unknown-opcode bar.

- **(B) Synthetic-vs-real drift check** — re-derives the coverage manifest from
  the **same** live source-of-truth catalogues the real-bytes suite keys on and
  diffs it against the committed manifest. It fails loud if:
  - a real-bytes-exercised component appears that the manifest does **not**
    cover (`missing` — synthetic dropped below real coverage),
  - the manifest lists a component the sources **no longer** produce (`extra` —
    invented/stale coverage), or
  - the manifest bytes otherwise diverged (metadata/formatting drift).

  It first runs the manifest extractor self-test so a silent parser break can't
  mask a real drift as "no diff", and — once the differential-validation node
  lands `scripts/synthetic-differential-validation.mjs` — runs that validator
  too (guarded on existence).

### Why the two stages prove the guarantee

They chain:

| stage | proves                                                         |
| ----- | -------------------------------------------------------------- |
| (A)   | catalogues **==** real bytes (0 unknown opcodes on real bytes) |
| (B)   | manifest **==** catalogues (re-derived diff is empty)          |
| ∴     | manifest (the synthetic's coverage contract) **==** real bytes |

If the synthetic ever silently diverged from reality, one of these links breaks
and the run goes red.

## Cadence

- **Nightly cron** + **manual `workflow_dispatch`** via
  `.github/workflows/real-bytes-oracle.yml`.
  - `drift-check` job runs on a hosted runner (repo-only, no corpora) so drift
    is caught every night regardless of where the real bytes are staged.
  - `ground-truth` job runs on a `[self-hosted, itotori-corpora]` runner that
    has the real corpora staged (the corpora live under `/scratch` +
    `/archive/vault` and are never committed). On a runner without the corpora,
    `just ci-real-bytes` pre-checks the roots and fails loud rather than passing
    with zero real bytes — a red run, never a false green.
  - `workflow_dispatch` takes a `stage` input: `full`, `drift-only`, or
    `ground-truth-only`.
- **On-demand locally**: `just real-bytes-oracle` (full) or `just
real-bytes-oracle-drift` (drift check only, no corpora).

## It is NOT in the per-gate CI path

The oracle is intentionally **not** wired into `scripts/affected.mjs` /
`scripts/qd-full-ci.mjs`. The `real-bytes-oracle` / `real-bytes-oracle-drift`
recipes are not in the affected-lane order, so a per-gate `qd-full-ci` run never
selects them. That separation is the whole point: per-gate green stays fast and
never waits on the ~30-45 min real-bytes suite; the slow ground-truth cost is
paid periodically instead.

## What a failure means

A red oracle means the synthetic fixtures / coverage manifest **drifted** away
from what the real bytes exercise. **Re-derive the synthetic**:

1. Regenerate the coverage manifest with `node
scripts/synthetic-coverage-manifest.mjs`.
2. Re-author / re-validate the synthetic fixtures against the real corpora.
3. Land the update **before** trusting per-gate green again.

The failure message on every red path prints this same re-derive hint.

## Corpora are read-only; nothing copyrighted is committed

Stage (A) reads the corpora in place under `/scratch/itotori-research` +
`/archive/vault`, read-only, exactly like `just ci-real-bytes`. No copyrighted
bytes are copied or committed; only the derived, non-copyrighted coverage
manifest is tracked.
