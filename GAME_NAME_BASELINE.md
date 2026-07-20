# Game-name baseline — the generalization purge worklist

North star: **no game is ever mentioned by name anywhere in shared/production
code.** A concrete game name (title, slug, vendor, or VNDB game id) baked into
an engine, CLI, app, or script is a generalization bug — a game's identity
belongs only in per-game DATA (fixtures, presets, test corpora), never in a code
path.

This inventory is the machine-checked worklist behind that goal. The guard
`scripts/audit-no-game-names.mjs` scans tracked source under `crates/`,
`packages/`, `apps/`, `scripts/` (excluding tests, fixtures, examples, docs,
build output, and the guardrail scanners themselves) and holds every existing
in-code game reference in a **shrink-only** ratchet whitelist
(`scripts/lint/game-name-whitelist.json`). Each genericization fix runs
`node scripts/audit-no-game-names.mjs --update` to ratchet the baseline DOWN;
the guard refuses to grow. When the whitelist reaches zero the purge is
provably complete.

## Baseline (this commit)

**287 in-code game references across 66 files.** This is the finish-line meter —
watch it fall to 0.

Token frequency:

| token | count | what it is |
| --- | --- | --- |
| `sweetie` | 221 | primary RealLive alpha-corpus slug (human title "Sweetie HD" contains it) |
| `v60663` | 18 | Softpal corpus VNDB game id |
| `corpus-observed` | 12 | marker: a constant derived from one game's real bytes, presented as universal |
| `sukara` | 11 | RealLive corpus vendor slug |
| `v21465` | 11 | Softpal corpus VNDB game id |
| `オシオキ` | 5 | Japanese title form of the RealLive alpha corpus |
| `karetoshi` | 4 | Siglus corpus game slug |
| `gamekoi` | 3 | Siglus corpus game slug |
| `oshioki` | 2 | RealLive alpha corpus slug (romaji) |

Curated real-game VNDB ids the guard also matches if they reappear in code (not
present in-scope today): `v11180`, `v31045`, `v55293`, `v57740`. Synthetic test
ids (`v1001`, `v1234`, `v9999`, …) are deliberately **not** matched.

## Category (a) — RealLive / Sweetie engine substrate constants (225 tokens, 45 files)

`crates/kaifuu-reallive/**` + `crates/utsushi-reallive/**`. The bulk. These are
the RealLive decode/render substrate that encodes one game's real-byte
observations (compiler versions, opcode aliases, scene layouts, syscall routes,
save format, WBCALL slot caps, `1280×720` frame size, `z0001` voice archive ids)
as if universal. This is the target of the `reallive-de-sweetie` genericization
node. `corpus-observed` markers (12) cluster in `utsushi-reallive/src/syscall*`
— each stamps a constant that must become engine-validated or move to per-game
config. Highest-density files:

| file | tokens | tokens |
| --- | --- | --- |
| `crates/kaifuu-reallive/src/opcode.rs` | 19 | sweetie x19 |
| `crates/utsushi-reallive/src/syscall.rs` | 19 | sweetie x15, corpus-observed x4 |
| `crates/utsushi-reallive/src/syscall/types.rs` | 15 | corpus-observed x8, sweetie x7 |
| `crates/utsushi-reallive/src/save.rs` | 14 | sweetie x11, オシオキ x3 |
| `crates/kaifuu-reallive/src/bridge.rs` | 12 | sweetie x11, sukara x1 |
| `crates/utsushi-reallive/src/rlop/module_sel.rs` | 11 | sweetie x11 |
| `crates/utsushi-reallive/src/decompressor.rs` | 10 | sukara x6, sweetie x4 |
| `crates/kaifuu-reallive/src/detector.rs` | 9 | sweetie x7, オシオキ x2 |
| `crates/utsushi-reallive/src/rlop/module_msg.rs` | 8 | sweetie x8 |
| ...36 more files (1–6 each): `lib.rs`, `nwa.rs`, `ovk.rs`, `g00.rs`, `gameexe.rs`, `scene_header.rs`, `scene_index.rs`, `xor2.rs`, `archive.rs`, `engine_port.rs` (hardcoded `PORT_FRAME_WIDTH=1280`), `bytecode_element.rs`, `expression*.rs`, `replay*.rs`, `render_pipeline/*`, `rlop/module_*`, `vm.rs`, `var_banks.rs`, `scene_store.rs`, `parser.rs`, `bridge/tests_*.rs`, `patchback/bundle_driven.rs` | | mostly `sweetie` |

## Category (b) — app / CLI RealLive defaults (8 tokens, 7 files)

The user-facing surfaces that default to or name the alpha corpus. These should
take the game as data/param, never hardcode it.

| file | tokens | tokens |
| --- | --- | --- |
| `apps/itotori/src/play/patch-runtime-launcher.ts` | 2 | sweetie x2 |
| `apps/itotori/src/extract/decode-extract-runner.ts` | 1 | sweetie x1 |
| `apps/itotori/src/structure-export/utsushi-structure-seam.ts` | 1 | sweetie x1 |
| `crates/kaifuu-cli/src/partial_adapter.rs` | 1 | sweetie x1 |
| `crates/utsushi-cli/src/patch_render.rs` | 1 | sweetie x1 |
| `crates/utsushi-cli/src/render_validate.rs` | 1 | sweetie x1 |
| `crates/utsushi-cli/src/staged_replay.rs` | 1 | sweetie x1 |

## Category (c) — everything else (54 tokens, 14 files)

Other engine families and shared scripts that name their corpus by design today.

**Softpal / Siglus engine substrate** (VNDB ids + slugs presented as universal):

| file | tokens | tokens |
| --- | --- | --- |
| `crates/kaifuu-softpal/src/script.rs` | 19 | v60663 x13, v21465 x6 |
| `crates/kaifuu-softpal/src/opcode.rs` | 4 | v21465 x2, v60663 x2 |
| `crates/kaifuu-softpal/src/patchback.rs` | 3 | v60663 x2, v21465 x1 |
| `crates/kaifuu-softpal/src/lib.rs` | 2 | v21465 x1, v60663 x1 |
| `crates/utsushi-softpal/src/scene_runtime.rs` | 1 | v21465 x1 |
| `crates/kaifuu-siglus/src/lib.rs` | 4 | gamekoi x2, karetoshi x2 |
| `crates/kaifuu-siglus/src/gameexe.rs` | 2 | gamekoi x1, karetoshi x1 |
| `crates/kaifuu-siglus/src/bridge.rs` | 1 | karetoshi x1 |

**Shared runtime / vault-source:**

| file | tokens | tokens |
| --- | --- | --- |
| `crates/kaifuu-vault-source/src/resolution.rs` | 2 | oshioki x1, sweetie x1 |
| `crates/utsushi-core/src/observation/metadata.rs` | 1 | sweetie x1 |

**Scripts** (operator/CI helpers that name the corpus):

| file | tokens | tokens |
| --- | --- | --- |
| `scripts/ci/private-real-byte-proof.mjs` | 7 | sweetie x7 |
| `scripts/synthetic-coverage-manifest.mjs` | 4 | sweetie x3, oshioki x1 |
| `scripts/stale-residue-guard.mjs` | 3 | sweetie x3 |
| `scripts/real-bytes-oracle.mjs` | 1 | sweetie x1 |

## How to use this worklist

1. Pick a file, genericize the reference (move the game's identity into a
   per-game data record — fixture / preset / config — or a parameter).
2. Run `node scripts/audit-no-game-names.mjs --update` — it ratchets the
   baseline down and refuses to grow.
3. Commit the shrunk `scripts/lint/game-name-whitelist.json` with the fix.

The guard is wired into `just ci-tier0-meta`; a new game reference fails CI.
