# Alpha Readiness

This document is the **alpha readiness README**: the checked statement of what
the suite can do at the alpha milestone and how a new user proves it from a
fresh clone. It is the human-facing companion to the machine gate
`just alpha-readiness-checklist`
([`scripts/alpha-readiness-checklist.mjs`](../scripts/alpha-readiness-checklist.mjs)).

> **What "alpha" means here.** Alpha is **readiness to _start_ a real
> localization project**, not a finished product and not a terminal release.
> It means the whole pipeline fires end-to-end on a single real game and that
> every stage is swappable — "let's try a different QA strategy" is a tractable
> change rather than a rewrite. Output quality is explicitly **not** the bar at
> alpha (worse-than-MTL is acceptable). The tiered definition lives in
> [`project-readiness.md`](project-readiness.md); beta (≥2 games per engine,
> encrypted variants) and full release come later.

## 1. The pipeline (not "just translation")

Itotori is a full games-localization pipeline, not a translation box. The
stages, in order:

1. **Catalog** — resolve a title from the read-only vault / catalog source
   adapters ([`itotori-vault-source-adapter.md`](itotori-vault-source-adapter.md),
   [`itotori-catalog-source-adapter-contract.md`](itotori-catalog-source-adapter-contract.md)).
2. **Inventory** — enumerate archives, assets, and localizable surfaces for the
   detected engine ([`localization-surfaces.md`](localization-surfaces.md)).
3. **Readiness** — classify engine/encryption/key posture and decide whether a
   title is realizable under the project laws (this document + the generated
   capability matrix below).
4. **Extraction** — Kaifuu reads real bytecode/archives and produces a bridge
   bundle ([`subprojects-kaifuu.md`](subprojects-kaifuu.md)).
5. **Localization** — Itotori's agentic loop (context → pre-translation →
   translation → QA → repair) drafts and reviews against a chosen
   `(modelId, providerId)` pair ([`subprojects-itotori.md`](subprojects-itotori.md)).
6. **Patching** — Kaifuu writes the localized bytes back (offset-table rewriting,
   JA→EN expansion) and emits a `.kaifuu` delta package + `PatchResult`
   ([`kaifuu-patch-safety.md`](kaifuu-patch-safety.md)).
7. **Validation** — Utsushi replays the patched output and captures runtime
   evidence tying observed post-patch text/choices back to bridge unit refs
   ([`subprojects-utsushi.md`](subprojects-utsushi.md),
   [`utsushi-runtime-artifacts.md`](utsushi-runtime-artifacts.md)).

The alpha proof exercises this whole chain end-to-end, not the translation
stage in isolation.

## 2. Fresh-clone demo (public fixtures only — no secrets, no real bytes)

From a clean checkout, after `just install`:

```sh
just alpha-demo
```

`just alpha-demo` runs the public-fixture alpha vertical (`just alpha-proof`):
Kaifuu extraction → Itotori draft/patch export → Utsushi runtime observation →
sanitized provider proof → fresh ITOTORI-026 benchmark → SHARED-025 manifest,
then independently re-proves cross-artifact linkage. It is **public-fixture-only
and deterministic**: no database, no live credentials, no private corpora, no
retail bytes. It fails unless every artifact agrees on the same fixture id,
source revision, locale branch, and content hashes — there is no success-string
shortcut. See [`alpha-proof.md`](alpha-proof.md).

To see the real-project pipeline plan without touching a game or an LLM (select
an alpha target-data record with `--project <alpha-target>`; the committed
allowlisted target record is listed in
[`fixtures-and-corpora.md`](fixtures-and-corpora.md#title-reference-allowlist-for-active-docs)):

```sh
just localize-project --dry-run --project <alpha-target>
```

The dry run prints the per-stage extract → localize → patch → replay commands
and the per-stage ZDR posture, and makes **zero** LLM calls. Live runs require
explicit corpus + credential env (see [`install.md`](install.md) and
[`security-and-limitations.md`](security-and-limitations.md)); they are never
the default and never fall back to a live provider silently.

## 3. Generated capability claims

The claims below are **re-derived from the generated engine capability matrix**
([`../apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json`](../apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json),
produced by [`scripts/generate-engine-capability-matrix.mjs`](../scripts/generate-engine-capability-matrix.mjs)
and drift-guarded by its `--check` mode). `just alpha-readiness-checklist`
re-derives these blocks from that matrix and fails if the text here has drifted,
so this section cannot silently overstate coverage. `positive_adapter` means an
adapter is exercised end-to-end on a fixture; `readiness_only` means detection /
key-posture evidence only, not an end-to-end extract/patch claim.

<!-- ALPHA-READINESS-CAPABILITY-CLAIMS:START -->
<!-- generated from apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json; edit that generator, not this block -->

Engine families in the generated capability matrix: **8**.

| engine family       | evidence posture |
| ------------------- | ---------------- |
| `bgi_ethornell`     | readiness_only   |
| `kiri_kiri_xp3`     | readiness_only   |
| `reallive`          | readiness_only   |
| `rpg_maker_mv_mz`   | readiness_only   |
| `siglus`            | readiness_only   |
| `synthetic_fixture` | positive_adapter |
| `tyranoscript`      | readiness_only   |
| `wolf_rpg_editor`   | readiness_only   |

<!-- ALPHA-READINESS-CAPABILITY-CLAIMS:END -->

<!-- ALPHA-READINESS-EXCLUSION-CLAIMS:START -->
<!-- generated from apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json; edit that generator, not this block -->

Engine families explicitly EXCLUDED from the capability breadth: **2**.

- `renpy`
- `unknown`
<!-- ALPHA-READINESS-EXCLUSION-CLAIMS:END -->

> Alpha end-to-end is **single-game (RealLive)** by definition. `readiness_only`
> rows are detection/key-posture evidence, NOT end-to-end support claims;
> multi-game and encrypted-variant end-to-end coverage is beta work
> ([`project-readiness.md`](project-readiness.md) §2.3, §3).

## 4. Evidence node references

The alpha readiness gate validates that each of these DAG nodes resolves in
`roadmap/spec-dag.json` and is cited here. Together they cover the required
gates: CI, the alpha-proof / public-fixture vertical, the benchmark smoke, and
recorded-or-opted-in real-provider proof.

| node          | proves                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALPHA-006`   | first real-engine end-to-end alpha vertical (RealLive); the live provider path (`alpha-006d` full-chain + `agentic-repair-live` residue) is opt-in.     |
| `ALPHA-007`   | suite public-fixture vertical run (`just alpha-proof` / `just alpha-demo`).                                                                             |
| `ALPHA-008`   | sanitized live-provider proof bundle.                                                                                                                   |
| `ITOTORI-116` | public real-LLM proof harness (recorded by default; `--live` opt-in).                                                                                   |
| `ITOTORI-117` | real-LLM degenerate raw-MTL baseline proof through the same harness.                                                                                    |
| `KAIFUU-042`  | alpha encrypted-readiness evidence integration: composes the KAIFUU-103 / KAIFUU-104 encrypted-readiness proofs; deterministic redacted no-corpus skip. |
| `UTSUSHI-119` | MV/MZ patched-output runtime proof: runtime observation consumes a `PatchResult` + SHARED-025 manifest ids (not a static/pre-patch read).               |
| `SHARED-025`  | alpha vertical proof manifest contract (ties bridge / patch / runtime / provider / benchmark ids + content hashes).                                     |
| `UNIV-013`    | self-contained DB test + scale smoke recipe.                                                                                                            |
| `SHARED-013`  | permission-gate negative test matrix.                                                                                                                   |
| `SHARED-014`  | permission constant + migration drift guard.                                                                                                            |
| `UNIV-021`    | spec-DAG implementability lint.                                                                                                                         |

### Patched-output runtime proof (UTSUSHI-119 × SHARED-025)

The SHARED-025 alpha proof manifest
([`../fixtures/alpha-vertical-proof/hello-game-alpha-proof-v0.2.fr-FR.json`](../fixtures/alpha-vertical-proof/hello-game-alpha-proof-v0.2.fr-FR.json))
records, for one source revision, a `patch_result` artifact ref **and** a
`runtime_report` artifact ref that observes the SAME `sourceBridgeId` /
`sourceBundleHash`, plus provider-proof and benchmark ids — the patched-output
runtime proof consumes a `PatchResult` and the SHARED-025 manifest ids rather
than a static read. `just alpha-readiness-checklist` re-verifies every one of
those artifact hashes against the committed fixtures and confirms the runtime
report's source matches the manifest (a mismatched revision or a missing patch
result fails the gate).

### Encrypted-readiness evidence integration (KAIFUU-042)

The `kaifuu:encrypted-readiness` workflow
([`../suite/scripts/kaifuu-encrypted-readiness-integration/run.mjs`](../suite/scripts/kaifuu-encrypted-readiness-integration/run.mjs))
**composes** the already-generated encrypted-readiness EVIDENCE of the
prerequisite slices — the KAIFUU-103 packed-engine readiness surface and the
KAIFUU-104 alpha-encrypted readiness evidence generator — into an alpha-readiness
composed-evidence artifact. It does **not** re-own those slices: the committed
[`prerequisites.manifest.json`](../suite/scripts/kaifuu-encrypted-readiness-integration/prerequisites.manifest.json)
NAMES the prerequisite surfaces, adapters, command evidence, and proof
artifacts, and the workflow AGGREGATES each committed proof artifact by content
hash (`composedEvidenceHash`). A missing, tampered (wrong source node), or
UNSUPPORTED prerequisite becomes a structured **semantic diagnostic**
(`status: failed`) — never a hidden success.

Like the KAIFUU-036 / KAIFUU-067 / KAIFUU-094 private-local workflows this is a
FIRST-CLASS LOCAL lane, intentionally absent from per-gate CI. When **no private
encrypted corpus is configured** (the public/default case, or `--no-corpus`) it
emits the deterministic REDACTED no-corpus artifact
`.tmp/kaifuu-private-local/encrypted-readiness-no-corpus-skipped.json` with
`status: skipped`, `reason: private_inputs_absent`, redacted (empty) corpus ids,
zero aggregate counts, and no local paths — byte-stable and matching the committed
[`no-corpus-skipped.example.json`](../suite/scripts/kaifuu-encrypted-readiness-integration/examples/no-corpus-skipped.example.json).
With an operator's already-redacted private-corpus manifest it instead emits the
safe aggregate readiness report. No raw keys, encrypted bytes, or decrypted
content ever reach any artifact.

```sh
pnpm exec vp run kaifuu:encrypted-readiness -- --no-corpus
```

## 5. Required gates (CI + workflows)

| gate                | command / workflow                                                                                                                                                                       | scope                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| CI                  | `.github/workflows/pr-tiers.yml` → `_tier0.yml` / `_tier1.yml` (`just ci-tier*`)                                                                                                         | tiered TS + Rust + DB + browser + alpha + mutation gates.                           |
| Alpha proof         | `_tier1.yml` `alpha` job → `just ci-tier1-alpha` → `just alpha-proof`                                                                                                                    | public-fixture vertical + independent linkage validator.                            |
| Benchmark smoke     | ITOTORI-026 `benchmark-harness-run` (invoked inside `just alpha-proof`)                                                                                                                  | fresh benchmark report, cost read verbatim from recorded artifacts.                 |
| Real-provider proof | `just provider-proof` / `just raw-mtl-baseline-proof` (recorded by default; `--live` + `ITOTORI_PROVIDER_PROOF_LIVE=1` opt-in) and the opt-in `alpha-006d` / `agentic-repair-live` tests | sanitized recorded proof always available; real ZDR calls opt-in only.              |
| Readiness checklist | `just alpha-readiness-checklist` (in `just check`)                                                                                                                                       | docs-vs-generated-artifact drift + node refs + patched-output proof + demo command. |

## 6. Running the checklist

```sh
just alpha-readiness-checklist
```

It reads the generated capability matrix and the SHARED-025 proof manifest,
validates the node references above, and confirms the patched-output proof
linkage. It is also run inside `just check` (and therefore `just ci`), so the
readiness docs cannot drift from the generated artifacts without turning CI red.
