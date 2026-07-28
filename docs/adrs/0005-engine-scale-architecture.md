# ADR 0005: Engine-Scale Architecture

## Status

Proposed.

## Context

The repository already gets dispatch mostly right. The extract registry requires
an engine discriminator, rejects an unregistered selection, and says that a new
engine is one registry entry rather than another caller branch
([`extract-adapter-registry.ts`](../../apps/itotori/src/extract/extract-adapter-registry.ts#L1-L16)).
The structure-export registry follows the same boundary
([`structure-provider-registry.ts`](../../apps/itotori/src/structure-export/structure-provider-registry.ts#L1-L6)),
and the runtime registry validates both adapter and operation from a map
([`runtime-launcher-registry.ts`](../../apps/itotori/src/play/runtime-launcher-registry.ts#L94-L143)).
The Rust CLI has a table lookup too, although its current command parser still
assumes one provider's arguments ([`structure.rs`](../../crates/utsushi-cli/src/structure.rs#L29-L87)).
One important correction to the brief's positive characterization: the
structure-export registry presently constructs unavailable providers that throw
at execution ([`structure-provider-registry.ts`](../../apps/itotori/src/structure-export/structure-provider-registry.ts#L123-L166)).
This ADR preserves the registry boundary but does not permit that stub pattern
in the catalog.

Configuration and proof scheduling do not have that shape. `ci-real-bytes`
selects roots, titles, and tests inline ([`justfile`](../../justfile#L272-L350));
five roots are mandatory before any test begins ([`justfile`](../../justfile#L287-L300)).
The periodic workflow sends two jobs to one self-hosted label
([`real-bytes-oracle.yml`](../../.github/workflows/real-bytes-oracle.yml#L70-L95),
[`real-bytes-oracle.yml`](../../.github/workflows/real-bytes-oracle.yml#L107-L125)).
The supplied runner audit reports zero registered runners, so this has queued
instead of proving anything. Its hosted drift job is useful, but does not prove
real bytes ([`real-bytes-oracle.yml`](../../.github/workflows/real-bytes-oracle.yml#L35-L55)).

The initial corpus-manifest documentation is a sound direction but is only a
local descriptor and has not replaced the inline recipe
([`fixtures-and-corpora.md`](../fixtures-and-corpora.md#L147-L193)). `itotori
init` currently writes a protected environment file and tells the operator to
export its location ([`init-command.ts`](../../apps/itotori/src/init-command.ts#L10-L14),
[`init-command.ts`](../../apps/itotori/src/init-command.ts#L130-L145)). The
workspace lists 22 members manually ([`Cargo.toml`](../../Cargo.toml#L1-L26)).
The capability matrix also has a separate hand-maintained input registry
([`generate-engine-capability-matrix.mjs`](../../scripts/generate-engine-capability-matrix.mjs#L54-L153)).

The supplied measurement is 121 distinct project-prefixed environment variables
and 75 recipes. A source search confirms that a bare prefix search is not a
usable inventory: it finds exported code constants and test-only identifiers as
well as process reads. This ADR therefore retains 121 as the frozen migration
baseline and makes the classifier, rather than a grep count, authoritative. The
apparent outlier, `STRICT_API_BODY_KEYS`, has 156 repository
references but is not process configuration: it is an exported API-schema
constant ([`api-schema.ts`](../../apps/itotori/src/api-schema.ts#L273-L686))
consumed to derive strict OpenAPI envelopes ([`api-contract.ts`](../../apps/itotori/src/api-contract.ts#L25-L38)).
It must be renamed to remove the environment-looking prefix, or remain a code
constant, but must never be treated as an environment variable.

## Decision and scale rule

Adopt a declarative engine catalog, generated consumers, independently
satisfiable real-byte evidence, and a private runner-location overlay. The
standing catalog invariant is at least two real titles for every engine.

The acceptance test for every plane is: **what does engine 21 cost?** It must
be one entry in `config/engine-catalog.v1.json` and one self-contained,
implemented adapter package. Generation is a build step, not a hand-edited or
committed source change; no workflow, recipe, caller, workspace member list,
environment variable, or prose page is edited. An engine is not catalogued as
supporting a capability until its adapter and real-byte validation command
exist; there are no claimed-but-stubbed rows.

## Catalog and generated consumers

`config/engine-catalog.v1.json` is the committed authority. JSON needs no new
parser in either primary implementation language and supports a checked JSON
Schema at `config/engine-catalog.schema.json`. It contains logical identity and
test requirements, never an absolute path, raw title text, key, or secret. A
catalog entry has this shape; identifiers below are illustrative and
intentionally generic.

```json
{
  "schema": "itotori.engine-catalog.v1",
  "engines": [
    {
      "id": "engine-x",
      "adapters": { "package": "engine-x-adapter" },
      "capabilities": ["identify", "extract", "patch", "runtime"],
      "validation": {
        "command": "real-bytes-engine-x",
        "evidenceKinds": ["extract", "patch", "runtime"],
        "cadenceHours": 168
      },
      "titles": [
        { "id": "engine-x-title-1", "sourceLocale": "ja-JP", "locationKey": "pool-a" },
        { "id": "engine-x-title-2", "sourceLocale": "ja-JP", "locationKey": "pool-b" }
      ]
    }
  ]
}
```

Title ids are opaque; no reusable code or documentation derives behavior from
them. `locationKey` identifies an eligible placement, not a filesystem path.
One title may be available on multiple pools. The schema requires unique engine
and title ids, two or more titles, a real command from the adapter's allowlisted
command manifest, a nonempty evidence contract, and an adapter for every
declared capability. It rejects roots, home-directory syntax, secret-shaped
fields, and values outside the declared enums.

`~/.config/itotori/corpus-locations.v1.json` is the private overlay. It maps a
location key and opaque title id to a read-only root or a vault locator, plus
the local agent identity. It is mode 0600, ignored, and validates against the
catalog. It is resolution data, not a second catalog: it cannot invent engines,
titles, requirements, commands, or capabilities. A runner can stage any subset.

`node scripts/engine-registry.mjs generate` is the only writer for these
ephemeral build outputs:

| Output                                                       | Consumer                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `.tmp/engine-registry/registry.generated.ts`                 | Extract, structure, and runtime registry assembly and capability API. |
| `.tmp/engine-registry/lib.rs`                                | Rust provider table and typed engine ids.                             |
| `.tmp/engine-registry/real-bytes-matrix.v1.json`             | Hosted evidence ingestion and local-agent selection.                  |
| `.tmp/engine-registry/capability-matrix.v1.{json,md}`        | Capability view, replacing its separate input list.                   |
| `.tmp/engine-registry/engine-support.md` and `real-bytes.md` | Published operator and contributor documentation.                     |

The generated registry imports an adapter module named by the entry; the adapter
owns source flags and engine-specific behavior exactly as today. Generated Rust
code refers to the declared crate only when that capability is present. There
is no mandatory decode/runtime crate pair: retain `kaifuu-<engine>` for
transform capability and `utsushi-<engine>` for runtime capability, but create
only the crate(s) the implemented adapter needs. Use the workspace member glob
`crates/*`, after validating every directory it includes is a Cargo package, so
a new crate does not edit root membership. This preserves focused ownership
without a 40-crate pairing rule or a central edit.

## Real-byte evidence and runners

`itotori real-bytes run --engine <id>` resolves only that engine's eligible
titles from the catalog plus local overlay. It executes every declared proof for
each staged title and emits one path-redacted, signed
`real-bytes-evidence.v1.json`. Its result is exactly one of these states:

| State        | Meaning                                                                         | GitHub presentation                                                         |
| ------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `passed`     | All selected proofs passed; aggregation separately checks the two-title quorum. | Green title receipt with executed counts and evidence hash.                 |
| `failed`     | At least one selected proof executed and failed.                                | Red engine check with a redacted failure receipt.                           |
| `not_staged` | No eligible title root is present on this agent.                                | Neutral, visible row naming missing location keys and zero executed proofs. |
| `incomplete` | A selected title could not be read or a selected proof was not executed.        | Red title receipt; it is not a skip.                                        |
| `stale`      | A registered agent missed its required report deadline.                         | Red freshness check for that agent.                                         |

Missing material on a machine therefore never makes another engine fail, and it
never looks like success. A missing title on an otherwise eligible agent is
`incomplete`; a machine with none is `not_staged`. The command exits zero only
for `passed` and `not_staged`, but always writes the evidence file. The
coordinator calls an engine covered only when fresh `passed` evidence covers two
distinct catalog titles. Fewer than two is a neutral coverage gap, never a
green engine result. The aggregate command returns nonzero for any `failed`,
`incomplete`, or `stale` row and a neutral summary when no engine ran. It cannot
produce an all-green result from zero executed proofs.

Use a hybrid runner model. A small fleet of private, supervised agents runs a
system timer per placement and retains private logs locally. Each invokes the
generic command, uploads only the signed redacted evidence to an evidence
inbox, and sends a heartbeat. A hosted workflow polls the inbox, verifies the
catalog revision, signature, result shape, freshness, and executed counts, then
publishes one check per engine and one pool-health check. Its matrix is produced
from the catalog; it does not wait for a self-hosted label. The existing hosted
drift job remains a separate public check. This makes a private failure visible
within the poll interval, and an absent or dead agent red as stale rather than
queueing for a day.

An agent's private overlay advertises location keys and a bounded concurrency
value. Engines can be split across machines; no machine needs all corpora. The
coordinator schedules only matching `(engine, locationKey)` work, with a
per-agent queue and a per-agent report deadline. A manual hosted workflow
dispatch requests evidence from agents but is not the executor. The old
self-hosted workflow is removed after two successful timer/report cycles.

## Configuration, commands, and onboarding

The target process environment is deliberately small: credentials and
machine-wide runtime overrides only. Corpus selection moves entirely into the
private overlay and explicit `--corpus-config` flag. Keep the existing
environment pointer only as a compatibility alias during migration; it names a
config file, never one corpus path. Keys remain in a protected secret provider
or external env file, referenced by opaque secret ids in the overlay.

The full 121-item disposition is an exhaustive, machine-checked partition, not
a hand-waved list. The migration introduces `config/env-disposition.v1.json`
with exactly 121 rows. Each has `legacyNameSha256`, `currentRole`,
`disposition`, `replacement`, and `removalRelease`; a local checker hashes every
recognized legacy process name before lookup. This retains the complete mapping
without publishing title-shaped legacy names. The checker imports the frozen
baseline and fails if a name is unmatched, appears twice, or a new
project-prefixed process variable lacks an approved row. Its initial rows use
these dispositions:

| Current-role matcher                                                                                                                  | Disposition                                            | Replacement                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Any per-title, per-engine, corpus-root, vault-root, research-root, probe-path, archive-path, bridge-path, or corpus hash input        | Remove.                                                | Private catalog overlay and `--corpus-config`; tests receive resolved inputs, not environment names. |
| Any raw key, token, password, field cipher, or secret input                                                                           | Keep only as a secret-provider or external-env value.  | Opaque `secretRef` in overlay; no secret enters catalog or evidence.                                 |
| Native binary, browser, library directory, temporary-directory, worktree, database compose, host/port, or database credential setting | Keep while it configures the host, not an engine.      | Existing generic runtime configuration.                                                              |
| Test-only allow/skip, fixture fault injection, regeneration, strictness, mutation, snapshot, or diagnostic toggle                     | Remove from normal process environment.                | Explicit test CLI flag or test fixture config.                                                       |
| Product version, schema hash, generated route/key collection, help text, API-body-key collection, or compile-time selector            | Remove as environment configuration.                   | Typed code constant or generated artifact.                                                           |
| Generic live-provider, cost limit, locale, selected account, permission, run-token, display, and operator preference                  | Keep only when it is genuinely operator configuration. | Protected config file/CLI flag, with environment compatibility aliases sunset.                       |

This partition includes dynamic baseline entries as explicit hashed rows and
classifies the API-body-key item in the fourth row. The checker reports the
exact identifier only locally, so generated public docs need not perpetuate
legacy title-shaped names.

Replace the large recipe family with four generic recipes:

```text
just engine-list
just engine-validate [engine]
just test real-bytes
```

They are thin calls to `itotori engine ...` and `itotori real-bytes ...`; shell
does not select engines, roots, or tests. `just test real-bytes` enumerates the
catalog and aggregates typed states. Public CI retains its existing public
recipes; private proof scheduling uses the evidence protocol above.

`itotori init` continues to establish credentials and database access, then
offers `itotori corpus configure`. The latter lists catalog engines, lets an
operator select the two they care about, asks for roots or vault locators, and
writes only the private overlay. `itotori corpus doctor` prints a redacted table
of `staged`, `not_staged`, unreadable, and stale selections. It never writes
shell exports for corpora. Noninteractive use accepts `--catalog`,
`--corpus-config`, and `--select-engine`; all choices are validated against the
same catalog.

## Enforcement

The following gates land with the catalog; all are Tier 0 except private-agent
execution.

1. `engine-registry validate` validates schema, unique ids, at least two titles,
   no private paths/secrets, real validation commands, and adapter/capability
   parity. `engine-registry generate --check` rejects derived-file drift.
2. `engine-scale-conformance.test.mjs` creates an isolated hypothetical engine,
   adapter, and two generic titles; generation, typecheck, docs, matrix, and
   generic recipe discovery must succeed. Its allowed changed inputs are the
   catalog entry and adapter implementation; any required central source edit
   fails.
3. `audit-engine-dispatch.mjs` follows the existing game-name guard's
   shrink-only, AST-based style ([`audit-no-game-names.mjs`](../../scripts/audit-no-game-names.mjs#L28-L53)).
   It obtains ids from the catalog and rejects comparisons, switches, or
   membership branches on an engine id outside adapter modules, generated
   registries, and the registry test fixture.
4. `audit-engine-sprawl.mjs` rejects engine ids and corpus-path variables in
   workflows, justfiles, hand-written docs, and root workspace membership;
   generated outputs are checked for drift instead. It also rejects an engine
   recipe or workflow job name.
5. `env-disposition check` enforces the exhaustive 121-row map, the approved
   end-state allowlist, and removal deadlines. It specifically prevents a code
   constant from being read through `process.env`.
6. `real-bytes-evidence check` verifies signatures, catalog revision, state
   semantics, nonzero executed proof counts for `passed`, and freshness. The
   hosted workflow fails red for bad, stale, or incomplete evidence and makes
   neutral rows visible in its summary.

## Staged migration

1. Land catalog schema, validator, generic fixture, and generated capability
   view in check-only mode. It reads current evidence but changes no callers.
2. Land the private overlay reader, resolver, doctor, and init flow. Keep legacy
   corpus variables as read-only compatibility inputs, with a warning receipt.
3. Convert one fully implemented engine end-to-end: generate its dispatch
   registration, make its real-byte command emit evidence, and prove both title
   records. This validates the seam before breadth migration.
4. Convert each remaining implemented engine independently. Each merge removes
   its inline recipe branch and legacy variable readers only after its catalog
   evidence is green or visibly `not_staged` locally.
5. Replace `ci-real-bytes` with generic recipes and add evidence ingestion plus
   hosted freshness checks. Run the old and new reporting paths in parallel for
   two cadence periods and compare executed counts.
6. Provision at least two private agents with disjoint placements; require the
   hosted health report before deleting self-hosted-label jobs. This is a
   prerequisite for making periodic evidence required.
7. Change Cargo membership to globs, generate Rust assembly, and migrate the
   capability matrix and documentation to catalog inputs. The conformance test
   becomes required here.
8. Delete compatibility variables, inline corpus branches, and obsolete
   workflow jobs at their published removal release. Tighten the environment
   allowlist and make stale proof checks required after every catalog engine has
   an assigned placement.

Every stage has a public validator and is merge-queue safe. Stages 1--2 precede
all conversion; stage 3 precedes broad migration; stage 6 precedes retirement
of the queued workflow; stage 7 can proceed alongside stages 4--6.

## Alternatives considered

### One giant corpus runner

Rejected. It makes storage, scheduling, and failure blast radius grow with the
number of engines, and repeats the unavailable-runner failure mode.

### Keep per-engine environment variables and recipes

Rejected. Adding an engine adds multiple path variables, shell branches, and
workflow edits. It fails the engine-21 test even if names are standardized.

### Make missing corpora a passing skip

Rejected. A passing check with no executed proofs is indistinguishable from
validation. Neutral `not_staged` evidence and red stale ownership make the
absence explicit without blocking unrelated engines.

### Put private roots in the committed catalog

Rejected. It leaks workstation topology and makes contributors edit shared data
for local setup. A logical placement key plus private overlay preserves one
validation contract without publishing paths.

### Keep mandatory transform/runtime crate pairs and explicit workspace members

Rejected. It creates empty or premature crates and a central edit per engine.
Capability-specific crates and workspace globs retain modularity at constant
central cost.
