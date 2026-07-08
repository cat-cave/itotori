# Architecture

> **Alpha definition (2026-06-24).** The redefined alpha gates live at the top
> of [`project-readiness.md`](project-readiness.md).
> References below to "alpha proof" describe the SHARED-025 manifest contract
> and the post-alpha dogfood vertical (the configured alpha corpus on
> RealLive), not the alpha gate. Alpha-ready means the architecture-proven
> dogfood point — substrate M.1–M.3, a non-synthetic engine port crate,
> real-bytes alpha-corpus smoke, recorded-LLM bundle, dashboard reachable,
> repo hygiene.

Itotori is a monorepo because the shared contracts are the hard part. The three
subprojects remain independent at runtime, but they evolve against the same
catalog, bridge, patch, delta, readiness, and runtime evidence schemas. Itotori
reads owned-game bytes from the configured corpus vault — managed by the sibling
vault-curation project — strictly read-only through the contract in
[itotori-vault-source-adapter.md](itotori-vault-source-adapter.md).

## Boundaries

- **Localization Bridge Schema** is neutral and lives under `packages/localization-bridge-schema`.
- **Catalog and readiness state** identify works across VNDB, EGS
  (ErogameScape / エロゲー批評空間), DLsite, Steam, IGDB, Wikidata, and local
  corpora. It records translation completeness,
  engine evidence, editions, releases, install state, and opportunity ranking
  before extraction or drafting is assumed possible.
- **Itotori** consumes catalog/readiness and bridge data, produces draft
  translations and patch exports, and ingests runtime evidence.
- **Itotori DB** owns migrations, Drizzle ORM schema, repositories, and dashboard read models.
- **Kaifuu** consumes game files and patch exports, then emits inventory,
  readiness profiles, bridge bundles, patch results, and `.kaifuu` delta
  packages. Text access is modeled as layered reversible transforms: locate
  surface, unpack container, decrypt, decode/decompile, normalize text, and
  patch back. Plaintext is the identity/null-key configuration of that model.
- **Utsushi** consumes patched game directories and emits runtime traces, captures, and smoke reports.

Search and indexing infrastructure is governed by
[ADR 0004](adrs/0004-search-and-indexing-infrastructure.md). Exact Postgres
indexes are the required baseline; semantic retrieval is an optional capability
with deterministic exact fallback when pgvector or embeddings are unavailable.

## Job queue: leases, retries, and late-completion safety

The event outbox and job queue (`packages/itotori-db/src/repositories/event-queue-repository.ts`)
are lease-based work queues. A worker `claimJobs`/`claimOutboxEvents` call atomically flips a
ready row to `running`/`publishing`, stamps `locked_by = <workerId>`, and sets
`lease_expires_at = now() + leaseSeconds`. Only rows whose lease is unset or already elapsed are
claimable, so a live lease grants exclusive ownership for its window.

**Stale-lease / late-completion policy (ITOTORI-046).** A worker may lose ownership of a job it is
still processing — its lease can expire before it finishes, a reaper can recover the lease, or a
second worker can take the lease over after recovery. Completing or failing a job on a lost lease
would corrupt final state (overwrite a newer owner's result, resurrect a dead-lettered job, or
double-count a retry). To prevent this, `completeJob` and `failJob` **revalidate ownership inside
the same guarded write**: the `UPDATE` matches a row only when

- `status = running`, **and**
- `locked_by = <workerId>` (the lease still belongs to this worker), **and**
- `lease_expires_at IS NOT NULL AND lease_expires_at > now()` (the lease has not expired).

Because the guard lives in the `WHERE` clause, a stale attempt matches **zero rows and mutates
nothing** — job state cannot be corrupted by a late completion. When the guarded write matches no
row, the repository reads the current row (read-only) and raises a typed
`JobLeaseRevalidationError` naming the expected vs actual owner, the current status, and the lease
expiry, with a `reason` classified in this order:

- `not_found` — the row no longer exists;
- `not_running` — already terminal or recovered (this is what a **duplicate completion** of an
  already-succeeded job reports; the first result is left untouched);
- `owner_mismatch` — still running, but **another worker owns the lease now** (ownership transfer);
- `lease_expired` — this worker still names itself owner, but its **lease elapsed** before it
  revalidated.

**Determinism of retries and dead-letter.** Because a rejected stale write is a no-op, the recovery
path (`recoverExpiredJobLeases`) remains the **single authority** over an expired lease: it moves
`running` rows past their lease back to `retry_waiting`, or to `dead_letter` once
`attempt_count >= max_attempts`, appending one `lease expired` history entry. A stale worker can
neither skip a retry nor prematurely dead-letter a job, so retry counting and dead-letter
transitions stay deterministic regardless of how late a stale worker calls in.

`ItotoriJobWorkerService.runAvailable` surfaces this at the worker loop: a `completeJob`/`failJob`
rejected by `JobLeaseRevalidationError` is counted as `leaseLost` (neither `succeeded` nor
`failed`) and the loop continues to the next claimed job, leaving the lost job to the recovery path.

## Tooling

Vite+ is the TypeScript/web workspace command surface (the `vp` CLI; task graph in `vite.config.ts`). Cached/affected task orchestration — affected-lane selection and the Vite+ task cache policy — is governed by [docs/ci-cache-and-affected.md](docs/ci-cache-and-affected.md) (`scripts/affected.mjs` plus the `vp` task cache). Cargo remains the authority for Rust builds, tests, and dependency modeling. The root `justfile` is the human-facing command layer.

## Studio SPA — design system, typed API client, app shell

The Studio SPA replaced the deleted HTML-string `dashboard.ts` /
`reviewer/detail-view.ts` / `workspace/view.ts` renderers with a single React
app served by `apps/itotori/src/server.ts`. It is the surface every downstream
Studio screen node inherits, so the patterns below are the precedent:

- **Dusk Observatory design system — `@itotori/ds`** (`packages/itotori-ds/`).
  React components + CSS tokens. The canonical CSS entry
  (`@itotori/ds/styles.css`) is consumed once at the SPA shell.
- **Typed API client — `fnd-api-client`** (`apps/itotori/src/api-client.ts`).
  Framework-agnostic; every route is generated from `api-schema.ts` (the
  `ItotoriApiRouteId` union + the route / response / error types) and
  `api-contract.ts` (the `ITOTORI_API_ROUTES` registry). Every response is
  validated by the same `assertItotoriApiResponse` guard the server uses; the
  error state carries the typed `ApiErrorResponse` (`{ code, error }`).
  Consumers read a discriminated `{ loading | ready | empty | error }` state;
  the shared singleton lives at `apps/itotori/src/ui/client.ts`.
- **React app shell — `fnd-spa-shell`** (`apps/itotori/src/ui/`). `App.tsx`
  client-routes off `window.location` and renders a parity-ported React
  screen; `use-api-resource.ts` adapts the stateful `ApiResource` to React via
  `useSyncExternalStore`. Routes this node does not port (asset-decisions /
  reviewer-batch / style-guide-builder) are bridged to their existing
  renderers via `LegacyRoute` (an honest, temporary mount — each is a tracked
  follow-on screen, not a dual path for a replaced view).

The full set of patterns (typed-query example, deleted predecessors,
downstream-screen patterns) lives in [frontend.md](frontend.md); the
design ↔ repo alignment for the hi-fi Studio epic lives in
[`design/hifi/README.md`](design/hifi/README.md).

## Current Alpha Proof

The public-fixture vertical intentionally avoids copyrighted game files. It proves the contract between the projects without claiming real-engine support or translation quality.

The alpha proof workflow (`just alpha-proof`, run by
[`.github/workflows/alpha-proof.yml`](../.github/workflows/alpha-proof.yml)) is
the deterministic integration guardrail on the public-fixture path. It validates
real cross-project artifact linkage — bridge, patch, PatchResult, provider
proof, benchmark, runtime observation, dashboard/read-model ingestion, and the
SHARED-025 manifest, all sharing one fixture id, source revision, locale branch,
and content hashes — rather than a placeholder success line. `ALPHA-007`
implemented the vertical command and `ALPHA-009` promoted it into CI and retired
the literal "Hello World" workflow. The first real-engine vertical is `ALPHA-006`
(the configured alpha target corpus on RealLive, sourced from the corpus vault
per the vault-source adapter contract). There is no second,
weaker Hello World source of truth: `just hello` survives only as a compatibility
alias that delegates to `just alpha-proof` and cannot diverge. See
[alpha-proof.md](alpha-proof.md).
