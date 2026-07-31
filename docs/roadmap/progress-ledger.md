# Executed progress ledger and stacked delivery

## Authority boundary

This extends the schema, pass rules, denominator, lanes, and verifier fixed by
[`ci-initialization.md`](ci-initialization.md). Plans and Issues remain intent;
progress is accepted evidence derived only from protected
`itotori.behavior-cell-report.v1` executions. Normally that is one report; the
failure-dominant envelope below is the only exception. Candidate CI cannot
publish a trusted conclusion ([`proof-system.md`](proof-system.md)).

No report or status snapshot is committed to any Git ref: not `main`, an orphan,
or a Pages source. No person writes cell state, counts, or transitions. Only the
designated verifier App, running protected CI, may publish accepted evidence.
Issues and web views are disposable projections, never inputs. Roadmap files
therefore record neither issue state nor progress fields ([roadmap README](README.md),
[`dependency-dag.md`](dependency-dag.md)).

## Durable publication choice

Use a verifier-App-bound GitHub Check Run named
`behavior-proof / accepted-report` as the current authoritative publication for
each accepted `main` commit. A Check Run is created for a specific commit, can
be queried by Git reference, and exposes structured output and paginated
annotations through the REST API ([Check Runs API](https://docs.github.com/en/rest/checks/runs#create-a-check-run),
[reference query](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)).
Consumers accept only the configured App ID, exact `head_sha`, completed status,
and `success` conclusion; a same-named result from any other actor is unrelated.
GitHub can bind a required check to its expected App
([protected-branch checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)).

The accepted-report Check Run says that the report is authentic and complete;
it may be `success` while roadmap cells remain red. The distinct
`behavior-proof / required` gate remains the merge decision, and the full-matrix
check remains visibly red until 687/687, exactly as
[`ci-initialization.md`](ci-initialization.md) specifies.

**UNVERIFIED permanence claim:** current GitHub documentation does not support
calling Check Runs permanent. Checks data is retained for 400 days, archived,
and permanently deleted 10 days later
([checks retention](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks#retention-of-checks-data)).
Before archival, the publisher refreshes the exact current evidence, revalidating
its manifest, chunks, App identity, and `main` binding. Refresh never edits cell
state; without a valid source, protected execution is required and absence is red.

GitHub also deletes older same-named runs after 1,000 runs in one Check Suite
([create-run limit](https://docs.github.com/en/rest/checks/runs#create-a-check-run)).
The App coalesces identical requests, permits one in-progress run per tuple, and
raises a maintenance failure at 800 retained runs. Before 900, a protected
maintenance change must create a new `main` SHA and fresh execution; at 900 the
App hard-stops publication. Retained count below 1,000 is an invariant, not a
cleanup suggestion, so deletion can never turn conflict into apparent
uniqueness. Only current `main` accepted evidence is refreshed; historical
evidence otherwise expires on GitHub's documented schedule.

Check output is mutable, so the protocol is append-only by policy: the App fills
a new run, completes it once, and never updates it. Readers reject conflicting
valid digests for one SHA. Only the protected verifier has the installation key;
candidate workflows cannot write, and acceptance is pinned to App ID
([Checks guide](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks),
[`proof-system.md`](proof-system.md)).

Trust is exact REST `app.id`, protected App provenance, and verified
report/chunk digests; no candidate-controlled signature exists.

### Complete-report encoding

The Check Run contains the report, not merely a link or digest:

1. Canonical UTF-8 `cell-report.json` is the RFC 8785 JSON Canonicalization
   Scheme serialization with no trailing newline
   ([JCS](https://www.rfc-editor.org/rfc/rfc8785)). Its report digest is
   lowercase hexadecimal SHA-256. Bytes are split at code-point boundaries into
   chunks of at most 45,000 bytes and encoded with standard, padded RFC 4648
   base64.
2. Each chunk annotation title is exactly `chunk-NNNN-of-TTTT`, with four-digit
   one-based sequence/total below 10,000; duplicates, gaps, out-of-range values,
   and inconsistent totals are red. `message` is lowercase SHA-256 of the raw
   chunk and `raw_details` its padded base64 text. A `notice` points at line 1 of
   [`ci-initialization.md`](ci-initialization.md); it is transport, not a finding.
3. `output.summary` carries the publication manifest: report schema,
   `head_sha`, candidate tree/build digests, plan/classification digests, exact
   byte length, report digest, ordered chunk digests, 687/96 record counts,
   predecessor identity, and App identity. The predecessor is the nearest
   earlier first-parent ancestor's accepted main SHA, evidence digest, and run
   ID. The initial 0/687 publication is genesis with no predecessor.
4. `output.text` carries only the generated human aggregates and the exact
   predecessor delta. Those values are recomputed from the reconstructed report.

Acceptance is serialized to order predecessors. A refresh preserves the original
logical publication ID, predecessor, and delta; it is not a new acceptance,
self-predecessor, or zero-delta transition.

GitHub documents 64 KB limits for annotation messages and details, a maximum of
50 annotations per update, append-on-update behavior, and a paginated annotation
read endpoint ([update a Check Run](https://docs.github.com/en/rest/checks/runs#update-a-check-run),
[list annotations](https://docs.github.com/en/rest/checks/runs#list-check-run-annotations)).
The publisher uses as many batches of at most 50 as required, then reads every
page back, sorts by the encoded sequence, reconstructs the bytes, and requires
byte-for-byte equality before completing the run.

**UNVERIFIED platform fit:** GitHub documents annotation strings, not arbitrary
file storage. Before enabling the required context, an integration test must
round-trip the maximum-size 687-cell/96-pair report through the live API,
measure its canonical byte count and annotation count, and prove exact digest
equality after paginated retrieval. It must also round-trip any self-contained
resolution envelope before that envelope can become accepted. Failure,
truncation, or an undocumented total limit leaves the evidence absent and the
gate red; it does not fall back to an artifact or authored summary.

For every literal pull-request branch head, GitHub-selected required-check
evaluation commit, lower stack revision, and merge-group SHA, the verifier
publishes the complete executed report with the same encoding in a Check Run
named `behavior-proof / candidate-report`. A candidate-report run is evidence
for comparison, not accepted `main` state. Gate readers require the same exact
verifier App ID, `head_sha`, completed `success`, manifest, chunk round-trip,
and single nonconflicting report digest as accepted-report readers. This gives
`HP`, `HE`, and every unmerged `L` an API-queryable full report; missing or
conflicting candidate runs are red.

### Alternatives evaluated

| Medium           | Retention and query                                                                                                                                                                                                                                                                                                                                                                                                                                        | Writer boundary                                                                                                                                                                                                                | Decision                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Check Run output | 400 days, then archive and deletion 10 days later; REST by SHA plus annotations ([retention](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks#retention-of-checks-data), [API](https://docs.github.com/en/rest/checks/runs))                                                                                                                                                                                              | Accept only the designated verifier App ID; refresh is protected CI                                                                                                                                                            | **Choose**, with measured chunk round-trip and refresh                                                  |
| Actions artifact | Default 90 days; configurable and explicitly expiring; REST lists/downloads artifacts ([retention settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-repository), [artifact API](https://docs.github.com/en/rest/actions/artifacts)) | Workflow upload and actors with Actions write can create/delete; deleting a workflow run deletes its artifacts ([artifact removal](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts)) | Reject as authority; retain only transient lane evidence                                                |
| Orphan CI branch | Git history is API-queryable but refs are mutable and deletable ([Git refs API](https://docs.github.com/en/rest/git/refs))                                                                                                                                                                                                                                                                                                                                 | A ruleset can restrict writes to an App ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets))                                | Reject: it is still a committed status file                                                             |
| Deployment       | Binds a ref/SHA and is REST-queryable; previous statuses expire after 90 days while the current status remains ([deployments](https://docs.github.com/en/rest/deployments/deployments), [status retention](https://docs.github.com/en/rest/deployments/statuses#data-retention))                                                                                                                                                                           | Tokens with Deployments write can publish                                                                                                                                                                                      | Reject: models an environment release, and payload capacity/object retention are **UNVERIFIED**         |
| Pages            | REST exposes site/build/deployment metadata, not retained historical content ([Pages API](https://docs.github.com/en/rest/pages/pages))                                                                                                                                                                                                                                                                                                                    | A custom Actions deployment has Pages write ([custom workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages))                                                   | Reject as authority; use only as generated presentation. Historical content retention is **UNVERIFIED** |

## Exact pull-request transition gate

The verifier evaluates immutable sets of passing cell identities. It never
reads a status assertion from the pull request, issue state, Pages, an artifact,
or planning prose. It preserves every invariant already fixed under
[`ci-initialization.md`](ci-initialization.md#lanes-cadence-and-gates).

For each evaluation it resolves one immutable tuple `T` containing:

- repository and pull-request identity; the literal branch-head SHA/tree `P`;
  and GitHub's required-check evaluation SHA/tree `E`, which is the test-merge
  commit when GitHub attaches checks there and otherwise `P`. Both are bound
  because GitHub may require the test-merge result
  ([required-check target](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#conflicts-between-head-commit-and-test-merge-commit));
- base ref: exactly `main` for a normal/bottom pull request, or the exact
  immediate-lower branch for a higher stack layer;
- native stack identity, position, and an ordered-membership digest over every
  pull-request number, base ref, and head SHA in the stack, plus the exact valid
  tuple/gate digest of every strictly lower layer;
- `A`, the sole Git merge base of `P` and `M` for a normal/bottom pull request,
  or the immediate-lower pull request/ref/literal SHA/tree for a higher layer.
  In the first mode, multiple merge bases are red and `A` is an ancestor of `P`
  and `M`; in the second, `A` is an ancestor of `P`. The current base tip must
  be an ancestor of `E`;
- `M`, GitHub's current `main` SHA, and `B`, the unique valid accepted evidence
  bound to `M`;
- `HP`, the report for `P`; `HE`, the report for `E`; and `L = report(A)`;
- `K`, the protected classifier result/rule digest over the literal diff
  `A..P`; unknown paths and errors default to governed; and
- `C`, the sorted managed issue references, their protected `Cells`
  arrays/body digests, and the full protected ownership index plus roadmap
  contract/native graph digest. Ownership comes from protected `main`, never
  candidate prose
  ([issue contract](proof-system.md#semantic-github-issue-contract)).

`T`'s digest binds the conclusion to topology, claims, evidence, and SHA.

It computes, without author input:

```text
mainRegression = pass(B) - pass(HE)
layerGreen = pass(HP) - pass(L)
layerRegression = pass(L) - pass(HP)
integrationRegression = (pass(B) union pass(L)) - pass(HE)
claimGreen = layerGreen intersection (all cells - pass(B))
globalOwners(cell) = managed specs in the protected contract whose Cells array contains cell
```

`behavior-proof / required` returns `success` only when all of these are true:

1. `L`, `HP`, and `HE`, plus a primitive `B`, reconstruct exactly with all 687
   applicable and 96 non-applicable records. If `B` is a resolution envelope,
   every primitive input reconstructs and agrees on target/contract bindings,
   and `pass(B)` is its verified intersection. Each report's schema, runner,
   plan, classification, SHA/tree/build, lane fragments, receipts, and digest
   verify against its own target and manifest; receipt/cone equivalence is
   required where the plan selects it.
2. Immediately before conclusion the verifier resolves `T` again and requires
   byte-identical equality, including `M`, head/lower ancestry, stack order,
   issue claims, body/graph digests, and every SHA/tree. Any movement forces a
   new evaluation rather than blessing an old comparison.
3. `mainRegression`, `layerRegression`, and `integrationRegression` are empty,
   and every `claimGreen` cell remains pass in `HE`. If `K` is governed, `C`
   and `claimGreen` are nonempty. If `K` is non-governed, `C` and `claimGreen`
   are empty. Non-governed requires an exhaustive protected allowlist proved
   unable to affect production, tests, reports, CI, or roadmap contracts;
   everything else fails into governed.
4. Every issue in `C` owns at least one cell in `claimGreen`. Thus a pull request
   that references a spec but makes none of its owned accepted-main-red to
   layer-green transitions fails mechanically.
5. Every cell in `claimGreen` has exactly one `globalOwners` result, and that
   sole global owner is in `C`; unlinked and duplicate-owned transitions fail.
6. Every `claimGreen` cell's protected mutation turns it red; selected,
   executed, asserted, and reported cases, lanes, and profiles agree exactly.
7. The issues in `C` are managed semantic specs, logically incomplete in `B`,
   and their native dependency cone matches the signed plan. Logical
   incompleteness and ownership come only from the report and protected
   contract, never live open/closed projection state. Every transitive blocker
   is report-complete before `HP`: all its cells pass in `B`, or, for a stack,
   pass in `L` and every `B`-red blocker cell belongs to `claimGreen` from
   exactly one strictly lower valid tuple. The same rule applies recursively;
   a normal or bottom pull request must satisfy every blocker in `B`; its `L`
   bound to `A` is used only to isolate the literal branch delta
   ([`dependency-dag.md`](dependency-dag.md)).

The App writes candidate reports on both `P` and `E` when distinct and ensures
the exact `L` report exists; it writes `behavior-proof / required` on `E`, the
commit GitHub actually requires. Activation requires a live native-stack test
proving this target selection for both head-check and test-merge-check cases.

Pull-request edits, base/head changes, stack membership or lower-branch changes,
`main` pushes, issue-reference/body changes, and roadmap graph changes invalidate
`T`. The App listens to their GitHub events and creates a new required Check Run
when metadata changes. **UNVERIFIED same-SHA admission:** GitHub documentation
does not prove that a later same-name failure supersedes an earlier success from
the same App and SHA for queue admission. Activation requires a live test that
first admits the success, mutates metadata without changing the SHA, observes
the later failure deny admission, and then observes a newly valid success
restore it. If that test fails, metadata changes require a new head SHA before
admission. Merge-group evaluation independently rereads `T`, so the final merge
still fails closed on a missed or delayed event.

A governed PR body has exactly one canonical `Behavior-Specs: #N, #N` line:
managed decimal numbers are ascending and unique. The parser accepts no other
claim form; missing, duplicate, malformed, or GitHub closing-keyword references
to managed issues are red. Non-governed bodies omit the line. Free-form progress
is ignored. This refines base/head and ownership without weakening
[`ci-initialization.md`](ci-initialization.md#cell-report-contract).

### Missing or stale inputs

A baseline is missing when no completed accepted-report run or valid resolution
from the designated App exists on `M`. It is stale or corrupt when a binding,
count, provenance, manifest field, chunk, digest, or predecessor disagrees; when
unresolved primitive copies conflict; or when its `head_sha` is not `M`. The
same rules apply to `L`, `HP`, and `HE`. The App emits content-free `failure`,
Pages shows unavailable, issues do not advance, and merge remains blocked.
It never selects an older commit, issue state, cached page, artifact, or catalog
declaration as a substitute ([first honest numerator](ci-initialization.md#first-honest-numerator)).

An accepted-`main` disagreement has one conservative recovery. A protected
resolver publishes a distinct `behavior-proof / accepted-resolution` payload
with schema `itotori.accepted-report-resolution.v1`; it is an envelope, not an
executed cell-report. Under a per-repository/SHA publication lock, it
exhaustively snapshots every primitive, non-refresh accepted-report run and
binds their sorted IDs/digests as `frontierDigest`; resolution envelopes are
excluded. Every input must reconstruct as a valid v1 report for the same target
and contract. The envelope embeds their canonical bytes/manifests, policy
digest, and effective pass-set intersection; it fabricates no execution record.
It uses the same canonical chunking/refresh rules and carries its own evidence
digest, logical predecessor identity, and effective predecessor delta.

After publishing, the App re-enumerates under the lock and requires the same
frontier, then seals that SHA: it refuses every later primitive, including rerun
requests; correction requires a new `main` SHA. Refresh keeps the embedded
frontier. Readers use its set for `pass(B)`, allow live primitives only when
embedded, and reject extras. If deletion may predate the initial lock,
completeness/round-trip is unproved, or envelopes conflict, the baseline stays
red. This avoids favorable-rerun selection and remains valid after normal input
expiry without asserting unexecuted evidence.

## Three query paths

The implementation provides one argv-only reader. It calls the reference
endpoint separately for the exact accepted-report and accepted-resolution
`check_name` values, with exact `app_id`, `status=completed`, `filter=all`, and
`per_page=100`; follows every page and every returned `annotations_url`; and
inspects all matching runs before deciding uniqueness. If one ref has more than
1,000 check suites, it uses the documented list-suites then list-runs-per-suite
fallback. It reconstructs the accepted evidence, validates the manifest and App
provenance, and exits nonzero on absence, staleness, unresolved conflict, or truncation
([Check Runs API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)).

| Consumer            | One path                                                                | Result                                                                                            |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CI/verifier         | `node scripts/ci/read-accepted-report.mjs --ref=FULL_SHA --format=json` | Canonical report/envelope bytes or nonzero; CI passes the already resolved SHA as argv            |
| Agent choosing work | `node scripts/ci/read-accepted-report.mjs --ref=main --format=work`     | Bound SHA, report-derived ready cells/blockers from the protected graph, and measured transitions |
| Person              | `https://cat-cave.github.io/itotori/progress/`                          | Generated current-main dashboard, or an unavailable/stale error instead of cached progress        |

These are required implementation paths; they do not assert that the reader or
Pages deployment exists before its owning roadmap cell passes.

The work view never consults live issue open/closed state; “ready” and blockers
are computed from accepted evidence plus the byte-verified protected graph.

No path introduces an environment variable. The reader and Pages generator are
consumers, so neither has Checks write or Issues write. The existing plan
already requires private paths, tool paths, and output paths to arrive through
signed files or argv ([immutable selection](ci-initialization.md#immutable-case-selection)).

## Generated human view

Protected CI deploys either a valid dashboard artifact or an error-only artifact
on every `main`/accepted-evidence event. A valid artifact embeds the canonical
evidence and renders:

- `passingCellCount / 687`, `failingCellCount`, and the existing floored
  two-decimal percentage;
- one pass/total row for every canonical engine subject plus a `shared` row for
  invariant cells;
- one pass/total row for every behavior;
- newly passing, regressed, and unchanged cell identities versus the evidence
  manifest's predecessor; and
- bound `main` SHA, evidence digest, Check Run link, and an explicit stale/error
  state when live `main` no longer matches.

All arithmetic and groups are generated from accepted evidence and the fields fixed in
[`ci-initialization.md`](ci-initialization.md#cell-report-contract). The page
contains no editable data source and is never queried by a gate. Before exposing
any cached metric, its browser code independently fetches the live `main` SHA
and exhaustive App-bound accepted evidence, applies the same digest/frontier
validation, and requires exact equality with the embedded SHA/evidence digest.
It starts in an error state, repeats the check while visible, and on mismatch,
absence, fetch/rate-limit failure, disabled script, or validation error replaces
all metrics with “unavailable/stale.” Thus an old deployment cannot display
cached progress during a verifier or deployment outage. GitHub supports
deploying Pages from a custom Actions artifact
([custom Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages));
the accepted evidence remains authority if Pages is absent.

## Issue reconciliation

The managed semantic issues beginning with `#800` carry the plan and the 381
transitively reduced native blocked-by/blocking relationships; they do not carry
progress. The measured graph and its prohibition on copied dependency/status
state are fixed in [`dependency-dag.md`](dependency-dag.md), while GitHub exposes
native dependencies in the UI, CLI, and API
([issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)).

After the verifier App accepts evidence bound to the still-current `main` SHA, a
separate protected issue-reconciler App first byte-compares every managed body,
`Cells` array, subissue edge, and native dependency edge with the protected
contract. Any mismatch or unreadable page aborts all writes. From one immutable
`{main SHA, evidence digest, body/graph digest}` snapshot it computes every
desired issue state. It idempotently closes a semantic issue with reason
`completed` if and only if every owned cell passes and every protected
blocked-by issue satisfies the same report-derived predicate. A bundle closes
if and only if all protected semantic subissues satisfy it.

The reconciler applies the complete desired-state set, then rereads `main`, the
accepted evidence, and every protected/live graph binding; movement schedules a
full rerun. A regression or false manual close is reopened, and a true manual
reopen is re-closed. An unavailable Issues API leaves visible projection drift
but cannot alter report or gate authority. Only the issue-reconciler identity
receives this Issues-write path; it cannot write Checks. The verifier retains
read-only issue access plus Checks write, and candidate CI remains read-only
([update issue API](https://docs.github.com/en/rest/issues/issues#update-an-issue),
[`proof-system.md`](proof-system.md#semantic-github-issue-contract)).

Pull requests use non-closing references because GitHub's closing keywords act
only when a pull request merges into the default branch, which is inconsistent
for higher stack layers
([linking pull requests to issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)).
A manual or automatic state change is non-authoritative drift. Issue state
always follows report state and never leads it.

## Failure and disagreement

The accepted evidence reconstructed from the designated App is authoritative.
If none exists, there is no progress state; no weaker source wins.

| Condition                                                   | Authoritative result                                       | Merge effect                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Accepted evidence absent, expired, corrupt, or stale        | No usable baseline                                         | Required App check is missing or `failure`; block                                                                        |
| Conflicting accepted `main` reports                         | No baseline until the failure-dominant resolver covers all | Block; disputed cells are absent from the envelope's effective pass set                                                  |
| Verifier unavailable                                        | No accepted conclusion; Actions cannot impersonate the App | Required context remains non-success; block                                                                              |
| Candidate report missing, stale, or changed by a rebase     | No usable head/layer report                                | `failure`; rerun protected execution                                                                                     |
| Candidate makes a base-green cell red                       | Executed head report is red                                | `failure`; block                                                                                                         |
| New accepted `main` evidence flips a cell back to red       | New evidence wins; issue and dashboard projections regress | Reopen derived issues, keep release red, and fail governed PR gates until later accepted evidence removes the regression |
| Candidate binding has conflicting states, including a flake | Failure dominates; the candidate SHA is quarantined        | `failure`; repeated green on the same SHA cannot erase red                                                               |
| Infrastructure ends before a verified report exists         | Absence, not a test result                                 | `failure` or missing context; block                                                                                      |

The App emits only `success` or `failure` for the required gate and consumers
accept only exact `success`; `neutral` and `skipped` never encode absence or
partial work. A test flake is a failed executed observation. Correction requires
a new candidate head SHA; a same-SHA retry is allowed only when no complete
executed candidate report existed. This preserves the repository's rule that
missing, skipped, pending, fixed-empty, and mismatched execution is red
([proof invariants](README.md#proof-and-dependency-invariants)).

## Mapping the dependency graph to native stacked pull requests

GitHub defines a native stack as two or more pull requests in one repository:
the bottom targets the trunk, each higher pull request targets the branch below,
and each layer shows its own diff. The feature is currently public preview
([about stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)).
The official quickstart shows that stack submission creates those base
relationships and links the pull requests
([stacked pull requests quickstart](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart)).

The 381-edge issue graph is a dependency DAG, not one stack. A set of dependent
specs becomes a stack only when all of these hold:

1. The selected issues form one simple directed path in the native graph, in
   dependency order, with no omitted blocker required by a higher layer.
2. A later implementation consumes an unmerged lower implementation, so waiting
   for sequential merges would idle useful dependent work.
3. Every branch is a discrete review unit and independently satisfies the exact
   layer gate above, including at least one owned cell transition.
4. Every branch is in this repository, as native stacks do not support
   cross-fork branches
   ([stack location limits](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs#where-can-you-use-stacked-pull-requests)).

Keep separate stacks, or use sequential pull requests, for parallel siblings,
unrelated issues, a join with several unresolved prerequisites, or branches
whose dependency is not the immediately lower layer. Use one pull request when
the proposed layers cannot each flip an owned cell. Stacks are also wrong for a
committed-status change, a cross-fork contribution, or preparatory work that is
green only at the tip. Issues retain the general DAG; a stack records only one
temporary linear delivery path ([root and graph constraints](dependency-dag.md#root-and-graph-constraints)).

### Checks and merge queue

GitHub applies the bottom pull request's base-branch protections to every stack
layer and runs default-branch pull-request workflows for every layer, not only
the bottom one
([stack rules and CI](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs#rules-ci-and-merging)).
Accordingly, each pull request gets its own candidate reports and required App
conclusion. `B` always comes from current `main`; `L` isolates a higher layer
from the exact lower branch and a normal/bottom change from its exact fork point
`A`. A green tip can never substitute for a red or absent middle layer.

The repository continues to land through its required native merge queue
([CI lane authority](../dev/ci-lanes.md)). GitHub queues stack pull requests in
bottom-up order; ejecting one also removes every pull request above it, and a
stack too large for the queue's documented buffer can be split across
consecutive merge groups
([merging stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests#merging-using-a-merge-queue)).

Before enqueue, every layer must have its own valid tuple and gate. For a merge
group the verifier binds `Bq` to accepted evidence for the event's exact base
SHA, `G` to the candidate report for its exact generated head SHA, and
`T1..Tn` to every included pull request in queue order, including unrelated and
non-governed entries. It requires pairwise-disjoint `claimGreen` sets (empty for
non-governed entries), `B(Ti) = Bq` for every tuple, and:

```text
pass(Bq) - pass(G) = empty
pass(G) - pass(Bq) = union(claimGreen(T1)..claimGreen(Tn))
```

Immediately before conclusion it re-resolves `Bq`, `G`, and all tuples. It also
requires unchanged ordered topology/claims/graph digests, exact generated
tree/build bindings, every claimed transition still green, no unowned extra
green, and equivalence of every selected pre-issued receipt and dependency
cone. The group reruns public lanes but starts no private or human work,
preserving
[`ci-initialization.md`](ci-initialization.md#lanes-cadence-and-gates). If the
target, topology, claims, split, tree, or tuple changes, all affected comparisons
are regenerated.

The verifier receives read-only Merge queues permission and the
`merge_group` webhook ([webhook contract](https://docs.github.com/en/webhooks/webhook-events-and-payloads#merge_group)).
**UNVERIFIED queue exactness:** current public documentation does not expose a
complete ordered-membership lookup or prove split-group base sequencing.
Activation requires a live fixture that reconstructs exact membership/order
from queue state and proves each event's base/head bindings. Queue build
concurrency is one; `Bq` must already be accepted, and no speculative
candidate-report baseline is allowed. Each split must land and publish new
accepted evidence before the next can pass. If the fixture cannot prove that
behavior, oversize stacks are submitted as separately queued segments only
after the prior segment lands.

After landing, the new accepted-main execution must prove landed/squashed
tree/build and receipt equivalence to `G` before issue reconciliation. Newly
based branches then compare against that accepted `main`; old conclusions
cannot carry forward.

### Mid-stack rework

Dequeue the whole stack before any edit, rebase, or restructure. Change the
branch that owns the work, then run `gh stack rebase --upstack` to update that
layer and every descendant
([stack rebasing](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs#rebasing)).
The edited layer and every rebased descendant receive new SHA/base bindings, so
their candidate reports, layer comparisons, checks, and affected-cone receipts
are stale. Rerun them bottom-up; an unchanged lower layer may retain its exact
binding. GitHub's server-side cascading rebase instead rewrites every unmerged
branch in the stack, so it invalidates every layer binding. Re-enter bottom-up
only after each gate passes. No issue is closed until accepted `main` evidence
reports the merged transitions.
