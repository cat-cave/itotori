# PR-sized behavior specs

The exact 241 issue specs are
[`spec-instances.jsonl`](spec-instances.jsonl). Every row names its dependencies,
estimated authored change surface, expected file count, sizing basis, and at
least one exact red-to-green cell. The 26 bundle definitions in
[`spec-bundles.jsonl`](spec-bundles.jsonl) provide the acceptance observation,
non-goal, and per-spec bundling rationale inherited by each expansion.

Shared cell names end in `::all`. Family cells end in the canonical
`sourceCapability` from
[`engine-families.jsonl`](../behaviors/engine-families.jsonl). There are no
numbered planning identifiers and no hand-maintained issue state.

## Shared invariant specs

Each row below creates one spec. These are behavior bundles, not infrastructure
milestones: even the proof runner closes explicit-failure and portable-evidence
cells.

| Bundle                                  | Direct dependency                   | Cells turned red → green                                                                                                                                         | Lines | Files |
| --------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ----: |
| `proof-ledger-and-explicit-failures`    | —                                   | `quality.failures-stay-explicit::all`; `quality.evidence-is-traceable-and-portable::all`                                                                         |   950 |     9 |
| `public-formats-and-artifact-lineage`   | proof ledger                        | `platform.public-formats-upgrade-predictably::all`; `platform.artifacts-are-immutable-and-retained-by-policy::all`                                               |   750 |     6 |
| `deployment-and-clean-host`             | formats/artifacts                   | `platform.deployment-inputs-and-secrets-are-safe::all`; `platform.clean-host-lifecycle-is-guided-and-recoverable::all`                                           |   900 |     8 |
| `identity-and-access`                   | deployment/lifecycle                | `account.authenticate-session::all`; `account.administer-access::all`                                                                                            |   700 |     6 |
| `privacy-and-commit-authority`          | identity/access                     | `privacy.govern-evidence-disclosure::all`; `quality.private-data-stays-within-approved-boundaries::all`; `quality.invalid-or-raced-actions-have-no-effects::all` |   900 |     8 |
| `catalog-refresh-and-selection`         | privacy/authority                   | `catalog.refresh-sourced-candidates::all`; `catalog.select-owned-release::all`                                                                                   |   800 |     7 |
| `locale-branch-and-policy`              | catalog                             | `project.create-locale-branch::all`; `project.configure-localization::all`                                                                                       |   700 |     6 |
| `source-and-locale-knowledge`           | locale/policy                       | `knowledge.maintain-source-wiki::all`; `knowledge.prepare-locale-context::all`; `knowledge.retrieve-authorized-precedent::all`                                   |   850 |     8 |
| `run-policy-accounting-and-entrypoints` | knowledge                           | `run.configure-policy::all`; `run.account-provider-use::all`; `workflow.use-equivalent-entrypoints::all`                                                         |   900 |     8 |
| `durable-control-and-state`             | run policy/accounting               | `platform.interrupted-work-resumes-once::all`; `run.control-durable-work::all`; `run.inspect-truthful-state::all`                                                |   900 |     8 |
| `compatibility-and-studio-discovery`    | catalog                             | `support.disclose-compatibility::all`; `studio.find-authorized-work::all`                                                                                        |   800 |     8 |
| `safe-runtime-proof-publication`        | first production runtime            | `evidence.publish-safe-runtime-proof::all`                                                                                                                       |   650 |     5 |
| `whole-round-refinement-and-comparison` | safe proof and first played journey | `review.refine-whole-round::all`; `review.compare-rounds::all`                                                                                                   |   850 |     8 |
| `evaluation-and-confidence`             | whole-round review                  | `evaluation.compare-contestants::all`; `evaluation.act-on-confidence::all`                                                                                       |   850 |     8 |

## Registered and bounded production families

The 15 registered or bounded production rows each expand through these five
specs. The family suffix makes every cell literal in the committed instance
file.

| Bundle                                     | Cells for the named family                                      | Why these files change together                                                                                                     | Lines | Files |
| ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----: | ----: |
| `admitted-profile-intake-safety`           | source preparation; untrusted-input safety                      | Complete materialization and destructive-input refusal share detector, container, helper, secret, and profile fixtures.             |   700 |     6 |
| `admitted-extraction-population`           | complete extraction; field population                           | The extractor and its real record census must walk the same selected members, preventing a separate empty report.                   |   850 |     7 |
| `admitted-localization-patch-reproduction` | complete localization; safe patch; equivalent reproduction      | Accepted normalized output, family writer, atomic transaction, re-extraction, and comparator are one source-to-native-output proof. |   900 |     8 |
| `admitted-runtime-admission`               | launch; control; routes; localized surfaces; capture            | One family port owns exact launch, causal state, traversal, sinks, and observation artifacts; launch-only work would be a fragment. |   950 |     9 |
| `admitted-played-export-journey`           | exact play; played export; owned-release journey; qualification | Human authority, export, complete product composition, profile census, and two-title receipt share one immutable admission chain.   |  1000 |    10 |

The first production family can complete its final spec as soon as its own
runtime spec is green. Each of the other 38 production families may build in
parallel but its final played/export/qualification spec is blocked by that
first complete production journey.

## Unqualified production families

The 24 unqualified production targets start farther from a complete adapter, so
their 16 cells are split into six specs instead of five. This is calibrated to
landed adapter/runtime changes rather than an arbitrary behavior count.

| Bundle                                | Cells for the named family                                      | Why these files change together                                                                                               | Lines | Files |
| ------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----: | ----: |
| `new-profile-intake-safety`           | source preparation; untrusted-input safety                      | A reviewed access profile is inseparable from complete materialization and its negative boundary.                             |   750 |     7 |
| `new-extraction-population`           | complete extraction; field population                           | Codec, normalized bridge, whole-scope accounting, source links, and real census close one decode vertical.                    |   900 |     8 |
| `new-localization-patch-reproduction` | complete localization; safe patch; equivalent reproduction      | Agent coverage, native writer, protected spans, re-extraction, mutation, and comparator close the new family round trip.      |   950 |     9 |
| `new-launch-control`                  | launch; reproducible control                                    | Patch binding, lifecycle, input clock, checkpoint, save, seek, and restore form the minimum causal runtime.                   |   850 |     8 |
| `new-routes-observation-admission`    | routes; localized surfaces; capture                             | Branch actions, bounded traversal, rendering/audio sinks, differential observation, and capture extend the same runtime port. |   950 |     9 |
| `new-played-export-journey`           | exact play; played export; owned-release journey; qualification | Product support exists only when play, export, full composition, profile measurements, and two-title evidence close together. |  1000 |    10 |

## Non-production rows

The eight synthetic, benchmark, parity, research, and exclusion rows each
create one `bounded-role-conformance/<source-capability>` spec, estimated at 600
changed lines across five files. It turns exactly these four explicit
canonical-row cells red to green:

- `content.extract-complete-scope`;
- `patch.produce-safe-output`;
- `play.launch-patched-content`; and
- `support.qualify-profile`.

Those rows have no invented localization, safety-profile, review, export, or
journey cells. Their green result is the exact synthetic, comparison, research,
or refusal outcome declared by the Gherkin role oracle, never production
support.

## Sizing basis

The `basis` field makes each estimate reproducible:

- `adapter-slice` and `runtime-slice` divide measured landed family changes
  across complete decode/write or runtime/proof boundaries;
- `service-slice` counts API, service, repository, migration/schema, contract,
  and integration-test seams;
- `browser-slice` adds route, typed client, rendered state, accessibility,
  screenshot, and production-database browser coverage;
- `policy-slice` counts registry/loader, package, guard, failure-path test, and
  directly affected documentation seams;
- `contract-harness` counts runner, parser binding, manifest, result schema,
  mutation, CI, and receipt files; and
- `journey-slice` counts the family adapter, service/API, database lineage,
  Studio/runtime, private receipt, human authority, and end-to-end tests.

Generated output, lockfile churn, and private corpus bytes are excluded. Each
candidate records its exact authored base/head diff in its owning cells; that
future measurement does not alter the fixed sizing rule. A spec that stops
turning at least one listed cell red to green must be merged into a neighboring
bundle or deleted.
