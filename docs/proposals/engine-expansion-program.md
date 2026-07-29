# Engine expansion program: from three drivers to a repeatable onboarding machine

## Audit basis and decision

This audit is anchored to detached `origin/main` at
`82014907256cd2e9944a2d2d31ba3c2d51cee7a1`. The decision is to build the
promotion machine before promoting another family: activate one engine package
authority; make real-byte, runtime, and product receipts fail-closed; make
reference comparison and corpus staging executable; then onboard RPG Maker,
Wolf RPG Editor, and KiriKiri in that order. Full KiriKiri is the wrong first
implementation because custom archive filters, KAG extensions, TJS, and native
plugins would make the least-known family define the supposedly generic
machinery.

“All” is an open-world claim and cannot honestly mean every future custom
filter or plugin. Here it means every identified profile in the declared target
cohort, including encrypted/custom profiles, with no unclassified target and
with two real-title proofs per materially distinct profile. The RPG Maker scope
is the Windows generations 95, 2000, 2003, XP, VX, VX Ace, MV, and MZ.
Console-specific and Unity-hosted products are separate engine intakes rather
than evidence borrowed from these profiles. Whether those products belong in
the product target is **UNVERIFIED — product-scope fetch request**.

The current three are drivers, not three uniformly full-ready engines. The
generated matrix reports no runtime support for any row
(`apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.md`,
“Capability rows”), all three descriptors say `runtime_vm = "not-claimed"`,
and product runtime composition registers only one engine
(`apps/itotori/src/play/patch-runtime-launcher.ts:patchRuntimeLauncher`).
This proposal therefore does not use “six engines” as a support count.

## Ranked findings

### 1. Proof integrity blocks every expansion claim

The planned catalog is explicitly inactive (`crates/engine-contract/src/lib.rs`,
crate documentation). No production caller of `compile_plan`, `execute_plan`,
or `EnginePlugin` was found; committed lane descriptors exist only in test
fixtures. Worse, `planner.rs:validate_receipt` accepts `Executed`, `Passed`, or
`Failed`, does not enforce `ProofReceiptRequirement.outcome` or
`minimum_executed`, and `plugin.rs:execute` emits only `Executed`. Descriptor
parity compares TOML with recorded JSON; inventory parity counts template rows
without opening bytes
(`tests/current_descriptor_parity.rs:descriptor_projection_matches_recorded_current_claims`,
`descriptor_proofs_have_matching_private_inventory_templates`).

Concrete false-green inputs remain: the KiriKiri descriptor requires one
corpus, the Wolf descriptor requires zero and names a synthetic proof, and
`corpus-registry::resolve_with_inventory_at` checks only `path.is_dir()`, not
the recorded content address. Several Siglus real-byte tests return `Ok` when
the corpus or required file is absent, for example
`crates/utsushi-siglus/tests/observe_real_bytes.rs` and
`scene_vm_real_bytes.rs`. `EngineAdapter::patch_preflight` also defaults to an
unconditional pass (`crates/kaifuu-core/src/adapter_core.rs`).

The automation state confirms that private truth is not operating. The
repository API command
`gh api repos/cat-cave/itotori/actions/runners` returned
`{"runners":[],"total_count":0}`. The two self-hosted jobs in
`.github/workflows/real-bytes-oracle.yml` are currently queued with empty
runner names; the previous instances were cancelled without runners. The
hosted drift check passed, but it opens no private corpus. This API snapshot
cannot detect local runs or state changes after measurement.

Production is independently blocked:
`apps/itotori/src/services/database-services.ts:productionRoleBindings`
installs review and adjudication methods that throw “has not been installed.”
Thus even a perfect new adapter cannot be called full Itotori-ready.

**Decision:** Wave 0 makes failed/executed-only, zero-read, missing-output,
duplicate-content, stale-digest, absent-corpus, and unstaffed-runner states
non-passing; it installs production review/adjudication before any family
promotion. **Rejected:** adding adapters while treating the existing catalog,
matrix, or green synthetic lane as proof. Those authorities are inactive or
self-consistent without exercising the named product path.

### 2. Good generic seams exist, but composition repeatedly reintroduces identity

| Existing reusable seam      | Evidence                                                                                                                               | Limit that matters                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kaifuu adapter and registry | `crates/kaifuu-core/src/adapter_core.rs:EngineAdapter,AdapterRegistry` cover detect, profile, inventory, extract, patch, and verify    | `detect` chooses the first sorted match; production obtains a manually populated fixture registry from `crates/kaifuu-engine-fixture/src/lib.rs:registry`    |
| Capability ladder           | `crates/kaifuu-core/src/registry/capability.rs:CapabilityLevel` and `registry/mod.rs:adapters_at_least` exclude partial rows           | It ends at patch; consistency checks in `adapter_capabilities.rs` are `debug_assert!`, and it has no variant, verify, runtime, or product evidence dimension |
| Golden round trip           | `crates/kaifuu-core/src/golden_harness_run.rs:run_golden_fixture` exercises detect, extract, no-op patch, translated patch, and verify | Public fixtures are not real-byte support                                                                                                                    |
| Utsushi port substrate      | `crates/utsushi-core/src/port/trait_.rs:EnginePort` and `port/conformance.rs:run_required_abi` cover lifecycle and shutdown            | The report can return zero observations, no capture, or false cancellation without rejecting the port                                                        |
| Runtime registry            | `crates/utsushi-core/src/lib/runtime_capture/execution_adapter.rs:RuntimeAdapterRegistry` checks descriptors and operation capability  | CLI composition manually registers four adapters in `crates/utsushi-cli/src/fixture_runtime.rs:runtime_registry`                                             |
| Private corpus addressing   | `crates/corpus-registry/src/lib.rs:Need,resolve` keeps engine identity as data and uses the one declared media mount                   | Resolution does not hash actual bytes; proof maps still hard-code families                                                                                   |
| Capability artifact         | generated matrix distinguishes positive adapters from readiness-only rows and lists limitations                                        | `scripts/generate-engine-capability-matrix-document.mjs:generateEngineCapabilityMatrix` calls engine-specific builders over a handwritten input list         |

Product code contains further central authorities: extract unions/maps
(`extract-adapter-types.ts:ExtractSource`,
`extract-adapter-registry.ts:EXTRACT_ADAPTERS`), structure unions/maps
(`structure-provider-registry.ts:STRUCTURE_PROVIDERS`), patchback’s ID union
and import list (`patchback/engine-adapter.ts:PatchbackEngineId`,
`patchback/adapters.ts`), and a runtime receipt fixed to one engine
(`play/runtime-launcher-registry.ts:PatchRuntimeLaunchReceipt`). Kaifuu and
Utsushi CLIs also carry exact-family commands. Engine #21 is therefore not a
small constant today.

**Decision:** complete the catalog migration atomically into a versioned,
repository-owned process adapter contract, then delete the old registries,
unions, branches, row builders, and compatibility route in the same slices.
The generic host validates package digest, schema negotiation, allowed
operations, read-only inputs, output root, resource budgets, and receipts.
**Rejected:** retain dual authorities or generate another central match table.
Both keep engine identity in shared code and preserve the drift already
measured. **Rejected:** accept arbitrary third-party plugins; only reviewed,
signed Itotori packages are executable.

### 3. Engine #3 became cheaper, but not a small constant

The history proxy below was measured once per driver with:

```text
git log --first-parent --format='@@@%H' --numstat -- \
  ':(glob)crates/kaifuu-<engine>/**/*.rs' \
  ':(glob)crates/utsushi-<engine>/**/*.rs' | <sum commits/additions/deletions>
rg --files crates/kaifuu-<engine> crates/utsushi-<engine> -g '*.rs' | xargs wc -l
```

| Driver order    | First-parent touches | Additions | Deletions |   Churn | Current Rust lines | Churn vs first |
| --------------- | -------------------: | --------: | --------: | ------: | -----------------: | -------------: |
| RealLive, first |                  289 |   167,128 |    75,106 | 242,234 |             92,022 |           100% |
| Siglus, second  |                   61 |    37,579 |     8,414 |  45,993 |             29,165 |         18.99% |
| Softpal, third  |                   32 |    15,677 |     4,874 |  20,551 |             10,803 |          8.48% |

RealLive’s one-off work is archive/compression/cipher, bytecode/expression VM,
relocation, media, input, save, and runtime (`crates/kaifuu-reallive/src/lib.rs`).
Siglus added distinct containers, key discovery, UTF-16/codec/opcodes/choices
and images. Softpal added PAC/TEXT.DAT/CP932, Sv20 semantics, pointer rewriting,
and loose overrides (`crates/kaifuu-softpal/src/lib.rs`). Reuse is real:
Softpal’s runtime consumes Kaifuu’s disassembler
(`crates/utsushi-softpal/Cargo.toml`); shared adapter/port/artifact contracts
also apply. CLI/product wiring and proof composition were still repeated.

This is code churn, not labor or equal-readiness cost. First-parent squash
granularity differs; the scope omits shared code, app/CLI, fixtures, docs,
research, CI, and later work elsewhere; churn includes refactors. Capability
scope also differs: RealLive has snapshot/replay, Siglus is a static walk, and
Softpal is a bounded VM. Person-hours, causal savings, and equal-readiness
cost are **UNVERIFIED — historical-accounting fetch request**. The rejected
alternative is to quote 8.48% as productivity: it confounds reuse with a
smaller delivered surface.

### 4. Reference knowledge exists, but not as an institutional capability

`/scratch/oracles` has six pinned Git checkouts. Only VNTranslationTools covers
a requested family: its KiriKiri descrambler and KS/SCN/SOC/TJS readers expose
scramble modes, encodings, text roles, scene data, and compiled strings. No
adapter, test, workflow, or generic differential runner invokes the shelf; it
lacks a central manifest, retrieval doctor, and license/use decision. Local
license observations are not legal clearance.

The Kaifuu playbook already asks for reference provenance, license review,
public/private fixture separation, semantic failure, static-first research,
and round trips (`docs/kaifuu-engine-playbook.md`, “Reference implementation
review” through “Round-trip testing”). More prose is not the missing feature.

**Decision:** every package carries `references.v1`: canonical URL, immutable
revision/archive hash, component license and text path, exact files/symbols
consulted, retrieval command, hypothesis, normalized oracle output, and use
decision (`allowed`, attribution, behavior-only clean room, or blocked).
Generic `research fetch`, `doctor`, and `compare` commands verify the lock,
stage references in a private cache, run reference and native implementations
on the same permitted bytes, and retain private diffs plus public redacted
categories. **Rejected:** shell out to or copy third-party implementations in
the product. That makes support inherit their platform, availability, and
license and does not produce an Itotori-owned adapter.

The mandatory research order is public/reference search, static inspection of
the shipped launcher/installer/executable when it can encode the container or
key profile, deterministic black-box vectors and oracle comparison, then
bounded dynamic instrumentation for a named unanswered hypothesis. This
encodes the Softpal history lesson: dynamic models were repeatedly revised
before a reference VM model supplied the semantics. **Rejected:** dynamic
observation first; it is expensive, weakly explanatory, and repeats documented
work.

## The active engine package and proof model

### What engine #21 costs

| Ownership          | Contents                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-engine data    | One descriptor; version/protection profiles; declarative required/forbidden fingerprints; reference lock; proof specification; fixture generator and public positive/negative fixtures; private inventory records outside Git                                       |
| Per-engine adapter | Structural probes; Kaifuu codecs/transforms/writer; key/helper boundary; optional Utsushi port or controlled shipped-runtime driver; engine-specific normalized oracle adapters                                                                                     |
| Shared once        | Schema/catalog loader, bounded feature scanner, signed process host, corpus hasher/stager, planner/receipt validator, artifact store, transform interfaces, Kaifuu/Utsushi conformance, generic CLIs, product projection, evidence aggregator, matrix/docs renderer |

An engine addition must not edit a shared enum/match, root workspace list,
Kaifuu/Utsushi/product command branch, app registry, workflow, recipe, matrix
builder/input list, or environment registry. A temporary-package conformance
test discovers and drives an otherwise unknown adapter through detect,
extract, patch, runtime, and product projection; its diff allowlist permits
only that package, descriptor, and fixtures. Mutations must make it red when
the adapter returns a fixed pass, reads zero bytes, reports `Failed`, reuses
one content address as two titles, omits a selected proof, uses no-op
preflight, hides an unknown runtime event, or matches only a colliding
extension.

**Rejected:** static central dispatch for compile-time convenience. It makes
each family a cross-cutting shared-code edit. The process boundary adds
sandbox, throughput, and ABI risk; that risk is **UNVERIFIED — prototype and
threat-model fetch request**, so authority migration cannot ship until the
mutation suite, schema negotiation, resource isolation, and signed-package
checks pass.

### Capability honesty and promotion receipt

Authority is a cell keyed by `(family, profile, pipeline stage, surface,
platform)`, never a family boolean. States are `research`, `unsupported`,
`partial`, `verified`, `stale`, and `failed`. Identify, inventory, unpack,
decrypt, decode, extract, patch, repack, verify, launch, execute, render,
audio/input/save, replay review, and product review are separate stages.
The four-rung ladder and generated matrix become projections of fresh cells.
Missing, stale, failed, incomplete, absent-runner, or zero-output evidence
cannot project `supported`.

Every receipt records opaque plan/proof/corpus IDs, verified content address,
profile and cell, package/source/tool/schema digests, selected/executed/passed/
failed assertion counts, files opened and bytes read, artifact hashes,
per-field populated/total counts, limitations, redaction policy, runner
identity, and signature. Validation rejects two inventory rows with one
content address, zero reads/assertions, failed or executed-only assertions,
missing outputs, stale digests, absent selected proofs, and descriptor
outcome/minimum mismatch.

Per-field rates are mandatory on real extraction and runtime outputs:
dialogue, speaker, choice, control markup, asset link, source span, structure
link, and runtime observation each report `populated / eligible`. “Source
absent,” “present but extractor missing,” and “implemented but produced zero”
are distinct diagnostics.

**Rejected:** one family-wide support badge or a confidence scalar. It lets
plain archives or one generation launder encrypted and older profiles and
hides which stage failed. **Rejected:** require only two pooled family titles.
Two easy profiles do not validate a materially different crypto/runtime
profile.

## Detection for sixty families

The current detector is a shared eight-function vector
(`archive_detection_model.rs:DETECTORS`) over names, extensions, 64-byte
headers, and selected JSON; unreadable entries disappear and traversal has no
budget. Siglus can be filename-only, and Wolf accepts an extension or ASCII
substring (`archive_detection_signals.rs`, `archive_detection_rows.rs`).
`AdapterRegistry::detect` then returns the first sorted positive. This is not
a scalable magic-byte system.

Replace it with:

1. A shared bounded feature extractor emits only engine-neutral facts:
   directory/co-occurrence graph, sizes, full required header/footer windows,
   container invariants, checksums/index bounds, executable metadata/imports/
   resources, installer manifests, runtime package metadata, encoding and
   script-grammar probes, plus unreadable/truncated/budget-exhausted facts.
2. Adapter-owned signature packs declare required/forbidden predicates,
   correlations, profile, evidence grade, and named bounded structural probes.
   All candidates run; outcomes are `verified candidate`, `ambiguous`,
   `unknown`, or `incomplete`, never first-match.
3. Calibration uses at least two content-distinct real positives per claimed
   profile plus negative neighbors and collisions. It reports precision,
   recall, ambiguity, and incomplete rate on the labeled set; scores rank
   candidates but are not probabilities.

Exact sixty-family accuracy is **UNVERIFIED — labeled-corpus fetch request**.
**Rejected:** add more extensions/magic in shared functions; current
extension-only and collision rules already show both false-positive risk and
central sprawl. **Rejected:** ML/LLM verdicts first; labeled data is sparse and
private. A learned model may later rank candidates but may not create support.

## Repeatable request → Kaifuu → Utsushi → Itotori path

| Stage    | Durable artifacts                                                                                                                             | Promotion observation                                                                                                                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake   | `engine-request.v1`, target cohort/profile cells, `support-scope.v1`, two-title slots, reference lock, explicit hypotheses/fetch requests     | Schemas valid; public record has no paths, secrets, title text, or copyrighted bytes; component license/use decisions recorded. Status remains research.                                                                                                                                                                   |
| Identify | Adapter fingerprints/probes, collision fixtures, private scan evidence, redacted receipt                                                      | Scan completed within declared budgets; two real titles per claimed profile are positive; neighbor/collision negatives do not match; ties are ambiguous; detection grants no later capability.                                                                                                                             |
| Kaifuu   | Profile, inventory, bridge, no-op and translated patch inputs, rebuilt/delta output, verify report                                            | Same two titles were actually opened (`files_opened` and `bytes_read` nonzero); fields report rates; no-op is byte-identical or a declared normalization equivalence; translated diff is restricted to planned spans; output reparses; wrong key, truncation, and absent helper fail semantically; source stays immutable. |
| Utsushi  | Exact Kaifuu output mounted through a playable VFS/package, port descriptor, coverage ledger, deterministic trace; full media remains private | On both identities the patched build launches, an attested translated unit is observed, and every declared load/text/choice/control/input/save/render/audio facet has executed numerator/denominator evidence. Unknown required events fail or keep the cell partial.                                                      |
| Itotori  | Product review package joining bridge, structure, patch, runtime, QA/review, private artifacts, and public receipt                            | A clean production job auto-identifies, ingests, localizes populated representative surfaces, patches, launches/replays, observes translated output, and completes installed review/adjudication. No manual family registry edit; unsupported cells are visible.                                                           |
| Maintain | Signed evidence index with freshness and regression state                                                                                     | Only passed assertions promote; regression demotes the affected cell. A second fresh receipt binds catalog revision, source commit, package digest, and corpus content address.                                                                                                                                            |

Public Git holds schemas, tiny fixtures, aggregates, opaque IDs, digests, and
redacted discrepancies. Raw installs, keys, decrypted content, filenames,
oracle diffs, and full media stay private under `docs/fixtures-and-corpora.md`
and `docs/kaifuu-fixture-policy.md`. Hash actual files at staging; use opaque
salted attestation IDs if a public hash could identify a release. Application
inventory uses the existing media mount/config; add no environment variable.

**Rejected:** synthetic-first promotion. Synthetic fixtures are excellent
regression assets only after real bytes and an independent oracle define the
format; the current invented KiriKiri/Wolf/RGSS profiles show why they cannot
establish truth. **Rejected:** public content-free receipt without retained
private evidence; it is an attestation, not ground truth.

## Family programs and acceptance observations

### RPG Maker — first implementation family

Current code is MV/MZ JSON extraction plus a narrow static event walk
(`crates/kaifuu-rpgmaker/src/lib.rs`,
`crates/utsushi-rpgmaker-mv/src/lib.rs`). The browser observation fixture
renders an authored DOM island rather than observing a deployed engine
(`crates/utsushi-fixture/tests/fixtures/mvmz_observation/index.html`);
older support is absent except a synthetic Ace-shaped profile/smoke
(`crates/kaifuu-core/src/rgss3_profile.rs`, `rgss3_smoke.rs`).

Use eight separate profiles:

| Profile | Known-hard decode and runtime work                                                            | Acceptance observation                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 95      | Binary project/event/string tables and legacy Windows runtime are not documented in this repo | **UNVERIFIED — fetch request:** two owned roots, file inventory/encodings, a licensed parser reference, native traces/frames, then lossless no-op and surgical patch plus native launch                |
| 2000    | LCF database/tree/map/save, legacy encoding, event VM                                         | Two roots; every encountered LCF chunk/command inventoried; decode/rewrite comparison; no-op preservation; patched native and reference traces/frames/audio agree                                      |
| 2003    | Related LCF with materially distinct commands/runtime                                         | Same independent gate; no evidence borrowed from 2000 without a byte-and-semantics equivalence proof                                                                                                   |
| XP      | First RGSS archive/Marshal/scripts, its Ruby and graphics/audio/input bindings                | Two roots; complete object/reference/symbol/encoding census, script-array decompression, every encountered script executes, patch reparses and native/reference traces agree                           |
| VX      | Second RGSS archive/runtime profile                                                           | Same profile-local observations, including the correct Ruby/binding version                                                                                                                            |
| VX Ace  | Third RGSS archive/runtime profile                                                            | Same, including archive generation and unknown-object preservation                                                                                                                                     |
| MV      | JSON/JavaScript, core/runtime version, plugins, encrypted media, browser/NW behavior          | Two deployed roots; unmodified runtime instrumentation at interpreter/message/scene/input/audio boundaries, encountered plugins execute, encrypted assets round-trip, deterministic traces/screenshots |
| MZ      | Distinct core/runtime/plugin APIs and packaging                                               | Same independent gate; authored DOM mimic is forbidden evidence                                                                                                                                        |

Primary behavioral references are
[liblcf](https://github.com/EasyRPG/liblcf) and
[EasyRPG Player](https://github.com/EasyRPG/Player) for 2000/2003,
[mkxp-z](https://github.com/mkxp-z/mkxp-z) for XP/VX/VX Ace, and the
[official MZ script reference](https://rpgmakerofficial.com/product/mz/plugin/javascript/script_reference/first.pdf).
GPL implementations are observation oracles unless a deliberate license
decision says otherwise. The 95 parser/runtime/reference status is
**UNVERIFIED**.

**Decision:** repair MV and MZ observation first, then 2000/2003, then the
shared RGSS archive/Marshal substrate with separate XP/VX/VX Ace runtime gates,
while 95 evidence is fetched in parallel. This family has the strongest
independent parser/interpreter references and pressures the profile model
without starting on per-title crypt filters. **Rejected:** one RPG Maker
adapter; it would let one generation’s JSON evidence claim seven unrelated
storage/runtime profiles.

### Wolf RPG Editor — second implementation family

Current code explicitly describes an invented Wolf-like archive/table and
fixture cipher, not commercial DXArchive support
(`crates/kaifuu-core/src/wolf_adapter.rs:WOLF_ADAPTER_SUPPORT_BOUNDARY`,
`wolf_profiled_production.rs`); no Utsushi Wolf crate exists.

Known-hard work is versioned archive compression/key/protection, SJIS/UTF-8,
binary game/common-event/database/map formats, relocation-safe rewriting, and
message/choice/branch/variable/string/loop/label/call/database commands.
[UberWolf](https://github.com/Sinflower/UberWolf) documents automatic key and
Pro-protection detection and versioned data readers;
[wolftrans](https://github.com/elizagamedev/wolftrans) is an independent
incomplete parser/patch reference. Bundled archive-library components and
WolfDec require component-level license review before use.

Unknown native scheduler, input/render/audio timing, menus/battles, extensions,
and protection variation are **UNVERIFIED — Wolf corpus/runtime fetch
requests**. Acquire two owned roots per targeted version/protection profile;
record archive/executable/data hashes, reference inventory and patch diff, and
controlled native traces/frames/audio. Acceptance observes correct
compression/key/version handling; lossless game/common-event/database/map
round trips; every encountered command’s strings and relocations; wrong-key/
version rejection; native-vs-port state/control/input/media checkpoints;
snapshot/jump; and patched native launch on both roots.

**Decision:** Wolf follows the shared byte/profile/oracle machinery and uses
the legally owned native executable as semantic oracle until an independent
full interpreter is found. **Rejected:** Wolf first; serializer references are
good, but the missing open full interpreter gives it the weakest runtime
feedback loop for designing the common harness.

### KiriKiri — final, adversarial implementation family

Current support is plaintext KAG plus synthetic crypt profiles:
`crates/kaifuu-kirikiri/src/lib.rs:capability_note` disclaims commercial
coverage, `xp3_production.rs:XP3_PRODUCTION_SUPPORT_BOUNDARY` says its filters
are invented, `crates/utsushi-kirikiri/src/lib.rs` is a bounded static replay,
and every lifecycle method in
`crates/utsushi-kirikiri-xp3/src/lib.rs:KirikiriXp3EnginePort` errors with zero
opcode handlers.

Standard XP3 is known-hard rather than unknown: embedded placement,
raw/zlib continued indexes, multi-segment members, checksums/flags, and a
position/hash-aware extraction-filter ABI are documented by
[the upstream KiriKiri Z source](https://github.com/krkrz/krkrz) and
[GARbro’s XP3 reader](https://github.com/morkt/GARbro/blob/master/ArcFormats/KiriKiri/ArcXP3.cs).
KAG’s asynchronous tag loop, waits, labels, macro/condition/call stack,
jump/call/return, inline script, and TJS bytecode/interpreter are documented
by [KAG3](https://github.com/krkrz/kag3) and the upstream TJS sources.
[KrkrExtract](https://github.com/xmoezzz/KrkrExtract) is useful negative
evidence: it excludes custom versions and protected executables.

The actual filter/key/index obfuscation per target, custom KAG tags/macros/
plugins, compiled-script mix, renderer/input behavior, and native-extension
requirements are **UNVERIFIED — KiriKiri corpus/profile fetch requests**.
For two owned roots per encountered profile, capture archive/executable hashes,
reference listings/member hashes, extraction-filter offset/hash/range traces,
VNTranslationTools KS/SCN/TJS observations, and controlled native KAG/TJS
text/choice/state/frame baselines.

Acceptance observes embedded/standalone placement; all encountered index and
segment modes; exact extraction-filter calls; KS scramble/encodings, PSB scene
data and compiled TJS strings; KAG macro/condition/call/iscript and TJS
execution; lossless no-op; surgical patch with unknown bytes preserved or a
declared controlled rebuild; wrong profile/key rejection; deterministic
native-vs-port traces/visuals; and patched native launch on both roots.

**Decision:** standard XP3 may pilot conformance early, but no encrypted or
family claim promotes until every target profile passes. Full-family
implementation comes after RPG Maker and Wolf. **Rejected:** backlog-size-first
or a plain-container demo. It front-loads title-specific reverse engineering
and creates the most tempting false family claim.

## Explicit fetch-request ledger

Every row is missing evidence, not a verdict.

| Request                      | Evidence required and plausible source                                                                                                                   | Unblocks                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Reference lock/license       | Reproducible checkout, full revision, component license/text, exact symbols and output schema for all references; upstream repositories and legal review | Permission to compare, observe, port, or block each component |
| KiriKiri cohort              | Two owned roots per crypt/script profile; archive/executable inventory, filter trace, independent listing/hashes, native KAG/TJS baseline                | Profile discovery, decoder/runtime acceptance                 |
| RPG legacy                   | Two roots each for 95, 2000, 2003; format/encoding census, licensed parser outputs, native/reference observations                                        | Legacy profiles; 95 remains wholly unverified                 |
| RPG RGSS                     | Two roots each for XP, VX, Ace; archive/data/script packs, Marshal census, Ruby version, reference/native traces                                         | Three distinct archive/runtime cells                          |
| RPG JavaScript               | Two deployed roots each for MV and MZ; exact core/plugin/package hashes, encrypted assets, actual runtime hooks/screenshots                              | Replacement of synthetic DOM evidence                         |
| Wolf cohort                  | Two roots per version/protection profile; archive/executable/data hashes, independent inventory/patch diff, native traces                                | Real decoder, key/profile and runtime semantics               |
| Detection calibration        | Labeled positive profiles plus negative neighbors/collisions, complete-scan facts                                                                        | Measured precision/recall/ambiguity at claimed scale          |
| Process adapter threat model | Signed-package lifecycle, ABI negotiation, sandbox escape/resource/throughput tests                                                                      | Safe activation of the single package authority               |
| Historical accounting        | Attributed shared/app/fixture/research changes or maintained effort records                                                                              | Any labor or equal-readiness cost claim                       |
| Product scope/legal          | Decision on console/Unity-hosted RPG products; jurisdiction/EULA/anti-circumvention review for launcher and key workflows                                | Honest family boundary and deployable helper policy           |

## Waves and dependencies

1. **Wave 0 — proof integrity and product reality.** Reject the receipt states
   named above; hash staged bytes; remove clean-success real-byte skips and
   default preflight; make capability consistency release-hard; install
   production review/adjudication; provision and execute private/browser
   runners. This blocks support promotion, not reference/corpus acquisition.
2. **Wave 1 — one authority.** Activate the signed process package contract and
   migrate/delete manual registries, identity branches, matrix builders, and
   inactive projections atomically. The engine #21 mutation test is the exit
   observation. Depends on Wave 0 receipt semantics and the threat model.
3. **Wave 2 — onboarding substrate.** Land bounded neutral detection,
   reference lock/fetch/doctor/compare, corpus hashing/staging, normalized
   oracle comparison, private/public artifact split, and generic
   Kaifuu→Utsushi→product promotion. Depends on Waves 0–1. Acquire evidence
   for all three families in parallel here.
4. **Wave 3 — RPG Maker profiles.** Actual MV/MZ runtime observation,
   2000/2003, XP/VX/VX Ace, and 95 when its fetch request resolves. Each cell
   promotes independently. Depends on Wave 2, not on another profile’s claim.
5. **Wave 4 — Wolf profiles.** Real archive/data writers and observed runtime
   semantics per version/protection profile. Depends on Wave 2 and reuses Wave
   3’s byte-preservation and runtime-observation machinery.
6. **Wave 5 — KiriKiri profiles.** Standard XP3, each encountered extraction
   filter, full script surfaces, and KAG/TJS/runtime observations. Depends on
   Wave 2 and the hardened machinery exercised by Waves 3–4.
7. **Wave 6 — operating evidence.** Private agents publish fresh signed
   receipts; hosted aggregation checks identity/freshness and demotes
   regressions. Delete replaced paths; no shadow or legacy compatibility mode.

## What remains UNVERIFIED

- No private corpus, oracle binary, native launcher, browser, or self-hosted
  proof ran; shipped-byte compatibility, populated rates, runtime fidelity, and
  full readiness for all six drivers are unverified.
- Local oracle metadata is not complete inventory/legal clearance. KAGParser,
  WolfDec, bundled/vendor components, EULAs, and anti-circumvention need the
  named fetch/review.
- Detection at sixty, process-adapter security/ABI/portability/throughput, RPG
  Maker 95 references/demand, and console/Unity-hosted scope are unverified.
- Churn does not verify labor, reuse causality, or equal-readiness cost.
- This was a strategic document audit. It did not implement or mutation-test
  the proposed machine, fix production role bindings, or run the full test
  suite.

## Final document guards

The following transcript must describe the final edit. Each command ran from
the repository root; blank output is reported explicitly.

```text
$ node scripts/audit-no-game-names.mjs
game-name guard: passed. 0 enforced references across 4219 scanned files. Limit: unstructured prose names and opaque bytes need an authoritative inventory.
(Exit 0; generated-ledger stderr is not reproduced because it contains the tokens this report is forbidden to copy.)
$ node scripts/audit-no-node-ids.mjs
node-id guard: passed. 0 references across 3686 scanned files. Scope: all tracked files; only generated fixtures/roadmap and applied migrations are exempt. Cannot see untracked or ignored files.
$ node scripts/file-line-cap-guard.mjs
file-line-cap guard scope: enforces a 500-line cap on tracked source files (.js: 3, .mjs: 210, .rs: 1396, .ts: 1404, .tsx: 107); scanned 3120.
file-line-cap guard limits: does not inspect untracked/ignored files, untracked generated output, or other extensions.
file-line-cap guard: passed. The 500-line cap is absolute; all tracked files in scope are at or below it.
$ pnpm exec vp fmt --check
Checking formatting... All matched files use the correct format.
Finished in [elapsed milliseconds omitted] on 2520 files using 48 threads.
$ git diff --check
(no output; exit 0)
$ wc -l docs/proposals/engine-expansion-program.md → 498
```

Limits: the name guard cannot identify arbitrary prose names or opaque bytes;
the ID guard cannot see untracked/ignored paths; the line guard covers tracked
Rust/TypeScript/JavaScript, while `wc -l` separately enforces this Markdown
cap; formatting checks style, not truth; `git diff --check` checks whitespace,
not semantics. None of these guards opens real bytes or exercises an engine.
