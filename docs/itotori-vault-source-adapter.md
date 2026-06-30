# Itotori Vault Source Adapter

This document defines the read contract by which itotori consumes owned-game
bytes from the vault-curation project's content-addressed store. It is the
binary-data counterpart to
[`itotori-catalog-source-adapter-contract.md`](./itotori-catalog-source-adapter-contract.md),
which governs metadata-importer adapters. The two contracts share no
implementation surface: catalog adapters write facts into the itotori catalog;
the vault source adapter reads bytes out of the vault so Kaifuu has a local
input to operate on.

The vault is owned by the vault-curation project. Its layout, hardlink scheme,
content-addressing rules, repack policy, and the `catalog.db` schema are
defined there. Itotori treats every byte under the configured vault root as
externally owned, immutable from itotori's perspective, and addressable only
through the contract described here.

## Purpose

The vault source adapter is the entry point that lets a Kaifuu engine
adapter (KiriKiri, RealLive, Ren'Py, RPG Maker, NScripter, custom in-house
engines, etc.) consume a specific owned release as a local directory tree. It
answers a single question on Kaifuu's behalf:

> Given a claim about a work or a release (engine family tag, producer, work
> title, release id, external identifier), what local filesystem path should
> Kaifuu point at, and what is the embedded provenance for those bytes?

The adapter has three responsibilities:

1. Resolve claims into vault artifacts via `catalog.db`.
2. Materialize artifact `.7z` files into scratch as extracted trees.
3. Cross-check the embedded `_vault/metadata.json` against the catalog and
   surface disagreements.

It has no other responsibilities. Launching the game, probing it at runtime,
fan-translation orchestration, key custody, patch back-write, repack, dedup,
or any write into the vault are out of scope (see below).

## Read-only Contract

Itotori never writes to the vault. This is the load-bearing invariant of this
contract; every other rule follows from it.

Concretely:

- `catalog.db` is opened in SQLite read-only mode (`mode=ro` on the URI; never
  `mode=rwc` or default open). No `PRAGMA` that mutates the database is
  permitted, including journal-mode changes. Itotori does not run migrations,
  does not create tables, does not insert into `facts`, and does not refresh
  `v_current_facts`.
- The vault tree (`artifacts/by-id/...`, `artifacts/by-name/...`, `cache/`,
  `derived/`, `incoming/`, `schema.sql`, anything else under the configured
  vault root) is treated as a read-only filesystem. No file is created,
  renamed, moved, deleted, repacked, hardlinked, symlinked, chmod'd, or
  touched.
- Disagreements between catalog and embedded metadata are reported, not
  reconciled in place. Reconciliation is vault-curation's exclusive concern.
- Itotori does not place its own files anywhere under the vault root. Scratch
  goes elsewhere (see below).

The vault is mounted read-only where the deployment supports it (e.g. a
read-only bind mount, virtiofs `ro=true`, or filesystem-level
read-only). Where it cannot be mounted read-only, the adapter still behaves
as if it were.

## Discovery

The adapter discovers candidate releases by querying `catalog.db`. The catalog
schema is defined by `<vault-root>/schema.sql`; the relevant surface for
discovery is:

- `works`, `work_titles`, `identifiers` for finding the abstract work by
  title, romanization, or any external id (VNDB `v`-id, DLsite `RJ/VJ/BJ`,
  EGS id, Steam appid, ...).
- `releases`, `release_languages`, `release_platforms` for narrowing to a
  specific distribution (platform, shipped languages, edition).
- `work_producers`, `producers`, `producer_identifiers` for finding releases
  by developer/publisher/circle.
- `tags`, `work_tags` for tag-shaped queries (genre, EGS attribute, manual
  label).
- `v_current_facts` for fields that aren't pinned columns. Most importantly,
  `field = 'engine'` (and `engine_version`) is how the adapter selects "all
  releases the catalog currently believes are KiriKiri" or similar engine
  claims. `v_current_facts` already applies the evidence priority (resolution
  > manual > direct_observation > source_assertion > inference) and recency
  > tiebreak, so the adapter consumes its rows directly and does not re-rank.
- `v_facts_needs_review` is read informationally: a release whose engine field
  is in the review queue is still resolvable, but the adapter surfaces the
  flag to its caller so Kaifuu can decide whether to proceed.

Discovery queries return release ids. The adapter does not cache the catalog
across runs; each run reopens `catalog.db` so vault-curation updates are
picked up without any explicit invalidation step.

## Resolution

Each release id resolves to one or more artifacts. The primary content links
via the direct `artifacts.release_id` column (role `primary`); supplementary
roles link via the `release_artifacts` junction. The adapter unions both:

```
artifacts(id, release_id, canonical_id, vault_path, artifact_kind,
          original_sha256, canonical_sha256, ...)
release_artifacts(release_id, artifact_id, role, subpath)
```

The adapter selects artifacts by `role`:

- `primary` is the canonical playable artifact and is what the adapter
  resolves by default.
- `patch`, `translation`, `crack`, `dlc`, `docs`, `bundle_member`,
  `volume_part` are returned alongside `primary` when the caller asks for the
  full set; otherwise omitted.
- `subpath` is honoured: a single artifact (one DLsite zip with `/Win/` and
  `/Mac/` subtrees) may host multiple releases. The adapter records the
  subpath and exposes the post-extraction path
  (`<tree-root>/<subpath>`) rather than the artifact root.

### By-id resolution (identity, not content hash)

The on-disk path is the content-addressed *by-id* store, reconstructed from
the stable `artifacts.canonical_id`:

```
<vault-root>/artifacts/by-id/<canonical_id>/<canonical_id>.7z
```

A content hash is **brittle identity** — any tiny change (folder layout, a
metadata edit, a repack) mints a new hash and breaks continuity — so it is
unfit as a classification/identity key. The adapter therefore resolves and
verifies by stable id + thorough metadata, never by archive hash:

1. The `canonical_id` is validated as a single safe path segment (no
   separators, no `..`), then the by-id path is reconstructed from it.
2. The catalog's recorded `artifacts.vault_path` must equal the reconstructed
   by-id path; a row pointing anywhere else is a typed resolution failure
   (never silently honoured).
3. The archive is stat-ed: it must exist and be a regular file (no symlink
   following into `by-name/`, no device files).

There is **no archive-level sha256/size verification**. `original_sha256` and
`canonical_sha256` are carried as informational provenance only. Identity is
established post-extraction by cross-checking the embedded
`_vault/metadata.json` (see below); byte-fidelity is a per-game-file concern
(e.g. the extracted `Seen.txt` sha256), never the archive/repack hash.

The `artifacts/by-name/{dlsite,legacy}/<human-name>.7z` tree is for human
navigation. The adapter does not read from it, list it, or rely on its
existence; vault-curation may restructure the human-name layout at any time
without touching `by-id/`.

## Extraction

Resolved artifacts are extracted on demand into per-run scratch. The
canonical scratch layout is:

```
<scratch-root>/<game-id>/<run-id>/
  extracted/
    <canonical_id>/            <- the by-id repack wraps the tree here
      _vault/
        metadata.json
      <game tree>
```

The by-id archive wraps its contents under a top-level `<canonical_id>/`
directory. The adapter exposes that wrapper as the *tree root* — the path
engine adapters point at — and reads `_vault/metadata.json` and any `subpath`
relative to it.

- `<scratch-root>` defaults to `/scratch/itotori/` on Linux; on other hosts
  it follows the platform's conventional scratch path or the configured
  override (see Cross-OS Path Resolution).
- `<game-id>` is a stable slug derived from the work/release identity. The
  derivation order is:
  1. VNDB `v`-id if present in `identifiers` (`v12345`).
  2. DLsite `RJ/VJ/BJ` code if present.
  3. EGS id if present.
  4. A slug of `works.canonical_title` plus the release id as a suffix.

  The slug is stable across runs so cached extractions and on-disk
  configuration keyed by `<game-id>` survive re-runs.

- `<run-id>` is per-run and opaque to the rest of the system.

The default extraction tool is `7z x` invoked with path preservation. The
adapter rejects archive entries that:

- contain `..` segments after normalization,
- are absolute paths,
- traverse symlinks outside the extraction root,
- collide with the `_vault/` directory by anything other than the expected
  `_vault/metadata.json` (and the optional sibling files the embedded schema
  permits).

Extraction failures (truncated archive, decoder error, path traversal
rejected, disk full) are surfaced as typed errors. Partial extractions are
not used; the per-run extraction directory is removed before retry. After a
nominally-successful extraction the adapter re-reads the archive header and
confirms every declared file entry landed on disk — a folder whose codec
combination the pure-Rust decoder cannot fully decode (and silently skips) is
surfaced as a typed `ExtractionFailed`, never observed as a partial tree.

`<canonical_id>/_vault/metadata.json` is the first file the adapter reads
after extraction.

## Cross-checking via Embedded Metadata

Every by-id artifact carries `_vault/metadata.json` under its
`<canonical_id>/` wrapper. This is the vault-curation *canonical* document —
top-level `canonical_id`, `identifiers[]` (`{source, kind, value}`), `engine`,
`work`, `release`, `languages`, ... — produced by the stage-2 repack. (It is
NOT the legacy "Vault Embedded Artifact Metadata v1.0" `releases[]` /
`vault_artifact` shape; that schema described the prior sha-addressed era and
is not used for by-id resolution.) The adapter parses it and cross-checks its
identity against the catalog:

- **`canonical_id` (hard identity gate).** The embedded top-level
  `canonical_id` must equal the catalog `artifacts.canonical_id` the by-id
  path was resolved from. This is the by-id replacement for the removed
  archive-hash identity check. A mismatch is a typed
  `CatalogEmbeddedMismatch`.
- **work `identifiers` (hard identity gate).** The embedded `identifiers`
  must intersect the catalog's `identifiers` for the resolved work — at least
  one external id (`vndb v`, `dlsite rj/vj/bj`, `egs id`, `steam appid`, ...)
  must agree — when both sides declare identifiers. Zero intersection is a
  typed `CatalogEmbeddedMismatch`.
- **`languages` / `engine` (soft checks).** A disjoint language set or a
  disagreeing engine is reported as a finding (not fatal by default); the
  catalog is the integrated multi-source truth. A strict tolerance promotes
  these to errors.

On a soft disagreement:

1. The catalog value wins. The adapter continues with what the catalog said.
2. The discrepancy is reported as a finding shaped like a
   `v_facts_needs_review` row: `(entity_type, entity_id, field,
catalog_value, embedded_value, source='vault:embedded',
evidence='direct_observation')`. The adapter does not write this finding
   into `catalog.db`; it returns it to the caller and to whatever findings
   sink itotori configures so vault-curation can pick it up.
3. A strict tolerance promotes the soft checks (languages, engine) to typed
   errors. The hard identity gates (`canonical_id`, work identifiers) always
   reject regardless of tolerance.

## Scratch and Secret Custody

Per-run scratch (`<scratch-root>/<game-id>/<run-id>/`) is owned by the
running user, gitignored, and treated as reproducible. It can be deleted
between runs with no loss of correctness; a subsequent run re-extracts from
the vault.

The adapter exposes a retention policy:

- `keep-none` (default for CI): delete `<run-id>/` on success and on failure.
- `keep-on-failure`: delete on success; preserve on failure for inspection.
- `keep-all`: never delete; the operator manages cleanup.
- `keep-extracted-for-game`: keep the extracted tree under `<game-id>/` (not
  `<run-id>/`) so repeated runs against the same release reuse the
  extraction. The adapter still verifies the artifact sha256 each run and
  re-extracts on any mismatch.

Scratch lives outside the vault. The adapter never writes a single byte
under the configured vault root, regardless of retention setting.

Secrets are a separate concern with a separate location. Any cryptographic
keys, passphrases, or per-game extraction secrets recovered by Kaifuu during
its work live at:

```
.kaifuu/secrets.local/<game-id>/
```

with mode `0600`, owned by the running user, gitignored. Secrets are never
written near the vault, never embedded in scratch artifacts that might be
archived, and never named in logs. The vault stores binary game data; the
secret store stores keys. These are different stores with different
lifetimes and different access policies, and the vault source adapter has
no read or write relationship with the secret store.

## Cross-OS Path Resolution

Itotori may run natively on Linux, macOS, or Windows. The contract is
platform-agnostic: a vault root is any directory containing a `catalog.db`
file and an `artifacts/by-id/` subdirectory with the expected
`<canonical_id>/<canonical_id>.7z` layout. Nothing else is assumed about the
path.

Resolution order:

1. The `ITOTORI_VAULT_ROOT` environment variable, if set.
2. A `vault.root` entry in the itotori user configuration.
3. The platform default:
   - Linux: `/archive/vault/`.
   - macOS: `~/Library/Application Support/itotori/vault/` (intended as a
     symlink to the operator's actual vault location).
   - Windows: `%LOCALAPPDATA%\itotori\vault\` (same).

The adapter validates the resolved path at startup by checking for
`catalog.db` and `artifacts/by-id/` and refuses to proceed if either is
missing. Path comparison uses canonicalized absolute paths; symlinks
encountered during canonicalization are permitted (operators commonly
symlink a network-mounted vault into the default location), but symlinks
under `artifacts/by-id/` itself are not followed during artifact reads.

Scratch root resolves analogously: `ITOTORI_SCRATCH_ROOT`, then config,
then platform default (`/scratch/itotori/`, `~/Library/Caches/itotori/`,
`%LOCALAPPDATA%\itotori\scratch\`).

The contract does not bake any Linux-specific path into itself. The
Linux defaults above are conveniences, not requirements.

## Failure Modes

Every failure is a typed semantic error. The adapter never falls back
silently to a degraded mode.

| Error                      | Trigger                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `VaultRootMissing`         | Configured vault root does not exist or is not a directory.                         |
| `VaultRootIncomplete`      | Vault root exists but lacks `catalog.db` or `artifacts/by-id/`.                     |
| `CatalogOpenFailed`        | `catalog.db` exists but cannot be opened read-only.                                 |
| `CatalogSchemaUnsupported` | `schema_version.version` is missing or not a version this adapter knows.            |
| `ReleaseNotResolved`       | Discovery returned zero releases, or a resolved row has no/invalid `canonical_id` or a non-by-id `vault_path`. |
| `ArtifactMissing`          | The `by-id` path for the resolved `canonical_id` does not exist (or is not a file). |
| `ExtractionFailed`         | Decoder error, truncated archive, decompression error, or an incomplete extraction (a codec folder the decoder could not fully decode). |
| `ExtractionUnsafePath`     | Archive entry rejected for path traversal or symlink escape.                        |
| `EmbeddedMetadataMissing`  | Extraction completed but `_vault/metadata.json` is absent.                          |
| `EmbeddedMetadataInvalid`  | `_vault/metadata.json` fails schema validation.                                     |
| `CatalogEmbeddedMismatch`  | Cross-check disagreement exceeds the configured tolerance (default: work identity). |
| `ScratchUnwritable`        | Resolved scratch root cannot be created or written.                                 |

Each error carries enough context (paths, hashes, ids, schema version, the
specific cross-check field) for an operator or downstream agent to act
without re-running discovery.

## Out of Scope

This adapter does not, and will never:

- Import metadata into the itotori catalog. That is the responsibility of
  catalog source adapters governed by
  [`itotori-catalog-source-adapter-contract.md`](./itotori-catalog-source-adapter-contract.md).
- Write anything into the vault. Repack, ingest, hardlink layout, dedup,
  garbage collection, and `catalog.db` mutation are vault-curation's
  exclusive concerns.
- Launch the game, probe it at runtime, capture screenshots, or evaluate
  patch behaviour. Those belong to Utsushi.
- Locate, decrypt, decompile, normalize, or patch text. Those are Kaifuu's
  layered transforms; the vault source adapter only hands Kaifuu a
  directory.
- Manage cryptographic key custody. Keys belong under
  `.kaifuu/secrets.local/`, owned by the running user, not in the vault and
  not in scratch.
- Provide a stable cache across machines. Scratch is per-host, per-user,
  per-run; re-extracting from the vault is always cheap enough relative to
  the rest of the pipeline that no shared cache layer is justified.

## Appendix: NixOS + Looking-Glass VM Example

This appendix describes one optional deployment configuration and is not
part of the contract. The vault source adapter has no awareness of the
arrangement below; it just reads from its configured vault root.

On the trevor-specific NixOS host with a Windows guest driven via
Looking-Glass, the vault root can be exposed read-only into the guest via
virtiofs. The host shares `/archive/vault/` at `/archive/winshare/vault/`
inside the guest with `ro=true`. A future dynamic-key-discovery helper that
needs to memory-scan a running protected process inside the Windows guest
can then run itotori (or a focused Kaifuu helper) natively in the guest
with `ITOTORI_VAULT_ROOT=Z:\winshare\vault` (or the equivalent virtiofs
mount path), use the same read-only contract, and surface any recovered
keys back to the Linux side via the normal `.kaifuu/secrets.local/`
mechanism on a shared writeable channel that is separate from the vault.

This is one deployment topology among several. The contract above is what
matters; the VM channel is invisible to the adapter.
