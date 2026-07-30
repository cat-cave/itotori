# Itotori action plan

This document is the sole program-intent authority. The portable behavior
catalog accounts for all 582 harvested capabilities without becoming a second
prose plan. Other documents may specify contracts or preserve evidence, but
they do not add, defer, or reinterpret scope.

## 1. The mission

Build an installable localization system that takes lawfully held source bytes
through engine-generic extraction, an entirely agent-run drafting and quality
loop, deterministic patching, and an actually playable result; lets a human
improve that result only at the granularity of whole review rounds; and exports
only after the human has played the patch. Every intended capability remains in
scope: every engine family and profile, multi-language output, exact cost
tracking, benchmarking and scoring, Wiki and style control, review and
refinement, self-hosted execution, and managed operator-blind execution.
Unbuilt is a state, never a reason to drop work.

## 2. Where we stand

The measurement is pinned to
`e2113b06e05e5ef99d43227e842d2db95b0a1720`. A capability is admitted only by
the observation named for its state:

| State              | Reported entries | Admission rule                                                                                 |
| ------------------ | ---------------: | ---------------------------------------------------------------------------------------------- |
| `proven-real`      |               38 | The composed capability was observed on at least two independently sourced real titles.        |
| `proven-synthetic` |              166 | The composed capability was observed only on authored or synthetic inputs.                     |
| `built`            |              101 | Code exists; composition at the claimed boundary is unproved.                                  |
| `asserted`         |              116 | A claim exists; no supporting observation was found.                                           |
| `intended`         |               57 | The capability is wanted but unbuilt, with a falsifiable acceptance observation.               |
| `dropped`          |               19 | A mechanism or scope is explicitly out, with a reason and any replacement capability retained. |

The synthesis brief reports 482 classified capabilities across its two
grounding scopes while supplying state buckets totaling 497. The 15-entry
difference is numerically equal to the generated capability-matrix projection,
but no identity crosswalk proves that explanation. The roadmap rebuild must
preserve every source identity and supplied classification and make the
reconciliation executable before either total can be called canonical.

| Grounded area     | Reported capabilities | Reported `proven-real` | What the distribution means                                                                    |
| ----------------- | --------------------: | ---------------------: | ---------------------------------------------------------------------------------------------- |
| Bytes and runtime |                   192 |                     34 | Strong real-byte foundations exist in three families, with narrower real runtime slices.       |
| Product           |                   290 |                      4 | Almost the entire user-facing composition is synthetic, partial, asserted, or merely intended. |
| Total             |                   482 |                     38 | Foundations landed; the product they were meant to compose did not.                            |

This is not a nearly finished product with a few missing adapters. It is a
large set of credible native components, contracts, repositories, synthetic
workflows, and fixture-rendered screens with no complete production
transaction. The old ledger recorded landed foundations as if they were the
product.

### Load-bearing evidence

| Observation                                                    | Reproducible evidence and limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real bytes are the strongest layer.                            | RealLive byte-exact framing, Siglus two-title bridge/patch, and Softpal two-title extract/patch are observed by `framing_pins_real_bytes::framing_is_byte_exact_and_round_trips_on_real_bytes`, `two_real_siglus_titles_assemble_schema_valid_deterministic_bridges`, `two_real_siglus_installations_patch_back_byte_correctly`, and `patchback_on_two_softpal_titles`. These are stage proofs, not a product receipt.                                                                                                                                                                                                                     |
| Runtime truth is fragmented.                                   | `crates/utsushi-reallive/tests/full_module_replay_real_bytes.rs:187-264` proves two-title RealLive replay foundations; `crates/utsushi-siglus/tests/observe_real_bytes.rs:42-54` walks two titles statically; `crates/utsushi-softpal/tests/softpal_runtime_real_corpus.rs:55-210` reaches callbacks but emits zero runtime dialogue and choices despite populated source oracles. None proves the selected product patch.                                                                                                                                                                                                                 |
| Registration contradicts breadth.                              | `apps/itotori/src/play/patch-runtime-launcher.ts:6,30-33` registers only `realliveRuntimeLauncherAdapterFactory`; `jq '{rows:(.rows\|length),runtime_unsupported:([.rows[]\|select(.levels.runtime.status=="unsupported")]\|length)}' apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json` reports 15 rows and 15 unsupported runtime cells.                                                                                                                                                                                                                                                                             |
| Production API composition is route-incomplete.                | `apps/itotori/src/services/database-services.ts:155-233,340-367` installs only a subset of the service surface and throws on an unbound port. The `/api/terminology/search` handler invokes an uninstalled `terminologyRepository` at `apps/itotori/src/api-handler-read-catalog-play.ts:43-52`. Facade construction itself succeeds because `apps/itotori/src/api-handler-contracts.ts:390-392` defers that read in a closure. This is a source trace, not a live HTTP boot.                                                                                                                                                              |
| A meaningful nonempty production localization cannot complete. | Production review and adjudication throw at `apps/itotori/src/services/database-services.ts:316-332`; repaired bodies are discarded at `apps/itotori/src/composition/workflow-ports.ts:134-154`; the finalizer creates temporary patch output and throws at patched-byte Build-LQA in `apps/itotori/src/composition/live/factory-finalizer.ts:108-143`.                                                                                                                                                                                                                                                                                    |
| Multi-language is storage metadata, not output behavior.       | Production reads a process-global target at `apps/itotori/src/services/localization-production-config.ts:20-35`; P1 lacks a target-language prompt field at `apps/itotori/src/roles/p1/localizer.ts:58-79`; `apps/itotori/src/services/project-workflow-service.ts:265-268,401-416` uses a default and synthesizes branch identity rather than accepting the requested locale. No receipt covers two languages through Bible, model, review, patch, and play.                                                                                                                                                                              |
| Benchmarking is narrow validation and offline arithmetic.      | Current executable metrics in `apps/itotori/src/benchmark-sensitivity/metric-caught.ts` are residual-script counting and approximate monospace wrapping. There is no composed contestant runner, meaning/voice scorer, human-evidence collector, full report store, five-artifact replay, or cockpit; `/benchmark` falls through in `apps/itotori/src/ui/App.tsx`.                                                                                                                                                                                                                                                                         |
| The human refinement boundary is inverted and open.            | Feedback-batch and refine contracts exist at `apps/itotori/src/api-routes-second.ts:181-207`, but `apps/itotori/src/api-handler-mutation-wiki-play.ts:120-142` has patch-play handling and no cases for `patchIteration.feedbackBatch`, `.feedback`, or `.refine`; no producer or UI triggers a successor round. Conversely, `apps/itotori/src/api-routes-second.ts:124-134` and `apps/itotori/src/api-handler-mutation-wiki-play.ts:105-117` declare and dispatch a one-unit human edit surface (its production binding is absent), while `apps/itotori/src/ui/screens/wiki-bible/unit-feedback-panel.tsx:111-114` exposes unit identity. |
| Export does not require evidence that the human played.        | `apps/itotori/src/ui/screens/PassLedgerPanelProducePatchedBuildAction.tsx:15-83` gates production only on steering permission; `apps/itotori/src/play/patchback-produce-service.ts:87-113` builds and returns the archive without consuming a play receipt.                                                                                                                                                                                                                                                                                                                                                                                |
| Agent adjudication can still escape to a human unit queue.     | `apps/itotori/src/roster/manifest.ts:305-311` permits Q6 to emit a human-escalation artifact; `apps/itotori/src/workflow/driver.ts:255-266,377-394` filters unresolved units and constructs patch scope only from the remainder. That is neither an agent disposition nor a resumable run-level pause and can evade configured-scope coverage.                                                                                                                                                                                                                                                                                             |
| Production configuration bypasses the closed registry.         | `apps/itotori/src/services/localization-production-config.ts:20-35` dynamically reads eight names absent from the eight-entry `config/environment-registry.json`; `node scripts/env-registry-guard.mjs` cannot see dynamic property reads. Provider credentials belong behind registered secret/custody references, while locale, revision hashes, and budgets belong in durable run configuration.                                                                                                                                                                                                                                        |
| Current encryption remains operator-custody.                   | `apps/itotori/src/composition/live/field-cipher.ts:29-35,127-159` wraps per-field keys under one process master key; `apps/itotori/src/services/database-services.ts:117` constructs that cipher. This is storage encryption, not a customer-held key, one-use grant, attested release, or operator-blind receipt.                                                                                                                                                                                                                                                                                                                         |

Every current claim inherits its check's limit: fixture and local-Postgres
passes prove only their named synthetic boundary; missing private inputs,
zero-execution returns, declarations, hashes, and a green process exit are not
proof.

## 3. The inner/outer loop boundary

```text
human authors Wiki/style
        |
        v
human triggers one review round
        |
        v
agents draft -> QA agents -> scored findings -> adjudication
        -> per-unit accept/reject/defer -> machine coverage gate
        |
        v
immutable playable patch
        |
        v
human plays -> records notes -> batches feedback
        |                                |
        +---- next review round <--------+
        |
        +---- human export gate, after play
```

| Boundary               | Actor and granularity                      | Owns                                                                                                | Architectural defect                                                                           |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Unit quality gate      | Agents, one unit at a time                 | QA findings, adjudication, targeted repair, and accept/reject/defer                                 | A human sees or transitions a unit worklist.                                                   |
| Pass coverage gate     | Machine, configured scope                  | Exactly one valid accepted target for every required unit and asset; deterministic patch preflight  | A reviewer opinion substitutes for coverage, or a missing unit becomes a deferral/source echo. |
| Round and export gates | Human, one immutable patch round at a time | Wiki facts, style, played-patch review, notes, batched feedback, round trigger, and export decision | An agent starts/ends a round or authorizes export; a human edits inner-loop state.             |

Operational blockers pause the run at a resumable run boundary; they never
create a human per-unit queue. QA findings remain immutable scored evidence.
Coverage closes the pass. The human may export only a patch they actually
played. Any API, CLI, or screen that leaks unit granularity outward or round
authority inward fails conformance by construction.

The missing round trigger is the headline product gap. Existing Wiki, style,
play, note, and export fragments do not constitute refinement until a feedback
batch causally starts a successor round and produces a new playable patch; the
human unit-edit surfaces and export without played-patch evidence are separate
blocking boundary defects.

## 4. Decisions locked

### Scope and evidence

- All 582 harvested capabilities are accounted for by the portable behavior
  catalog. The inventory itself does not enter this document.
- A real family claim requires the same mechanism on at least two real titles.
  Synthetic fixtures qualify regression machinery, never real support.
- Full-fidelity text, bytes, frames, art, audio, and reconstruction data stay
  private; public artifacts are non-reconstructive redacted derivatives.
- The deployment-input registry remains exactly the eight entries in
  `config/environment-registry.json`. No workstream may propose a ninth
  environment variable. Existing dynamic unregistered reads are defects:
  provider credentials move behind registered secret or custody references,
  and locale, revision hashes, and budgets move into durable application/run
  configuration.
- Before public compatibility starts, each concept has one canonical schema
  and one production path. Once released, explicit version negotiation,
  migration, and retirement policy applies.
- Engine, corpus, proof, check, and lane topology is data, not names embedded
  in recipes, workflows, dispatchers, or environment variables. One committed
  adapter-owned catalog declares public checks and strict proofs; one private
  inventory supplies opaque corpus records; and one planner is the only
  component allowed to join them into executable plans. Capability projections,
  developer commands, CI, and release selection consume that authority rather
  than maintaining engine lists. A strict plan fails on an empty selection,
  missing requirement, unavailable runner, skipped required proof, zero
  execution, or any difference between its selected and executed sets; its
  content-free receipt records both sets and their outcomes. This introduces no
  deployment input beyond the closed eight-entry registry.
- `dropped` is reserved for a reasoned retirement or explicit scope exclusion,
  never difficulty. Replacement capabilities stay in scope.

### The nine resolved conflicts

1. **First proving vertical:** RealLive.
2. **Engine support depth:** one admission bar—production extraction from real
   bytes through the common whole-project path. Detection/readiness is a
   truthful lesser capability, never support.
3. **Encrypted XP3:** encrypted production profiles are required. Plain-only
   support would misrepresent real use.
4. **Protected spans:** typed identity and original order are both invariant.
   Deletion, duplication, overlap, corruption, or reordering fails before
   writes.
5. **Evidence tiers:** E0/E1/E2 are retired. Capability state uses only
   `proven-real`, `proven-synthetic`, `built`, `asserted`, `intended`, and
   `dropped`; runtime observation kinds remain orthogonal evidence metadata.
6. **Human intervention:** per-unit approve/reject/defer is an agent queue,
   never a human worklist.
7. **Quality gating:** agent QA gates units; configured-scope coverage gates the
   pass; the human, having played the patch, gates export.
8. **Structured-output recovery:** malformed output is an immutable typed
   failure. Fence stripping, tolerant coercion, and JSON salvage cannot create
   an accepted result; policy may make a fresh bounded call and otherwise
   pauses resumably.
9. **Provider routing:** fallback is permitted only within the current ZDR
   allowlist. Every physical call records requested and actually served
   provider/model, generation identity, ZDR evidence, usage, and billed cost;
   an unapproved or unidentified served pair is quarantined.

### Scope manifests retained

- The fixed 19-role manifest is A1 Style Lead, A2 Terminology Analyst, A3 Scene
  Analyst, A4 Continuity/Lore Reconciler, A5 Voice Director, A6 Cultural
  Adaptation Analyst, A7 Character Biographer, A8 Relationships/Background
  Analyst, A9 Route-Arc Analyst, A10 Speaker Resolver; P1 Whole-Scene
  Localizer, P2 Line Editor, P3 Semantic Repair; Q1 Meaning, Q2 Voice, Q3
  Terminology, Q4 Continuity, Q5 Build-LQA, and Q6 Adjudicator. Profiles govern
  tools and artifacts; no hidden or dynamically invented production role is
  allowed.
- Production ambition remains explicit for RealLive, Siglus, Softpal, NeXAS,
  KiriKiri/KAG/XP3, BGI/Ethornell, Ren'Py, Wolf RPG Editor, TyranoScript,
  Majiro, CatSystem2, RPG Maker MV/MZ, VX Ace/RGSS3, and the separately intended
  95, 2000, 2003, XP, and VX generations, plus bounded Unity I2, Naninovel, and
  registered storage profiles. The fixture family is synthetic-reference only;
  MAGES is benchmark-reference only. LiveMaker, YU-RIS, Artemis, Aoi, Flash,
  Director, Shiina Rio, and System-NNN remain asserted research, not support.
  Dedicated NScripter/ONScripter and generic Unity emulation remain `dropped`
  with their recorded reasons; no downstream evidence may be inferred from a
  reference.
- Playability is cumulative: C0 decoded bytes; C1 visible player gate; C2
  causal control; C3 observed audiovisual surface; C4 durable bounded route;
  C5 same-log patched route; C6 audited clean-process replay; and C7 a
  completion inventory for every start mode and reachable terminal. C4 or C6
  never implies C7 completion or reference fidelity.

### Playability admission and artifacts

P1 playability is a bounded claim about one port revision, installed-content
digest, patch digest, fixed environment, and scenario—not launch success,
whole-title completion, or reference-runtime fidelity. Admission requires all
five predicates: the port presents the expected real input gate; the injected
input is consumed exactly once and causes the named semantic checkpoint; the
relevant rendered, backlog, choice, or mixed-audio surface is observed; a
second clean-process replay yields identical canonical events, checkpoints,
and fixed-tick frame digests; and replay refuses any mismatch in content,
patch, port, adapter, renderer/font, locale, clock, or seed identity.

A P1 manifest must select and pass every applicable core scenario. Advance,
choice, text presentation, and persisted save/load are never
`not_applicable`; at least one two-option route must commit each selected index
and produce a divergent immediate checkpoint. Backlog, text speed, auto,
volume, and voice are required when discovery finds them; absence needs a
nonempty bounded discovery record, while exhaustion or an unsupported required
operation fails. C2 proves the route remains blocked without the input and
advances with exactly one input. C5 replays the original and patch with one log,
preserving structural checkpoints while displayed target digests, glyph
coverage, encoding, and bounds match the private expectations. C6 captures
twice, replays in a fresh process, and restores each checkpoint cut; retries or
state-hash tolerances cannot turn nondeterminism green.

The gating artifact is the immutable input log, causal event trace, canonical
state/checkpoint digests, and result manifest. Lossless fixed-tick checkpoint
frames in a pinned renderer corroborate it; an indexed scrub timeline is the
human review surface. Video is optional, private, and derived from those frames
for failure triage or an approved baseline—it is never a test oracle or the
primary proof. Full-fidelity frames, audio, text, and state remain encrypted
private artifacts. A public manifest contains only opaque handles, hashes,
counts, outcomes, and references to non-reconstructive redacted derivatives.
Redaction failure blocks publication without deleting private failure evidence;
a missing, stale, hash-mismatched, or unmanaged artifact makes the evidence
invalid rather than passed.

### Platform and custody

- Choose PlanetScale Postgres as the authoritative relational ledger because
  Cloudflare documents
  [PAYG dashboard provisioning and consolidated billing](https://developers.cloudflare.com/hyperdrive/planetscale/).
  Use cache-disabled Hyperdrive for authoritative request traffic and a
  separate direct TLS connection for migrations, advisory locks, and
  session-dependent administration. Provision PostgreSQL 17.9 HA; if
  Cloudflare exposes only PlanetScale's PostgreSQL 18 default while
  Hyperdrive's compatibility remains bounded at 17, launch stops.
  [PlanetScale's version table](https://planetscale.com/docs/postgres/cluster-configuration/versions)
  and
  [Hyperdrive's compatibility matrix](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)
  are the decision sources.
- Cloudflare is a ciphertext-and-control plane: Workers Paid serves the
  metadata-only UI/API; a per-project or active-run Durable Object projects
  admission and progress; one coarse Workflow orchestrates a run; Queues carry
  idempotent pointer batches through a mandatory dead-letter path; R2 stores
  immutable application ciphertext. Postgres remains authoritative; Durable
  Objects, Workflows, and Queues are reconstructible projections.
- Hyperdrive caching is explicitly
  [disabled](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
  Workflow concurrency remains bounded by the lower documented value until the
  conflict between the
  [limits page](https://developers.cloudflare.com/workflows/reference/limits/)
  and
  [limit-change notice](https://developers.cloudflare.com/changelog/post/2026-04-15-workflows-limits-raised/)
  is resolved by an account probe.
- Ordinary Cloudflare Containers may execute only public, synthetic, redacted,
  or otherwise content-insensitive work. They are not a private plaintext
  boundary.
- One versioned `CustodyExecutionCapability` protocol governs fully
  self-hosted, managed-control/local-executor, and managed confidential
  placements. The encrypted-object format, executor core, operation semantics,
  output encryption, and receipt are identical; only local enrollment versus
  managed attestation evidence changes.
- Customer-controlled key agents sign exact one-use grants, preallocate output
  recipients and key/nonce namespaces, mark an attempt spent before release,
  and release only named object and credential keys over a session-bound
  channel. Project epoch keys never go to a job or the service operator.
- The initial managed qualification target is a fresh production Google
  [Confidential Space](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-overview)
  workload with exact
  [image](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-images)
  and
  [attestation claims](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims),
  channel-bound attestation, memory/tmpfs plaintext, default-deny egress, and
  encrypted R2 input/output. An installed independently bootstrapped custody
  companion—not operator-served browser JavaScript—owns keys, policy,
  attestation verification, grant display/signing, recovery, and updates; the
  documented
  [security boundary](https://docs.cloud.google.com/docs/security/confidential-space)
  remains part of the residual-risk statement.
- Any managed plaintext model egress uses a customer-owned provider account and
  credential over direct executor TLS to the exact customer-signed
  DNS/host/port/certificate destination; no operator gateway or provider
  account may relay it. Receipts account for calls, tokens, and bytes, while an
  `egress=none` run proves that no plaintext leaves the executor.
- A redaction operation produces a private encrypted candidate. Publication is
  a separate customer-signed capability after local preview.
- The honest claim is **operator-blind confidential processing**, not “zero
  knowledge.” Model providers authorized to receive plaintext still see it;
  legal rights, provider retention, endpoint compromise, TEE trust, residency,
  backup purge, and authorized-recipient copies remain outside the
  cryptographic claim.

The remaining harvested conflicts are not implicitly decided. Their
load-bearing groups are listed under UNVERIFIED; the replacement ledger must
retain each individual ambiguity until a contract observation resolves it.

## 5. Workstreams

### 1. Eliminate the ten shared engine-identity layers

**Gap:** promotion still requires coordinated edits at ten central layers:

| Layer | Current shared seams                                                                                                                                                                                                                                          |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Workspace and Kaifuu CLI membership/dispatch: `Cargo.toml`, `crates/kaifuu-cli/Cargo.toml`, `crates/kaifuu-cli/src/main.rs`                                                                                                                                   |
|     2 | Kaifuu manual registry: `crates/kaifuu-engine-fixture/src/lib.rs:324-333`                                                                                                                                                                                     |
|     3 | Detection/readiness/compatibility identities: `crates/kaifuu-core/src/archive_detection_model.rs`, `crates/kaifuu-core/src/packed_engine_readiness.rs`, `crates/kaifuu-core/src/compat_profile.rs`                                                            |
|     4 | Utsushi CLI commands, structure table, and registries: `crates/utsushi-cli/Cargo.toml`, `crates/utsushi-cli/src/main.rs`, `crates/utsushi-cli/src/structure.rs`, `crates/utsushi-cli/src/fixture_runtime.rs`, `crates/utsushi-cli/src/replay_cli_registry.rs` |
|     5 | Exhaustive runtime family map: `crates/utsushi-core/src/port/impl_map/schema.rs:290-363`                                                                                                                                                                      |
|     6 | Product extract union and map: `apps/itotori/src/extract/extract-adapter-types.ts`, `apps/itotori/src/extract/extract-adapter-registry.ts`                                                                                                                    |
|     7 | Product patch union and imports: `apps/itotori/src/patchback/engine-adapter.ts`, `apps/itotori/src/patchback/adapters.ts`                                                                                                                                     |
|     8 | Product structure union and map: `apps/itotori/src/structure-export/structure-provider-registry.ts`                                                                                                                                                           |
|     9 | Product runtime factory list and family-shaped receipt: `apps/itotori/src/play/patch-runtime-launcher.ts`, `apps/itotori/src/play/runtime-launcher-registry.ts`                                                                                               |
|    10 | Matrix and proof enrollment: `scripts/generate-engine-capability-matrix-inputs.mjs`, `scripts/generate-engine-capability-matrix-document.mjs`, `scripts/real-bytes-lane.mjs`, `scripts/synthetic-coverage-manifest.mjs`                                       |

**Outcome:** one adapter-owned manifest and package authority generates
registries, contracts, capability projections, and proof enrollment; duplicate
identities or unsupported advertised operations fail before publication.

**Acceptance observation:** two engine families complete promotion
concurrently, by independent workers, with no shared-file edits.

**Dependencies:** none. Every other engine workstream serializes behind this
one until it passes.

The remaining workstreams retain the same four-part contract: the gap is
current state; the outcome names scope; the observation can fail; dependencies
control sequencing.

|                                                Workstream | Gap closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Outcome and acceptance observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Dependencies                                                                    |
| --------------------------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
|                    2 — evidence, corpora, CI, and release | Declarations, skips, projections, and stage-local checks can outrun executed behavior; clean inventory and the broad Rust sweep are unreproduced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Content-addressed receipts bind revision, command, adapter/profile, immutable I/O, selected/executed assertions, bytes read, field N/total, limits, privacy, and outcome. Platform-neutral data-class, encrypted-object, local-artifact, and receipt contracts land here. Component-complete synthetic CI is differentially qualified against a periodic two-real-title oracle; the release gate composes generated-contract, Rust, TypeScript, DB, browser, security, privacy, corpus, package, and docs lanes, and any governed change expires its receipt. **Accept when** replacing one admitted adapter with fixed-empty output makes named test `promotion_receipt_rejects_fixed_empty_adapter` fail; deliberately breaking each release lane blocks release; a post-check change is stale; two real receipts replay cleanly; matrix, catalog, API, and Studio agree; missing infrastructure fails; public artifacts contain no retail content.                                                                                                                                                                                                                   | Workstream 1.                                                                   |
|              3 — service, identity, and durable execution | A terminology GET reaches an unbound port and writes expose partial services. `apps/itotori/src/server.ts:140-146,280-284` forwards a session cookie, but `apps/itotori/src/services/database-services.ts:75-82,107-117` ignores `sessionId` and hard-codes the local principal; account repositories exist, while resource tenancy, production workers, and restart recovery do not compose.                                                                                                                                                                                                                                                       | Startup validates every route's service graph. Swappable browser OIDC/OAuth and SAML resolve principals, never provider roles; members, invitations, sessions, grants, security audit, plans, seats, and billing views compose without billing granting authority. Portable Postgres owns tenant-bound resources, append-only jobs, outbox, leases, costs, and artifacts. **Accept when** a generated route count proves every declared shipping route returns its specified authorized and denied outcome; conformance IdPs complete login/link/logout while forged or replayed state/assertions fail; invite/seat/revoke flows are transactional; account A cannot list/read/mutate/run/reveal/download B data; faults after admission, outbox, result, CAS, artifact, and terminal writes recover once. A crash after provider acceptance but before result commit pauses for reconciliation with no automatic redispatch, false zero, or false success.                                                                                                                                                                                                             | Workstream 2.                                                                   |
| 4 — catalog, owned intake, structure, Wiki, and languages | Live catalog acquisition/selection is uncomposed; `apps/itotori/src/services/project-workflow-service.ts:401-416` and `packages/itotori-db/src/repositories/project-repository-drafts-mixin.ts:20-35` lose durable engine/profile and requested-locale binding. Current Softpal extraction hard-codes empty protected spans; its linear v1 structure emits null text surfaces/branch entries and no next/fanout topology at `crates/kaifuu-engine-fixture/src/softpal/real/extract.rs:98-115` and `crates/utsushi-cli/src/structure/softpal.rs:124-177`. Target/localized Bible orchestration has no production caller; language is process-global. | Registered live/recorded catalog import, resumable crawl, exact/fuzzy linking, conflict evidence, opportunity/readiness, candidate browsing, and consented community feedback lead to a lawful read-only install, complete bridge/structure, source Wiki, and explicit locale branches whose language reaches every model/export. **Accept when** interrupted acquisition resumes to the same provenance-complete catalog, an ambiguous candidate stays uncommitted, and an exact selected release becomes the project; two real RealLive inputs report every field as populated, source-absent, extractor-missing, implemented-but-empty, invalid, or unknown; three target locales reuse source facts while producing disjoint Bibles, policies, lineage, costs, patches, and runtime observations.                                                                                                                                                                                                                                                                                                                                                                   | Workstreams 1-3; branch-safe persistence and engine receipts.                   |
|                              5 — durable agent inner loop | Production review/adjudication throw; repairs are discarded; Q6 permits human escalation and unresolved units can be omitted. Strict immutable failure, per-call cost attribution, and complete coverage are not proved across every role and dispatch path.                                                                                                                                                                                                                                                                                                                                                                                        | The fixed 19-role manifest consumes one frozen Wiki/Bible/context snapshot; whole-scene drafts, scored findings, adjudication, repair, agent per-unit accept/reject/defer, strict typed output, ZDR routing, served-pair lineage, exact cost, CAS, bounded concurrency, and resumable run-level pauses compose. **Accept when** the manifest rejects any added/omitted/duplicate role and N/N required role calls carry identical snapshot hashes; forced draft A plus approved repair B finalizes B; no-verdict and reject/defer either reach an agent disposition or pause the run and cannot disappear from coverage; malformed output never becomes accepted; an unallowlisted served pair is quarantined; provider usage reconciles to invoice; observed concurrency never exceeds its cap; kill/resume duplicates no committed call; one missing unit blocks the pass.                                                                                                                                                                                                                                                                                            | Workstreams 2-4; live provider/ZDR proof for any real-call claim.               |
|                             6 — RealLive source to pixels | The sole registered product adapter sits over failing generic variants, unknown whole-store operations, one-title integrated render, and no selected reviewed patch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The common path performs length-changing text/image/audio patching, re-extraction, generic runtime launch, deterministic audiovisual capture, and the retained C0-C7 ladder. **Accept when** two real titles with nonempty translation scope traverse source -> Wiki/Bible -> live agents -> reviewed patch -> rebuilt bytes -> clean runtime -> translated pixels; advance remains blocked then consumes exactly one input; every choice commits its selected index and a required pair diverges; backlog is visible; speed changes logical ticks; auto advances only under virtual time; volume changes mixed PCM and voice decodes non-silently; save/load survives fresh-process replacement; original/patched runs share an input log and structural checkpoints; two clean C6 replays match; and a distinct C7 manifest accounts for every start mode and reachable terminal. Both titles report nonzero source-oracle and observation N/total for each claimed leg; missing/empty legs fail, and C4/C6 never display as C7 or reference fidelity.                                                                                                                | Workstreams 1-5; runtime conformance and local/private artifacts.               |
|                    7 — production Studio and human rounds | Core surfaces are fixture-rendered or disconnected; account/project/locale navigation, large-corpus behavior, and accessibility lack a production gate. Unit-edit/unit-ID surfaces violate the boundary, no feedback batch starts a successor round, export lacks a played-patch gate, and refinement state is disconnected.                                                                                                                                                                                                                                                                                                                        | One accessible typed Studio owns the design system/shell, account/project/locale switching, stable deep links, permission-aware search/command palette, pagination/virtualization, notifications, private/public redaction governance, portfolio/jobs/progress/cost/ZDR views, and linked catalog, Wiki, runtime, asset, review, benchmark, and export surfaces. The human plays an immutable patch, records scene/moment notes, batches feedback, triggers a round, and alone gates export; agents map feedback inward. **Accept when** production-DB browser runs—not fixtures—prove every core route; account/project/locale switches and deep links neither leak nor stale; UI actions equal server grants; 50,000 equal-key rows paginate/virtualize with zero duplicate/gap; keyboard/a11y checks and locked-width screenshots pass; public mode leaks zero private artifacts; zero human unit controls remain; two successor rounds preserve unrelated hashes and recover the parent on failure; export consumes the exact play receipt.                                                                                                                         | Workstreams 3-6; durable addresses, feedback, CAS, patch, and runtime evidence. |
|                    8 — benchmark, scoring, and confidence | Narrow residue/layout checks and offline reducers do not measure semantic, voice, terminology, continuity, cultural, rendered-layout, speaker, choice, or comparative quality.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A locked holdout, anonymous contestants, fair context, deterministic metrics, calibrated semantic reviewers, inspectable human anchors, bias/sabotage/meta-validity, exact cost/latency, durable reports, backlog, cockpit, zero-call replay of Wiki/Bible/accepted-output/patch/runtime artifacts, and a strict non-compensating readiness scorecard compose. **Accept when** current, reference, pure-MTL, and ablation outputs cover identical held-out units; scores, confusion matrices, agreement, validity, bills, and latency reproduce; all five artifacts replay; seeded meaning/voice defects, contestant-order bias, or provenance leakage invalidate the result and create evidence-linked backlog items; every required scorecard dimension meets its locked threshold, and a zero or failed dimension blocks readiness rather than averaging away.                                                                                                                                                                                                                                                                                                       | Workstreams 2 and 5-7; lawful aligned corpora and real runtime layout.          |
|                                   9 — every engine family | Most families lack a two-title corpus, production extractor, runtime port, or product composition; `crates/kaifuu-core/src/adapter_core.rs:57-75` selects the first positive detector, which cannot scale to the retained sixty-family discovery horizon, and reference-only entries risk inflation.                                                                                                                                                                                                                                                                                                                                                | A bounded engine-neutral feature extractor feeds adapter-owned signature packs; all candidates resolve as verified, ambiguous, unknown, or incomplete, never first-match. Every family/generation in the scope manifest keeps its ledger role/state; production profiles admit extraction before downstream legs; encrypted XP3 is mandatory; bounded Unity and reference rows cannot inflate support. **Accept when** all sixty discovery entries evaluate within declared byte/time budgets; every claimed detection profile uses at least two real positives plus negative neighbors/collisions and reports precision, recall, ambiguity, and incomplete rates; detection grants zero downstream support; each claimed production family extracts two real titles through the common path; encrypted XP3 qualifies two distinct encryption profiles and refuses wrong/missing keys before writes; receipts alone populate downstream cells; two families promote concurrently without shared orchestration edits.                                                                                                                                                    | Workstreams 1-2 for parallel implementation; 3-8 for product admission.         |
|                        10 — portable platform and custody | Encryption is operator-custody; no managed deployment, companion, PlanetScale qualification, confidential executor, placement parity, package, or operator-blind receipt exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The platform-neutral PostgreSQL/object/executor/capability/receipt contract serves self-hosted and Cloudflare placements; customer keys, exact grants, attestation, customer-direct provider egress, packaging, init/update/rollback, retention/deletion reporting, observability, and release require no ninth environment input. **Accept when** local/managed runs match on two real titles per admitted family with field N/total; a planted sentinel is unrecoverable to a full-control service adversary from Postgres, R2, Queue, Workflow, Durable Object, logs, backups, or an operator provider/gateway; wrong DNS/certificate/host/port/credential/account and every extra destination/call/token/byte fail, while `egress=none` emits none; a clean host completes the journey; PlanetScale provisioning/load/failover/invoice meets the locked profile; the registry remains eight and a source guard rejects config outside `readRegisteredProjectEnv` or durable config; replayed/forked/stale/spent grants, changed claims, state loss, publication, deletion, and update/rollback attacks fail. Managed upload stays disabled until every case passes. | Workstreams 2-9; legal, attestation, residency, and platform qualification.     |

## 6. Milestones

Milestones are dependency waves, never dates or task totals.

| Wave                                   | Composed capability                                                                               | Exit observation                                                                                                                                                                                                                                                                                                                                                                                                          | Depends on |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A — concurrent promotion               | Engine identity and evidence are package-owned.                                                   | Two independent workers promote two families concurrently with no shared-file edits; fixed-empty adapter test `promotion_receipt_rejects_fixed_empty_adapter`, duplicate identity, missing corpus, and zero-execution receipt each turn the gate red.                                                                                                                                                                     | None       |
| B — truthful production foundation     | A tenant-safe, restart-safe project can be created from sourced catalog evidence and owned bytes. | A conformance browser login and exact catalog release selection create a tenant-bound project; member/seat and two-account isolation pass; engine/profile, complete structure, Wiki, locale, run config, jobs, costs, and artifacts persist; every declared route binds; kill/restart and provider-uncertainty faults follow Workstream 3.                                                                                | Wave A     |
| C — agent-complete RealLive patch      | The inner loop produces the exact native patch it approved.                                       | On two real titles, every configured unit is agent-accepted, repair B replaces draft A, native output re-extracts to the accepted hashes, and incomplete coverage cannot finalize.                                                                                                                                                                                                                                        | Wave B     |
| D — playable human round               | The outer loop closes over audited play without unit-level human work.                            | Two RealLive titles produce C6 clean-process patched-route receipts and separate C7 start/terminal inventories; bounded-route and completion labels never conflate. A human plays the exact patch in the production Studio, batches scene/moment notes, triggers a successor round, receives a changed child, and exports only by its play receipt; zero human unit surfaces remain and parent recovery survives failure. | Wave C     |
| E — language and portfolio composition | One source supports multiple target languages across concurrent projects.                         | Three locale branches share source facts but have disjoint Bible, policy, output, cost, patch, and play histories; at least two distinct projects run concurrently, and pausing/cancelling one does not alter the other.                                                                                                                                                                                                  | Wave D     |
| F — breadth and confidence             | A second family and the evaluation facility use the same product path.                            | Another two-title family reaches playable human rounds without shared orchestration edits; a held-out comparative benchmark reproduces quality, calibration, cost, latency, validity, and backlog, and readiness fails if any required scorecard dimension misses its locked threshold.                                                                                                                                   | Waves D-E  |
| G — portable private release           | Self-hosted and managed placements satisfy the same custody and product receipts.                 | A clean host completes the product journey; every replay/fork/stale/spent grant, changed claim, state-loss, leakage, publication, deletion, and update/rollback attack in Workstream 10 fails; local/managed real-title outputs agree; the composed release gate retains only post-change receipts and honest residual risks.                                                                                             | Waves A-F  |

## 7. What remains UNVERIFIED

### Audit and evidence limits

- The supplied 482/497 classification accounting has not yet been
  deduplicated by the replacement ledger.
- The full Rust workspace/package sweep did not complete after an initial disk
  quota failure; targeted runs used reduced build settings and were not a
  substitute.
- Clean documented private-inventory setup is unverified: the audited
  inventory required an out-of-repository schema conversion.
- No final full repository, browser, private-corpus, provider, deployment, or
  mutation sweep was part of the read-only grounding audits. Their reported
  test counts prove only the named synthetic or stage-local boundary.
- No current private CI runner, media-recording producer, or complete portable
  capability receipt was observed.

### Bytes, runtime, and engine breadth

- Exact sixty-family detector accuracy is unverified until the labeled corpus
  supplies two positives per claimed profile plus negative neighbors and
  collisions; detection alone will still prove no support.
- Two-title real bytes are absent for XP3, NeXAS, RPG Maker MV/MZ and RGSS
  generations, BGI, TyranoScript, Ren'Py, Wolf, Majiro, CatSystem2, and the
  Unity profiles; other researched families have no admitted production
  observation.
- RealLive XOR2 and length-changing translation apply at family scale to only
  one suitable real title; whole-store execution still has unknown operations;
  the second integrated-render failure may be a missing asset or resolver
  defect; two-title input, jump, native save, audio, and patch-to-render remain
  unproved.
- Siglus static decode, bridge, patch, and frame evidence is strong, but full
  VM, replay, save/load, audio, delta, generic adapter registration, and
  selected-patch execution are unproved.
- Softpal real extraction and patch are strong, but protected crypto covers one
  title, the override source binary is absent, runtime emits zero dialogue and
  choices, and generic product runtime composition is unproved.
- Commercial helper launch, dynamic process/key discovery, browser-hosted real
  runtime, native launcher portability, media recording, and every remaining
  family runtime are unverified.

### Product, agents, and human use

- No family has a retained two-title receipt for intake -> complete structure
  -> Wiki/Bible -> live localization -> agent QA -> exact native patch ->
  patched play -> human round -> export.
- The `/api/terminology/search` missing-binding failure is source-traced, not
  reproduced by a live deployed HTTP boot.
- Browser login/logout, session-to-actor binding, account resource tenancy,
  external catalog acquisition, production queue workers, restart recovery,
  and exact repaired-patch delivery are unimplemented or uncomposed.
- No two-language output receipt, multi-project scale receipt, live provider
  generation, ZDR wire proof, provider bill, attribution reconciliation, or
  complete cost/latency distribution exists.
- Source Wiki and localized Bible completeness, all declared agent roles,
  review/adjudication calibration, repair propagation, translation-memory
  integration, context invalidation, feedback lineage, review-round triggering,
  and selection-last refinement have only synthetic pieces or no producer.
- UI observations are fixture/jsdom results. Real browser behavior, visual
  density, accessibility, large-corpus performance, nondeveloper usability,
  abandonment, and screenshots remain unmeasured.
- Benchmark contestants, aligned inspectable holdout, semantic/voice scoring,
  human rater/adjudication receipts, calibration, meta-validity, real-run
  adapter, durable report, five-artifact replay, confidence cockpit, and
  improvement flywheel are unverified.

### Platform and custody

- Cloudflare, PlanetScale, and confidential-compute capabilities are vendor
  assertions for this project: no deployment, invoice, account probe, load,
  failover, restore, connection-saturation, attestation, or real-input run was
  produced.
- Cloudflare's PlanetScale surface for exact PostgreSQL version, region, SKU,
  HA topology, direct port, backup/deletion controls, credential rotation,
  contract-account billing, and support handoff is unverified; PostgreSQL 18
  through Hyperdrive remains ambiguous.
- Workflow concurrency documentation conflicts between 10,000 and 50,000;
  announced billing, Queue consumer CPU limits, Data Localization Suite price,
  and end-to-end residency are unverified. The design must not depend on the
  disputed ceilings.
- Cloudflare Containers have no reviewed customer-verifiable attestation
  boundary. Confidential Space native tools, browser/runtime, tmpfs/disk,
  image size, performance, boot time, quota, region, side channels, and unit
  economics have not been qualified.
- The custody companion, policy chain, canonical encoder/verifier,
  encrypted-object migration, one-use release authority, recovery, revocation,
  deletion evidence, comprehensive leakage scan, malicious-update defense,
  managed executor, and self-hosted/managed parity do not exist.
- Provider-blind inference is not established; customer-direct provider mode
  blinds the service operator, not the model provider. Per-object
  cryptographic erasure is not established. No per-project or per-unit price is
  authoritative.
- Copyright, licensing, anti-circumvention, takedown, legal possession of
  ciphertext, provider terms, residency, and customer rights require separate
  policy and legal evidence.

### Contract questions not silently resolved

- Provider implementation library, application-versus-provider fallback
  ownership, and any local-model posture.
- Durable state mechanics where memo/CAS and lease/fence designs overlap;
  cost-kind taxonomy for external benchmark inputs; cache-discount accounting.
- Snapshot size envelopes, partial-report shape, bridge identity algorithm,
  and the post-repair semantic-review policy.
- Output and source contracts: schema versus another strict wire mode;
  Shift-JIS `81 40`/U+3000 notation; configured translation scope versus
  whole-archive decode; Wiki-required-field pauses versus every-unit writing;
  environment-only versus scoped external secret-file loading; canonical by-ID
  vault resolution versus hash-path identity.
- RealLive opcode framing, complete corpus accounting, graphical-choice
  mapping, malformed G00 behavior, qualifying second prose corpus, and removal
  of the legacy patcher.
- Siglus key-resolution method; structural Softpal/NeXAS classification;
  native/helper/browser delegation boundaries; runtime migration end state.
- Identity-provider default, registry granularity for KAG and RPG generations,
  and the exact point at which public schema compatibility begins.

Each question stays UNVERIFIED until one canonical contract and a failing
observation resolve it. None may create a second production path or a new
environment input.
