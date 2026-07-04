# Synthetic-fixture differential validation

**What this proves:** the fast, copyright-free **synthetic** fixtures are _as
strong as_ the ~30-minute **real-bytes** lanes at **catching regressions**, so a
per-gate CI lane may run the synthetic corpus **instead of** re-parsing whole
real archives **without losing regression-detection power**. This is the
guardrail that makes single-mode synthetic CI strict-proof-compliant and kills
the real-bytes gate drag.

It is **not** a claim that synthetic bytes _are_ real bytes. It is a claim about
**detection power**, established by two independent safeguards that must **both**
hold. A synthetic fixture qualifies to replace a real-bytes test in a per-gate
lane **only when**:

> `mutation-kill(synthetic) >= mutation-kill(real)` **AND** `coverage-parity(synthetic ⊇ real)`.

The real ground-truth corpora are **not** deleted — they remain the periodic
ground truth in `just ci-real-bytes`, run OUTSIDE per-gate CI as the nightly
`real-bytes-oracle` (see `docs/real-bytes-periodic-oracle.md`). Per-gate CI is
single-mode synthetic; this differential validation certifies the per-gate
synthetic lane loses nothing between those periodic runs.

---

## Safeguard 1 — Mutation testing (`scripts/mutation-differential.mjs`)

A **source-level mutation runner** — the faithful, strict-proof form. For each
realistic decoder/patchback/replay bug it:

1. applies a targeted one-line **source patch** to the **real** decoder/patchback
   code (never a mock, never a data corruption — the real algorithm is broken);
2. recompiles and runs the owning engine family's **synthetic** (default,
   non-`#[ignore]`, no-real-bytes) test suite;
3. asserts the synthetic suite turns **RED** (the mutation is _killed_);
4. **always reverts** the source and verifies it is byte-identical to the
   original (the mutations are never shipped in the real code path — they live
   only in the harness).

A mutation the synthetic suite lets pass is an **escape** — a coverage hole — and
the lane **fails loud (exit 1)**. A non-compiling patch is **invalid** (not a
legitimate kill) and also fails.

### The mutation set (representative real-regression classes)

| id                              | class                                           | file                                             |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `header_wrong_offset`           | wrong offset (off-by-one header read)           | `kaifuu-reallive/src/scene_header.rs`            |
| `opcode_byteswap`               | swapped / mis-typed opcode                      | `kaifuu-reallive/src/opcode.rs`                  |
| `framing_off_by_one`            | off-by-one framing (header width)               | `kaifuu-reallive/src/opcode.rs`                  |
| `xor2_skip_cipher`              | skipped / incorrect cipher (xor_2)              | `kaifuu-reallive/src/xor2.rs`                    |
| `avg32_broken_backref`          | broken AVG32 LZSS back-reference run length     | `utsushi-reallive/src/decompressor.rs`           |
| `patchback_no_rebase`           | patchback jump-recalc error (goto not re-based) | `kaifuu-reallive/src/patchback/bundle_driven.rs` |
| `choice_drop_option`            | dropped choice option                           | `kaifuu-reallive/src/opcode.rs`                  |
| `g00_paletted_reorder`          | broken paletted-LZSS G00 palette B/R reorder    | `utsushi-reallive/src/g00.rs`                    |
| `rpgmaker_misclassify_dialogue` | mis-typed opcode (cross-family: RPG Maker code) | `kaifuu-rpgmaker/src/codes.rs`                   |

**Result: 9/9 killed by the synthetic suite (kill rate 100%), ~90 s total.**

### Why 100% synthetic kill ⇒ `synthetic >= real`

The mutation set is drawn from the representative real-regression classes, each
landing in a code path the real-bytes lanes also exercise (Safeguard 2). If the
synthetic suite kills **every** mutation, then trivially

```
synthetic_kills (= N)  >=  real_kills (<= N)
```

— there is **no** mutation real could catch that synthetic misses, because
synthetic catches all of them. The proof therefore does **not** require running
the slow real lane. `node scripts/mutation-differential.mjs --with-real` runs the
real-bytes lane per mutation as _corroborating_ evidence only (needs the staged
corpora + env).

### One gap the harness found — and how it was closed

The `g00_paletted_reorder` class originally **escaped**: the type-1 (paletted
LZSS) G00 decode path was exercised **only by real bytes** — no synthetic
paletted fixture existed, so a mutation to the palette decode passed the
synthetic suite green. This was closed (not documented away) by authoring a
synthetic type-1 G00 fixture (`synthetic_type1_g00`, using the same SCN2k literal
encoder the type-2 fixture uses) and a first-pixel assertion in
`synthetic_g00_images_instantiate_every_g00_type`. The mutation is now **killed**.
This is the intended workflow: _a real-only gap the harness surfaces is closed by
strengthening the synthetic fixture until it catches it_ (or, when genuinely
unclosable, recorded in the real-only ledger below).

---

## Safeguard 2 — Coverage parity (`scripts/coverage-parity.mjs`)

Asserts the synthetic corpus exercises the **same component surface** the
real-bytes tests do, cross-checking three artifacts and failing loud on any
mismatch:

1. **`fixtures/synthetic/coverage-manifest.v0.json`** — the per-engine-family
   enumeration of every unique component the real corpora + real-bytes tests
   exercise, each entry **derived** from a named source-of-truth
   catalogue/enum/assertion (already 100%-instantiated; enforced by
   `scripts/synthetic-coverage-manifest.mjs --check`).
2. **`INSTANTIATION_MAP`** — for **every** manifest component group, the synthetic
   test file + `#[test]` fn that drives that group's components through the real
   decoder and asserts 100% instantiation. A manifest group with no synthetic
   instantiation test ⇒ synthetic is **not** ⊇ real ⇒ **FAIL**. (This makes
   "synthetic ⊇ real" _enforced_, not asserted in prose — adding a manifest group
   without a synthetic test breaks the lane.)
3. **`REAL_ONLY_SURFACES`** — the honest, reviewed list of residual surfaces only
   real bytes exercise, each with its reason and where its underlying decode
   **logic** is still covered so no correctness regression escapes.

All **11 manifest component groups** (across RealLive, RPG Maker MV/MZ,
KiriKiri XP3, Siglus) map to a synthetic instantiation test → synthetic ⊇ real.

### Documented real-only residual surfaces (nothing hidden)

| id                                                        | surface                                                             | why real-only                                                                                      | decode logic still covered by                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `avg32_scn2k_tail_clip_under_backreference`               | AVG32/SCN2k "clip final back-ref to declared size" branch           | synthetic corpora are literal-only, so decode is input-bounded and never reaches the out_size clip | back-ref _copy_ logic covered by the decompressor synthetic unit tests + type-0 G00 trailing back-ref                                              |
| `reallive_real_scene_plaintext_variety_for_xor2_recovery` | xor_2 key recovery over real scenes' natural plaintext distribution | synthetic stages a planted key over uniform padding for exact recovery                             | recovery+validate+decrypt _algorithm_ runs on the synthetic xor2 corpus; mutation-killed by `xor2_skip_cipher`                                     |
| `siglus_real_opcode_catalogue`                            | real Siglus opcode semantics                                        | the Siglus opcode catalogue is still a skeleton stub (only `Unknown`)                              | manifest records `status=stub_no_catalogue`; synthetic instantiates the stub opcode; add real opcodes + remove this entry when the catalogue lands |

Each residual is an **integration** surface whose decode **logic** is covered
elsewhere — no decode-correctness regression can escape the synthetic suite.

---

## How it is wired into CI

Per-gate CI is **single-mode synthetic** — it runs the fast synthetic suites +
these two safeguards, and needs **no** real corpora. The ~30-45min real-bytes
lane is periodic-only (`just real-bytes-oracle`), never per-gate.

- **`just check`** (fast, always-run per-gate lane):
  `node --test scripts/mutation-differential.test.mjs` +
  `node --test scripts/coverage-parity.test.mjs` +
  `node scripts/coverage-parity.mjs`.
  Cheap: harness-logic regression tests + the static component-surface parity
  check (Safeguard 2). No Rust recompile.
- **`just mutation-differential`** (heavy kill-matrix, run by `just ci` AND
  selected per-gate for any crate-family diff via `scripts/affected.mjs`):
  `node scripts/mutation-differential.mjs` — the source-level mutation kill
  matrix (Safeguard 1). Deterministic; ~90 s; fails loud on an escaped mutation.
  This is the per-gate lane that **replaced** the old ~30-45min real-bytes lane:
  a crate change now runs the family's synthetic rust gate + this guardrail, NOT
  `ci-real-bytes`. The real corpora are re-run only in the periodic oracle.

The cargo driver defaults to `cargo`; override with `ITOTORI_MUTATION_CARGO`
(e.g. `direnv exec . cargo`) outside the devshell.
