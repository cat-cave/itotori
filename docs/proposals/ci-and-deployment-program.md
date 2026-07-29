# CI and deployment program

## Executive decision

This is a false-green proof system and a non-deployable application boundary,
not merely slow CI and missing hosting. Public CI does substantial work but
overclaims it; private proof never completed, has no runner, and stops at
preflight. The app parses a session but uses the legacy local actor, lacks
resource tenancy, and throws at production review/adjudication.

The program has three top recommendations:

1. Make a declarative plan/receipt authoritative for every CI claim and make
   unavailable private infrastructure fail. Reject label, regex, marker, and
   successful-exit inference.
2. Make identity-to-actor propagation, account-owned resources, repository
   predicates, and working production roles release gates before any managed
   deployment. Reject exposing the current local-user compatibility path as a
   multi-user service.
3. Use one protocol in two placements: Cloudflare control plane and
   local/self-hosted full-fidelity executor. Keep original archives, binaries,
   keys, frames, patching, and native validation local by default. Reject
   all-Workers and cloud-raw-upload defaults.

**If one thing is done:** require the content-free plan/receipt and availability
check behind every named proof. Missing, empty, skipped, stale, queued, and
unexecuted work becomes red. This proposal changes no executable behavior.

## Scope, snapshot, and method

The audit applies both shared standards, contributor standards, and the brief.
Repository evidence is pinned to
`82014907256cd2e9944a2d2d31ba3c2d51cee7a1`; operational evidence was queried
2026-07-29. Every Cloudflare claim uses official documentation at that cutoff.

Terms: **source-present** is not executed; **executed** is observed output;
**operational** is observed external state; **UNVERIFIED** names missing proof.

| Reproduction                                    | Observed output                             |
| ----------------------------------------------- | ------------------------------------------- |
| `node scripts/test-collection-guard.mjs`        | `305 on disk, 305 collected, 0 uncollected` |
| `wc -l justfile`                                | `22 justfile`                               |
| `gh api repos/cat-cave/itotori/actions/runners` | `{"runners":[],"total_count":0}`            |

The result is 305, not the documented 307. The scanner covers conventionally
named TypeScript/JavaScript suites in six projects plus the database Node
manifest; it does not execute, detect skips, count Rust, or find unusual names
(`scripts/test-collection-guard.mjs`). The other outputs prove only physical
line count and repository runner registration at observation time.

## Part A — CI audit

### What the required gates actually establish

The protected branch requires `Tier 0 / required` and `Tier 1 / required`, plus
strict checks, linear history, and force-push/deletion protection.
`enforce_admins.enabled=false`: legitimate normal-merge gate, not admin-proof.
Evidence:
`gh api repos/cat-cave/itotori/branches/main/protection`.

`.github/workflows/_tier0.yml:13-47` joins four jobs;
`_tier1.yml:14-234` joins native, two TypeScript, three Rust, database, browser,
alpha, and mutation jobs. `pr-tiers.yml:6-30` covers pull requests, merge queue,
and pushes. Joins check conclusions, not executed work.

| Gate                 | Observed proof                                                                                                                                                                                                                     | Exact limit and verdict                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tier 0 metadata      | `scripts/developer-command.mjs:71-146` runs many source, schema, policy, and unit guards.                                                                                                                                          | Mostly static or fixture assertions. It runs the collection guard's unit test, not the live collection scan. **Real but narrower than named.**                                                                                               |
| Tier 0 TypeScript    | Formatting/lint/type/build checks and 12 schema files/323 tests execute (`scripts/developer-command.mjs:66,291`).                                                                                                                  | Compilation and one package's behavior only; the general TypeScript, database, and private suites are absent.                                                                                                                                |
| Tier 0 Rust          | Format/check/clippy/deny execute (`scripts/developer-command.mjs:67-70,292`).                                                                                                                                                      | No Rust behavior test executes in this job.                                                                                                                                                                                                  |
| Tier 0 manifest      | `just ci tier0-manifest` printed `manifest gate pending` and exited zero. The dispatcher checks for an absent `scripts/ci/lane-manifest-gate.mjs` (`scripts/developer-command.mjs:293-296`).                                       | **False green: no manifest was verified.** Remove the required label until implemented, or make absence fail.                                                                                                                                |
| Native               | Two release files existed and spawned in the pinned run (`_tier1.yml:14-52`).                                                                                                                                                      | Packaging smoke only; it asserts no CLI semantics and unnecessarily blocks every portable job.                                                                                                                                               |
| TypeScript shards    | The pinned run reported shard 1: 83 passing/16 skipped files and 613 passing/50 skipped tests; shard 2: 88 passing/10 skipped files and 716 passing/40 skipped tests. Measured routing had a 197-file union and zero intersection. | The union is observed once, not enforced by a receipt. Both rebuild shared packages; shard 2 also exits green after reporting all 70 database suites skipped.                                                                                |
| Rust partitions      | The pinned run executed 1,243 + 1,239 + 1,262 = 3,744 tests. Current selectors are distinct (`scripts/developer-command.mjs:305-314`).                                                                                             | Each reports a 3,895-test universe, leaving 151 candidates outside all partitions, chiefly ignored/resource tests; no reviewed ignore inventory or identifier-level union exists.                                                            |
| Strict database      | The pinned job ran all 70 database files/763 tests, then the application in database mode: 192 passing/5 skipped files and 1,404 passing/15 skipped tests (`scripts/developer-command.mjs:315-318`).                               | Genuine live-database evidence, but permission/replay receipt verifiers are not invoked. The marker guard says absence means tests ran **or were never invoked** (`scripts/assert-db-tests-not-skipped.mjs:2-21`); application skips remain. |
| Browser              | The pinned job ran 26/30 browser tests, five runtime-browser checks, and 35 visual stories at zero differing pixels (`scripts/developer-command.mjs:319-322`).                                                                     | Pinned Chromium/public fixtures only; four private cases skip. A project test setting can opt out of exact Nix/font assertions (`scripts/ci/assert-renderer-contract.mjs:19-20,47-66`).                                                      |
| Alpha                | One file and two reachability tests passed (`scripts/developer-command.mjs:221-233`).                                                                                                                                              | It cannot establish a production end-to-end path because production review/adjudication methods throw.                                                                                                                                       |
| Mutation             | Ten selected mutations were killed; nine concern one adapter family and one another (`scripts/mutation-differential.mjs`).                                                                                                         | Any non-compilation test failure counts as killed (`scripts/mutation-differential-outcome.mjs:12-22`), without a target-failure signature. It proves only these ten defects.                                                                 |
| Public lane coverage | `node scripts/ci/public-lane-coverage.mjs --check` reported ten categories “proven secretless.”                                                                                                                                    | It checks paths, markers, command strings, and shard tokens (`:243-300`), not execution. Its cited memo tests all skipped without a database (`apps/itotori/test/llm-physical-step-memo.test.ts:19-21`). **False claim.**                    |
| Environment registry | `node scripts/env-registry-guard.mjs` reported zero undeclared literal reads.                                                                                                                                                      | Its regular expression recognizes only selected literal dot/call forms (`scripts/env-registry-guard.mjs:14`). It misses dynamic reads and workflow YAML; seven undeclared production settings are therefore a current false green.           |
| File cap             | `node scripts/file-line-cap-guard.mjs` reported a 500-line absolute cap across 3,120 supported files, with no whitelist.                                                                                                           | It scans tracked `.js`, `.mjs`, `.rs`, `.ts`, and `.tsx`; it does not constrain Markdown, generated/untracked files, or unsupported extensions.                                                                                              |
| Surface budget       | `node scripts/surface-budget.mjs` reported environment names 66/66 and recipes 6/6.                                                                                                                                                | This is a tracked-text budget, not a proof that every runtime configuration read or command path is registered.                                                                                                                              |
| Required aggregators | They fail when a declared upstream job fails (`_tier0.yml:39-47`, `_tier1.yml:223-234`).                                                                                                                                           | They inherit every upstream false green and do not reject missing receipts, zero execution, or undeclared skips.                                                                                                                             |

Two historical defects must not be reported as current failures. Commit
`c59436eca` corrected the Rust partition selector, and the current run shows
three different executed counts. Commit `fba43c7b5` made the strict database
runner enumerate all 70 suites. The non-database public shard still
intentionally skips those suites and must be named accordingly. Compatibility
also remains intentionally present: the bridge package exports the v0.1
fixture contract (`packages/localization-bridge-schema/src/linecap-schema/bridge-core-types.ts:58-119`)
and the database retains the all-grant local actor
(`packages/itotori-db/src/authorization-permissions-and-local-user.ts:58-114`).
The program must delete compatibility paths at their replacement cutover, not
add another shim.

### Timing and duplicated work

The current-tree push run
`https://github.com/cat-cave/itotori/actions/runs/30475880984` succeeded in
844 seconds (14:04). The strict database job took 830 seconds, mutation 388,
native 244, metadata 192, and the three Rust jobs 205–216 seconds. The required
join therefore waited on database work.

Operational samples also miss the comments' targets: 23 successful pull
requests had median 715 seconds/p95 948; 18 merge-queue runs had median
762/p95 1,023; 16 pushes had median 881/p95 1,261. These are not code-identical
benchmarks: cache, queue, image, and commit differ. One merge run failed a
database progress assertion after 836 seconds; the next passed, and the commits
had the same parent and identical tree. That is evidence of a race, not source
regression; retries must not convert it to green.

| Structural cause          | Evidence and consequence                                                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Universal setup           | `.github/actions/setup-itotori/action.yml:1-102` installs both toolchains and restores about 177 MB in 14 jobs—about 2.48 GB/workflow—even in JavaScript, metadata, and no-op lanes.                                                                                        |
| False dependency          | Portable jobs wait for native (`_tier1.yml:54-89`); Rust partitions do not consume its release.                                                                                                                                                                             |
| Repeated build/test       | Schema tests ran four times; both TypeScript shards rebuild shared packages; database reruns the full application suite.                                                                                                                                                    |
| Serialized migration      | Each suite migrates a schema (`db-test-context.ts:6-65`) under one constant advisory lock (`migrations-control.ts:28-113`); database tests disable file parallelism and allow 90 seconds (`vitest.config.ts:3-17`). Parallelism before lock isolation would amplify flakes. |
| Ineffective compile cache | One mutation run logged two hits, 148 misses, and 829 non-cacheable compilations; one run is not a stable rate.                                                                                                                                                             |

### The missing ground truth

The real-byte oracle is source-present but not operational. Among its latest
20 scheduled runs, 19 were cancelled and one remained queued; none succeeded
or failed. The queued run completed its hosted drift job, while both
`[self-hosted,itotori-corpora]` jobs had zero steps
(`.github/workflows/real-bytes-oracle.yml:39-97`). The repository reported zero
registered runners. GitHub documents that self-hosted jobs remain queued until
a matching runner is online and fail if still unassigned after 24 hours
([self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)).
The observed daily cancellation converts infrastructure absence into no proof.

The private proof workflow has zero runs. Its dispatcher invokes only
`private-real-byte-proof.mjs --preflight`
(`scripts/developer-command.mjs:324`), so successful input checks can exit
without extract, structure, patch, replay, runtime, or evidence emission.
Artifact absence is only a warning
(`.github/workflows/real-bytes-private-proof.yml:42-47`). A PR label also
checks out that PR's code onto the corpus runner (`:18-35`), an unacceptable
trust crossing. The script hard-codes
one provider profile and one corpus
(`scripts/ci/private-real-byte-proof.mjs:44-62`), below the standard of two
independently staged real titles for each family-level claim. Its content-free
heuristic rejects recognized content keys and long strings, but unknown keys
and short text can pass (`:148-203`); that is not an absolute non-disclosure
proof.

The hosted “drift” compares a committed catalog/source manifest and still
prints that real bytes are ground truth; it inspects none
(`scripts/real-bytes-oracle.mjs:214-245`). The private lane uses a hard-coded
three-family map and parses aggregate passed counts, so an ignored real-input
test can count as passed (`scripts/real-bytes-lane.mjs:10-67,82-132`).
Synthetic parity spans 11 groups/four families/three admitted real-only
surfaces; without a successful real run, synthetic-greater-than-real parity is
**UNVERIFIED**.

### CI target and enforceable service levels

Adopt the catalog/planner/receipt design already specified in
`docs/proposals/minimal-command-config-ci-surface.md:76-270,330-370`, with
these concrete acceptance rules:

1. A committed catalog declares every check, executor, required input class,
   lane, expected test/proof identifier, and permitted skip. A generated plan
   records commit, toolchain, immutable input hashes, and exact selected set.
2. Every job emits a content-free receipt with planned, selected, started,
   executed, passed, failed, skipped, and unavailable sets plus timings. The
   aggregator requires exact set equality; empty, missing, duplicate,
   unexpected, skipped-required, or unavailable entries fail.
3. Run the live collection scan in required CI. Replace “secretless,”
   “strict,” and “end-to-end” labels with claims computed from receipts.
   Implement the manifest check or remove its required status immediately.
4. Build each shared TypeScript artifact once and distribute it. Build one
   Rust test archive and partition its inventory, then reconcile the union.
   Split setup actions by lane and remove the native dependency from consumers
   that do not use its artifact.
5. Prove schema-scoped migration isolation first, replace the global lock with
   a target-scoped mechanism or a migrated template, and only then shard
   database tests. Separate migration/setup timeouts from test timeouts.
6. Enforce Tier 0 p95 at five minutes and the complete required public gate p95
   at ten minutes over the latest 20 code-identical successful runs. A hosted
   collector must fail regression checks; until 20 comparable receipts exist,
   status is **UNVERIFIED**, not green.
7. Require two immutable, independently staged real installations per claimed
   adapter family. Mount them read-only and prove extract → structure → patch
   → re-extract → replay/runtime. Store only opaque identifiers, hashes,
   counts, tool versions, and pass/fail evidence.
8. Provision ephemeral, single-job private runners under an unprivileged
   account with root-owned configuration, read-only corpus mounts,
   per-job encrypted scratch that is wiped, pinned toolchains, deny-by-default
   egress, and external content-free logs. Never run fork or otherwise
   untrusted changes there. GitHub recommends ephemeral autoscaled runners and
   external durable logs
   ([self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners));
   exchange GitHub OIDC identity for short-lived broker credentials instead of
   storing long-lived cloud credentials
   ([GitHub OIDC guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers)).
9. A hosted watchdog fails runner pickup after ten minutes, zero-step terminal
   jobs, missing receipts, or private-proof freshness beyond 24 hours for
   affected adapter claims. Exercise the failure path daily. Enforce branch
   checks for administrators, with a separately audited break-glass event.

Rejected CI alternatives:

- Keep the no-op manifest status as a roadmap marker — rejected because a
  required green check is an assertion, not a placeholder.
- Treat the private lane as optional or cancel it silently — rejected because
  no runner then looks like no defect. Availability is part of proof.
- Add more YAML, recipe selectors, or regex guard vocabulary — rejected
  because distributed selection cannot reconcile declared and executed sets.
- Add database workers immediately — rejected because the shared advisory lock
  makes unproven parallelism a flake amplifier.
- Put private corpora on ordinary persistent self-hosted runners — rejected
  because untrusted state, credentials, and prior work can cross jobs.

## Part B — deployment audit

### Current release blockers

Exactly eight project deployment inputs are declared in
`config/environment-registry.json:1-58`: a field-cipher key, vault root,
scratch root, four container-image bindings, and a runtime secret. Preserve
that boundary. The production config nevertheless reads seven undeclared
dynamic settings—locale, four model hashes, and two cost limits—through
`env[name]` (`apps/itotori/src/services/localization-production-config.ts:20-35,91-99`).
The regex guard misses them. It also misses private CI's undeclared
`ITOTORI_ZDR_PROFILE` (`real-bytes-private-proof.yml:32-34`) and four
project-prefixed database settings in `docker-compose.yml:14-18`. Move these
choices into typed installer/admin records and binding adapters; add no project
environment variables. Standard database/provider contracts remain
provider-owned secret references, not project aliases.

Deployment is currently blocked before infrastructure selection:

- `apps/itotori/src/server.ts:140-155` parses a session, but
  `apps/itotori/src/services/database-services.ts:75-119` ignores
  `options.sessionId` and constructs the all-grant local actor. Exact
  permission constants and persisted grants exist
  (`packages/itotori-db/src/authorization-permissions-and-local-user.ts:12-56`;
  `authorization-provider-claims-and-seeds.ts:55-139`), but they are not wired
  to the request actor.
- Projects and workspaces have no account owner
  (`packages/itotori-db/src/schema-project-core.ts:16-49`). Effective
  permissions union active accounts
  (`authorization-effective-permissions.ts:29-94`), and repositories authorize
  a supplied identifier without a resource-tenant predicate. Cross-account
  isolation is absent.
- Production review and adjudication methods throw
  (`apps/itotori/src/services/database-services.ts:292,316-330`), so the
  one-project production path cannot finish.
- The server binds only loopback
  (`apps/itotori/src/server-runtime.ts:9-27`). The tracked tree has no
  application container, Cloudflare configuration, infrastructure definition,
  reverse-proxy deployment, or production object-store adapter; the compose
  file contains only PostgreSQL and no volume (`docker-compose.yml:1-23`).
  **UNVERIFIED — external deployment:** no runtime outside this repository
  could be inspected.
- Generic OIDC/SAML persistence and provider-claim logic exist, but the
  application has no identity-provider connector or login/callback route.
  **UNVERIFIED — Zitadel integration:** only generic adapters and tests were
  found; no working application flow or operational tenant was found.

### Copyright, key custody, and operator visibility

Current source units, targets, and translation-memory text are plaintext in
PostgreSQL (`packages/itotori-db/src/schema-project-core.ts:187-216`;
`packages/itotori-db/src/schema-project-style.ts:196-257`). Rebuilt model
inputs use AES-256-GCM envelopes
(`apps/itotori/src/composition/live/field-cipher.ts:74-159`), but one
operator-held master key wraps all keys and backups remain decryptable
(`:29-35`). The content authorizer ignores the requested content reference and
purpose and checks a global `content.read` permission
(`packages/itotori-db/src/llm-content-access.ts:6-24`). This is encryption at
rest, not operator blindness or object-scoped capability security.

Use explicit data classes and two honest service modes:

- **Local-only bytes:** original archives, executables, keys, audio, images,
  frames, writable trees, and native/runtime traces remain on the companion or
  self-host. Patch and re-extract there.
- **Operator-blind derived content:** a per-project content key is generated
  and retained by customer devices. The service stores ciphertext and
  user/device public-key envelopes, never an escrowed plaintext key. Model
  calls use the customer's direct provider relationship from the companion.
  The service operator cannot read content, but the model provider can;
  provider retention and legal posture are **UNVERIFIED** until contractually
  and technically demonstrated.
- **Managed-decrypt opt-in:** server-side provider calls may decrypt authorized
  units for a bounded operation. Call this managed processing, not
  operator-blind. Record consent, provider, hashes, purpose, retention policy,
  and deletion evidence.
- Capabilities must bind tenant, project, object hash, action, purpose, byte
  ceiling, egress destination, expiry, and nonce. Authorization prevents
  unauthorized calls; only customer-held cryptographic keys constrain the
  operator.

Cloud-managed encryption or customer-supplied R2 encryption is not zero
knowledge when operator-controlled code receives the key; Cloudflare documents
R2 encryption and SSE-C behavior
([R2 data security](https://developers.cloudflare.com/r2/reference/data-security/),
[R2 SSE-C](https://developers.cloudflare.com/r2/examples/ssec/)).
**UNVERIFIED — legal sufficiency:** this boundary reduces copied material and
operator access but is not a copyright/licensing conclusion; title rights,
provider terms, notices, deletion, and jurisdiction require counsel and
customer-specific evidence.

### Verified Cloudflare fit and limits

| Component               | Current official fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Decision                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers + static assets | Paid Workers have 128 MB memory, 30-second default/5-minute maximum CPU, 10,000 subrequests, six simultaneous outbound connections, and a 10 MB compressed bundle ([limits](https://developers.cloudflare.com/workers/platform/limits/)). Native child processes are compatibility stubs, WebAssembly is single-threaded, and WASI is partial ([Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)). Paid pricing starts at $5 with 10 million requests and 30 million CPU-ms; static requests are free ([pricing](https://developers.cloudflare.com/workers/platform/pricing/), [static assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). | Serve SPA/API/auth, validate capabilities, issue leases, and coordinate. Do not decode native archives or render engines here.                                          |
| Durable Objects         | One object is single-threaded with a soft approximately 1,000-request/second limit; SQLite storage is 10 GB/object and transactions are strongly consistent/serializable ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [glossary](https://developers.cloudflare.com/durable-objects/reference/glossary/)). WebSocket hibernation preserves idle connections without duration billing ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).                                                                                                                                                                                                                                                                                       | One compact coordinator per active project/run for serialized transitions and progress, not the corpus or relational authority.                                         |
| Workflows               | Workflows persist steps, retries, sleep, and external events ([overview](https://developers.cloudflare.com/workflows/), [retry model](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)). Paid limits include 25,000 steps, 1 GB state, 1 MiB event/result, 50,000 active instances, 300 new instances/second, and 30-day completed-state retention ([limits](https://developers.cloudflare.com/workflows/reference/limits/)).                                                                                                                                                                                                                                                                                                                                                    | One workflow per project/language or major operation; batch units and keep the permanent ledger elsewhere. One 27,407-unit step-per-unit run would exceed the step cap. |
| Queues                  | Messages are 128 KB, delivery is at least once, backlog is 25 GB, retention up to 14 days, and a queue supports 5,000 messages/second and 250 push consumers ([limits](https://developers.cloudflare.com/queues/platform/limits/), [delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)). DLQs are supported ([dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)).                                                                                                                                                                                                                                                                                                                                                           | Carry idempotency keys and R2 references only; batch, deduplicate, retry, and dead-letter. Never put artifacts or tenant-wide credentials in messages.                  |
| R2                      | Standard storage is $0.015/GB-month, Class A $4.50/million, Class B $0.36/million, and internet egress is free ([pricing](https://developers.cloudflare.com/r2/pricing/)). Multipart objects can approach 5 TiB; a single upload is 5 GiB ([limits](https://developers.cloudflare.com/r2/platform/limits/)). Exact-path presigned URLs and path/action-scoped temporary credentials are supported ([presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)); lifecycle rules delete by policy ([lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).                                                                                                          | Store client-encrypted, content-addressed derived artifacts, checkpoints, and signed evidence manifests. Upload directly with narrow grants.                            |
| Containers              | Linux/amd64 instances permit up to 4 vCPU, 12 GiB RAM, and 20 GB ephemeral disk; disk returns fresh after sleep ([overview](https://developers.cloudflare.com/containers/), [limits](https://developers.cloudflare.com/containers/platform-details/limits/), [architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)). Egress can be denied or host-allowlisted ([outbound controls](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)).                                                                                                                                                                                                                                                                                               | Optional CPU-native executor only after representative fit, interruption, and checkpoint benchmarks. Do not make it the universal tier.                                 |
| Hyperdrive + PostgreSQL | Hyperdrive pools existing PostgreSQL connections, but does not support advisory locks, `LISTEN/NOTIFY`, or session state; limits include about 100 origin connections/configuration and 60-second queries ([overview](https://developers.cloudflare.com/hyperdrive/), [features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/), [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)). Cached reads are not invalidated by writes ([caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)).                                                                                                                                                                                                                       | Preserve PostgreSQL for self-host/managed parity. Use cache-disabled Hyperdrive for request traffic; run migrations and lock-dependent administration directly.         |
| D1                      | Paid D1 is SQLite, has a 10 GB/database limit, processes one query at a time per database, and caps a query at 30 seconds ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Reject as primary storage: it creates a second SQL path and weaker parity.                                                                                              |
| AI Gateway              | Gateway payload logging is on by default, cache keys include the full body unless skipped, and Unified Billing adds 5% while limiting a gateway to 200 requests/60 seconds; BYOK is excluded from that specific throttle ([logging](https://developers.cloudflare.com/ai-gateway/observability/logging/), [caching](https://developers.cloudflare.com/ai-gateway/features/caching/), [pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/), [limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)). Unified Billing ZDR covers selected providers and can fall back to ordinary retention ([Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)).                                                                            | Not in the operator-blind path. If managed-decrypt adopts it, use BYOK, suppress payload logging, skip cache, and independently enforce downstream retention.           |

Cloudflare's Queue limit page states a five-minute configurable CPU maximum,
while the Workers pricing page describes Queue consumers running up to 15
minutes
([Queues limits](https://developers.cloudflare.com/queues/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
**UNVERIFIED — conflicting documentation:** the design dispatches only
references and therefore depends on neither duration.

### Target topology

```text
customer device / self-host
  companion: discover → extract → patch → re-extract → native validate
       │ signed capability; ciphertext, hashes, bounded derived units
       ▼
Cloudflare control plane
  static UI + Worker API → Workflow → Queue → qualified executor
             │                │          │
             ├─ project/run Durable Object
             ├─ external PostgreSQL through cache-disabled Hyperdrive
             └─ client-encrypted R2 checkpoints and evidence
```

The self-hosted distribution runs the same API, workflow-state machine,
PostgreSQL schema, object-storage interface, and executor protocol in one
operator-controlled installation. The managed distribution substitutes
Cloudflare bindings behind adapters; bindings do not expand the eight-input
application contract. A companion obtains an object-scoped lease, performs
full-fidelity work locally, and uploads a signed content-free receipt plus
authorized encrypted outputs. A managed CPU container may accept only adapters
whose measured image, architecture, memory, scratch, restart, and egress needs
fit the documented envelope.

Workers cannot launch the current native CLI, and one runtime path requires
Chromium (`apps/itotori/src/extract/decode-extract-runner.ts:18-123`;
`crates/utsushi-fixture/src/launch_adapters/capability_contracts.rs:17-19`).
The current localization route detaches work in the web process and writes
local files (`apps/itotori/src/services/launch-localization-pass.ts:200-262`);
runtime stores also have in-memory implementations
(`apps/itotori/src/runtime-evidence/artifact-store.ts:25-62`). It has no durable
lease/reclaim after process loss. Workflow checkpoints, at-least-once
idempotency, a DLQ, global admission, and signed terminal receipts replace it.

### Capacity and cost truth

The brief's `$2.07 / 27,407 units` is not a measured full-project result.
`roadmap/spec-dag.json:133429` derives $0.2008 from 3,159 units/324 calls and
then states an approximately $2.07 curve, but its referenced temporary report
is absent. A later record at `:133671` reports $0.135 for the same route and an
approximately $1.20 projection. The checked evidence
`docs/openrouter-integration-evidence/2026-07-11-pr78-qa-reliability.json:24-33`
enumerates 27,407 units but runs only 37: 25 accepted, 12 deferred, three
failures, cost $0.068981.

Therefore:

- **UNVERIFIED — $2.07 baseline:** no complete 27,407-unit run, receipt, token
  distribution, retry ledger, or surviving source artifact supports it.
  Simple extrapolation of $0.2008/3,159 is about $1.74, while the tiny 37-unit
  run is not representative enough to extrapolate.
- If `$2.07` is retained only as a planning scenario, 100 projects cost
  `$207 × output languages × passes` before retries, QA, revisions, and human
  review. It is a scenario, not a forecast.
- One maximum-size Container costs approximately $0.401/hour in raw overage,
  calculated from 12 GiB RAM, 4 vCPU, and 20 GB disk at Cloudflare's published
  rates, excluding allowances, egress, Workers, logging, and idle policy
  ([Container pricing](https://developers.cloudflare.com/containers/pricing/)).
- Queue pricing includes one million operations then charges $0.40/million;
  successful delivery commonly bills write, read, and delete
  ([Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/)).
  At one message per unit, 100 projects would generate about 8.22 million
  operations per language and about $2.89 after the included million, before
  retries. Batching pointers is still required for throughput and receipts.
- **UNVERIFIED FUTURE PRICING — Workflows:** the official page says billing
  begins 2026-08-10, after this audit cutoff; do not budget announced rates
  until effective and reconfirmed
  ([Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/)).

The first verified break at one current project is the throwing production
role boundary. After it is fixed, the first systems break is durable execution
and global admission: in-memory detached work cannot be reclaimed and replicas
multiply provider concurrency. At 100 projects, the model-provider token/rate
contract and human-review capacity are likely candidates for the next
bottleneck, but both are **UNVERIFIED** because languages, tokens, batch size,
quotas, retries, and reviewer throughput have not been measured. Model cost
dominance is also **UNVERIFIED** until artifact bytes, native CPU time,
retention, and complete model spend are measured.

### Program waves and dependencies

| Wave                                  | Required outcome and exit evidence                                                                                                                                                                                                                                  | Depends on                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0 — stop false green/release exposure | Remove or implement the manifest gate; run live collection; provision private runner/watchdog; require non-empty receipts. Wire session identity to actor, add account ownership/resource predicates/cross-account denial tests, and implement review/adjudication. | None. These are blockers, not optional hardening.                                   |
| 1 — one contract and trust decision   | Adopt catalog, plan, executor, capability, receipt, and eight-input typed-config schemas. Select operator-blind versus managed-decrypt semantics; define data classes, key recovery, deletion, provider retention, and legal intake.                                | Wave 0 truth and authorization boundaries.                                          |
| 2 — CI cutover                        | Build once, reconcile shard inventories, correct database lock scope, use ephemeral private runners, require two real installations per claimed family, and enforce measured p95/freshness. Delete old selectors and compatibility paths in the same cutover.       | Wave 1 schemas and a healthy runner.                                                |
| 3 — durable managed control plane     | Deploy static/API Worker, external PostgreSQL with cache-disabled Hyperdrive, project/run coordinator, stage workflows, batched queues/DLQ, encrypted R2 evidence, global admission, and operational Zitadel OIDC.                                                  | Wave 0 tenancy/roles; Wave 1 trust/config contracts; measured Cloudflare probes.    |
| 4 — hybrid executors                  | Ship signed local/self-host companion and patch/revalidation path. Qualify individual CPU adapters for Containers; route incompatible, large-scratch, or full-runtime work local/external.                                                                          | Wave 3 leasing/checkpoint protocol; key-custody decision.                           |
| 5 — capacity and adjudication         | Run full receipts across languages and passes; measure tokens, retries, bytes, CPU/scratch, provider quotas, review throughput, deletion, recovery, and cross-region behavior. Set budgets only from these distributions.                                           | Production roles, durable scheduler, qualified executors, and complete cost ledger. |

### Rejected deployment alternatives

- **All Workers/Wasm:** rejected by native process, threading, memory,
  filesystem, and CPU limits.
- **All Cloudflare Containers:** rejected because adapter fit is unmeasured,
  scratch is capped/ephemeral, interruption recovery is unproved, and GPU
  support is not documented.
- **Cloud upload of original installations:** rejected because it expands
  copyright exposure and operator visibility without being necessary for the
  control plane.
- **D1 primary database:** rejected because it breaks PostgreSQL/self-host
  parity and imposes documented size/serialization constraints.
- **Workflow step or Queue artifact per unit:** rejected because 27,407 steps
  exceed the workflow cap, messages are 128 KB, and delivery duplicates.
- **Operator master key plus authorization as “zero knowledge”:** rejected
  because operator-controlled code can decrypt; capabilities do not change key
  custody.
- **AI Gateway defaults:** rejected because payload logging and body-based cache
  keys conflict with the content boundary.
- **More deployment environment variables:** rejected because deployment
  bindings, tenant choices, and adapter metadata belong behind typed adapters,
  not in a growing process-global namespace.
- **Role-name branching for Zitadel:** rejected; map verified identity claims to
  exact persisted permissions and resource predicates.

### UNVERIFIED register

The following are load-bearing unknowns. “Could not verify” is literal, not a
work item represented as completed:

| Claim                                              | Why it is UNVERIFIED                                                                                                                                                                                                                                                                                                                                | Evidence required                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Current real-byte correctness and synthetic parity | No oracle/private run completed; current private command is preflight-only and has one corpus.                                                                                                                                                                                                                                                      | Signed receipt from two immutable real installations per claimed family, with full stage execution and mutation comparison. |
| Enforceable CI p95 targets                         | Operational samples mix commits, queues, images, and cache states; no 20 code-identical receipt set exists.                                                                                                                                                                                                                                         | Twenty comparable receipts per gate and a failing regression collector.                                                     |
| Queue consumer CPU ceiling                         | Official pages conflict between five and 15 minutes; the design deliberately relies on neither.                                                                                                                                                                                                                                                     | Reconciled official limit and a deployed probe before any CPU-heavy consumer is accepted.                                   |
| Private runner isolation                           | Zero runners exist; mount layout, broker, egress, artifact policy, wiping, and host isolation could not be inspected.                                                                                                                                                                                                                               | Ephemeral-runner provision receipt plus healthy and adversarial no-runner/untrusted-code/egress/cleanup tests.              |
| Zitadel application integration                    | Generic identity persistence/tests exist; no login/callback path or operational tenant was found.                                                                                                                                                                                                                                                   | End-to-end login, token validation, actor mapping, expiry/revocation, and cross-account denial receipt.                     |
| Existing external deployment                       | No tracked packaging/IaC/object adapter and no reachable environment was in scope.                                                                                                                                                                                                                                                                  | Immutable deploy artifact, configuration manifest, health/rollback evidence, and external observation.                      |
| Managed PostgreSQL provider/capacity               | Hyperdrive connects to an existing database; no provider, HA/backup contract, region, sizing, or price was selected.                                                                                                                                                                                                                                | Provider contract plus version, connection, failover, restore, residency, load, and invoice evidence.                       |
| Cloudflare Container adapter fit                   | No representative native image was benchmarked against 4 vCPU/12 GiB/20 GB/amd64/restarts.                                                                                                                                                                                                                                                          | Per-adapter peak RAM/scratch/CPU, cold start, interruption, checkpoint, and output-equivalence matrix.                      |
| General Container GPU and GPU need                 | Official limits enumerate CPU/RAM/disk but not general GPU devices ([limits](https://developers.cloudflare.com/containers/platform-details/limits/)); the repository has no need benchmark.                                                                                                                                                         | Official product support plus workload benchmark showing a GPU requirement and equivalent output.                           |
| Confidential/attested managed execution            | Could not verify an official Cloudflare facility that attests this native workload while hiding plaintext from the operator.                                                                                                                                                                                                                        | Documented trust boundary, attestation verifier, key release policy, and adversarial proof.                                 |
| External CPU/GPU pool                              | No provider was selected or researched outside the Cloudflare constraint.                                                                                                                                                                                                                                                                           | Provider, price, capacity, residency, egress, isolation, attestation, and failure benchmark.                                |
| Full service residency                             | Products expose different controls ([R2 location](https://developers.cloudflare.com/r2/reference/data-location/), [DO location](https://developers.cloudflare.com/durable-objects/reference/data-location/), [Container placement](https://developers.cloudflare.com/containers/platform-details/placement/)); the complete path was not exercised. | Jurisdiction-specific deployment plus storage, queue, log, database, container, backup, and provider trace.                 |
| Container lifetime/SLA                             | Restarts and ephemeral storage are documented ([FAQ](https://developers.cloudflare.com/containers/faq/)); a load-bearing per-instance lifetime guarantee was not found.                                                                                                                                                                             | Contractual SLA and chaos/recovery receipts; design must remain restart-safe regardless.                                    |
| Provider ZDR, quota, and ephemeral credentials     | Gateway ZDR is selective/fallback-capable; downstream contract and bulk quotas were not supplied.                                                                                                                                                                                                                                                   | Provider contract/config audit plus retention probe, token/request limits, fail-closed test, and credential rotation.       |
| `$2.07` full-run cost and 100-project bottleneck   | Only partial, inconsistent runs exist; no complete language/pass/retry/review distribution exists.                                                                                                                                                                                                                                                  | Full-project receipts by language/pass with calls, tokens, retries, QA, reviewer time, and accepted outputs.                |
| Model-cost dominance                               | Complete model spend, storage bytes/retention, native compute, and egress are absent.                                                                                                                                                                                                                                                               | Same-run cost ledger across every service and human stage.                                                                  |
| Operator-blind recovery/deletion                   | Customer-key topology is proposed, not implemented; backups and device loss behavior are unknown.                                                                                                                                                                                                                                                   | Threat model, multi-device envelope tests, recovery policy, deletion/backup expiry proof, and lost-key drill.               |
| Companion platform breadth                         | Current decode is local but installer, sandbox, updates, and supported OS matrix were not proven.                                                                                                                                                                                                                                                   | Signed packages, least-privilege sandbox tests, update/rollback, and representative OS receipts.                            |
| Legal sufficiency and title rights                 | Technical minimization cannot establish ownership, license, fair use, or provider terms.                                                                                                                                                                                                                                                            | Counsel-approved policy and per-customer/title rights evidence.                                                             |
| Workflow post-cutoff pricing                       | Official charges are announced for a date after the audit.                                                                                                                                                                                                                                                                                          | Recheck effective pricing and an actual invoice before making it budget authority.                                          |

## Final validation

These were rerun after the last edit. Eight token-bearing ledger lines are
omitted to preserve the zero-game-token rule; the formatter's nondeterministic
timing-only line is also omitted.

```text
$ node scripts/audit-no-game-names.mjs
game-name guard: generated ledger requires regeneration: 8 reference(s). [8 token-bearing detail lines omitted.]
game-name guard: passed. 0 enforced references across 4218 scanned files. Limit: unstructured prose names and opaque bytes need an authoritative inventory.
$ node scripts/audit-no-node-ids.mjs
node-id guard: passed. 0 references across 3685 scanned files.
Scope: all tracked files (including binary files); exempt only generated, content-addressed fixtures/, generated roadmap/, and applied packages/itotori-db/migrations/. Cannot see untracked or ignored files.
$ node scripts/file-line-cap-guard.mjs
file-line-cap guard scope: enforces a 500-line cap on tracked source files (.js: 3, .mjs: 210, .rs: 1396, .ts: 1404, .tsx: 107); scanned 3120.
file-line-cap guard limits: does not inspect untracked or ignored files, generated output not tracked by Git, or source files with other extensions.
file-line-cap guard: passed. The 500-line cap is absolute; all tracked files in the stated scope are at or below the threshold.
$ pnpm exec vp fmt --check
Checking formatting...
All matched files use the correct format.
$ git diff --check
[no output; exit 0]
```

Explicit scans of this new file reported zero name and node-id references
across one file. `wc -l docs/proposals/ci-and-deployment-program.md` reported `498`.
