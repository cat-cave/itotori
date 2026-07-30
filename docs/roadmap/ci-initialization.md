# Behavior-proof CI initialization

This plan fixes every implementation choice needed to build the executable
behavior ledger. It preserves the 687-cell denominator, makes absence red, and
adds no environment variable. Planning files remain immutable intent; only the
verified cell report records execution state.

## Fixed decisions

### One Gherkin runner

Pin `@cucumber/cucumber` **13.2.0** as an exact root development dependency and
commit its `pnpm-lock.yaml` resolution. It supports the repository's pinned
Node 24 toolchain, Cucumber Messages, JUnit, strict execution, and process
sharding. The tagged documentation defines its
[formatters](https://github.com/cucumber/cucumber-js/blob/v13.2.0/docs/formatters.md),
[JavaScript API](https://github.com/cucumber/cucumber-js/blob/v13.2.0/docs/javascript_api.md),
and [sharding](https://github.com/cucumber/cucumber-js/blob/v13.2.0/docs/sharding.md).

Reject Rust `cucumber` 0.23.0. It is maintained, but it would introduce a second
Gherkin parser, step registry, and result stream, then still need to launch the
TypeScript product boundary. One JavaScript runner can instead drive both
public surfaces and produce one report.

Use this implementation layout:

```text
suite/behavior/cucumber.mjs
suite/behavior/tsconfig.json
suite/behavior/steps/*.ts
suite/behavior/support/*.ts
suite/behavior/drivers/*.ts
suite/behavior/schemas/cell-report.schema.json
scripts/ci/run-behavior-proof.mjs
scripts/ci/build-cell-report.mjs
```

Compile the TypeScript support code with the existing TypeScript toolchain into
`.tmp/behavior-proof/glue/`, then import the emitted ESM. Do not add a
just-in-time transpiler. `cucumber.mjs` fixes:

```text
strict = true
retry = 0
failFast = false
publish = false
order = defined
```

The support World reads a signed selection-plan file. Step definitions call
only command, HTTP, rendered-interface, produced-artifact, produced-byte,
persisted-record, provider-receipt, or runtime-observation drivers. TypeScript
drivers exercise the built application boundary. Rust drivers spawn the built
product CLI named in the signed plan, pass request data through argv/stdin, and
parse typed JSON stdout. The observation returns to the same World, assertion
wrapper, Cucumber Messages stream, and cell report. A Rust library path that has
no product boundary is a failed cell until its owning spec adds one.

Missing or ambiguous steps, a pending/skipped result, a driver that returns a
fixed empty/default value, and a Then step that records no assertion all fail.
The root implementation-killing test is
`cell_transition_rejects_fixed_empty_driver`: replacing the explicit-failure
driver with fixed success must make it fail.

### Immutable case selection

[`case-selection.md`](case-selection.md) fixes the mapping of all 47 outlines
and 570 authored rows. The protected planner regenerates:

- 3,400 selected executable cases;
- 687 applicable cells;
- 96 explicit non-applicable production-only behavior/non-production-subject
  pairs; and
- the exact case, profile, lane, comparison, and assertion requirements for
  every applicable cell.

Every selected case has exactly one execution lane. A cell can require several
lanes because its selected cases cross several public boundaries. Unknown
selectors, zero selected cases, duplicate selection, a subject/comparison
swap, or disagreement with the committed crosswalk fails collection.

The selection plan contains relative driver paths and arguments. Private
inventory, provider policy, tool paths, and output paths also arrive through
signed files or argv. No runner, workflow, broker, or driver receives a new
environment variable.

### Native issue rendering

Implement `scripts/render-roadmap-issues.mjs` as the sole roadmap renderer. It
has two modes:

- `--check` reads repository and issue state and exits nonzero on drift;
- `--apply` requires an authenticated repository-owner `gh` session and
  reconciles managed issue state.

Both modes verify `roadmap-contract.sha256`, then read
`spec-bundles.jsonl` and `spec-instances.jsonl`. Apply creates 26 bundle parent
issues and 241 semantic spec sub-issues, never a status issue. It queries 100
issues per page and sends GraphQL mutations in batches of 20 aliases. A second
apply over unchanged inputs must perform zero mutations.

The measured graph has 381 transitively reduced direct edges, maximum 47
blocking and two blocked-by links. Map each direct edge with `addBlockedBy`;
remove a managed extra with `removeBlockedBy`. Use native sub-issues for
bundle-to-spec hierarchy. Query `blockedBy`, `blocking`,
`issueDependenciesSummary`, `parent`, `subIssues`, and
`subIssuesSummary`, and treat the REST blocked-by endpoint as a conformance
cross-check. Runtime-resolved opaque API identifiers are never committed.

Managed issue bodies contain semantic spec, bundle, subject, exact cells,
expected red observation, green observation, negative controls, evidence
class, sizing basis, and non-goal. They do not duplicate dependency state and
the renderer never writes issue status, Projects fields, labels, milestones,
dates, percentages, or delivery estimates. Issue Forms/Projects automation is
rejected because it cannot validate identity/dependency truth and would create
a second progress ledger.

## Cell report contract

The runner writes public-safe fragments below `behavior-proof/`:

```text
cucumber/<lane>-<shard>.ndjson
cucumber/<lane>-<shard>.xml
cell-report.json
cell-report.junit.xml
mutations.json
summary.txt
```

Private agents retain raw messages privately and publish only a verified,
content-free fragment. Candidate-authored summaries are untrusted. The
protected verifier consumes Cucumber Messages and signed private receipts and
recomputes the final report.

`cell-report.json` has schema identifier
`itotori.behavior-cell-report.v1`. It binds:

- candidate tree and build digests;
- selection-plan and classification digests;
- runner package and exact version;
- every received lane-fragment digest;
- 687 lexically sorted applicable cell records;
- 96 lexically sorted non-applicable pair records; and
- the integer summary.

An invariant cell is named `cell::<behavior>::all`. A varying cell is named
`cell::<behavior>::<sourceCapability>`, using the canonical registry identity.
The 687 applicable records have exactly these fields:

```text
cell
behavior
subject
status = pass | fail
requiredCaseIds
executedCaseIds
assertedCaseIds
requiredLanes
receivedLanes
requiredProfiles
executedProfiles
messageFragmentDigests
verifiedReceiptDigest
reasonCodes
```

Private public records expose only request-known identifiers, generic reason
codes, and randomized commitments. Counts, paths, filenames, content, captures,
provider payloads, and private evidence handles stay in the private bundle.

The 96 non-applicable records contain behavior, canonical subject,
`status = not-applicable`, classification digest, and a fixed applicability
reason. These are the twelve production-only behaviors crossed with the eight
non-production rows. Shared behavior aliases are covered by their one `::all`
cell and are not called non-applicable. A selected or classified applicable
cell may never emit `not-applicable`.

A cell passes only when required, executed, asserted, and reported case sets,
lane sets, and profile sets are exactly equal; every selected scenario and step
passes; every Then records an assertion; every required driver observation is
nonempty; every required private receipt verifies; and its protected
`kill::<behavior>::<subject>` mutation makes it fail. Any missing, duplicate,
unexpected, skipped, pending, undefined, ambiguous, zero-byte, zero-assertion,
or fixed-empty input makes it fail.

The JUnit file contains exactly one testcase per applicable cell. Its name is
the cell identity, classname is the behavior, and child case identities appear
in `system-out`. Failed cells have a `failure` element. It contains no skipped
testcase; non-applicable pairs live only in JSON.

Summary arithmetic is exact:

```text
applicableCellCount = 687
passingCellCount = count(status == pass)
failingCellCount = 687 - passingCellCount
notApplicablePairCount = 96
passBasisPoints = floor(passingCellCount * 10000 / 687)
displayPercent = passBasisPoints / 100, rendered with two decimal places
```

Non-applicable pairs never enter the denominator. Flooring prevents the display
from overstating the passing share. Fewer or more than 687 applicable records,
or a summary that does not recompute exactly, fails the report.

## Lanes, cadence, and gates

The signed selection plan, not workflow prose, assigns cases and required lanes.

| Lane                          | Selected work                                                                                                                            | Cadence                                                                        | Gate                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| Tier 0 manifest               | Parse all features; validate 3,400 cases, 687 cells, 96 N/A pairs, schemas, ownership, bindings, and the live repository test collection | Every pull request, merge group, main push, manual run                         | Existing Tier 0 aggregate                       |
| Public TypeScript, two shards | Cases assigned `public-ts`                                                                                                               | Same four events                                                               | Existing Tier 1 aggregate                       |
| Public Rust, three shards     | Cases assigned `public-rust`; only these shards consume the native artifact                                                              | Same four events                                                               | Existing Tier 1 aggregate                       |
| Database                      | Cases assigned `database` against the service database                                                                                   | Same four events                                                               | Existing Tier 1 aggregate                       |
| Browser                       | Cases assigned `browser` inside the Nix-pinned renderer/font shell                                                                       | Same four events                                                               | Existing Tier 1 aggregate                       |
| Mutation                      | Every affected cell's protected kill case                                                                                                | Same four events                                                               | Existing Tier 1 aggregate and external verifier |
| Private machine               | Selected production-positive and private/provider cases                                                                                  | Approved, reviewed candidate before queue; trusted-main nightly health request | External App receipt                            |
| Private human                 | Selected played-round and export-authority cases                                                                                         | Approved, reviewed candidate before queue                                      | External App receipt                            |

This reuses the current event surface in
[`pr-tiers.yml`](../../.github/workflows/pr-tiers.yml) and current job classes in
[`_tier0.yml`](../../.github/workflows/_tier0.yml) and
[`_tier1.yml`](../../.github/workflows/_tier1.yml). Replace the successful
placeholder manifest dispatcher in
[`developer-command.mjs`](../../scripts/developer-command.mjs) with the real
collection command. Remove the native-artifact dependency from shards that do
not consume either product CLI.

Each execution job uploads its required public-safe fragment with
`if-no-files-found: error`. An `always()` aggregation job downloads every
expected fragment, reports every failed lane, and then fails if any fragment or
lane is absent. Only enumerated content-free failure diagnostics may be
collected under `always()`.

Keep the two existing Actions aggregate contexts. Install the external App and
atomically add `behavior-proof / required` as a third App-bound required
context without removing either existing context. A same-named Actions job
cannot satisfy it. A missing App result is red.

For a pull request, the App enforces:

```text
no accepted base-green cell becomes head-red
each governed change links at least one open semantic spec
each linked spec turns at least one owned base-red cell candidate-green
every transitioned cell has exactly one linked owner
each transitioned cell's protected mutation turns it red again
selected = executed = asserted = reported cases and profiles
```

An affected production transition also requires the exact reviewed candidate's
pre-queue private and human receipts. No private, provider, or human work starts
inside the merge queue. A merge group reruns public lanes and verifies
pre-issued receipt tree, build, selected-cell, and dependency-cone equivalence.
An affected cone is red and needs fresh evidence. Main verifies squashed
tree/build equivalence before release.

The full-matrix context always reports `passingCellCount/687` and stays visibly
red while any cell fails. It is not a merge requirement during roadmap
execution. It becomes a release requirement only at 687/687.

## Missing input is failure

The audit found four local tasks outside required CI that emit successful
no-corpus artifacts:

- `kaifuu:private-local-triage`;
- `siglus:private-local-validation-render`;
- `kaifuu:key-hunt`; and
- `kaifuu:encrypted-readiness`.

Their registrations are in [`vite.config.ts`](../../vite.config.ts), and the
measured false-green behavior is preserved in
[`ci-audit.md`](ci-audit.md). Change all four command contracts as follows:

1. Remove the successful no-corpus mode and `skipped` result from schemas and
   examples.
2. A missing manifest, missing root, empty directory, empty selection, zero
   bytes, or explicit absent-input request emits a content-free typed diagnostic
   and exits nonzero.
3. Public CI does not select private work. Once the signed plan selects a
   private case, missing input is a failed cell, never not-applicable.
4. Tests may exercise a pure absent-input builder, but the command wrapper must
   preserve the nonzero result.

`selected_private_task_without_manifest_fails_cell` is the
implementation-killing test. Temporarily changing the command to return zero
must fail that test; after restoration it must pass. The aggregate has a
separate `missing_lane_fragment_fails_aggregate` negative control.

## Private production path

The existing opt-in corpus workflow is quarantined before any corpus-bearing
host is attached. Remove its pull-request label route and disable its private
jobs; retain safe public drift logic in the public scheduled lane. Do not reuse
the workflow, repository-local setup action, or self-hosted runner for the
replacement. The current preflight in
[`private-real-byte-proof.mjs`](../../scripts/ci/private-real-byte-proof.mjs)
hashes a list file and uses conflicting input forms; it is not evidence.

The replacement follows [`real-bytes.md`](real-bytes.md):

1. The external verifier resolves the approved reviewed tree, build, requested
   cells, adapter manifest, policy, and dependency cone.
2. A protected hosted broker job presents pinned OIDC claims and submits one
   nonce-bound immutable request.
3. A fresh one-request Confidential Space evidence agent starts with no GitHub
   publication token, general network route, host socket, metadata access, or
   sibling corpus.
4. The signed private inventory names two independent lawful title-equivalence
   groups, mount-relative entries, expected sizes/digests, allowed stages,
   provider posture, and resource bounds.
5. The protected sidecar resolves the one custody root, creates an immutable
   snapshot, rejects unsafe entries, and hashes every selected byte through
   descriptor-rooted handles before and after execution.
6. Missing input, zero bytes, one title, alias/edition duplication, hash drift,
   a writable mount, or snapshot mutation fails before candidate execution.
7. Selected machine stages execute nonzero input, output, and assertion counts.
   Selected, planned, executed, and reported cells must be identical.
8. Default egress is none. A selected provider case uses an attested in-boundary
   component, customer-account direct TLS, one-use custody, fixed destination
   and payload bounds, provider-origin identity/retention evidence, exact bill
   reconciliation, and extra-unit negative controls.
9. Human cells use the independently installed customer companion, WebAuthn
   user presence, and a device/session/patch-bound end-to-end display/input
   channel. Candidate-injectable, stale, foreign, machine-originated, or replayed
   authority fails.
10. The sidecar encrypts the full-fidelity private bundle. An attested
    declassifier emits only the typed allowlist to a separate external
    publisher; no private evidence enters an Actions artifact.
11. A fresh P-256 signing key generated inside the confidential workload binds
    its public key, sidecar image, policy, request, and isolation claims to the
    hardware-rooted attestation. The verifier pins attestation roots and rejects
    revoked image or policy digests; recovery creates a fresh request.
12. Schema-pinned DSSE statements use the in-toto Test Result v0.1 predicate and
    the two owned v0.1 predicates. Their content-free envelope digest receives a
    Sigstore Rekor signed checkpoint, integrated timestamp, and inclusion proof.
13. The external verifier checks request freshness, all bindings, negative
    controls, field population, two-title quorum, human authority, provider
    accounting, private-bundle resolvability, and the public allowlist before it
    writes the required conclusion.

No production cell can pass before every applicable item above exists and
verifies for its exact candidate. The replacement becomes release evidence only
after two independently requested complete cycles produce resolvable bundles,
valid public attestations, successful negative controls, and passing privacy
sentinels.

## Six prerequisite repairs

These are ordered proof obligations, not infrastructure milestones. Each lands
inside cells that change red to green.

| Order | Audit repair and owning cells                                                                                                                                                                                                         | Required exit                                                                                                                                          |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
|     1 | Restore catalog/manifest/collection in `cell::quality.evidence-is-traceable-and-portable::all`                                                                                                                                        | Recompute the authoritative 582-identity crosswalk, replace the placeholder with 687-cell/3,400-case accounting, and run the live suite collection     |
|     2 | Execute Gherkin in `cell::quality.failures-stay-explicit::all`                                                                                                                                                                        | Missing steps, skips, pending, fixed-empty drivers, zero assertions, and selection/execution mismatch are red                                          |
|     3 | Replace the private path in `cell::source.prepare-owned-content::decode.engine.reallive`, `cell::content.extract-complete-scope::decode.engine.reallive`, and `cell::quality.output-completeness-is-reported::decode.engine.reallive` | Quarantine first; then require input presence, every-byte hashing, actual stages, exact field census, and signed content-free receipts                 |
|     4 | Require private receipt comparison in `cell::quality.invalid-or-raced-actions-have-no-effects::all` and `cell::quality.private-data-stays-within-approved-boundaries::all`                                                            | After two replacement cycles, atomically require the external context, verify merge-group equivalence, and delete the disabled old path                |
|     5 | Gate retained claims in `cell::platform.artifacts-are-immutable-and-retained-by-policy::all` and the explicit-failure cell                                                                                                            | Repair stale selectors/counts, gate every retained validator, retain cell/JUnit/browser/mutation/proof summaries, report all lane failures, and notify |
|     6 | Change database migration ownership in `cell::run.control-durable-work::all`                                                                                                                                                          | Keep the identical collected tests; record before/after queue and lock wait, do not regress median or p95, and expose all failures                     |

Repairs 3 and 4 are one coordinated private landing: quarantine, build, run two
cycles, wire the required verifier, then remove the disabled path. No
intermediate change claims a green production cell.

## First honest numerator

Before executable evidence, generate all 687 applicable records as
`fail` with reason `missing-execution`; the visible baseline is exactly 0/687.
Do not copy `state` values from the catalog.

The root initialization then:

1. regenerates and signs the exact 3,400-case selection plan;
2. runs every public shard and imports only exact-tree protected receipts;
3. treats every missing case, lane, assertion, profile, input, mutation, or
   receipt as fail;
4. recomputes the 687 records and 96 N/A pair records from raw messages and
   verified receipts; and
5. lets the external verifier publish the first accepted report.

That report's `passingCellCount` is the first measured numerator. Every later
base/head comparison consumes accepted reports with matching plan,
classification, tree, build, and dependency-cone digests. Catalog declarations,
successful process exit, issue state, and planning prose never increase it.
