# Alpha Readiness

> **Point-in-time evidence, not product intent.** This checked readiness report
> preserves the legacy alpha vocabulary and generated capability projection.
> [`action-plan.md`](action-plan.md) is the sole authority for current scope,
> state admission, and dependency waves.

This document is the **alpha readiness README**: the statement of what the
suite can do at the alpha milestone and how a new user proves it from a fresh
clone.

> **What "alpha" means here.** Alpha is **readiness to _start_ a real
> localization project**, not a finished product and not a terminal release.
> It means the whole pipeline fires end-to-end on a single real game and that
> every stage is swappable — "let's try a different QA strategy" is a tractable
> change rather than a rewrite. Output quality is explicitly **not** the bar at
> alpha (worse-than-MTL is acceptable). The legacy tiered definition lives in
> [`project-readiness.md`](project-readiness.md); beta (≥2 games per engine,
> encrypted variants) and full release come later.

## 1. The pipeline (not "just translation")

Itotori is a full games-localization pipeline, not a translation box. Its
stages, in order:

1. **Extract** — Kaifuu reads game bytes and produces a bridge bundle
   ([`subprojects-kaifuu.md`](subprojects-kaifuu.md)).
2. **Structure export** — Utsushi derives the narrative structure that supplies
   scene, route, and speaker context to later stages.
3. **Wiki build** — Itotori builds the source-language bible used by the
   localizer.
4. **Localize** — Itotori's agentic loop drafts and reviews against a chosen
   `(modelId, providerId)` pair ([`subprojects-itotori.md`](subprojects-itotori.md)).
5. **Patch** — Kaifuu writes the localized bytes to a separate output and emits
   a `.kaifuu` delta package plus `PatchResult`
   ([`kaifuu-patch-safety.md`](kaifuu-patch-safety.md)).
6. **Validate** — Utsushi replays the patched output and captures runtime
   evidence tying observed post-patch text and choices back to bridge unit refs
   ([`subprojects-utsushi.md`](subprojects-utsushi.md),
   [`utsushi-runtime-artifacts.md`](utsushi-runtime-artifacts.md)).
7. **Review** — inspect the run summary, QA findings, and runtime evidence
   before accepting the patched output.

The alpha proof exercises this whole chain end-to-end, not the translation
stage in isolation.

## 2. Fresh-clone demo (public fixtures only — no secrets, no real bytes)

From a clean checkout, after `just dev install`:

```sh
just test alpha
```

`just test alpha` runs the public-fixture alpha vertical:
Kaifuu extraction → Itotori draft/patch export → Utsushi runtime observation →
sanitized provider proof → fresh recorded-LLM benchmark → SHARED-025 manifest,
then independently re-proves cross-artifact linkage. It is **public-fixture-only
and deterministic**: no database, no live credentials, no private corpora, no
retail bytes. It fails unless every artifact agrees on the same fixture id,
source revision, locale branch, and content hashes — there is no success-string
shortcut. See [`alpha-proof.md`](alpha-proof.md).

The alpha proof is exercised by `just alpha-demo`; it is not a copy-paste
real-corpus CLI localize invocation. The real-corpus public CLI boundary is
documented in [`localize-reallive.md`](localize-reallive.md).

Use `production` or `pilot` only with the required live corpus and credentials;
the mode policy rejects invalid combinations. See [`install.md`](install.md) and
[`security-and-limitations.md`](security-and-limitations.md) for the live-run
requirements.

## 3. Generated capability claims

The claims below are **re-derived from the generated engine capability matrix**
([`../apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json`](../apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json),
produced by [`scripts/generate-engine-capability-matrix.mjs`](../scripts/generate-engine-capability-matrix.mjs)
and drift-guarded by its `--check` mode). `just check alpha-readiness`
re-derives these blocks from that matrix and fails if the text here has drifted,
so this section cannot silently overstate coverage. `positive_adapter` means an
adapter is exercised end-to-end on a fixture; `readiness_only` means detection /
key-posture evidence only, not an end-to-end extract/patch claim.

<!-- ALPHA-READINESS-CAPABILITY-CLAIMS:START -->
<!-- generated from apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json; edit that generator, not this block -->

Engine families in the generated capability matrix: **9**.

| engine family       | evidence posture |
| ------------------- | ---------------- |
| `bgi_ethornell`     | readiness_only   |
| `kiri_kiri_xp3`     | positive_adapter |
| `reallive`          | readiness_only   |
| `rpg_maker_mv_mz`   | positive_adapter |
| `siglus`            | readiness_only   |
| `softpal`           | positive_adapter |
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

## 4. Encrypted-readiness evidence integration

The `kaifuu:encrypted-readiness` workflow
([`../suite/scripts/kaifuu-encrypted-readiness-integration/run.mjs`](../suite/scripts/kaifuu-encrypted-readiness-integration/run.mjs))
**composes** the already-generated encrypted-readiness EVIDENCE of the
prerequisite slices — the packed-engine readiness surface and the alpha-encrypted
readiness evidence generator — into an alpha-readiness
composed-evidence artifact. It does **not** re-own those slices: the committed
[`prerequisites.manifest.json`](../suite/scripts/kaifuu-encrypted-readiness-integration/prerequisites.manifest.json)
NAMES the prerequisite surfaces, adapters, command evidence, and proof
artifacts, and the workflow AGGREGATES each committed proof artifact by content
hash (`composedEvidenceHash`). A missing or unsupported prerequisite becomes a
structured **semantic diagnostic** (`status: failed`) — never a hidden success.

Like the related private-local workflows this is a
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

| gate        | command / workflow                                                                | scope                                                                  |
| ----------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| CI          | `.github/workflows/pr-tiers.yml` → `_tier0.yml` / `_tier1.yml` (`just ci <lane>`) | tiered TypeScript, Rust, database, browser, alpha, and mutation gates. |
| Alpha proof | `_tier1.yml` `alpha` job → `just test alpha`                                      | public-fixture vertical + independent linkage validator.               |
