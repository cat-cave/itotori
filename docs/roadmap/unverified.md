# UNVERIFIED acceptance register

This is a fail-closed evidence register. Every item names the behavior cell
whose executable test owns the observation. A cell stays red until that test
produces the stated evidence; absence, skip, an empty result, or an unverified
assertion is failure.

`cells(<behavior>, canonical-engines)` means the 47 literal cells produced by
the roadmap validator from that behavior and the canonical engine registry.
`cells(<behavior>, production-targets)` means its 39 literal production cells.
These finite sets use `docs/roadmap/classification.jsonl` and
`docs/behaviors/engine-families.jsonl`; they do not introduce another registry.

## Suite and planning mechanics

Sources: `docs/behaviors/catalog.jsonl`,
`docs/behaviors/engine-families.jsonl`, `docs/behaviors/features/*.feature`,
`docs/roadmap/case-selection.md`, `package.json`, `pnpm-lock.yaml`, and the CI
commands in [`ci-audit.md`](ci-audit.md).

- **Runner pin — owner `cell::quality.failures-stay-explicit::all`:**
  `@cucumber/cucumber` 13.2.0 is the sole Gherkin runner. The cell stays red
  until the exact dependency and lockfile integrity are pinned, TypeScript
  steps drive both TypeScript and Rust public boundaries, and undefined,
  ambiguous, pending, skipped, or zero-assertion cases fail.
- **Initial pass numerator — owner
  `cell::quality.evidence-is-traceable-and-portable::all`:** the fail-closed
  bootstrap is exactly 0/687. The cell stays red until the protected verifier
  accepts the first executable 687-record cell report and records its measured
  passing numerator without importing catalog state.
- **Source identity regression — owner
  `cell::quality.evidence-is-traceable-and-portable::all`:** the sole source
  universe is 582 unique canonical `c` identities in
  `docs/behaviors/source-inventory/*.jsonl`; its sorted-identity SHA-256 is
  `48777d244fafe26e8ba834ed6b456b1756217380ef6a4af17ef27b42a942bcb3`.
  The cell fails on any missing, duplicate, relabeled, or undisposed identity.
  Observation labels in grounding reports are not alternate source identities.
- **Expanded-case selection — owner
  `cell::quality.evidence-is-traceable-and-portable::all`:** the selected
  executable count is exactly 3,400, with the fourteen partial outlines mapped
  in `case-selection.md`. The cell fails if generated subject, comparison,
  profile, applicability, or selected-case identities differ from that
  committed crosswalk.
- **Native issue facilities — owner
  `cell::quality.evidence-is-traceable-and-portable::all`:** the measured 381
  reduced edges use native blocked-by relationships and the 26 bundle-to-241
  spec hierarchy uses native sub-issues. Renderer permission absence,
  relationship drift, a redundant edge, or an invented Markdown dependency
  fails the cell.
- **External required check — owner
  `cell::quality.evidence-is-traceable-and-portable::all`:** the required
  context is `behavior-proof / required`, emitted only by the installed
  external App from a digest-pinned verifier. Missing installation, wrong App
  provenance, mutable verifier input, or a non-atomic ruleset update is red.
- **Base/head private comparison — owner
  `cell::quality.invalid-or-raced-actions-have-no-effects::all`:** the verifier
  admits only receipts whose reviewed tree, build, requested cells, and private
  dependency cone match the candidate and merge group. Stale, overlapping,
  replayed, or affected receipts leave no admitted transition.
- **Roadmap-to-issue rendering — owner
  `cell::quality.evidence-is-traceable-and-portable::all`:**
  `scripts/render-roadmap-issues.mjs` is the sole renderer. Its read-only check
  and owner-authorized apply mode consume the immutable bundle/instance files,
  query 100 issues per page, mutate in batches of 20, and reconcile bodies,
  sub-issues, and dependencies without writing status, labels, dates, or
  percentages. Any non-idempotent second render fails the cell.

## Engine and corpus truth

Sources: `docs/action-plan.md` sections 4–7,
`docs/roadmap/case-selection.md`,
`docs/behaviors/engine-families.jsonl`, and
`scripts/ci/private-real-byte-proof.mjs`.

- **Discovery authority — owner `cell::support.disclose-compatibility::all`:**
  the executable authority is exactly 47 canonical rows: 39 production and
  eight non-production. Prose-only discovery leads create no identity or
  denominator entry. The cell fails unless every retained alias, generation,
  profile, exclusion, comparison, and research relationship in
  `case-selection.md` resolves to one canonical row or an explicit
  non-executable disposition.
- **Parity-role migration — owner
  `cell::support.qualify-profile::runtime.engine.rpg-maker-xp-parity-reference`:**
  the cell stays red until a reviewed same-identity migration has two-title
  production evidence and preserves the former parity receipt as a distinct,
  non-qualifying comparison artifact.
- **Two-title availability — owners
  `cells(support.qualify-profile, production-targets)`:** each production family
  cell requires two distinct lawful title-equivalence groups with independent
  provenance and unequal corpus roots. Missing inventory access, one title, an
  alias, an edition, or an unverified acquisition record keeps that family red.
- **Inventory compatibility — owner
  `cell::source.prepare-owned-content::decode.engine.reallive`:** the signed
  inventory uses one custody root plus mount-relative entries. The cell stays
  red until clean setup rejects an absolute-root form, escape, symlink, alias,
  device, case-fold collision, writable root, and an undeclared entry.
- **Per-file content address — owner
  `cell::source.prepare-owned-content::decode.engine.reallive`:** the sidecar
  must read and hash every selected byte through descriptor-rooted handles
  before and after execution. Hashing only a list file, accepting zero bytes, or
  omitting an entry is red.
- **Field population — owners
  `cells(quality.output-completeness-is-reported, production-targets)`:** every
  family cell requires per-title nonempty/total counts for every structured
  field and one exact status: populated, source-absent, extractor-missing,
  implemented-but-empty, invalid, or unknown. A zero without independent
  source-absence evidence is red.
- **End-to-end family proof — owners
  `cells(journey.localize-owned-release, production-targets)`:** each family
  cell requires a retained two-title receipt joining exact intake, complete
  structure/context/localization, safe patch, re-extraction, deterministic
  play, human round, and played export. Fixture substitution or a missing leg
  is red.
- **Detection scale — owners
  `cells(support.qualify-profile, canonical-engines)`:** each applicable cell
  records precision, recall, ambiguity, incomplete rate, negative neighbors,
  collisions, byte limits, time limits, inputs, outputs, and failures at its
  declared scale. A smaller run or an omitted measure is red.

## Private proof infrastructure

Sources: the Actions runner/workflow API audit in [`ci-audit.md`](ci-audit.md),
`.github/workflows/real-bytes-*.yml`,
[`real-bytes.md`](real-bytes.md), and
`scripts/ci/private-real-byte-proof.mjs`.

- **Broker and agents — owner
  `cell::source.prepare-owned-content::decode.engine.reallive`:** use the
  protected hosted broker and a fresh one-request Confidential Space evidence
  agent with an independently protected sidecar and external log sink. No
  eligible agent, reused sandbox, candidate publication credential, or missing
  health proof keeps the cell red.
- **Isolation — owner
  `cell::quality.private-data-stays-within-approved-boundaries::all`:** the
  selected agent must pass penetration tests for read-only least-scope handles,
  default-deny egress, clean disposal, resource high-water capture, and denial
  of metadata, host, sibling-corpus, and broker sockets. Any successful negative
  probe is red.
- **Provider egress — owners
  `cell::quality.private-data-stays-within-approved-boundaries::all` and
  `cell::run.account-provider-use::all`:** an attested in-boundary component
  uses customer-account direct TLS and one-use custody, with provider-origin
  served identity and retention evidence plus destination, call, token, byte,
  and bill reconciliation. An operator relay, missing counter, extra-unit
  negative-control success, or nonzero no-egress event is red.
- **Signing — owner `cell::evidence.publish-safe-runtime-proof::all`:** each
  request uses a fresh P-256 signing key generated inside Confidential Space;
  its public key, sidecar image, policy, request, and isolation claims bind to
  the hardware-rooted attestation. Google attestation roots are pinned by the
  verifier; image/policy revocation denies admission, and recovery means a new
  request rather than key recovery.
- **Receipt predicates — owner
  `cell::evidence.publish-safe-runtime-proof::all`:** the in-toto Test Result
  v0.1 statement and the two owned v0.1 predicates have hash-pinned schemas,
  DSSE conformance tests, an exact cross-binding index, a closed privacy
  allowlist, and a complete subject dependency cone. Any extra field, missing
  subject, failed binding, or schema drift is red.
- **Transparency — owner `cell::evidence.publish-safe-runtime-proof::all`:**
  the content-free envelope digest is entered in Sigstore Rekor with a signed
  checkpoint, integrated timestamp, and inclusion proof. Missing independent
  log verification, broker/request time binding, or a publicly reproducible
  verification transcript is red.
- **Human authority — owners `cell::review.refine-whole-round::all` and
  `cell::export.download-played-patch::decode.engine.reallive`:** the installed
  customer companion requires WebAuthn user presence and an end-to-end
  device/session-bound display/input channel. Two played children, two
  human-started successor rounds, candidate-noninjectable input provenance, and
  separate final-child export authority are mandatory; stale, foreign,
  machine-originated, or replayed authority is red.
- **Privacy proof — owner
  `cell::quality.private-data-stays-within-approved-boundaries::all`:** a
  sentinel from every forbidden class must be absent and unrecoverable across
  the prospective receipt, logs, diagnostics, public artifacts, timing, and
  metadata. The declassifier rejects an unapproved field or value before the
  publisher can receive it.
- **Failure recovery — owner
  `cell::platform.interrupted-work-resumes-once::all`:** broker outage, agent
  loss, sandbox crash, sidecar crash, cancellation, duplicate delivery, and
  result uncertainty each execute end to end. One-use request state admits one
  result or a typed red outcome, never duplicate work, an ambiguous pass, or
  leaked scratch state.
- **Operational latency and capacity — owner
  `cell::run.control-durable-work::all`:** the protected lane records queue,
  runtime, storage, CPU, memory, and concurrency high-water measures at the
  declared scale. Missing measures, exceeded signed bounds, or an unbounded
  queue is red; no unmeasured throughput promise is made.

## Product and release observations

Source: `docs/action-plan.md` section 7. Synthetic checks never substitute for
the production, browser, provider, deployment, or full-journey observations
below.

- **Production database/browser journey — owners
  `cell::studio.find-authorized-work::all` and
  `cell::journey.localize-owned-release::decode.engine.reallive`:** production
  database and browser execution must cover every declared route,
  account/project/locale isolation, complete navigation, and the installed
  first-production journey. An unvisited route, cross-scope record, or synthetic
  replacement is red.
- **Large-catalog interface — owners
  `cell::studio.find-authorized-work::all` and
  `cell::platform.clean-host-lifecycle-is-guided-and-recoverable::all`:**
  pagination/virtualization, density, representative glyphs, accessibility,
  keyboard control, and fixed-width screenshots execute at the catalog and host
  scales named by those cells. Clipping, stale results, missing screenshots, or
  a smaller collection is red.
- **Live provider — owner `cell::run.account-provider-use::all`:** a current
  provider-origin receipt must prove served identity, privacy controls, exact
  bill reconciliation, replay-zero-call behavior, and complete fixed-role
  output. Local self-attestation or a missing token/cost value cannot pass.
- **Benchmark — owners `cell::evaluation.compare-contestants::all` and
  `cell::evaluation.act-on-confidence::all`:** the locked holdout must report
  equal coverage, calibration, semantic and voice dimensions, bias/sabotage
  validity, exact cost/latency, and every non-compensating confidence gate.
  Missing dimensions, unequal input, or compensating averages are red.
- **Deployment parity — owners
  `cell::platform.deployment-inputs-and-secrets-are-safe::all`,
  `cell::platform.clean-host-lifecycle-is-guided-and-recoverable::all`,
  `cell::platform.artifacts-are-immutable-and-retained-by-policy::all`,
  `cell::platform.interrupted-work-resumes-once::all`,
  `cell::privacy.govern-evidence-disclosure::all`, and
  `cell::quality.private-data-stays-within-approved-boundaries::all`:**
  self-hosted, managed-control/local-executor, and managed-confidential
  placements must produce equivalent authorized outcomes while proving
  database authority and failover, split data paths, metadata-only control
  surfaces, immutable ciphertext, reconstructible durable state, fresh
  attestation, customer custody, retention/deletion, update/rollback, and
  operator-blind processing. Any missing placement or predicate is red.
- **Optimized CI — owner `cell::run.control-durable-work::all`:** compare the
  same collected tests before and after workspace reuse and migration-ownership
  changes. Median and p95 must not regress, at least one must improve, shard
  start and database-lock wait must fall, and one failure must expose all lane
  diagnostics. A changed collection or unmeasured claim is red.

These 32 entries exhaust the grouped material observations retained from the
action plan. A newly discovered material observation must be added here with an
exact owning cell before it can affect scope or admission.
