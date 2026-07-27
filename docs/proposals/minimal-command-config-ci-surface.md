# Minimal command, configuration, and CI surface

## Decision

Replace name-encoded configuration and hand-wired execution topology with one
declarative catalog and one planner. The catalog is the authority for engines,
corpora, proof requirements, checks, and lanes. A local inventory supplies
private machine facts. The planner is the only component that turns those two
inputs into commands. `just`, CI, capability reporting, and strict-proof
selection invoke that planner; none owns an independent list of engines,
corpora, or tests.

The target is deliberately opinionated:

- no project-prefixed environment variables;
- no corpus path, ordinal, variant, or engine identity encoded in an environment
  variable name;
- no engine family branch in a recipe, workflow, capability generator, or
  application dispatcher;
- no strict run that can succeed with an empty plan, a missing required input,
  an unexecuted selected proof, or an unavailable runner.

This is a replacement design. It is not a compatibility layer for the current
variables, recipe names, or bespoke selectors.

## The disease

The disease is **distributed, name-encoded control-plane state**. Information
that should be data (a corpus identity, a variant, a capability, an execution
owner, and a lane membership) is encoded in variable names and repeated in
several imperative owners. The resulting system has no single object that can
answer: "what inputs are required for this proof, who runs it, and what did it
actually execute?"

There are four related faults, not one.

1. **Addressing is transport syntax.** The current tracked tree has 147
   distinct project-prefixed environment names; 49 match the supplied
   locator-shaped rule (`ROOT|DIR|DIRS|PATH|CORPUS|RESEARCH`). An engine,
   ordinal, and variant become part of a variable name rather than fields of a
   corpus record. A new variant therefore requires a new public spelling,
   code to read it, documentation, and a test invocation.

2. **Topology is duplicated.** The strict recipe selects packages and inputs
   itself (`justfile:279` onward); the application registry has separate
   adapter branches (`extract-adapter-registry.ts:516,626,690,772`); the
   capability generator names exact locator pairs
   (`generate-engine-capability-matrix.mjs:495,817`). These are independent
   partial registries, so adding a supported engine is an edit sweep rather
   than a declaration.

3. **The execution contract is inferred, not declared.** The strictness
   guard recognises only a fixed locator-name pattern
   (`audit-strictness.mjs:280` onward). A real-corpus test outside that
   vocabulary is invisible to the guard, and an absent input can be translated
   into a successful no-op. The guard can prove only what its heuristic knows
   how to spell, not what the product claims.

4. **Configuration scopes are conflated.** Installed-user preferences,
   secret references, developer scratch paths, runner inventory, generated
   test controls, and CI artifacts all use the same global process namespace.
   A recipe has consequently become a configuration loader, scheduler,
   package selector, and test runner. That is why it is 997 lines and why its
   additions are rarely local.

The evidence is not merely count growth. A missing corpus setting produced a
zero-proof success; a real oracle was outside the guard's spelling; and the
strict workflow's target label had 18 attempts with 17 cancellations, one
queued run, and no successful run. In the latest cancelled attempt both
strict jobs had zero steps. These are all missing-control-plane failures:
the system did not have a checked plan and receipt that bound a declared
requirement to an executed action.

## Target objects and ownership

The catalog is committed, reviewable data under `catalog/`. The inventory is
private host data under the operating-system configuration directory; it is
never committed. A user-facing profile contains non-secret choices and secret
_references_, never secret values. The default locations are:

```text
catalog/
  engines/<engine-id>/engine.toml
  lanes/<lane-id>.toml
  checks/<check-id>.toml
  schema/

<config-dir>/
  profile.toml
  inventory.toml                 # developer or runner, private
  secrets.toml                   # references only, private
```

`<config-dir>` follows the platform configuration convention. Every command
also accepts `--config-dir <path>`; that is the only location override. It is
an argument, not an environment variable.

### Committed engine descriptor

An engine descriptor is the registration unit. It is the sole committed
place that declares an engine's public identity, plugin artifact, capability
claims, supported input forms, public checks, and strict proofs. It contains
no absolute paths, credentials, corpus bytes, or title-specific identifiers.

Illustrative shape:

```toml
schema = "engine/v1"
id = "example-engine"
plugin = "libexec/engines/example-engine/engine-runner"

[capabilities]
extract = "supported"
patch = "partial"
runtime = "not-claimed"

[[proof]]
id = "extract-patch-two-inputs"
lane = "strict"
requires = { corpus_count = 2, tags = ["extract", "patch"] }
executor = { kind = "engine-plugin", command = "prove", selector = "extract-patch" }
receipt = { outcome = "byte-preserving-patch", minimum_executed = 1 }

[[check]]
id = "synthetic-contract"
lane = "public"
executor = { kind = "engine-plugin", command = "test", selector = "synthetic" }
```

The descriptor can say that a capability is not claimed. It cannot omit a
claimed capability's coverage state: schema validation requires either one or
more check/proof entries or an explicit `not-claimed` state. This distinguishes
unsupported work from forgotten work.

### Private inventory and user profile

`inventory.toml` maps opaque corpus ids to local facts. It is the only object
that contains private roots. Its entries are records, not variable names:

```toml
schema = "inventory/v1"

[[corpus]]
id = "corpus-a"
engine = "example-engine"
variant = "base"
root = "/private/read-only/corpus-a"
content_address = "sha256:<redacted>"
tags = ["extract", "patch"]
access = "read-only"

[[corpus]]
id = "corpus-b"
engine = "example-engine"
variant = "revision-b"
root = "/private/read-only/corpus-b"
content_address = "sha256:<redacted>"
tags = ["extract", "patch"]
access = "read-only"
```

The profile selects a target, locale, output policy, and named secret
reference. A secret reference may point to the platform secret store or to a
provider's standard credential environment name; it never introduces a
project-specific environment spelling. Installation locates bundled plugins
relative to the installed executable, so binary and browser locations are
profile fields or doctor-discovered facts, not global overrides.

### Lanes and checks

A lane is declarative selection plus policy, not a shell script:

```toml
schema = "lane/v1"
id = "strict"
class = "periodic"
selector = "proof.lane == 'strict'"
requirements = ["private-inventory", "read-only-inputs", "renderer"]
empty_plan = "fail"
missing_requirement = "fail"
unexecuted_selection = "fail"
receipt = "required"
```

`itotori-ci plan --lane strict` joins lane selector, engine descriptors, and
inventory. It writes a content-free plan containing expected proof ids,
corpus ids, executor identity, and requirement checks. `itotori-ci run` can
execute only that plan and writes a receipt with planned, selected, started,
executed, passed, failed, skipped, and unavailable counts. The runner rejects
`skipped > 0` for a strict lane; an optional corpus is modeled as a separate
lane whose requirements explicitly include it, never as a conditional branch
inside a passing strict lane.

This is how a check discovers its coverage: it is selected from the catalog
and its descriptor provides the executor contract. There is no source-code
regular expression that guesses coverage from a variable name.

## Commands people type

An installed user uses the product command, not `just`:

```sh
itotori setup
itotori doctor --profile local
itotori extract --corpus corpus-a
itotori verify --lane public
itotori verify --lane strict --config-dir /etc/itotori
```

`extract --corpus` resolves the record from inventory, validates that its
engine plugin is installed, and passes the resolved root only across the local
process boundary. A one-off source is explicit (`--source <path>`); it does
not create a durable alternative setting.

Developers retain six convenience recipes, each a one-line delegation with
parameters rather than a growing family of aliases:

```text
just worktree-setup
just dev [service]
just doctor [profile]
just check [scope]
just test [selector]
just ci [lane]
```

`scope`, `selector`, and `lane` are validated catalog ids. Database lifecycle,
package build, browser verification, formatting, shards, and affected-work
selection are subcommands of the planner, for example `just check static` or
`just ci public`; they are not new recipes. The installed package supplies
`setup` and `doctor`; a package installation does not require a repository
recipe.

## CI and runner strategy

There are three stable workflows:

| Workflow class | Trigger and runner                                            | Command                           |
| -------------- | ------------------------------------------------------------- | --------------------------------- |
| public         | pull request, merge queue, and push on hosted runners         | `itotori-ci run --class public`   |
| periodic       | schedule and manual dispatch on the corpus runner             | `itotori-ci run --class periodic` |
| private        | manual dispatch or approved opt-in event on the corpus runner | `itotori-ci run --class private`  |

Workflow YAML contains checkout, setup, the runner class, and that one command.
It contains no engine ids, corpus roots, package lists, shard lists, or
project-specific environment block. A new lane is one lane descriptor with a
`class`; the generic workflow selects it. A new check is one engine or check
descriptor entry.

The periodic runner is configured with a root-owned config directory and a
read-only corpus mount. Runner registration is a prerequisite, not an excuse
to weaken the lane. When it is available, the periodic workflow runs the
planner and requires a non-empty receipt.

When it is not available, a separate hosted watchdog polls the workflow jobs
and runner availability. After a short, documented service-level threshold,
it cancels the stranded periodic run, creates a failed `strict availability`
check, and pages the runner owner. It also fails if a periodic job reaches a
terminal state with zero steps or without a receipt. The watchdog uses a
least-privilege automation credential that can read jobs and write that check;
its failure is itself alertable. Thus an absent label produces a visible red
availability failure, not a green skip, an indefinitely ambiguous queue, or a
cancelled run that looks like test evidence. A daily hosted probe exercises
the watchdog path even when no periodic proof is due.

The periodic lane has no "best effort" sub-lane. If the installed inventory
does not satisfy a descriptor's required count and tags, planning fails before
any proof starts and reports the unsatisfied descriptor ids. A site with a
different corpus set declares a distinct lane profile; a green receipt always
states exactly which declared requirements it satisfied.

## Engine and crate shape

The current static application union and central adapter table do not scale to
twenty-plus engines. The target splits a small stable contract from isolated
engine packages:

```text
crates/engine-contract/          # request, capability, proof, receipt schemas
crates/engine-<engine-id>/       # one implementation package per engine
  engine.toml                    # the descriptor above
  src/
  tests/
```

Each engine package builds an installed plugin executable implementing the
contract's `capabilities`, `extract`, `patch`, `test`, and `prove` operations.
The main application loads descriptors, validates them, and invokes a plugin
by installed-relative path. It does not maintain a discriminated union or a
switch over engine identities. Workspace membership uses the engine-package
directory pattern, and packaging discovers validated descriptors, so adding a
package does not require editing a central workspace list or install list.

The unavoidable cost of engine twenty-one is its implementation package and
its one descriptor. It must provide synthetic coverage before it can claim a
public capability, and a strict proof declaration plus matching inventory
before it can claim real-input support. It requires no recipe, workflow,
environment-variable family, central registry, capability-generator branch, or
test-runner edit. Adding a title or variant is one inventory record; adding a
check is one descriptor record; adding a lane is one lane record.

This is a process boundary and therefore trades some compile-time cross-engine
typing for a versioned machine contract. The contract schema, plugin
contract tests, and catalog compiler are the compensation; see the objections
below.

## Quantified surface reduction

The baseline is the stated measurement on the tracked main tree. A current
worktree text scan has one extra match only because the untracked brief repeats
one setting name; it is not a product-source change and is excluded here.

| Plane                              |                                Baseline | Target | Mapping                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------: | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project-prefixed environment names |                                     147 |      0 | 49 locator-shaped names become inventory records; the other 98 become profile fields, secret references, planner arguments, generated test fixtures, or internal process data. |
| Locator-shaped environment names   |                                      49 |      0 | `engine × ordinal × variant` names become `[[corpus]]` records with `id`, `engine`, `variant`, `root`, tags, and content address.                                              |
| `just` recipes                     |                                      75 |      6 | All existing aliases and lane-specific recipes collapse into the six parameterized delegates above.                                                                            |
| CI workflow families               |                                       5 |      3 | Reusable tier fragments and bespoke strict/private dispatch collapse into public, periodic, and private generic workflows.                                                     |
| CI command forms                   |                       many recipe names |      3 | One `itotori-ci run --class ...` invocation per workflow class.                                                                                                                |
| Engine registration authorities    |                              at least 3 |      1 | Descriptor is authoritative; registry, capability matrix input, and plan are generated/validated projections.                                                                  |
| Corpus addressing authorities      | multiple variables plus recipe defaults |      1 | Private inventory is authoritative; the receipt records the resolved opaque ids and hashes.                                                                                    |

The 147-to-zero target concerns project-prefixed names. Standard platform and
third-party contracts remain where genuinely external: `PATH`, platform config
location conventions, CI-provided metadata, the database connection standard,
and a provider's documented credential name. They are not aliases for
per-engine or per-corpus settings. The application records only a secret
reference, never the credential value.

## Enforcement

This design is useful only if it prevents drift.

1. **Catalog compilation gate.** `itotori-ci catalog check` validates schemas,
   unique ids, plugin-relative paths, engine-to-proof coverage, inventory-free
   public lanes, and lane selector closure. It generates the capability
   projection and plan schema. CI fails on a stale generated projection.

2. **Plan/receipt integration gate.** A fixture catalog containing a new
   engine, two matching corpora, and one strict proof must produce one selected
   proof and one executed receipt entry. Deleting descriptor-driven planning
   makes this test fail because selected/executed ids no longer match. A
   companion fixture with a missing corpus, an empty selection, a skipped
   proof, and a zero-execution plugin each must fail with distinct diagnostics.
   The implementation task must mutation-run this test by replacing the planner
   with an empty plan and report the observed failure before merging.

3. **No-project-env gate.** A tracked-source scanner rejects all
   project-prefixed environment reads, writes, documentation examples, CI
   `env` blocks, and recipe exports. Its allowlist is empty. Standard
   external names are centrally listed with owner and reason. Adding a new
   project environment variable is therefore a failing change until the design
   itself is revised and reviewed.

4. **No-independent-topology gate.** The catalog compiler owns engine ids and
   proof selectors. A scanner rejects engine-identity switches and literal
   package selection outside an engine package or generated projection. The
   planner's expected set is compared with the receipt's selected and executed
   sets; set difference is an error, not a warning.

5. **Surface-budget gate.** Parse the `justfile` and workflow files in CI:
   exactly six recipes and exactly three workflow classes may call the planner.
   A deliberately approved increase requires changing a checked budget record,
   an architecture decision, and a test; ordinary feature work cannot silently
   add a convenience alias.

6. **Strict availability gate.** The watchdog and receipt validator make
   unavailable, queued-too-long, zero-step, missing-receipt, zero-execution,
   and skipped-required-proof states failed checks. They retain only opaque
   ids, counts, hashes, and diagnostics.

These gates make the engine-twenty-one cost measurable: the diff may add its
package and descriptor, but an edit to the central planner's engine list, a
recipe, a workflow selector, or a project-prefixed environment reference is a
red build.

## Migration sequence

Each step is independently reviewable and leaves the existing active path
green. "Green" in preparatory steps does not mean the new system is active;
the final cutover is intentionally atomic to avoid compatibility paths.

1. **Specify schemas and receipt contract** — mechanical after design review.
   Add catalog, inventory, lane, plan, and receipt schemas plus fixture-only
   parser tests. Do not route production commands through them.

2. **Build the planner and generic plugin contract** — judgement-heavy.
   Implement catalog compilation, plan/receipt validation, and one synthetic
   contract plugin. Add the kill test described above, including the required
   deliberate mutation run. It remains unreachable from existing commands.

3. **Move every current engine into isolated packages and descriptors** —
   mostly mechanical, with judgement for genuine capability boundaries. For
   every existing claim, write explicit public-check and strict-proof metadata;
   for every private input, create a local inventory template. Add parity
   fixtures that compare the descriptor projection to the current claimed
   capabilities. No CI or user command switches yet.

4. **Provision and prove the periodic runner** — operational, not optional.
   Install the runner configuration and read-only mounts, run `doctor` against
   its private inventory, install the watchdog credential, and prove both its
   healthy receipt path and its no-runner red path. Keep the old workflow
   active until this evidence exists; do not call queued jobs a successful
   migration.

5. **Atomic control-plane cutover** — cannot be incrementally compatible.
   In one change, make the six recipes and three workflows call the planner;
   replace the central adapter registry and capability-generator special cases
   with catalog projections; move all corpus selection to inventory; delete all
   project-prefixed environment reads/writes and every old recipe/workflow
   path; update active installation and operator documentation; and enable the
   gates in this proposal. The new strict lane must produce a non-empty
   receipt on the provisioned runner before this change is accepted.

6. **Remove temporary parity fixtures and enforce the steady-state budget** —
   mechanical. Keep the permanent catalog, planner, receipt, no-env,
   topology, availability, and surface-budget gates. Delete only migration
   comparison fixtures that duplicate the retired implementation.

Step 5 is the non-incremental part. A per-engine live migration would retain
two registries, two configuration mechanisms, and two proof-selection rules,
which is precisely the disease. Preparatory code may coexist while inactive;
once the new path becomes active, old paths are deleted in that same change.

## Costs, limitations, and strongest objection

This design makes several things worse.

- A plugin process boundary adds startup cost, version negotiation, packaging
  complexity, and less static type coupling than a single in-process union.
  It must not be chosen merely to make a table look tidy.
- A strict all-required policy can make a periodic run red when a site loses a
  corpus that was previously treated as optional. That is operationally noisy
  and requires real ownership of runner inventory.
- A six-recipe budget removes useful ad-hoc shortcuts. Debugging becomes more
  verbose because the supported escape hatch is an explicit argument and a
  saved plan, not an exported shell variable.
- Some tests genuinely require unusual host services, interactive hardware, or
  privileged setup. They should be modeled as a requirement-bearing lane or
  an explicit unsupported claim; a generic plugin cannot make them portable.

The strongest argument against adoption is that it introduces a new central
planner and a plugin ABI while the current code already contains detailed,
type-specific adapters. If the catalog becomes a second, weakly typed shadow
of those adapters, the proposal merely trades visible recipe sprawl for hidden
schema sprawl. Adoption is justified only if the descriptor is truly the
single authority, generated projections replace the current duplicates, and
the plan/receipt gates demonstrate that a declared proof either executed or
failed. If the team will not fund that atomic cutover and enforcement, keep
the existing explicit complexity rather than pretending a partial registry is
consolidation.

## Deliberately not done in this proposal

This document changes no executable behavior, configuration, CI, installation,
or tests. It does not claim a passing implementation check, a populated
runtime output, a registered runner, or a successful strict proof. The
required implementation tests, mutation demonstration, runner-health evidence,
and final gate sweep are specified above for the implementation task that
follows.
