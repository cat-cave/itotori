# Behavior variation audit

The classification authority is
[`classification.jsonl`](classification.jsonl). Each row links the behavior's
Gherkin, one contributing capability-map row, and concrete implementation or
test evidence. A parameter name was never accepted as evidence.

“Invariant” means one behavior proof consumes engine/profile facts as data.
“Engine-varying” means a family adapter, codec, writer, launcher, runtime, or
receipt materially changes implementation or observation. “Profile-varying”
means the real difference is a concrete container, encryption, helper, field,
comparator, or execution profile within a family.

## Engine-invariant: 31

| Behavior                                                  | Why it is one shared cell                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account.administer-access`                               | Grants, tenancy, seats, revocation, sessions, and audit resolve without engine data (`packages/itotori-db/test/effective-permission-resolver.test.ts:38`).                                       |
| `account.authenticate-session`                            | Opaque session, expiry, linking, and revocation vary by identity protocol only (`packages/itotori-db/test/auth-session-service.test.ts:45`).                                                     |
| `catalog.refresh-sourced-candidates`                      | Provenance and local scans persist engine confidence as record data (`packages/itotori-db/test/catalog-repository.test.local-scan-upsert.ts:35`).                                                |
| `catalog.select-owned-release`                            | One generic readiness map resolves arbitrary adapter identifiers and ambiguity (`packages/itotori-db/src/repositories/catalog-repository/catalog-benchmark-readiness.ts:119`).                   |
| `evaluation.act-on-confidence`                            | A shared non-compensating dimension gate acts on candidate evidence (`apps/itotori/src/contracts/scorecard-definition.ts:90`).                                                                   |
| `evaluation.compare-contestants`                          | Locked splits, alignment, privacy, and validation are one methodology; family is corpus metadata (`apps/itotori/src/benchmark-corpus/validate.ts:141`).                                          |
| `evidence.publish-safe-runtime-proof`                     | Visibility, retention, authority, containment, and hash determine publication (`crates/utsushi-core/src/runtime_artifact/root.rs:35`).                                                           |
| `knowledge.maintain-source-wiki`                          | Normalized facts and citations consume upstream evidence without family dispatch (`apps/itotori/src/wiki/evidence-index.ts:60`).                                                                 |
| `knowledge.prepare-locale-context`                        | Frozen context derives from facts, locale, route scope, and accepted versions (`apps/itotori/src/localized-wiki/ground-truth/resolve.ts:30`).                                                    |
| `knowledge.retrieve-authorized-precedent`                 | Reuse ranks and refuses on project, branch, locale, source, and authority compatibility (`packages/itotori-db/test/translation-memory-repository.test.ts:26`).                                   |
| `platform.artifacts-are-immutable-and-retained-by-policy` | Portable URI, hash, authorization, and retention rules are shared (`packages/itotori-db/src/managed-artifact-refs.ts:23`).                                                                       |
| `platform.clean-host-lifecycle-is-guided-and-recoverable` | Install, initialization, fonts, updates, and rollback vary by host/package, not engine (`scripts/itotori-installable-package.test.mjs:227`).                                                     |
| `platform.deployment-inputs-and-secrets-are-safe`         | One closed loader owns inputs, precedence, parsing, and failure (`apps/itotori/src/env/external-env-file.ts:10`).                                                                                |
| `platform.interrupted-work-resumes-once`                  | The durable tracker explicitly has no engine knowledge (`apps/itotori/src/cli/localize-run-tracker.ts:49`).                                                                                      |
| `platform.public-formats-upgrade-predictably`             | One registry owns bridge, delta, API, and database format meaning (`packages/localization-bridge-schema/src/format-stability.ts:55`).                                                            |
| `privacy.govern-evidence-disclosure`                      | Classification, permission, reveal intent, derivative state, and revocation drive disclosure (`apps/itotori/src/wiki/media-index.ts:290`).                                                       |
| `project.configure-localization`                          | Normalized surfaces and capabilities feed one branch policy (`apps/itotori/src/workflow/output-scope.ts:19`).                                                                                    |
| `project.create-locale-branch`                            | Source revision, branch, locale, idempotency, and isolation form generic lineage (`apps/itotori/src/composition/provisioning.ts:34`).                                                            |
| `quality.evidence-is-traceable-and-portable`              | Relative references and content hashes are one evidence discipline (`packages/itotori-db/src/managed-artifact-refs.ts:102`).                                                                     |
| `quality.failures-stay-explicit`                          | Operations normalize into one stable diagnostic and no-effect contract (`packages/itotori-db/src/repositories/project-run-diagnostics.ts:12`).                                                   |
| `quality.invalid-or-raced-actions-have-no-effects`        | Commit-time authority and one-winner transactions are application rules (`packages/itotori-db/test/auth-member-management-repository.test.ts:176`).                                              |
| `quality.private-data-stays-within-approved-boundaries`   | Placement, provider, storage, retention, egress, and publication share one privacy contract (`apps/itotori/src/contracts/privacy.ts:15`).                                                        |
| `review.compare-rounds`                                   | Normalized immutable parent, feedback, context, cost, and artifact lineage is family-neutral (`packages/itotori-db/src/repositories/localization-result-revision-repository-persistence.ts:36`). |
| `review.refine-whole-round`                               | Scene/moment feedback and successor lineage are normalized; current unit editing is a boundary defect (`apps/itotori/src/play/result-revision-service.ts:22`).                                   |
| `run.account-provider-use`                                | Physical attempt identity, privacy, tokens, latency, retry, and cost are one ledger (`apps/itotori/src/llm/physical-attempt-policy.ts:221`).                                                     |
| `run.configure-policy`                                    | Locale, mode, provider, privacy, budget, and authority share one admission gate (`apps/itotori/src/workflow/policy.ts:18`).                                                                      |
| `run.control-durable-work`                                | Leases, pause, cancellation, concurrency, isolation, progress, and cost are generic (`apps/itotori/src/cli/localize-run-tracker.ts:77`).                                                         |
| `run.inspect-truthful-state`                              | Counts, blockers, next actions, costs, and status are configured-scope read models (`packages/itotori-db/src/repositories/project-run-repository-read-model.ts:32`).                             |
| `studio.find-authorized-work`                             | Navigation, pagination, stable addressing, search, and authority are project concerns (`apps/itotori/src/api-client-pagination.ts:10`).                                                          |
| `support.disclose-compatibility`                          | One schema and validator process every capability tuple (`crates/kaifuu-core/src/compat_profile/validator.rs:119`).                                                                              |
| `workflow.use-equivalent-entrypoints`                     | Command, HTTP, and rendered paths call one injected adapter interface (`apps/itotori/test/gateway-entrypoints.test.ts:178`).                                                                     |

## Engine-varying: 11

| Behavior                               | Applicable subjects   | Material difference                                                                                                                                                                                 |
| -------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content.extract-complete-scope`       | all 47 canonical rows | Archive, paired-store, bytecode, and unit construction are family codecs (`crates/kaifuu-engine-fixture/src/reallive_adapter.rs:187`; `crates/kaifuu-engine-fixture/src/bgi/engine_adapter.rs:80`). |
| `patch.produce-safe-output`            | all 47 canonical rows | Reference rewriting, encodings, text pools, and writer preflight differ (`crates/kaifuu-engine-fixture/src/bgi/engine_adapter.rs:103`; `crates/kaifuu-core/src/patch_transaction.rs:37`).           |
| `play.launch-patched-content`          | all 47 canonical rows | Native replay, script execution, browser delegation, and bounded refusal are port-owned (`crates/utsushi-core/src/port/trait_.rs:205`).                                                             |
| `play.control-reproducible-session`    | 39 production targets | Choice, page, input, snapshot, save, and seek semantics differ (`crates/utsushi-reallive/tests/engine_port_synthetic.rs:55`; `crates/utsushi-kirikiri/src/replay/engine.rs:174`).                   |
| `play.explore-routes`                  | 39 production targets | Scene targets, labels, menus, and actions differ; the common port currently refuses discovery (`crates/utsushi-core/src/port/runtime_adapter.rs:96`).                                               |
| `play.observe-localized-surfaces`      | 39 production targets | Text, frame, audio, and browser observations require different render ports (`crates/utsushi-rpgmaker-mv/src/port.rs:228`).                                                                         |
| `evidence.capture-runtime-observation` | 39 production targets | Producers emit materially different trace, image, and fallback artifacts (`crates/utsushi-softpal/src/engine_port.rs:413`; `crates/utsushi-siglus/src/cg_port.rs:445`).                             |
| `run.localize-complete-scope`          | 39 production targets | Common agent output becomes mechanically valid bytes through family-owned apply and arguments (`apps/itotori/src/patchback/engine-adapter.ts:184`).                                                 |
| `review.play-exact-patch`              | 39 production targets | Artifact layout, launch descriptors, arguments, and exact-byte receipts differ (`apps/itotori/src/play/runtime-launcher-registry.ts:17`).                                                           |
| `export.download-played-patch`         | 39 production targets | Played-receipt checks and delivery are common, but compatible byte production is family-owned (`apps/itotori/src/play/patchback-produce-service.ts:84`).                                            |
| `journey.localize-owned-release`       | 39 production targets | Real decode, patch, replay, render, review, and export receipts cross the selected adapters (`apps/itotori/src/extract/decode-extract-runner.ts:31`).                                               |

## Profile-varying: 5

| Behavior                                           | Applicable subjects   | Real axis                                                                                                                                                                                                |
| -------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support.qualify-profile`                          | all 47 canonical rows | Each concrete profile has distinct admissible operations and evidence; the shared validator must not let one profile inherit another's proof (`scripts/generate-engine-capability-matrix.test.mjs:250`). |
| `source.prepare-owned-content`                     | 39 production targets | Container, crypto, codec, helper, key, misleading-input, and materialization profiles (`crates/kaifuu-core/src/layered_access_model.rs:3`).                                                              |
| `quality.untrusted-inputs-fail-without-harm`       | 39 production targets | Archive expansion, protected spans, snapshot shapes, size envelopes, and helper hazards (`crates/utsushi-core/tests/snapshot_envelope.rs:128`).                                                          |
| `quality.output-completeness-is-reported`          | 39 production targets | Field availability and legitimate source absence differ by executable source profile (`crates/kaifuu-reallive/tests/protected_span_second_corpus_real_bytes.rs:40`).                                     |
| `quality.same-inputs-reproduce-equivalent-results` | 39 production targets | Byte versus semantic comparators, archive repack, transport, snapshot, and mutation cones (`crates/kaifuu-core/tests/xp3_real_bytes_roundtrip.rs:112`).                                                  |

Profile-varying does not mean “multiply by every profile-shaped string.” One
family cell aggregates every concrete material profile registered for that
family. [`engines.md`](engines.md) fixes the required profile crosswalk and
[`case-selection.md`](case-selection.md) fixes its selected cases. Any missing,
generic-only, or unexecuted required profile fails the owning qualification
cell; inventing subcells would recreate the false denominator.

## Engine-shaped behavior that should not stay engine-shaped

- Catalog selection, localization policy, contestant comparison, compatibility
  disclosure, clean-host doctor probes, entrypoint parity, explicit failures,
  privacy boundaries, and safe proof publication all carry family/profile data
  today but should remain shared algorithms.
- Patch transactionality, launch binding, deterministic clock/event envelopes,
  route scheduling and coverage accounting, sink ordering, capture
  completeness, and played-receipt/archive delivery are shared substrates
  around genuinely varying adapters. The bundle specs require those shared
  seams to land with a cell-closing family vertical.
- Route exploration is engine-varying in the current tree because the common
  port refuses branch discovery. A typed branch/action port can make the
  scheduler invariant later; the classification changes only after the code
  and tests supply that evidence.
