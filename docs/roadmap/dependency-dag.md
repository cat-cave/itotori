# Native issue dependency DAG

The 26 bundle definitions expand into the exact 241 semantic issue specs in
[`spec-instances.jsonl`](spec-instances.jsonl). Its `dependsOn` arrays are the
reviewed, transitively reduced blocked-by relationships. GitHub Issues hold
those native relationships; Markdown and labels do not duplicate their state.

## Expansion rules

1. A shared bundle creates one semantic spec and owns only invariant `::all`
   cells.
2. A scoped bundle creates one spec for each engine row selected by its scope.
   Its name is `<bundle>/<sourceCapability>`.
3. A dependency on a shared bundle resolves to that one shared spec.
4. A dependency between bundles with the same scope resolves to the same
   engine's instance.
5. `afterFirstProduction` resolves to the named bundle for the first production
   family fixed by the action plan. A self-edge is omitted.
6. Every expanded spec owns the exact cell names listed in its instance. A
   missing, duplicate, or extra owner fails the roadmap audit.

No dependency is inferred from issue creation order. The committed instance
file is regenerated in memory by the validator and must match the bundle rules
exactly.

## Shared foundation

The shared path begins:

```text
proof ledger and explicit failures
  → public formats and artifact lineage
  → deployment and clean host
  → identity and access
  → privacy and commit authority
  → catalog refresh and selection
```

Catalog then has two branches:

```text
catalog
  ├─→ locale branch and policy
  │     → source and locale knowledge
  │     → run policy, accounting, and entrypoints
  │     → durable control and state
  └─→ compatibility and Studio discovery
```

Every production intake spec is blocked by both source/locale knowledge and
compatibility/Studio disclosure. The branches are independent prerequisites,
so neither link is transitively redundant.

## Family chains

Registered or bounded production families use:

```text
profile intake and safety
  → extraction and population
  → localization, patch, and reproduction
  → runtime admission
  → played export, journey, and qualification
```

The localization/patch spec also depends directly on durable control/state.
That shared branch is not reachable through the family codec chain.

Unqualified production families use:

```text
profile intake and safety
  → extraction and population
  → localization, patch, and reproduction
  → launch and control
  → routes, observation, and capture
  → played export, journey, and qualification
```

The same durable-control join occurs at localization/patch. Each non-production
row has one bounded-role conformance spec blocked by shared compatibility
disclosure; it has no invented product chain.

## First-production gates

Family implementations may proceed concurrently, but the action plan fixes the
first complete production vertical:

- shared safe-proof publication is blocked by that family's runtime-admission
  spec;
- each new-family routes/observation spec is also blocked by the same first
  runtime observation, so it consumes the shared envelope rather than creating
  another;
- every other production final journey/qualification spec is blocked by the
  first family's final journey/qualification spec; and
- shared whole-round refinement/comparison is blocked by both safe-proof
  publication and that first played-export journey.

Evaluation and confidence follows whole-round review. Other families can build
decode, patch, and runtime work in parallel; only final product admission waits
for the first complete vertical.

## Root and graph constraints

`proof-ledger-and-explicit-failures` is the sole root. It carries the executable
runner, honest 687-cell manifest, source-identity reconciliation, collection
scan, explicit-failure driver, portable evidence references, and protected
fixed-success mutations. It is a real behavior bundle, not a
completion-free infrastructure issue.

The validator requires:

- one root and full reachability from it;
- no cycle or redundant transitive edge;
- every dependency target to exist;
- at most 50 blocking and 50 blocked-by relationships for any native issue;
  and
- exact equality between generated and committed instances.

The largest fan-out is the shared compatibility/Studio spec: it directly
unlocks 39 production intake specs and 8 non-production conformance specs, for
47 blocking relationships. The first complete production journey directly
blocks the other 38 production final specs plus whole-round review, for 39.
Both remain within GitHub's native relationship limit.

## Native relationship initialization

The renderer in [`proof-system.md`](proof-system.md) treats the committed
reduced graph as desired state. Its measured initialization has 241 semantic
specs and 381 direct relationships, with one root, full reachability, maximum
outgoing degree 47, and maximum incoming degree 2.

For each missing direct edge it invokes GitHub GraphQL `addBlockedBy`; for each
extra direct edge it invokes `removeBlockedBy`. It verifies the native Issue
fields `blockedBy`, `blocking`, and `issueDependenciesSummary` after mutation.
It independently lists each issue's
`/issues/{issue_number}/dependencies/blocked_by` REST endpoint and requires the
same direct set.
The 26 bundle issues own the semantic specs through native subissues, verified
through `parent`, `subIssues`, and `subIssuesSummary`. No dependency is copied
into Markdown, labels, milestones, Projects fields, or a local status file.

## Merge-group semantics

Public pull-request CI may prove redistributable cells. A production cell turns
green only after the reviewed candidate tree receives protected pre-queue
evidence and any required human receipt. The merge group verifies those
receipts against its final tree, build, and dependency cone without starting
private or human work.

Missing, stale, zero-byte, selected/executed-mismatched, duplicated, or
dependency-affected evidence is red. Preparatory changes may share a pull
request with their owning spec, but no standalone work is complete unless at
least one exact instance cell changes red to green.
