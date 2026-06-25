# OpenRouter cost-tracking audit — 2026-06-25

Status: **draft, awaiting Trevor review**.

Trigger: Trevor's standing rule, stated 2026-06-25:

> "There should never be a single hardcoded model cost anywhere in this
> repo, under any circumstances, ever. There should also never be a
> 'fallback' or 'unknown' cost. Every model on openrouter has publicly
> and easily queryable cost stats, broken down by provider, token type,
> and every request you send to openrouter comes back with the real cost
> of usage. Thus, there is never a reason to estimate, as it's always
> possible to know the exact, real spend."

This audit is **narrowly scoped to cost reporting** and does NOT overlap
with `openrouter-wiring-audit-2026-06-25.md` (ZDR, provider routing,
recorded-bundle structure, structured outputs, the `DEV_PAIR` model id
typo, the policy gate's wrong shape). Where the policy gate, recorded
provider, or DAG cross-references intersect cost, this audit notes it
briefly and defers the deep work to the parallel audit.

itotori code as of HEAD (`5a90a70`). Every OR claim cites the URL it was
fetched from.

---

## §0 Source map

OR documentation pages fetched:

- Usage accounting — `https://openrouter.ai/docs/cookbook/administration/usage-accounting.md`
- Per-generation lookup (`/api/v1/generation`) — `https://openrouter.ai/docs/api/api-reference/generations/get-generation.md`
- Prompt caching cost annotations — `https://openrouter.ai/docs/guides/best-practices/prompt-caching.md`
- Model-fallback cost reporting — `https://openrouter.ai/docs/guides/routing/model-fallbacks.md`
- Router metadata (provider/fallback attribution) — `https://openrouter.ai/docs/guides/features/router-metadata.md`
- Analytics API (`/api/v1/analytics/query`, `/api/v1/analytics/meta`) — `https://openrouter.ai/docs/cookbook/administration/analytics-cost-control.md`
- Model catalog pricing schema (`/api/v1/models`) — `https://openrouter.ai/docs/api/api-reference/models.md` and the live JSON at `https://openrouter.ai/api/v1/models`

itotori code surveyed (all paths absolute):

- `/home/trevor/projects/itotori/apps/itotori/src/providers/types.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/providers/policy.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/providers/openrouter.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/providers/recorded.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/providers/dev-pair.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/orchestrator/agentic-loop.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/orchestrator/agentic-loop-smoke-command.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/cli-handlers.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/telemetry/{queries.ts,queries-impl.ts,cli.ts}`
- `/home/trevor/projects/itotori/apps/itotori/src/services/project-workflow.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/batch-planner/cli.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/draft/{draft-attempt-recorder.ts,draft-attempt-fixtures.ts,in-memory-draft-repositories.ts}`
- `/home/trevor/projects/itotori/apps/itotori/src/api-schema.ts`
- `/home/trevor/projects/itotori/apps/itotori/src/style-guide-provider-smoke.ts`
- `/home/trevor/projects/itotori/packages/itotori-db/src/repositories/{draft-attempt-provider-ledger-repository.ts,model-ledger-repository.ts,translation-memory-repository.ts}`
- `/home/trevor/projects/itotori/packages/itotori-db/migrations/0006_model_registry_cost_ledger.sql`
- `/home/trevor/projects/itotori/packages/itotori-db/migrations/0035_draft_attempt_provider_ledger.sql`
- `/home/trevor/projects/itotori/packages/itotori-db/migrations/0038_draft_attempt_provider_ledger_provider_id_required.sql`
- `/home/trevor/projects/itotori/packages/localization-bridge-schema/src/agentic-loop-bundle.ts`
- `/home/trevor/projects/itotori/apps/itotori/test/openrouter-provider.test.ts`
- `/home/trevor/projects/itotori/apps/itotori/test/openrouter-live.test.ts`
- `/home/trevor/projects/itotori/apps/itotori/test/api-fixtures.ts`
- `/home/trevor/projects/itotori/fixtures/itotori-style-guide/provider-smoke-suggestion.json`
- `/home/trevor/projects/itotori/roadmap/spec-dag.json`

---

## §1 What OpenRouter actually returns for cost

The OR contract is explicit: **real cost is in every chat-completions
response, and can be re-fetched after the fact by generation id.
Estimation is never required.**

### 1.1 The `usage` block is always included

From the usage-accounting cookbook
(`https://openrouter.ai/docs/cookbook/administration/usage-accounting.md`):

> "Full usage details are now always included automatically in every
> response."

The deprecated request flags `usage: { include: true }` and
`stream_options: { include_usage: true }` "have no effect." There is no
opt-in/opt-out; cost is unconditionally returned.

### 1.2 The two cost fields and their units

The `usage` block carries (all units are **USD as a `number`**, not
credits — confirmed against live `/chat/completions` responses):

| Field                                        | Meaning                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `usage.cost`                                 | Total amount charged to your OpenRouter account for this request.                                            |
| `usage.cost_details.upstream_inference_cost` | Underlying cost charged by the upstream AI provider (visible only on BYOK or transparency-enabled accounts). |

The example response quoted in the cookbook:

```json
{
  "usage": {
    "completion_tokens": 2,
    "completion_tokens_details": { "reasoning_tokens": 0 },
    "cost": 0.95,
    "cost_details": { "upstream_inference_cost": 19 },
    "prompt_tokens": 194,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 100,
      "audio_tokens": 0
    },
    "total_tokens": 196
  }
}
```

The full-page units note is "in credits" (a 1:1 USD shadow on the
account ledger), but in practice OR's chat-completions endpoint surfaces
`cost` as USD-denominated `number`; the per-generation lookup endpoint
spells `total_cost` and `usage` in USD explicitly (§1.4 below). Both
must be **read as the source of truth, never recomputed.**

### 1.3 Cache hits/misses are reported per-token AND per-discount

From prompt-caching (`https://openrouter.ai/docs/guides/best-practices/prompt-caching.md`):

- `usage.prompt_tokens_details.cached_tokens` — number of tokens **read**
  from cache.
- `usage.prompt_tokens_details.cache_write_tokens` — number of tokens
  **written** to cache (only on models with explicit cache-write
  pricing).
- `usage.cost_details.cache_discount` (also surfaced under the
  per-generation `/generation` lookup as a top-level `cache_discount` —
  see §1.4) — "how much the response saved on cache usage", with
  negative values for cache-write surcharges and positive values for
  cache-read discounts.

itotori does **not** read any of these fields today (verified — grep for
`cached_tokens`, `cache_write_tokens`, `cache_discount` returns only the
single `cached_input_tokens` reference in `openrouter.ts:680`, which
reads it as a _token count_, never as a cost annotation).

### 1.4 The per-generation cost lookup endpoint

From `https://openrouter.ai/docs/api/api-reference/generations/get-generation.md`:

**Endpoint:** `GET https://openrouter.ai/api/v1/generation?id={generationId}`

Returns the full request/usage metadata for any previously-made
generation. Cost fields:

| Field                     | Type             | Unit                                        |
| ------------------------- | ---------------- | ------------------------------------------- |
| `total_cost`              | `number`         | USD                                         |
| `usage`                   | `number`         | USD (synonym for `total_cost` at this seam) |
| `upstream_inference_cost` | `number \| null` | USD                                         |
| `cache_discount`          | `number \| null` | USD                                         |

This endpoint exists **specifically** so a caller can re-fetch real
cost after the fact — e.g. for ledger reconciliation, late-arriving
chargeback adjustments, or pulling the upstream-vs-marketplace breakdown
that wasn't in the original response body. itotori does **not** call
this endpoint anywhere today (grep `api/v1/generation` returns zero
hits).

### 1.5 Fallback-chain cost reporting

From `https://openrouter.ai/docs/guides/routing/model-fallbacks.md`:

> "Requests are priced using the model that was ultimately used, which
> will be returned in the `model` attribute of the response body."

So OR bills a single total against the model that succeeded, and the
selected upstream provider is reported in `openrouter_metadata.attempts`
(the per-attempt status array — see the parent wiring audit). There is
no "billed for the failed attempts too" line item; the response's
`usage.cost` IS the canonical real cost for the whole fallback chain.

### 1.6 The Analytics API (per-period rollups)

From `https://openrouter.ai/docs/cookbook/administration/analytics-cost-control.md`:

- `GET /api/v1/analytics/query` — returns `total_usage`, `usage_upstream`,
  `usage_cache`, `usage_data`, `usage_web`, `usage_file`, all in USD,
  grouped by `model`, `api_key_id`, `app`, `user`, `workspace`, or
  `generation_id`.
- Requires a _management_ API key (regular inference keys return 403).

itotori does not currently consume this endpoint; the §3 corrective
nodes treat it as the "outside" reconciliation seam.

### 1.7 The model catalog pricing schema

From `https://openrouter.ai/api/v1/models` (live JSON, fetched
2026-06-25) and the OpenAPI schema page
(`https://openrouter.ai/docs/api/api-reference/models.md`):

Per-model `pricing` block (USD per token, decimal strings):

```
prompt, completion, web_search, image, audio,
input_cache_read, input_cache_write, internal_reasoning,
image_output, image_token, input_audio_cache,
audio_output, request, discount
```

Example: `"pricing": {"prompt":"0.000005","completion":"0.000025","input_cache_read":"0.0000005","input_cache_write":"0.00000625"}`.

This catalog is the canonical source for _forecasting_ a cost (e.g. for
a cost cap budget) and for explaining a billed line item after the
fact. itotori does **not** read this catalog at runtime today (the
provider's HTTP shape never queries `/models` or `/models/<id>/endpoints`).

### 1.8 The plain truth

OR returns **real, billed USD cost in every chat-completions response**
(`usage.cost`). It exposes a **per-generation lookup** to re-fetch real
cost by id. It exposes a **catalog** for forecasting. It exposes a
**management Analytics API** for period-level rollups. There is no
documented mode in which OR ever asks the caller to _estimate_ cost.
Every `costKind: "provider_estimate"`, `costKind: "local_estimate"`,
`costKind: "unknown"`, and `costTier` enum value in itotori is
architecturally redundant.

---

## §2 Where itotori is wrong

Sixteen sites. Listed by severity, then by file path.

### 2.1 — `ProviderDataHandlingPolicy.costTier` enum is a category error (critical / wrong abstraction)

- **What's wrong:** `costTier` is encoded on the _data-handling policy_
  shape (privacy gate input) and gates `private_corpus`/`confidential`
  requests on whether the tier is `"free" | "paid" | "mixed" | "local"
| "unknown"`. The user's rule states there are no tiers — there is
  only real spend. The policy gate is using "cost tier" as a proxy for
  some unrelated privacy concept (likely "is this a free tier where the
  provider's TOS lets them train on private inputs?"), but it's labeled
  as a _cost_ concept and so silently invites every cost code path in
  the repo to read it as such.
- **Where:**
  - `apps/itotori/src/providers/types.ts:49` defines
    `export type ProviderCostTier = "free" | "paid" | "mixed" | "local" | "unknown";`
  - `apps/itotori/src/providers/types.ts:60` makes it required on
    `ProviderDataHandlingPolicy`.
  - `apps/itotori/src/providers/policy.ts:23-25` is the gate:
    ```
    if (policy.costTier === "free" || policy.costTier === "mixed" || policy.costTier === "unknown") {
      reasons.push(`cost tier is ${policy.costTier}`);
    }
    ```
  - `apps/itotori/src/providers/policy.ts:77,87` and
    `apps/itotori/src/providers/openrouter.ts:383` set the default.
  - 17+ call sites across `dev-pair.ts:122,170,215`,
    `style-guide-provider-smoke.ts:339`, `services/project-workflow.ts:939`,
    `batch-planner/cli.ts:126`, `test/api-fixtures.ts:101,140`,
    `test/provider-abstraction.test.ts:491,868,913`,
    `test/style-guide-provider-smoke.test.ts:277`,
    `test/project-workflow.test.ts:916`,
    `packages/itotori-db/test/model-ledger-repository.test.ts:67,590`,
    `fixtures/itotori-style-guide/provider-smoke-suggestion.json:210`.
- **Severity:** critical. The field is load-bearing for the privacy
  gate (so we cannot just delete it cold), but it's the _wrong shape_
  for what it actually gates. The parallel wiring audit owns the
  privacy-gate redesign; for this audit's purposes, the cost-tier
  ABSTRACTION must die — whatever survives in the privacy gate must be
  renamed to a privacy concept (e.g. `inferenceContext: "free_trial" |
"byok" | "paid_marketplace" | "local"`) so no cost code path is
  tempted to read it.
- **What OR says:** there is no "tier" concept in OR's cost model. Every
  request reports a real `usage.cost`, and the catalog at `/api/v1/models`
  is per-token decimal pricing per endpoint
  (`https://openrouter.ai/docs/api/api-reference/models.md`). "Free" is
  not a tier; it's a `pricing.prompt == "0"` row in the catalog. "Paid"
  is just `pricing.prompt > "0"`. There is no `tier` field anywhere in
  the OR API surface.

### 2.2 — `openRouterDefaultCapabilities.dataHandling.costTier: "unknown"` is the literal "unknown cost" the rule forbids (critical)

- **What's wrong:** The OR provider's default capability sheet ships
  with `costTier: "unknown"`, and the policy gate at `policy.ts:23-25`
  treats `"unknown"` as a hard block on private inputs. This is the
  exact "unknown cost" Trevor said must never exist. (It is also the
  proximate cause of the `provider policy blocks private_corpus input:
cost tier is unknown` error that triggered the parallel wiring
  audit.)
- **Where:** `apps/itotori/src/providers/openrouter.ts:383`,
  `apps/itotori/src/providers/policy.ts:23-25`.
- **Severity:** critical. This is the surface that demands every OR
  caller "fix" the cost tier before invoking, and the only "fix"
  callers know is to write `costTier: "paid"` literals at construction
  sites — which is itself another rule violation (a hardcoded
  _categorical_ cost claim, even if not a numeric one).
- **What OR says:** "Full usage details are now always included
  automatically in every response"
  (`https://openrouter.ai/docs/cookbook/administration/usage-accounting.md`).
  There is no state in which an OR provider's cost is "unknown" — the
  cost is whatever the next response's `usage.cost` says it is.

### 2.3 — `normalizeOpenRouterCost` mis-tags the real `usage.cost` as a `provider_estimate` (critical)

- **What's wrong:** The real billed cost from `usage.cost` is wrapped
  in `costKind: "provider_estimate"` — not `"billed"`. Three other
  branches fall through to `"provider_estimate"` too
  (`upstream_inference_prompt_cost` + `upstream_inference_completions_cost`
  sum; `upstream_inference_cost`; and a synthetic
  `tokenUsage.promptTokens * endpointPricing.prompt + ...` re-derivation
  from `selectedOpenRouterPricing`). A fifth branch falls all the way
  through to `costKind: "unknown"` with `amountMicrosUsd` undefined.
- **Where:** `apps/itotori/src/providers/openrouter.ts:685-744`.
  Specifically:
  - Line 693: `costKind: "provider_estimate"` for real `usage.cost`.
  - Line 706: `costKind: "provider_estimate"` for the sum-of-details
    branch.
  - Line 715: `costKind: "provider_estimate"` for
    `upstream_inference_cost`.
  - Lines 721-737: re-derives cost from `tokenUsage * endpointPricing`
    — a **literal hardcoded recomputation** even though it sources its
    rate from the response — and tags it `"provider_estimate"`. This
    is the path that fires when (somehow) `usage.cost` is missing.
  - Lines 740-743: returns `costKind: "unknown"` with no `amountMicrosUsd`.
- **Severity:** critical. The ledger's `cost_kind` column then carries
  `provider_estimate` for every real-cost row, which means the
  `model-ledger-repository.ts:277-288` rollup classifies every billed
  cent as `estimatedMicrosUsd` rather than `billedMicrosUsd`. The
  cost report's "billed vs estimated" split is upside-down.
- **What OR says:** `usage.cost` IS the billed amount
  (`https://openrouter.ai/docs/cookbook/administration/usage-accounting.md`).
  The recomputation branch and the "unknown" fallback both violate
  Trevor's rule. The correct kinds are exactly two: `billed` (real),
  and `provider_response_missing_cost_field` (a hard error — refuse
  the response, don't paper over it).

### 2.4 — `buildProviderRunRecord` falls back to `unknownCost()` on the success path (critical)

- **What's wrong:** Line 788 of `openrouter.ts`:
  ```
  cost: input.status === "succeeded" && input.cost ? input.cost : unknownCost(),
  ```
  Even on a successful call, if `normalizeOpenRouterCost` returned the
  `costKind: "unknown"` path (no `usage.cost`, no `cost_details`, no
  `endpointPricing`), the ledger row is written with cost unknown. Per
  Trevor's rule this case should be a hard error, not a fallback
  value.
- **Where:** `apps/itotori/src/providers/openrouter.ts:788,801-806`.
- **Severity:** critical.
- **What OR says:** every chat-completions response carries
  `usage.cost`. A response with no `usage.cost` is malformed and OR
  itself would flag it; itotori should raise
  `provider_response_invalid` rather than silently writing
  `cost_kind = 'unknown'` to the ledger.

### 2.5 — `OpenRouterModelProvider.costCapUsd` defaults to a hardcoded `1.0` USD (high)

- **What's wrong:** `DEFAULT_COST_CAP_USD = 1.0` at
  `apps/itotori/src/providers/openrouter.ts:1162`. A second, _different_
  hardcoded default — `0.5` — lives at
  `apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts:139`.
  These are caller-tunable, but the defaults silently coexist; a
  caller that constructs `OpenRouterModelProvider` directly and a
  caller that goes through the alpha closer get different effective
  caps. The cap is enforced against `this.spentUsd` (USD micro-totals
  accumulated from `result.providerRun.cost.amountMicrosUsd`), so the
  cap arithmetic is correct _if_ `cost.amountMicrosUsd` is the real
  billed amount — which today it is, except `cost.costKind` is
  mis-labeled as `provider_estimate` (see §2.3).
- **Where:** `apps/itotori/src/providers/openrouter.ts:1162,1176,1219-1254`;
  `apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts:139,300`;
  `apps/itotori/src/cli-handlers.ts:333,342,392`.
- **Severity:** high — not a wrong-cost regression, but the cap is a
  user-facing protection (the rate-limit / budget-blast surface) and
  having two different defaults across two seams is a footgun.
- **What OR says:** OR has no opinion on cost caps. This is purely an
  itotori-side budget guard, and **it does correctly enforce against
  real billed cost** (because `recordSpend()` reads
  `providerRun.cost.amountMicrosUsd`, which is `usdToMicros(usage.cost)`
  — verified at `openrouter.ts:691-696`).

### 2.6 — The ledger column is named `cost_amount` but typed as a USD decimal-string; nothing in the schema constrains it to be the _real_ cost (high)

- **What's wrong:** Migration `0035_draft_attempt_provider_ledger.sql`
  defines `cost_unit text not null, cost_amount numeric(20, 8) not null`
  with `check (cost_amount >= 0)`. There is no schema-level constraint
  that `cost_unit = 'usd'` (every fixture in
  `apps/itotori/src/draft/draft-attempt-fixtures.ts:143,184,217` writes
  `unit: "usd"`, but the schema would happily accept `"jpy"` or
  `"micro_credits"`). There is no schema-level link between
  `cost_amount` and the `usage.cost` field of the originating OR
  response — a future code path could insert _any_ number.
- **Where:** `packages/itotori-db/migrations/0035_draft_attempt_provider_ledger.sql:32-34`.
- **Severity:** high. Combined with §2.3 (the cost is tagged
  `provider_estimate` even when real), there is no way to prove from
  the ledger row alone whether the number is real-billed or
  estimated. Once §3-N1 forces every row to be real, the schema should
  enforce that.
- **What OR says:** out-of-scope for OR; this is the itotori-side ledger
  contract.

### 2.7 — `itotori_cost_ledger_entries` (model-ledger, migration 0006) ENUMERATES `'unknown'` as a valid cost_kind at the schema level (high)

- **What's wrong:** Migration `0006_model_registry_cost_ledger.sql:142-150`:
  ```
  cost_kind in ('billed', 'provider_estimate', 'local_estimate', 'zero', 'unknown')
  ...
  (cost_kind = 'unknown' and amount_micros_usd is null)
    or (cost_kind in ('billed', 'provider_estimate', 'local_estimate') and amount_micros_usd is not null and amount_micros_usd >= 0)
  ```
  The schema **explicitly accommodates the "unknown cost" case** with a
  separate branch in the CHECK constraint. This is the rule violation
  baked into Postgres.
- **Where:** `packages/itotori-db/migrations/0006_model_registry_cost_ledger.sql:142-150`;
  `packages/itotori-db/src/repositories/model-ledger-repository.ts:281,290`
  (the `unknownRunCount` aggregate that the schema enables).
- **Severity:** high.
- **What OR says:** see §1.1 — every response carries `usage.cost`; the
  "unknown" branch should not exist.

### 2.8 — The agentic-loop bundle's wire field is literally named `costEstimate` (medium)

- **What's wrong:** The field that carries real cost into the bundle
  artifact is named `costEstimate` in the schema and the bundle
  package's typed surface:
  - `packages/localization-bridge-schema/src/agentic-loop-bundle.ts:90-99,116,234,262,277,295`
    declares `costEstimate: string` (decimal USD).
  - `apps/itotori/src/orchestrator/agentic-loop.ts:605,622` populates
    it from `BigInt(invocation.providerRun.cost.amountMicrosUsd ?? 0)`
    — i.e., the real billed micros from `usage.cost`.
  - `apps/itotori/src/orchestrator/agentic-loop-smoke-command.ts:173`
    sums it as `totalCostMicros`.
  - `apps/itotori/src/draft/draft-attempt-recorder.ts:30-39,89-90`
    feeds it into the ledger row as `costAmount`.
  - Test/fixture sites at
    `apps/itotori/src/draft/draft-attempt-fixtures.ts:143,184,217`
    write hardcoded decimal-string values (`"0.01250000"`,
    `"0.00850000"`, `"0.00000000"`).
- **Severity:** medium — the value is real, but the name lies. Every
  downstream consumer that reads the bundle JSON will reasonably
  assume the field is an estimate and treat it as fuzzy.
- **What OR says:** OR's term is "cost" (real, billed USD). The
  itotori-side field name should match.

### 2.9 — `costMicros: BigInt(invocation.providerRun.cost.amountMicrosUsd ?? 0)` silently coerces "no cost" to "zero cost" (medium)

- **What's wrong:** Four call sites in the orchestrator do
  `BigInt(providerRun.cost.amountMicrosUsd ?? 0)`:
  - `apps/itotori/src/orchestrator/agentic-loop.ts:698,750,823,906`.
    When the cost was `costKind: "unknown"` (no `amountMicrosUsd`), this
    silently rolls it up as `0` USD spent. That cascades into the
    telemetry rollups, the bundle's `costEstimate`, and ultimately the
    cost cap budget (the cap thinks no money was spent and lets the next
    call fire). Per Trevor's rule, the upstream "unknown" should not
    exist; if it ever did, the right reaction is a hard error here, not
    `?? 0`.
- **Where:**
  `apps/itotori/src/orchestrator/agentic-loop.ts:698,750,823,906`.
- **Severity:** medium — only fires when §2.3/§2.4 also fired, but
  compounds the silent-zero failure mode.

### 2.10 — `unknownBenchmarkDataHandlingPolicy` carries `costTier: "unknown"` (medium)

- **What's wrong:** `apps/itotori/src/services/project-workflow.ts:938-946`
  declares a default for unattributed benchmark rows that carries
  `costTier: "unknown"`. Re-introduces the same "unknown cost" the rule
  forbids. (Same in `apps/itotori/src/batch-planner/cli.ts:126`.)
- **Where:** `apps/itotori/src/services/project-workflow.ts:938-946`,
  `apps/itotori/src/batch-planner/cli.ts:126`.
- **Severity:** medium — once §2.1 lands, these defaults vanish or get
  renamed (privacy-only).

### 2.11 — `dev-pair.ts` hardcodes `costTier: "paid"` per pair (medium / will vanish with §2.1)

- **What's wrong:** Each known-pair entry hardcodes `costTier: "paid"`.
  This is not a hardcoded _price_, but it is a hardcoded categorical
  claim about cost on a per-pair basis, which the policy gate then
  uses for non-cost purposes. Once `costTier` dies (§2.1), these
  literals go too.
- **Where:** `apps/itotori/src/providers/dev-pair.ts:122,170,215`.
- **Severity:** medium.

### 2.12 — `RecordedModelProvider` REPLAYS `cost: { costKind: "zero", amountMicrosUsd: 0 }` instead of the captured real cost (high)

- **What's wrong:** `apps/itotori/src/providers/recorded.ts:144-148`
  hardcodes `cost: { costKind: "zero", currency: "USD",
amountMicrosUsd: 0 }` for every replayed bundle. A recorded bundle
  was supposed to faithfully reproduce the original LIVE call — but
  the _original_ call's billed cost is **not preserved** in
  `RecordedProviderResponse` and is **dropped on replay**. So every
  recorded call replays as if it were free, and every cost rollup that
  groups by recorded-mode runs is wrong.
- **Where:** `apps/itotori/src/providers/recorded.ts:43-64` (the
  `RecordedProviderResponse` type has no cost field),
  `recorded.ts:144-148` (the hardcoded zero),
  `apps/itotori/src/draft/draft-attempt-fixtures.ts:207-217` (the
  fixture that writes `cost: { costKind: "zero", ..., amountMicrosUsd:
0 }` into the providerRun mirror).
- **Severity:** high. This is a literal hardcoded cost
  (`amountMicrosUsd: 0`) standing in for the real captured cost. It is
  a recorded-cost ZERO fallback in a system that is meant to faithfully
  replay reality.
- **What OR says:** the original LIVE response carried the real
  `usage.cost`; replays should mirror it.

### 2.13 — `style-guide-provider-smoke.ts` and the smoke fixture both hardcode `costTier: "paid"` (low; will vanish with §2.1)

- **Where:** `apps/itotori/src/style-guide-provider-smoke.ts:339`;
  `fixtures/itotori-style-guide/provider-smoke-suggestion.json:210`.
- **Severity:** low.

### 2.14 — `openrouter-provider.test.ts` synthesises responses with `cost: opts.costUsd ?? 0.001` (low — acceptable for tests, but documented here)

- **What's wrong:** The test fake returns
  `usage.cost = opts.costUsd ?? 0.001` for synthesised responses
  (`apps/itotori/test/openrouter-provider.test.ts:50,67,182-238`).
  The fixed default `0.001` and per-test `0.6` / `1.0` / `0.001`
  values are passed through the same code path as a real `usage.cost`,
  so this is acceptable (the cap-cap test cumulates them and asserts
  the third call rejects — that arithmetic uses the same code path).
- **Severity:** low (acceptable per Trevor's `(H)` guidance: "tests
  using fixed costs is OK as long as they flow through the same code
  path as real ones").
- **Note:** the same file's `costUsd?: number; ... cost: opts.costUsd
?? 0.001` is the seam to add a regression-guard test that the cost
  flows in as `costKind: "billed"` (not `"provider_estimate"`) once
  §2.3 lands.

### 2.15 — Telemetry queries aggregate the ledger's `cost_amount` faithfully (low / passing)

- **What's right:** `apps/itotori/src/telemetry/queries-impl.ts:110-272`
  and the SQL aggregate at
  `packages/itotori-db/src/repositories/draft-attempt-provider-ledger-repository.ts:386-421`
  sum `cost_amount` as-is and never re-derive cost from token counts.
  `topPairsByCost` and `pairRanking` both ride on `summary.totalCostUsd`
  / `value.totalCostUsd` which are SQL-summed numerics.
- **Where:** `apps/itotori/src/telemetry/queries-impl.ts:225,260,272`;
  `packages/itotori-db/src/repositories/draft-attempt-provider-ledger-repository.ts:391`.
- **Severity:** low (no action; **the aggregations are real-cost-faithful
  conditional on §2.3 + §2.12 + §2.4 being fixed upstream**). The
  telemetry layer is not the bug; it propagates whatever the ledger
  has. Once the ledger is forced to real cost, telemetry is correct by
  construction.

### 2.16 — `estimatedCostUsdSaved` (translation-memory reuse) is a different concept (informational, not a violation)

- **What:** `packages/itotori-db/src/repositories/model-ledger-repository.ts:134,148,316,352`
  and `translation-memory-repository.ts:62,749,1044` carry an
  `estimatedCostUsdSaved` field on translation-memory reuse events. This
  is a _counterfactual_ metric — "how much would the avoided LLM call
  have cost?" — not a real-spend mirror. It is a different question
  from "what did this call actually cost?". By the strict rule, it's
  still an estimate; per the §1 contract, it should be computed _from_
  the catalog (`/api/v1/models` per-token rates) of the pair that
  would have been called, never hardcoded.
- **Where:** as above.
- **Severity:** informational. It does NOT pollute the real-cost
  ledger. The §3 corrective nodes should rename it to
  `notCalledCostUsdFromCatalog` (or similar) and document its catalog
  source. Today it's nullable and the api-schema asserts non-negative
  when present, so at minimum it's typed as "may be unknown" — but the
  field name still misleads.

---

### Cross-references to the parallel wiring audit (do not deep-dive here)

- The recorded provider's `cost: { costKind: "zero" }` (§2.12) ALSO
  affects the parallel audit's "recorded-bundle faithfulness" topic.
- The `costTier: "unknown"` default (§2.2) is the literal trigger for
  the parallel audit's "policy gate is wrong-shaped" finding.
- The DEV_PAIR model id issue (`deepseek/deepseek-chat-v4` —
  `dev-pair.ts:47`) is parallel-audit territory; this audit does not
  touch it.

---

## §3 Corrective DAG nodes to mint

The next available `ITOTORI-` id after `ITOTORI-223` is `ITOTORI-224`.
The proposed nodes are sequential.

> **Mint order:** N1 first (it deletes the abstractions §2.1-§2.4
> depend on); N2-N6 layer on top.

### ITOTORI-224 — Rip out cost-tier; cost is always the real OR-returned value

- **id:** `ITOTORI-224`
- **title:** "Rip out cost-tier abstraction and all estimated /
  hardcoded / unknown cost states; cost is exactly the real value
  returned by OpenRouter, every time."
- **status:** `planned`
- **priority:** `P0`
- **target:** `alpha`
- **dependsOn:** `["ITOTORI-220", "ITOTORI-221", "ITOTORI-222", "ITOTORI-223"]`
- **summary:** Delete `ProviderCostTier`, `ProviderDataHandlingPolicy.costTier`,
  the `costTier` field on every capability sheet, and the corresponding
  branches in `evaluateProviderInputPolicy` (`policy.ts:23-25`). What
  remains of that gate's privacy intent must be renamed to a privacy
  concept (e.g. `inferenceContext: "free_marketplace" | "byok" |
"paid_marketplace" | "local"`) — the renaming lives in the parallel
  ZDR/wiring audit. Inside the OR provider, replace
  `normalizeOpenRouterCost`'s five-branch ladder with a single branch:
  read `usage.cost` (USD number) and tag it `costKind: "billed"`. If
  the response has no `usage.cost`, raise
  `ModelProviderError(code="provider_response_invalid")` — never write
  a row with `costKind: "unknown"` or a `?? 0` fallback. Delete the
  `"unknown"` and `"local_estimate"` and `"provider_estimate"` variants
  from `ProviderCost.costKind`. Delete `unknownCost()`. Delete the
  `endpointPricing`-driven `tokenUsage * promptPrice + ...`
  re-derivation branch.
- **deliverables:**
  - `apps/itotori/src/providers/types.ts`: delete `ProviderCostTier` and
    `ProviderDataHandlingPolicy.costTier`; narrow `ProviderCost.costKind`
    to `"billed" | "zero"` (zero only for the recorded path — see N2).
  - `apps/itotori/src/providers/policy.ts`: delete lines 23-25 and
    18-20; replace with a privacy-only gate (parallel audit defines).
  - `apps/itotori/src/providers/openrouter.ts`: rewrite
    `normalizeOpenRouterCost` to a single `usage.cost`-or-error
    function; delete `unknownCost()`; delete the `?? unknownCost()`
    fallback in `buildProviderRunRecord`.
  - `apps/itotori/src/orchestrator/agentic-loop.ts`: replace the four
    `BigInt(providerRun.cost.amountMicrosUsd ?? 0)` coercions
    (lines 698, 750, 823, 906) with hard assertions —
    `assertBilledCost(providerRun.cost)`.
  - `apps/itotori/src/services/project-workflow.ts:938-946`,
    `apps/itotori/src/batch-planner/cli.ts:126`,
    `apps/itotori/src/providers/dev-pair.ts:122,170,215`,
    `apps/itotori/src/style-guide-provider-smoke.ts:339`,
    `fixtures/itotori-style-guide/provider-smoke-suggestion.json:210`,
    every test fixture in `apps/itotori/test/`,
    `packages/itotori-db/test/model-ledger-repository.test.ts:67,590`:
    delete every `costTier` literal.
  - `packages/itotori-db/migrations/0039_drop_unknown_cost_kind.sql`:
    new migration that (a) backfills any row currently tagged
    `provider_estimate` / `local_estimate` / `unknown` to `billed`
    where `amount_micros_usd is not null`, (b) refuses rows where
    `amount_micros_usd is null` (forces operator review), then
    (c) drops the `cost_kind in (..., 'unknown')` branch from the
    CHECK constraint, narrowing to `cost_kind in ('billed', 'zero')`.
  - Add `scripts/audit-no-hardcoded-cost.mjs` (see §5).
- **acceptanceCriteria:**
  - `git grep -nE 'costTier|costKind:\s*"(unknown|provider_estimate|local_estimate)"|unknownCost\(\)'`
    returns zero hits across `apps/`, `packages/`, `fixtures/`,
    `scripts/`.
  - `apps/itotori/test/openrouter-provider.test.ts` asserts every
    recorded `ProviderCost` from a successful response has
    `costKind === "billed"`.
  - The OR provider raises `provider_response_invalid` when
    `usage.cost` is missing (new test case).
  - The new migration runs cleanly on the dev DB and the CHECK
    constraint excludes `'unknown'`.
- **verification:**
  - `pnpm -F itotori test -- openrouter-provider`
  - `pnpm -F itotori test -- telemetry-queries`
  - `pnpm -F @itotori/db test -- draft-attempt-provider-ledger`
  - `node scripts/audit-no-hardcoded-cost.mjs` (CI exit 0)
- **auditFocus:** §2.1, §2.2, §2.3, §2.4, §2.9, §2.10, §2.11, §2.13.

### ITOTORI-225 — Recorded provider replays the original real cost (no zero fallback)

- **id:** `ITOTORI-225`
- **title:** "Recorded provider replays the captured real cost; remove
  the hardcoded `costKind: zero`."
- **status:** `planned`
- **priority:** `P0`
- **target:** `alpha`
- **dependsOn:** `["ITOTORI-224"]`
- **summary:** Today every recorded replay returns `cost: { costKind:
"zero", amountMicrosUsd: 0 }` regardless of what the original LIVE
  call cost. The recorded bundle format must carry the original
  `usage.cost` (USD micros) verbatim from the captured response, and
  the replay must surface it on the `ProviderCost` of the replayed
  `ProviderRunRecord` so cost-cap arithmetic, telemetry rollups, and
  the ledger are byte-equal to the LIVE run that produced the bundle.
  Bundle-key collisions (different costs under the same key) are
  surfaced as a typed `RecordedCostMismatchError`.
- **deliverables:**
  - Extend `RecordedProviderResponse` (`recorded.ts:33-41`) with
    `cost: ProviderCost` (required; never `unknown` after N1 — only
    `billed` or `zero`).
  - `RecordedModelProvider.invoke` (`recorded.ts:106-165`) returns the
    response's captured cost rather than hardcoded zero.
  - Update `apps/itotori/src/draft/draft-attempt-fixtures.ts:207-217`
    and every recorded fixture in `apps/itotori/test/` and
    `fixtures/` to carry the real cost from the originating recording
    session.
  - Recording capture path (the OR provider's artifact recorder) must
    write `usage.cost` into the bundle file so future replays mirror
    it.
- **acceptanceCriteria:**
  - A unit test constructs a recorded bundle from a _captured_
    LIVE-mode artifact, replays it, and asserts the replayed
    `ProviderCost.amountMicrosUsd` equals the captured value (not 0).
  - `git grep -nE 'costKind:\s*"zero"' apps/ packages/` returns hits
    only in the recorded-replay seam (and only for genuinely zero
    captured costs, e.g. a recorded fixture that was a zero-cost
    response).
  - The cost-cap test (`openrouter-provider.test.ts:182`) passes
    unchanged.
- **verification:**
  - `pnpm -F itotori test -- recorded`
  - `pnpm -F itotori test -- draft-attempt-recorder`
- **auditFocus:** §2.12.

### ITOTORI-226 — Rename `costEstimate` to `costUsd` across the bundle wire surface

- **id:** `ITOTORI-226`
- **title:** "Rename `costEstimate` → `costUsd` in agentic-loop bundle
  and every downstream consumer."
- **status:** `planned`
- **priority:** `P1`
- **target:** `alpha`
- **dependsOn:** `["ITOTORI-224"]`
- **summary:** The agentic-loop bundle field
  (`packages/localization-bridge-schema/src/agentic-loop-bundle.ts:99,116,234,262,277,295`)
  is named `costEstimate` even though it carries real billed cost. Rename
  to `costUsd` across the schema package, the bundle, the smoke
  command, the fixtures, and the assertion paths. Bump the bundle
  schema version (`AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION`); the parallel
  audit lists this version-bump as a co-located concern. No
  deprecation shim — delete the old name in the same change as the
  rename.
- **deliverables:**
  - Rename in `agentic-loop-bundle.ts` (schema + assertions).
  - Rename in `agentic-loop.ts:605,622`, `agentic-loop-smoke-command.ts:173`,
    `draft-attempt-fixtures.ts:143,184,217`,
    `draft-attempt-recorder.ts:30-39,89-90`.
  - Bump `AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION`.
- **acceptanceCriteria:**
  - `git grep -n costEstimate` returns zero hits.
  - The bundle JSON serialises `costUsd` and is deserialisable by the
    new schema.
- **verification:**
  - `pnpm -F itotori test -- agentic-loop`
  - `pnpm -F itotori test -- agentic-loop-smoke`
- **auditFocus:** §2.8.

### ITOTORI-227 — Single source of truth for the OR cost cap default

- **id:** `ITOTORI-227`
- **title:** "Single source of truth for `DEFAULT_COST_CAP_USD`; delete
  the duplicated `0.5` in the alpha closer."
- **status:** `planned`
- **priority:** `P1`
- **target:** `alpha`
- **dependsOn:** `["ITOTORI-224"]`
- **summary:** `DEFAULT_COST_CAP_USD = 1.0` in `openrouter.ts:1162` and
  `DEFAULT_COST_CAP_USD = 0.5` in
  `localize-sweetie-hd-stage-command.ts:139` disagree. Pick one
  canonical default, export it from the provider module, import it
  everywhere. The CLI flag (`--cost-cap-usd`) remains and overrides
  the default per invocation.
- **deliverables:**
  - Export `DEFAULT_COST_CAP_USD` from
    `apps/itotori/src/providers/openrouter.ts`.
  - Delete the local constant in
    `apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts:139`
    and import the canonical one.
  - Document the chosen default (probably `0.5` USD per process for
    interactive runs) in a comment that cites Trevor's standing rule.
- **acceptanceCriteria:**
  - `git grep -n 'DEFAULT_COST_CAP_USD\s*='` returns exactly one hit.
  - Both the alpha closer test and the OR provider test pass with the
    shared constant.
- **verification:**
  - `pnpm -F itotori test -- localize-sweetie-hd`
  - `pnpm -F itotori test -- openrouter-provider`
- **auditFocus:** §2.5.

### ITOTORI-228 — Schema-level enforcement of real-cost in the ledger

- **id:** `ITOTORI-228`
- **title:** "Schema-level enforcement: ledger `cost_amount` is USD,
  is the value mirrored from `usage.cost`, never null."
- **status:** `planned`
- **priority:** `P1`
- **target:** `alpha`
- **dependsOn:** `["ITOTORI-224", "ITOTORI-225"]`
- **summary:** Tighten the `itotori_draft_attempt_provider_ledger`
  schema so a future code path cannot regress to fake cost:
  - Add `check (cost_unit = 'usd')` (every row is USD; non-USD
    currencies are a future concern, not a way for cost regressions to
    slip through).
  - Add a new `usage_response_json jsonb` column (NOT NULL) that holds
    the originating OR response's `usage` block (`prompt_tokens`,
    `completion_tokens`, `cost`, `cost_details`, `prompt_tokens_details`
    with caching annotations).
  - Add a CHECK constraint that `cost_amount` equals
    `(usage_response_json->>'cost')::numeric` within 1e-9 — so the row's
    cost MUST match the mirrored OR response.
  - Drop the model-ledger `cost_kind in ('billed', 'provider_estimate',
'local_estimate', 'zero', 'unknown')` constraint from migration
    0006 and replace with `cost_kind in ('billed', 'zero')` (zero is
    recorded-mode only).
- **deliverables:**
  - `packages/itotori-db/migrations/0040_ledger_real_cost_enforcement.sql`
    (the schema tightening; runs after the 0039 introduced by N1).
  - Repository update to write `usage_response_json` on every
    `recordLedgerEntry` (the OR adapter already has the bytes — the
    artifact recorder dropped them).
  - Test that inserting a row with mismatching
    `cost_amount` vs `usage_response_json->>'cost'` fails the CHECK.
- **acceptanceCriteria:**
  - The new migration runs cleanly; the `select cost_amount from ...`
    queries continue to work.
  - A regression test inserts a row with a fake cost and asserts the
    CHECK rejects it.
- **verification:**
  - `pnpm -F @itotori/db test -- draft-attempt-provider-ledger`
  - `pnpm -F @itotori/db test -- migrations`
- **auditFocus:** §2.6, §2.7.

### ITOTORI-229 — `/api/v1/generation` reconciliation endpoint

- **id:** `ITOTORI-229`
- **title:** "Optional cost reconciliation: replay-fetch billed cost
  via `/api/v1/generation?id={runId}` after the fact."
- **status:** `planned`
- **priority:** `P2`
- **target:** `beta`
- **dependsOn:** `["ITOTORI-224", "ITOTORI-228"]`
- **summary:** OR exposes `GET /api/v1/generation?id={genId}` to re-fetch
  the canonical real cost (with `total_cost`, `upstream_inference_cost`,
  `cache_discount`) for any prior generation
  (`https://openrouter.ai/docs/api/api-reference/generations/get-generation.md`).
  itotori captures the generation id today (it lands in
  `adapter_metadata.openrouterMetadata.id`); add a small reconciliation
  helper that, given a ledger row, re-fetches the canonical cost and
  raises if the ledger's `cost_amount` drifts. This closes the
  "billed-later" gap (some providers true up costs after the response,
  e.g. on caching adjustments). Not required for alpha (alpha is
  single-run), but cheap insurance for beta and full release.
- **deliverables:**
  - `apps/itotori/src/providers/openrouter-cost-reconciler.ts`
    (`fetchBilledCostByGenerationId(generationId): Promise<{ totalCostUsd: number; upstreamInferenceCostUsd: number | null; cacheDiscountUsd: number | null }>`).
  - CLI command `itotori cost reconcile --project <id> --window <...>`
    that walks recent ledger rows and surfaces drift.
- **acceptanceCriteria:**
  - The reconciler hits a real generation id end-to-end in the live
    OR test suite and the returned `total_cost` matches the ledger's
    `cost_amount` (within 1e-9).
  - The CLI surfaces a non-zero exit when any ledger row drifts.
- **verification:**
  - `pnpm -F itotori test -- openrouter-cost-reconciler`
  - `OPENROUTER_API_KEY=... pnpm -F itotori test -- openrouter-live` (smoke)
- **auditFocus:** §1.4.

### ITOTORI-230 — Cache-cost annotations through the ledger

- **id:** `ITOTORI-230`
- **title:** "Mirror prompt-caching cost annotations
  (`cached_tokens`, `cache_write_tokens`, `cache_discount`) through
  the ledger and telemetry."
- **status:** `planned`
- **priority:** `P2`
- **target:** `beta`
- **dependsOn:** `["ITOTORI-228"]`
- **summary:** Today `normalizeUsage` reads `cached_tokens`
  (`openrouter.ts:680`) but throws away `cache_write_tokens` and the
  `cache_discount` (cost) annotation. Once the ledger mirrors the full
  `usage_response_json` (N5), surface the cache annotations on the
  `TokenUsage` shape and the telemetry roll-ups so the dashboard can
  report cache-hit-driven savings. This is NOT estimation — the values
  are real, returned by OR per request.
- **deliverables:**
  - Extend `TokenUsage` (`types.ts:221-228`) with `cacheReadTokens`,
    `cacheWriteTokens`, and on `ProviderCost` add an optional
    `cacheDiscountMicrosUsd: number`.
  - Extend `normalizeUsage` and `normalizeOpenRouterCost` to populate
    them from `usage.prompt_tokens_details` and
    `usage.cost_details.cache_discount`.
  - Telemetry: surface a cache-savings line on the dashboard, sourced
    from the real `cache_discount` mirrored in the ledger.
- **acceptanceCriteria:**
  - A live response with `prompt_tokens_details.cached_tokens > 0`
    lands the cache fields in the ledger row's `usage_response_json`.
  - `apps/itotori/src/telemetry/cli.ts` prints
    `cache_savings_usd=<real>` for the window.
- **verification:**
  - `pnpm -F itotori test -- telemetry-queries`
- **auditFocus:** §1.3.

---

## §4 Retroactive fixes to already-merged code

Touch the smallest possible delta. **No deprecation shims.**

### ITOTORI-220 — model+provider pair refactor

- **What to change:** None on cost. ITOTORI-220 added `requestedProviderId`
  to the ledger (`migration 0038`), which is fine — providerId is part
  of the cost-attribution key (real cost is per (model, provider) pair).
- **What N1 affects it:** the data-handling policy enum's `costTier`
  goes away as part of N1; the ITOTORI-220 audit trail comment about
  "policy gate uses costTier" gets corrected.

### ITOTORI-221 — OpenRouterModelProvider

- **What to change:** `normalizeOpenRouterCost`
  (`openrouter.ts:685-744`) is the load-bearing wrongness — see §2.3.
  Apply the N1 rewrite. The cost cap (`recordSpend`) already reads
  `amountMicrosUsd` correctly; no change needed there.
- **Net delta:** ~40 LOC in `openrouter.ts`, +1 test case in
  `openrouter-provider.test.ts` that asserts `costKind === "billed"`.

### ITOTORI-222 — agentic loop

- **What to change:** four `?? 0` coercions
  (`agentic-loop.ts:698, 750, 823, 906`) become hard assertions via
  `assertBilledCost`. Apply at the same time as N1.

### ITOTORI-223 — telemetry queries

- **What to change:** none functionally — the aggregation is real-cost
  faithful conditional on the ledger being real-cost (§2.15). After N1
  - N5, document in `queries.ts` that the `totalCostUsd` string is by
    construction the sum of `usage.cost` values mirrored from OR
    responses; no estimation involved.

### UTSUSHI-228 — alpha closer

- **What to change:** delete the local `DEFAULT_COST_CAP_USD = 0.5`
  (`localize-sweetie-hd-stage-command.ts:139`) and import the
  canonical one (N4).

### Does the existing provider ledger contain fake costs today?

**Yes, two ways:**

1. **Recorded-mode rows** have `cost_amount = 0` for every replayed
   call (§2.12). Whether these rows exist on disk depends on whether
   any recorded-mode QA run has been executed; the CI / smoke
   harnesses do use recorded mode. The cost CHECK accepts them
   (`cost_amount >= 0`), so they ARE polluting the ledger today.
2. **`cost_kind` is tagged `provider_estimate`** on EVERY live OR row
   today (§2.3), because `normalizeOpenRouterCost` returns
   `costKind: "provider_estimate"` even for real `usage.cost`. The
   `cost_amount` is the real number, but the `cost_kind` is a lie
   that leaks into `model-ledger-repository.ts` rollups as
   `estimatedMicrosUsd`.

**Recommendation for the N1 migration:** the backfill must
_re-tag_-`cost_kind` from `provider_estimate` → `billed` for rows where
`amount_micros_usd is not null AND is_recorded_provider = false`. Rows
with `is_recorded_provider = true AND cost_amount = 0` should be left
alone (they will be re-recorded by N2's bundle re-capture, or marked
for review).

---

## §5 Guardrails

### 5.1 — `scripts/audit-no-hardcoded-cost.mjs`

Add a CI script that fails on any new hardcoded-cost-like literal
outside known-good locations:

- Scan: `apps/`, `packages/`, `crates/` (Rust side is currently
  cost-free).
- Forbidden patterns (case-sensitive, with allowlist):
  - `costUsd:\s*[0-9]` outside `apps/itotori/test/`,
    `apps/itotori/src/draft/draft-attempt-fixtures.ts` (recorded
    fixtures), and `**/*.recorded.json`.
  - `amountMicrosUsd:\s*[0-9]` same allowlist.
  - `costAmount:\s*"[0-9]` outside `**/draft-attempt-fixtures.ts`.
  - `costKind:\s*"(unknown|provider_estimate|local_estimate)"`
    anywhere — never permitted.
  - `costTier` — never permitted (after N1 lands).
- Exit non-zero with a per-file, per-line report; CI fails.

Install as a `package.json` script and wire into the existing CI step
that runs the no-deprecation audit.

### 5.2 — Schema-level NOT NULL on the cost mirror

(Implemented as part of N5.) The ledger row's `cost_amount` becomes
NOT NULL AND ties via CHECK to a NOT NULL `usage_response_json` column
that holds the originating OR `usage` block. Then a missing real cost
cannot be papered over — the row simply cannot be inserted.

### 5.3 — Test guard for `costKind === "billed"` on every live OR response

`apps/itotori/test/openrouter-provider.test.ts`: add a regression test
that asserts every `successResponse(...)` mocked result lands as
`result.providerRun.cost.costKind === "billed"`. Today this would fail
(it lands as `provider_estimate`). After N1, it passes.

---

## §6 Open questions for Trevor (not blocking)

1. **Currency:** assume USD-only for alpha? OR returns USD; the ledger
   has `cost_unit text` allowing arbitrary strings. N5 proposes
   `check (cost_unit = 'usd')`. Confirm.
2. **Catalog-driven forecasting:** do we want pre-flight forecasting
   from `/api/v1/models` (e.g. for the cost cap to be expressed as
   "max N translation calls of K tokens"), or only post-hoc
   real-cost accounting? Affects whether N6 grows to include a
   catalog fetcher.
3. **Recorded-bundle cost faithfulness (N2):** existing recorded
   bundles do not carry the original `usage.cost`. Do we re-record
   from a live run, or accept that pre-N2 bundles replay with cost =
   0 until each is refreshed? (My preference: mark old bundles
   schemaVersion-incompatible and force a recapture.)
