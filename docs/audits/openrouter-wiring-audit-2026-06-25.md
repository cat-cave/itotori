# OpenRouter wiring audit — 2026-06-25

Status: **draft, awaiting Trevor review**.
Trigger: `just localize-sweetie-hd --project sweetie-hd-alpha-1` hard-blocked on
phase 2 (the live OpenRouter invocation) with the typed error

> `provider policy blocks private_corpus input: cost tier is unknown; prompt
logging is unknown; completion logging is unknown; retention is unknown;
training use is unknown; account input/output logging is unknown; account
use of inputs/outputs is unknown; account provider data policy filters are
unknown`

The user surfaced three load-bearing wrongnesses on the spot: (a) the
`DEV_PAIR` model id is wrong, (b) ZDR is enforced account-wide by OpenRouter
itself and itotori is reinventing infrastructure that already exists, (c) if
those two slipped through, others have too. This audit closes the
investigation against the OpenRouter docs (URLs cited inline) and the
itotori code as of HEAD (commit `5a90a70`).

The audit is intentionally written so the parent-agent can mechanically mint
the §4 corrective DAG nodes after Trevor signs off.

---

## §0 Source map

OR documentation pages fetched (every claim in §1 / §3 cites one of these):

- Provider routing — `https://openrouter.ai/docs/guides/routing/provider-selection.md`
- Zero Data Retention — `https://openrouter.ai/docs/guides/features/zdr.md`
- Model fallbacks — `https://openrouter.ai/docs/guides/routing/model-fallbacks.md`
- Latest-resolution (`~author/family-latest`) — `https://openrouter.ai/docs/guides/routing/routers/latest-resolution`
- Structured outputs — `https://openrouter.ai/docs/guides/features/structured-outputs.md`
- Prompt caching — `https://openrouter.ai/docs/guides/best-practices/prompt-caching.md`
- Presets — `https://openrouter.ai/docs/guides/features/presets.md`
- API reference overview — `https://openrouter.ai/docs/api/reference/overview.md`
- Request parameters — `https://openrouter.ai/docs/api/reference/parameters.md`
- Privacy quickstart — `https://openrouter.ai/docs/quickstart` (page 1)
- Model catalog (live JSON) — `https://openrouter.ai/api/v1/models` (queried 2026-06-25)

itotori files audited:

- `apps/itotori/src/providers/openrouter.ts` (1265 lines)
- `apps/itotori/src/providers/policy.ts` (95 lines)
- `apps/itotori/src/providers/types.ts` (360 lines)
- `apps/itotori/src/providers/dev-pair.ts` (303 lines)
- `apps/itotori/src/providers/recorded.ts` (270 lines)
- `apps/itotori/src/providers/capability-guard.ts` (285 lines)
- `apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts` (539 lines)
- `apps/itotori/src/orchestrator/agentic-loop.ts` (1174 lines)
- `apps/itotori/src/telemetry/queries.ts` (158 lines)
- `presets/localize-sweetie-hd.pair-policy.json` (37 lines)
- `packages/itotori-db/migrations/0035_draft_attempt_provider_ledger.sql`
- `packages/itotori-db/migrations/0038_draft_attempt_provider_ledger_provider_id_required.sql`
- `apps/itotori/test/openrouter-provider.test.ts` (head)
- `apps/itotori/test/openrouter-live.test.ts`
- DAG nodes ITOTORI-220, 221, 222, 223; UTSUSHI-227, 228 (in `roadmap/spec-dag.json`)

Where the docs do not unambiguously answer a question (notably: how the
account-wide ZDR toggle surfaces in the chat-completions response), the audit
labels the gap **DOC-AMBIGUOUS** and proposes an empirical-evidence step
(usually "fire one toy call, inspect the response, write findings into the
canonical doc") rather than guessing.

---

## §1 What OpenRouter actually gives us

### §1.1 Provider routing primitives

`POST /api/v1/chat/completions` accepts a `provider` object whose documented
fields are (source: provider-selection.md):

| Field                      | Type                                                          | Default       | Semantics                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order`                    | `string[]`                                                    | none          | "List of provider slugs to try in order"; falls back to other providers unless `allow_fallbacks=false`.                                                                                                                                           |
| `allow_fallbacks`          | `boolean`                                                     | **`true`**    | Controls whether backup providers become available when primary providers are unavailable.                                                                                                                                                        |
| `require_parameters`       | `boolean`                                                     | **`false`**   | "Only use providers that support all parameters in your request." Without this, unsupported parameters are silently ignored by providers.                                                                                                         |
| `data_collection`          | `"allow" \| "deny"`                                           | **`"allow"`** | `"deny"` restricts routing to providers that do not retain data for training.                                                                                                                                                                     |
| `only`                     | `string[]`                                                    | none          | "List of provider slugs to allow for this request." Merged with account-wide allowances.                                                                                                                                                          |
| `ignore`                   | `string[]`                                                    | none          | "List of provider slugs to skip for this request." Merged with account-wide ignores.                                                                                                                                                              |
| `quantizations`            | `string[]`                                                    | none          | Filter providers by quantization (`int4`, `int8`, `fp4`, `fp6`, `fp8`, `fp16`, `bf16`, `fp32`, `unknown`).                                                                                                                                        |
| `sort`                     | `"price" \| "throughput" \| "latency"` _or_ `{by, partition}` | none          | Sorts providers; disables OR's default load-balancing.                                                                                                                                                                                            |
| `preferred_min_throughput` | `number` _or_ percentile cutoffs (`p50/75/90/99`)             | none          | Endpoints below threshold are de-prioritised but still in the fallback list.                                                                                                                                                                      |
| `preferred_max_latency`    | `number` _or_ percentile cutoffs                              | none          | Same shape, latency dimension.                                                                                                                                                                                                                    |
| `max_price`                | `{prompt?, completion?, request?, image?}`                    | none          | Cap pricing; request fails when no provider matches.                                                                                                                                                                                              |
| `zdr`                      | `boolean`                                                     | none          | "Restrict routing to only ZDR (Zero Data Retention) endpoints." **Acts as an OR with account-wide and guardrail ZDR settings — if any is enabled, ZDR applies; the per-request parameter cannot DISABLE account-wide enforcement.** (Per zdr.md.) |
| `enforce_distillable_text` | `boolean`                                                     | none          | Routes only to models that allow text distillation.                                                                                                                                                                                               |

Source quote — `data_collection`: itotori's request flows `"deny"` whenever
input is non-public (see §2 / §3-B), which is correct semantically but is
not in itself ZDR enforcement — `data_collection: "deny"` controls retention
for training; ZDR is a separate, stricter axis.

### §1.2 Zero Data Retention (zdr.md)

The page documents three levels of enforcement:

1. **Account-level** — "In your [privacy settings](/settings/privacy), each
   model group has its own toggle." (Trevor's account has this on.)
2. **Guardrail-level** — applied to specific API keys or org members.
3. **Per-request** — the `provider.zdr=true` request field.

The enforcement composition is explicit: **"if any is enabled, ZDR
enforcement will be applied"**. The per-request flag cannot override or
disable a higher-level setting.

OR's conservative posture is also explicit: **"If OpenRouter is not able to
establish or ascertain a clear policy ... we ... assume that the endpoint
both retains and trains on data."** That means OR's routing layer is the
authoritative dispatcher — providers OR considers ambiguous are dropped
from the candidate set, not "passed through with a warning".

**DOC-AMBIGUOUS-1**: the page does **not** document a response field that
declares "ZDR was in effect for this call". The chat-completions reference
(parameters.md / overview.md) does not list one either. Empirically the
echoed `provider` string identifies which upstream answered; whether that
provider was in the ZDR set is a property of OR's account-level policy, not
of the response shape. **Implication for itotori**: do not look for a
"zdr_enforced: true" field in the response — there isn't one. The proof
that ZDR was in force is the **combination** of (a) Trevor's account being
configured ZDR-only and (b) `provider.zdr=true` being set on the request,
and (c) OR returning a non-error response (any provider that answers under
those flags is, by definition, in the ZDR set).

**DOC-AMBIGUOUS-2**: behaviour when no ZDR provider is available for a
model is not explicitly documented. The provider-selection page's general
shape implies the request would fail (no candidate matches the filters); a
toy call to confirm is part of the §4 first corrective node.

### §1.3 Model routing

From parameters.md, model-fallbacks.md, latest-resolution:

- Model id (slug) shape is `vendor/family-variant`, e.g. `openai/gpt-5.2`,
  `anthropic/claude-sonnet-4.6`, `deepseek/deepseek-v4-flash`. The catalog
  exposes a "canonical slug" (e.g. `deepseek/deepseek-v4-flash-20260423`)
  alongside the alias.
- `model: "<slug>"` is the single-model path.
- `models: ["<slug-1>", "<slug-2>", ...]` is the **fallback array**: OR
  tries each model in order on context-length / rate-limit / moderation /
  downtime errors. **"Requests are priced using the model that was
  ultimately used."** The actual model is in the response's top-level
  `model` field.
- Suffixes: model-fallbacks.md does **not** document `:nitro` / `:floor` /
  `:online` / `:free` in the page itotori can access today. Cross-referenced
  doc fragments at `presets.md` and `provider-selection.md` mention they
  exist but the detail page either moved or is unreleased — **DOC-AMBIGUOUS-3**.
  The presets feature (see §1.6) collapses several of those into a single
  reusable reference.
- `~author/family-latest` aliases (latest-resolution.md) auto-resolve to the
  newest concrete model in a family. Itotori SHOULD NOT use these for
  recorded-bundle keys (they violate the deterministic-replay assumption);
  for live calls they are fine.
- An "Auto Router" exists (referenced from llms.txt but not deep-documented
  on a page we can access) — **DOC-AMBIGUOUS-4**.

### §1.4 Structured outputs (structured-outputs.md)

- `response_format: { type: "json_schema", json_schema: { name, strict,
schema } }` is the strict path. `strict: true` enforces schema adherence.
- `response_format: { type: "json_object" }` exists (parameters.md confirms
  the type, structured-outputs.md does not detail it separately).
- Supported model families: "OpenAI models (GPT-4o and later versions),
  Google Gemini models, Anthropic models (Sonnet 4.5, Opus 4.1+), Most
  open-source models, All Fireworks provided models". DeepSeek V4 Flash
  reports `"structured_outputs"` and `"response_format"` in its
  `supported_parameters` list (verified from the catalog JSON).
- The doc EXPLICITLY recommends pairing structured outputs with
  `provider.require_parameters: true` so a provider that silently lacks
  `response_format` is filtered out at routing time rather than returning
  unformatted text.
- A separate `structured_outputs: true` request parameter exists
  (parameters.md row), distinct from `response_format`. Treating these as
  one is incorrect: the boolean is a capability declaration ("the model
  can return structured outputs using response_format json_schema"), and
  the docs are not crisp on whether the boolean alone (without
  `response_format`) does anything useful. **DOC-AMBIGUOUS-5**.
- Tool-call enforcement (`tool_choice: "required"` / `{type: "function",
function: {name}}` / `parallel_tool_calls: false`) is documented in
  parameters.md but not in the structured-outputs.md page. itotori's
  `tool_call_arguments` mode wires `tool_choice: {type: "function", ...}`
  which lines up with the OpenAI shape OR mirrors.

### §1.5 Cost reporting (overview.md, prompt-caching.md, parameters.md)

The response `usage` block (from overview.md):

```
prompt_tokens         : number  (includes images, audio, tools)
completion_tokens     : number
total_tokens          : number  (sum)
prompt_tokens_details : { cached_tokens, cache_write_tokens?, audio_tokens?, video_tokens? }
completion_tokens_details : { reasoning_tokens?, audio_tokens?, image_tokens? }
cost                  : number  (in credits, i.e. USD-equivalent)
is_byok               : boolean
cost_details          : { breakdown of inference costs }
server_tool_use       : { web_search_requests? }
```

`cost` is the **OR-reported total in credits**. Per prompt-caching.md, the
caching-discount field is exposed as `cache_discount` in the response body;
the doc does NOT explicitly state that `cost` already nets out the discount,
only that `cache_discount` "tells you how much the response saved". **DOC-
AMBIGUOUS-6**: whether `usage.cost` already includes the cache discount, or
must be computed as `usage.cost - cache_discount`, is not directly stated.
The prudent posture: prefer `usage.cost` if present and trust it as the
billed number; only fall back to per-token math if it's absent.

Prompt caching provider matrix (prompt-caching.md):

- **Implicit / automatic** (no `cache_control` markers): OpenAI, Grok,
  Moonshot AI, Groq, DeepSeek (V4 family included), Google Gemini 2.5
  Pro/Flash.
- **Explicit** (caller inserts `cache_control: {type: "ephemeral"}`):
  Anthropic Claude, Alibaba Qwen, Google Gemini.

For DeepSeek V4 Flash (itotori's intended dev pair), caching is implicit;
the agentic-loop does not need to mark cache breakpoints.

### §1.6 Presets (presets.md)

Presets bundle: provider routing preferences, model selection (incl. the
`models` fallback array), system prompts, generation params, provider
inclusion/exclusion rules. They are referenced as
`"model": "@preset/slug"`, as a separate `preset` field, or combined
(`"model": "openai/gpt-4@preset/slug"`).
**"Request-level fields override matching preset fields, but preset fields
not present in the request are preserved."** Presets are dashboard-defined
**and** API-defined. itotori does not currently use OR presets — it
re-implements them as `provider.order/only/data_collection/zdr` per call.

### §1.7 Account-side privacy (quickstart + zdr.md + presets.md cross-refs)

What an OR account configures at the dashboard level:

- **Private Input & Output Logging** — off by default; opt-in to make
  prompts/completions visible in user logs.
- **OpenRouter Use of Inputs/Outputs** — off by default; opt-in trades a
  1% discount for OR training-use of prompts.
- **Provider Data Policy Filters** (per-model-group ZDR toggle in privacy
  settings).
- **Provider exclusion / inclusion** — account-level allow/ignore lists
  that the `provider.only` / `provider.ignore` request fields merge with.

By default (without opt-in) **"OpenRouter does not store your prompts or
responses"**. Metadata (tokens, latency) is always collected and is what
powers OR's leaderboards / reporting.

### §1.8 Errors, retries, idempotency

From overview.md + parameters.md:

- Error envelope: `{ code: number, message: string, metadata?: ... }`,
  surfaced in the `choices[].error` field (streaming + non-streaming) and
  at the top level on non-2xx.
- Streaming responses use `delta`; non-streaming use `message`.
- No documented idempotency key; **DOC-AMBIGUOUS-7**. Trevor should not
  rely on dedupe-by-key on the OR side.
- Rate limit docs live at `/docs/faq#how-are-rate-limits-calculated` —
  not deeply mirrored on a per-feature page; itotori's existing
  token-bucket at 1 rps is below any documented OR limit.

### §1.9 Model catalog — DeepSeek family (catalog JSON, 2026-06-25)

Live query against `https://openrouter.ai/api/v1/models`:

- **`deepseek/deepseek-v4-flash`** (canonical: `deepseek/deepseek-v4-flash-20260423`)
  — MoE 284B / 13B active, 1M context, 65K max completion, supports
  `response_format`, `structured_outputs`, `tools`, `tool_choice`,
  `reasoning` (xhigh/high effort).
- **`deepseek/deepseek-v4-pro`** (canonical: `deepseek/deepseek-v4-pro-20260423`)
  — same param set, 1M context, 384K max completion.

**`deepseek/deepseek-chat-v4` DOES NOT EXIST** in the catalog. It was a
plausible-looking but invented slug — likely a confused mix of the old
`deepseek/deepseek-chat-v3` family (which did exist pre-2026) and the v4
launch. A live call with the wrong slug returns OR's "model not found"
error envelope and never reaches a provider.

---

## §2 What itotori currently does

### §2.1 The provider implementation (`openrouter.ts`)

`OpenRouterProvider.invoke()` (lines 90–342) and `OpenRouterModelProvider`
(lines 1165–1255) compose two layers:

- **Outer (`OpenRouterModelProvider`)** — reads `OPENROUTER_API_KEY` from
  `process.env` at construction (line 1180), enforces a per-process USD
  cost cap (default $1.0, line 1162) by checking the running spend BEFORE
  the HTTP call (line 1224), and gates each call through a token-bucket
  rate limit (line 1190; default 1 rps, line 1163). Registers every
  known (modelId, providerId) pair from `dev-pair.ts` into the global
  `CapabilityGuard` at construction (line 1213).
- **Inner (`OpenRouterProvider`)** — builds the JSON body via
  `buildOpenRouterRequestBody` (line 401) and `buildOpenRouterProviderRouting`
  (line 457), POSTs to `${baseUrl}/chat/completions`, and runs a
  **post-response pair check** at line 258: if the upstream provider that
  answered does not byte-equal the request's `providerId`, the call fails
  with `ModelProviderError("pair_mismatch", ...)`. Hashes the routing
  block into `routeSettingsHash` for the ledger.

The provider-routing block written today (`buildOpenRouterProviderRouting`,
lines 457–515) sets:

- `data_collection` — `"deny"` whenever input is non-public (line 462,
  `dataCollectionForRequest`).
- `require_parameters: true` — only when the request asks for
  `json_schema` / `tool_call_arguments` / tools are present (line 468).
- `only: [request.providerId]` — always; refuses to widen a caller-supplied
  list (line 487).
- `allow_fallbacks: false` — always (line 493); explicit comment that this
  is the providerId pin.
- `order`, `ignore`, `quantizations`, `sort`, `zdr`, `enforce_distillable_text`,
  `max_price` — only set when the caller-side `OpenRouterProviderRouting`
  passes them (lines 473–513).

The default routing for `OpenRouterModelProvider` is `{}` (line 79) —
**zero defaults for `zdr`, `order`, `sort`, `max_price`, `quantizations`**.
The wrapper does not set `zdr: true` by default.

### §2.2 The policy gate (`policy.ts`)

`evaluateProviderInputPolicy` (lines 13–56) is what raised the alpha-closer
failure. For non-`public` / `synthetic_public` input, it requires the
`ProviderDataHandlingPolicy` to satisfy:

- `costTier` ∈ {paid, local} (not free/mixed/unknown)
- `promptLogging` = "disabled" or "not_applicable"
- `completionLogging` = same
- `retention` ∈ {none, metadata_only, not_applicable}
- `trainingUse` ∈ {deny, not_applicable}
- `dataCollection` ∈ {deny, not_applicable}
- `accountPrivacy.inputOutputLogging` = "disabled"
- `accountPrivacy.useOfInputsOutputs` = "deny"
- `accountPrivacy.providerDataPolicyFilters` = "enabled"

Each failing axis adds a reason string; the policy is "all clear or
fail". This is the source of the eight-clause message in the alpha-closer
log.

`openRouterDefaultCapabilities` (`openrouter.ts:358`) declares EVERY
`dataHandling.*` field as `"unknown"` and EVERY `accountPrivacy.*` field as
`"unknown"` except `metadataCollection: "expected"`. **That is what
guarantees the alpha-closer failure mode**: the default capability sheet
never satisfies the policy gate for `private_corpus`, regardless of whether
the user's OR account is actually ZDR-locked.

The known-pair table in `dev-pair.ts` (lines 87–228) does override the
sheet for `DEV_PAIR` / `claude-sonnet-4` / `gemini-2.5` to claim
`dataHandling: { costTier: "paid", promptLogging: "disabled",
completionLogging: "disabled", retention: "none", trainingUse: "deny",
dataCollection: "deny", rawCaptureDefault: "disabled" }`. It does NOT
override `accountPrivacy`, so the policy gate still trips on
`accountPrivacy.inputOutputLogging is unknown` etc. (See §3-B for the
root cause.)

### §2.3 The pair-policy preset

`presets/localize-sweetie-hd.pair-policy.json` is a JSON object with one
`pair` field at the top + 11 `stages.*.*` leaf pairs (one per
context/preTranslation/translation/qa/repair agent). The
`parseLocalizeSweetieHdPairPolicy` parser at
`localize-sweetie-hd-stage-command.ts:162` enforces byte-equal between
the top-level pair and every leaf. The schema currently carries NO
provider-routing knobs (no ZDR posture, no `order`, no `sort`, no preset
slug, no fallback-models array).

The `pair` declared today is
`{ "modelId": "deepseek/deepseek-chat-v4", "providerId": "fireworks" }` —
the wrong slug.

### §2.4 The agentic loop

`agentic-loop.ts` accepts a `PairPolicy` (lines 93–116) with one
`PairChoice` per stage. The orchestrator's per-stage calls (context,
pre-translation, translation, deterministic, QA, routing, repair,
final-draft) pull the pinned pair from this policy and pass it into
`providerFactory({stage, agentLabel, pair})`. Every request sets
`inputClassification: "private_corpus"` for live game scripts (e.g. line
676 for the context probe).

The cost summation at the end-of-stage uses
`invocation.providerRun.cost.amountMicrosUsd ?? 0` — silent zero when the
provider didn't report cost. There is no separate "cost was unknown"
counter.

### §2.5 Cost normalisation (`openrouter.ts` 685–744)

`normalizeOpenRouterCost` tries four sources in order:

1. `response.usage.cost` (in USD as a number) — converts to micros.
2. `response.usage.cost_details.upstream_inference_prompt_cost` +
   `upstream_inference_completions_cost`.
3. `response.usage.cost_details.upstream_inference_cost`.
4. `selectedOpenRouterEndpoint(body).pricing` × `usage.tokens` — only
   works when the response includes `openrouter_metadata.endpoints[]`
   with a `selected: true` entry (this is NOT echoed by default; see §3-G).

Cached-token discount handling: `assignNumber(usage, "cachedInputTokens",
value.cached_tokens)` at line 680 — `cached_tokens` is read into the
ledger but **nothing in the cost path subtracts the cache discount or
reads `cache_discount`**. The cost path trusts `usage.cost` as billed.

### §2.6 Telemetry and ledger

- Migration 0035 created the ledger; migration 0038 added
  `provider_id NOT NULL` with `'unknown'` backfill.
- The ledger captures `model_id`, `provider_id`, `tokens_in/out`,
  `cost_amount` (numeric 20,8), `latency_ms`, `fallback_chain`, but NO
  field for the routing posture (was `zdr=true` set? was
  `data_collection=deny`?). It carries `model_provider_family` (the OR
  family vs local-OAI vs recorded), but nothing about the **ZDR
  enforcement state** at the time of the call.
- `telemetry/queries.ts` aggregates by `(modelId, providerId)`. It has
  no per-call ZDR-enforced filter or per-call routing-hash filter.

### §2.7 Recorded provider (`recorded.ts`)

`RecordedModelProvider` keys bundles by SHA-256 of
`(modelId, providerId, promptHash, inputClassification)` (line 202). It
declares `recordedModelCapabilities` (line 239) with EVERY routing
capability `"unsupported"` and `dataHandling:
deterministicFixtureDataHandlingPolicy`. It does NOT mirror the
`openrouter_metadata.endpoints` block or any ZDR state from the original
call — replays are blind to "was this originally ZDR-enforced".

### §2.8 The alpha-closer stage command (`localize-sweetie-hd-stage-command.ts`)

`liveOpenRouterFactory` (line 347) constructs a single
`OpenRouterModelProvider` at the first call and reuses it. It passes only
`costCapUsd: opts.costCapUsd ?? DEFAULT_COST_CAP_USD` (line 360).
**It does NOT pass any provider-routing knobs** — no `zdr`, no `sort`, no
`order`. The pair-policy file's only effect is the per-stage `(modelId,
providerId)` pin.

### §2.9 Tests

`openrouter-provider.test.ts` mocks the OR HTTP layer with fixtures whose
`provider` field echoes the request's providerId. The mocked
`successResponse()` body shape is:
`{ id, model, provider, choices[], usage: { prompt_tokens, completion_tokens, total_tokens, cost } }`.
That is faithful to OR's documented response shape **for the
`provider`-string echo path** but does NOT include `openrouter_metadata`
or `cost_details`, so several code paths in `normalizeOpenRouterCost` are
not exercised by these unit tests.

`openrouter-live.test.ts` is the opt-in live smoke; it gates on
`OPENROUTER_LIVE=1` and writes an artifact.

---

## §3 The gaps (the audit)

Numbered findings, each citing OR docs + itotori files. Severity guide:

- **critical**: production-broken or wrong-shaped — must fix before live alpha.
- **high**: subtly wrong, silently degrades correctness.
- **medium**: suboptimal but works.
- **low**: style / cleanup.

### §3-A — Wrong DEV_PAIR model id (critical)

**What's wrong**: `DEV_PAIR.modelId = "deepseek/deepseek-chat-v4"` is not
a slug OpenRouter knows. The catalog (verified live 2026-06-25, `https://
openrouter.ai/api/v1/models`) lists exactly two DeepSeek v4 slugs:
`deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro`. Trevor's
intent was `deepseek/deepseek-v4-flash`.

**Where**:

- `apps/itotori/src/providers/dev-pair.ts:47` — `modelId: "deepseek/deepseek-chat-v4"`.
- `presets/localize-sweetie-hd.pair-policy.json:4, 12, 14, 17, 18, 21, 24, 27, 28, 29, 30, 33` — same wrong slug in 12 places.
- `apps/itotori/src/providers/dev-pair.ts:12` — code comment "deepseek-chat-v4 is the cheapest production-grade model on OpenRouter that still supports JSON-schema structured output well" — this rationale was written against an imagined slug.
- `apps/itotori/src/providers/dev-pair.ts:133` — note claims "verified against OpenRouter's published Fireworks-hosted deepseek-v4 endpoint as of 2026-06" — there is no Fireworks-hosted entry for either v4-flash or v4-pro in the live catalog (see §3-A-2).

**§3-A-2 — Provider id pin is unverified**. The catalog endpoint pricing
data shows each v4 model carries a _single_ "top provider" (the catalog
truncated the per-endpoint list, but neither v4 entry returned `fireworks`
in the small slice we fetched). Whether `fireworks` actually hosts
`deepseek/deepseek-v4-flash` in 2026-06 is an empirical question — Trevor
should run a one-shot toy call with `provider.only=["fireworks"]` against
the corrected slug and confirm it routes; if it doesn't, the providerId
pin needs to change too. The corrective DAG node (§4-2) explicitly mandates
this evidence step.

**What docs say**: model slugs are listed in `https://openrouter.ai/models`
and the JSON catalog at `https://openrouter.ai/api/v1/models`. Slugs are
case-sensitive and must match a real catalog entry. Latest-resolution
aliases (`~deepseek/deepseek-latest` style) auto-resolve to the newest
concrete model, but itotori's recorded-bundle key (ITOTORI-220) requires a
**concrete** slug for deterministic replay — `~author/family-latest`
should NOT be used for itotori's pair pin.

**Severity**: **critical**. The alpha-closer would 404 (or worse, OR's
"model not found" envelope) on every phase-2 attempt. Already proven by
the in-progress UTSUSHI-228 run that triggered this audit.

**Blast radius**:

- `dev-pair.ts` exported constant `DEV_PAIR` — used by `DEV_POLICY` in
  `agentic-loop.ts:126`, by `OpenRouterModelProvider` capability
  registration (line 1213), by `openrouter-provider.test.ts` (line 24).
- `presets/localize-sweetie-hd.pair-policy.json` — only file outside
  `dev-pair.ts` that hard-codes the slug.
- Recorded bundles already on disk (28 per ITOTORI-220's statusReason)
  may be keyed against the wrong slug; the bundle key includes the
  modelId byte-for-byte (recorded.ts:202), so they will MISS after the
  slug is corrected. The corrective node MUST inventory and re-key them.

### §3-B — itotori reinvents OR's account-wide ZDR enforcement (critical)

**What's wrong**: itotori maintains a `ProviderDataHandlingPolicy` registry
that for every OR call defaults to `"unknown"` and then hard-fails the
`assertProviderInputAllowed` gate. This was load-bearing in a world where
itotori had no idea what OR's account-wide ZDR posture was. With OR
account-wide ZDR-only enforcement on (Trevor's reality), **OR is the
authoritative dispatcher** — it refuses to route to non-ZDR endpoints
regardless of what itotori asks. The itotori-side policy registry is
duplicate plumbing.

Three sub-problems:

**§3-B-1**. `openRouterDefaultCapabilities` (line 358) ships every
`dataHandling.*` and `accountPrivacy.*` as `"unknown"`. The known-pair
overrides in `dev-pair.ts` declare `dataHandling` correctly but do NOT
override `accountPrivacy`, so the policy gate still trips on three
account-level reasons (`accountPrivacy.inputOutputLogging is unknown`,
etc.). This is structurally why the alpha-closer hit eight reason strings
instead of zero.

**§3-B-2**. Even if the per-pair sheet WAS correct, it would be inferring
account state from a code constant, not from OR. The right shape: trust
that ZDR is on at the account level, set `provider.zdr: true` on every
private-corpus call to ensure the OR account-wide flag and the request
flag agree, and let OR's routing reject if no ZDR endpoint is available.

**§3-B-3**. itotori's request body **does not currently set
`provider.zdr: true` by default for private-corpus calls**. The flag is
only set if the caller-side `OpenRouterProviderRouting.zdr` is supplied
— and the alpha closer's `liveOpenRouterFactory` (line 359) doesn't supply
it. So the only ZDR enforcement actually in effect right now is whatever
account-wide policy Trevor has on. Setting `provider.zdr: true`
explicitly is a free belt-and-suspenders: it costs nothing, it makes
every request self-documenting, and it ensures that if Trevor's account
state ever changes, the request still gets ZDR-only routing.

**Where**:

- `apps/itotori/src/providers/openrouter.ts:382-399` — `openRouterDefaultCapabilities` declares "unknown".
- `apps/itotori/src/providers/policy.ts:13-56` — `evaluateProviderInputPolicy` is the failing gate.
- `apps/itotori/src/providers/openrouter.ts:457-515` — `buildOpenRouterProviderRouting` reads `zdr` from the caller, never sets it as a default.
- `apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts:357-371` — `liveOpenRouterFactory` does not pass `zdr`.

**What docs say**: ZDR is account-level, guardrail-level, and per-request;
"if any is enabled, ZDR enforcement will be applied"
(`zdr.md`). Per-request `provider.zdr=true` is the documented way to set
the per-request flag (provider-selection.md).

**Severity**: **critical**. The policy gate's eight-reason refusal is the
literal blocker the alpha closer hit.

**Blast radius**:

- `policy.ts` `evaluateProviderInputPolicy` — used everywhere via
  `assertProviderInputAllowed` (capability-guard.ts:25).
- `types.ts:69-75` `OpenRouterAccountPrivacyState` shape is itself
  scoped wrong: it models "what does this provider declare?" as if
  itotori were the dispatcher.
- `ProviderRunRecord.accountPrivacy` (types.ts:271) writes the
  capability-sheet's account-privacy onto the ledger artifact — this
  is misleading data because the sheet doesn't reflect runtime state.

### §3-C — `openRouterDefaultCapabilities` shape is wrong (high)

**What's wrong** (closely related to §3-B but worth separating): the
default shape says "every privacy axis is unknown until a per-pair sheet
is registered." That stance was correct under the original
"itotori-is-the-dispatcher" assumption but is now actively misleading
under the OR-is-the-dispatcher reality. The shape should be derived from
**OR account state at runtime** (or, since OR doesn't expose that as an
API, hard-coded as "OR account configured for ZDR-only; per-request zdr
flag always set; the sheet's `accountPrivacy` is therefore not the right
abstraction") — not from a static constant.

**Where**: `apps/itotori/src/providers/openrouter.ts:358-399`.

**What docs say**: zdr.md treats account state as the source of truth.
There is no API to query "what is my OR account's current ZDR posture";
the truthful posture for itotori is "trust the account is ZDR and require
ZDR on every request; refuse to run if either has not been confirmed".

**Severity**: **high**. Not directly user-visible after §3-B is fixed
(the gate stops being load-bearing), but the field stays as dead
plumbing until it's removed.

### §3-D — Request body posture (high, mixed)

Audit of every documented `provider.*` field against itotori's
`buildOpenRouterRequestBody` + `buildOpenRouterProviderRouting`:

| OR field                                                      | itotori behaviour today                                           | Should be                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider.order`                                              | Caller-supplied only.                                             | OK, no change.                                                                                                                                                                                                                                                                                                                                                            |
| `provider.allow_fallbacks`                                    | Always `false`.                                                   | OK — pins the providerId.                                                                                                                                                                                                                                                                                                                                                 |
| `provider.require_parameters`                                 | Set to `true` only when structured-output or tools are requested. | OK; OR docs explicitly recommend this pairing.                                                                                                                                                                                                                                                                                                                            |
| `provider.data_collection`                                    | `"deny"` when input is non-public, else caller-supplied.          | OK.                                                                                                                                                                                                                                                                                                                                                                       |
| `provider.only`                                               | Always `[request.providerId]`.                                    | OK; pins the providerId.                                                                                                                                                                                                                                                                                                                                                  |
| `provider.ignore`                                             | Caller-supplied only.                                             | OK.                                                                                                                                                                                                                                                                                                                                                                       |
| `provider.quantizations`                                      | Caller-supplied only.                                             | OK; the alpha pair doesn't care.                                                                                                                                                                                                                                                                                                                                          |
| `provider.sort`                                               | Caller-supplied only.                                             | OK; `only`+`allow_fallbacks=false` makes sort moot.                                                                                                                                                                                                                                                                                                                       |
| `provider.zdr`                                                | Caller-supplied only — **alpha closer never sets it**.            | **Should default to `true` for private-corpus inputs.** (§3-D-1)                                                                                                                                                                                                                                                                                                          |
| `provider.enforce_distillable_text`                           | Caller-supplied only.                                             | OK — itotori doesn't want distillation.                                                                                                                                                                                                                                                                                                                                   |
| `provider.max_price`                                          | Caller-supplied only.                                             | Optional belt-and-suspenders for the per-process cap.                                                                                                                                                                                                                                                                                                                     |
| `provider.preferred_min_throughput` / `preferred_max_latency` | **Not in `OpenRouterProviderRouting` type at all.**               | Acceptable for alpha; mention in §4-3.                                                                                                                                                                                                                                                                                                                                    |
| `models` (top-level fallback array)                           | Set when `fallbackPlanForRequest` returns >1 entry.               | OK shape-wise, but the alpha pair-policy never populates `fallbackModels`, so `models` is never emitted. (§3-D-2)                                                                                                                                                                                                                                                         |
| `response_format`                                             | json_schema and json_object both wired.                           | OK.                                                                                                                                                                                                                                                                                                                                                                       |
| `tool_choice`                                                 | Forced when structured-output is `tool_call_arguments`.           | OK.                                                                                                                                                                                                                                                                                                                                                                       |
| `structured_outputs: true` (boolean param)                    | **Not sent.**                                                     | Probably benign — `response_format.json_schema` is the canonical path. Note as DOC-AMBIGUOUS-5.                                                                                                                                                                                                                                                                           |
| `parallel_tool_calls`                                         | **Not sent.**                                                     | itotori's QA prompts request one tool call at a time; OK default.                                                                                                                                                                                                                                                                                                         |
| `seed`                                                        | **Not sent.**                                                     | Deterministic replay would benefit from this; medium priority. (§3-D-3)                                                                                                                                                                                                                                                                                                   |
| `usage.include` / `usage` request opt-in                      | Not configured.                                                   | OR's response always includes `usage` per overview.md; no action.                                                                                                                                                                                                                                                                                                         |
| `plugins`                                                     | Not configured.                                                   | OK — itotori doesn't want web-search or PDF-parse.                                                                                                                                                                                                                                                                                                                        |
| Headers — `X-OpenRouter-Metadata: enabled`                    | Sent (line 139).                                                  | This header is undocumented in the pages we can access (it appears to be the toggle for the `openrouter_metadata.endpoints` echo block). The cost-fallback path 4 (§2.5) depends on it — but the docs do not document the header. **DOC-AMBIGUOUS-8.** §4 should resolve this empirically; if the header is unsupported, the endpoint-pricing cost fallback is dead code. |

**§3-D-1**. Default `provider.zdr: true` for non-public input — also
addresses §3-B-3. Severity: high.

**§3-D-2**. Pair-policy schema doesn't carry a `fallbackModels` array.
For alpha (one game, one model, one provider) this is fine; for beta the
policy will need a way to say "if `deepseek/deepseek-v4-flash` is down,
try `deepseek/deepseek-v4-pro` next". Severity: medium.

**§3-D-3**. Set `seed` for repair re-tries so the bounded-repair loop's
second attempt is reproducible from the bundle. Severity: medium.

### §3-E — Cost-cap math omits cache discount accounting (medium)

**What's wrong**: `normalizeOpenRouterCost` (line 685) reads `usage.cost`
as authoritative and ignores `cache_discount`. Per prompt-caching.md,
**DOC-AMBIGUOUS-6**: it is not crisp whether `usage.cost` is gross or net
of the cache discount. The token-usage path captures
`cached_tokens` (line 680) but the cost path does not consume it.

Three sub-issues:

**§3-E-1**. If `usage.cost` is gross of the cache discount (the docs are
ambiguous), itotori over-attributes spend by the discount amount. The
per-process $0.50 cap would refuse a call earlier than it needs to.

**§3-E-2**. The dashboard widget (ITOTORI-223) aggregates `cost_amount`
without exposing the cache hit rate. A heavy-cache prompt looks the
same as a no-cache prompt in the dashboard. Medium priority for alpha.

**§3-E-3**. The endpoint-pricing fallback path (lines 721–738) computes
`promptTokens × promptPriceUsd + completionTokens × completionPriceUsd`
without subtracting cached tokens at the implicit-cache discount rate.
This is dead-code if `X-OpenRouter-Metadata: enabled` is not supported
(see §3-D / DOC-AMBIGUOUS-8); if it IS supported, the math is wrong.

**Where**: `apps/itotori/src/providers/openrouter.ts:685-744`.

**What docs say**: prompt-caching.md exposes `cache_discount` and
`prompt_tokens_details.cached_tokens`; usage of `cost` is documented as
"in credits" without disambiguating gross vs net.

**Severity**: medium for alpha (the absolute amounts are small enough
that the discount won't swing the cap by an order of magnitude). High
for beta (cache discount on a route-heavy game can hit 60%+; getting
spend wrong by that much breaks budgeting).

### §3-F — Pair-policy schema is too narrow (medium)

**What's wrong**: `presets/localize-sweetie-hd.pair-policy.json` carries
only `(modelId, providerId)` per stage. It does not declare:

- The OR ZDR posture for the run (should this be `zdr: true` everywhere?).
- The fallback `models` array per stage.
- A reference to an OR preset slug (if itotori ever adopts OR-side
  presets — see §1.6).
- The per-stage `data_collection` posture (currently inferred from
  `inputClassification`).
- A per-stage `max_price` cap (the dashboard $0.50 process cap is
  coarse).
- `seed` for the repair loop.

**Where**: `presets/localize-sweetie-hd.pair-policy.json` + parser at
`localize-sweetie-hd-stage-command.ts:162`.

**What docs say**: presets.md treats all of these as bundleable on the
OR side; itotori SHOULD either mirror that on the itotori side or adopt
OR presets directly. The corrective DAG node should pick one (no
optionality).

**Severity**: medium. Functional today; becomes a beta blocker.

### §3-G — Recorded provider doesn't mirror OR routing metadata (high)

**What's wrong**: `RecordedModelProvider` replays just content, finish
reason, token usage, and an optional `adapterMetadata`. It does NOT
mirror:

- The `provider` echo string (the actual upstream provider).
- The `openrouter_metadata.endpoints[]` block when present.
- The ZDR posture in effect at the original call (because §3-B means
  itotori doesn't currently capture it on the live call either).
- The `cost_details` shape (so replayed costs in offline CI mode don't
  exercise the same code paths as live cost normalisation).

Result: an offline replay artifact cannot prove "the original call was
routed to a ZDR endpoint". The audit-trail story for downstream
consumers is incomplete.

**Where**: `apps/itotori/src/providers/recorded.ts:106-165` (the replay
path) + `recordedModelCapabilities` at lines 239–264.

**What docs say**: the `provider` field in the response is the docs'
canonical "which upstream answered" surface (overview.md). For ZDR proof
there's no documented response field (DOC-AMBIGUOUS-1), so the recorded
bundle has to capture **the request's routing posture** to make the
ZDR-was-in-force claim reproducible.

**Severity**: high. Lands on the offline CI / non-real-bytes story
(non-reallive-fixture-needs); does NOT block alpha but blocks audit
parity between live and recorded modes.

### §3-H — Misc.

**§3-H-1**. `OpenRouterModelProvider` reads `process.env.OPENROUTER_API_KEY`
at construction. That is correct per ITOTORI-221's spec, but the
constructor also takes `options.env` for tests; production code paths
should NEVER set `options.env` — there's no compile-time guard. Low
priority.

**§3-H-2**. `assertProviderInvocationSupported` in `capability-guard.ts`
calls `assertProviderInputAllowed` UNCONDITIONALLY (line 25). After
§3-B, this should be replaced with a much simpler "did the caller assert
ZDR account-wide enforcement is configured?" check. Low priority cleanup.

**§3-H-3**. The `notes` field in the per-pair capability sheets includes
strings like "ITOTORI-221 DEV_PAIR capabilities are verified against
OpenRouter's published Fireworks-hosted deepseek-v4 endpoint as of
2026-06-." Once we confirm whether Fireworks hosts v4-flash, these
notes need to be re-grounded against real evidence (a captured response
body), not against assumed catalog data. Medium.

**§3-H-4**. `metadataCollection: "expected"` on `accountPrivacy` —
metadata collection is unavoidable per OR docs (tokens/latency power
the leaderboards), so this field is non-actionable. Could be deleted
with the rest of `accountPrivacy` per §3-B. Low.

**§3-H-5**. `OpenRouterProviderRouting.zdr` is currently typed as
`boolean | undefined` with the implicit semantic "undefined = don't
send" / "true = enforce". Once the default flips (§3-D-1), the type
should become `boolean` non-optional with a default at the call site
that documents the choice. Low.

**§3-H-6**. There's no test exercising "ZDR is set on the request body
and the response carries the expected provider". The existing
`openrouter-provider.test.ts` fixtures don't include `provider.zdr` in
the assertions on the request body. Medium.

---

## §4 Corrective DAG nodes to mint

Next available IDs (from `roadmap/spec-dag.json` jq query, 2026-06-25):

- `ITOTORI-224` — next free
- `KAIFUU-212` — next free (not used in this audit)
- `UTSUSHI-231` — next free
- `OR-AUDIT-*` — would need a new project prefix; per current convention
  we should keep these under `ITOTORI-` since they live in the itotori
  app.

Proposed nodes (in priority order):

### §4-1. ITOTORI-224 — Publish canonical OR integration doc (P0, alpha)

```
id: ITOTORI-224
title: itotori-agent-runtime: publish canonical OpenRouter integration doc + adopt audit as baseline
status: planned
priority: P0
target: alpha
projects: [itotori]
dependsOn: [ITOTORI-220, ITOTORI-221, ITOTORI-222, ITOTORI-223]
summary: |
  Land docs/openrouter-integration.md as the canonical itotori-side
  understanding of how OpenRouter routes / enforces ZDR / reports cost /
  surfaces structured outputs / exposes the model catalog. Anchor every
  claim to a fetched OR docs URL and a fetched-date. Adopt
  docs/audits/openrouter-wiring-audit-2026-06-25.md as the audit
  baseline; subsequent corrective nodes (ITOTORI-225..) reference its
  numbered findings. Includes one toy live call against the OR endpoint
  (private corpus classification, provider.zdr=true, response captured
  to docs/openrouter-integration-evidence/<date>.json) to resolve the
  six DOC-AMBIGUOUS items the audit flagged.
deliverables:
  - docs/openrouter-integration.md (canonical)
  - docs/openrouter-integration-evidence/<date>.json (captured live OR response)
  - docs/audits/openrouter-wiring-audit-2026-06-25.md committed as baseline
acceptanceCriteria:
  - docs/openrouter-integration.md cites every audit-§1 doc URL + a
    fetched-date for each
  - The evidence JSON shows usage.cost present, provider field present,
    and (where the doc is ambiguous) resolves DOC-AMBIGUOUS-1, -2, -6, -8
  - git log shows the audit doc + integration doc + evidence JSON
    landed in the same commit (no-legacy-compat: the prior dev-pair.ts
    "verified against published Fireworks endpoint" note is rewritten
    in the same commit to point at the evidence file)
verification:
  - command: rg -n "deepseek/deepseek-chat-v4" -- . | wc -l    # expects 0
  - command: rg -n "openrouter-integration\\.md" docs apps | head
  - command: node scripts/spec-dag.mjs validate
auditFocus:
  - Documenting a posture instead of measuring it
  - Evidence JSON committed with API key or PII present
  - Cited URLs that 404 again (re-fetch on commit day)
```

### §4-2. ITOTORI-225 — Fix DEV_PAIR + propagate (P0, alpha)

```
id: ITOTORI-225
title: itotori-agent-runtime: fix DEV_PAIR to deepseek/deepseek-v4-flash + re-key recorded bundles
status: planned
priority: P0
target: alpha
projects: [itotori]
dependsOn: [ITOTORI-224]
summary: |
  Replace dev-pair.ts:47 modelId with the catalog-correct
  "deepseek/deepseek-v4-flash". Empirically confirm provider id
  ("fireworks" today) actually hosts this model with a one-shot toy
  call; if not, change the providerId to whatever the catalog reports
  as the canonical Fireworks-hosted endpoint (or a different provider
  if Fireworks doesn't host it). Rewrite the in-code rationale comment
  against real evidence captured by ITOTORI-224. Re-key every recorded
  bundle whose key contains the old modelId so RecordedBundleMissingError
  doesn't fire across the offline CI runs. Update
  presets/localize-sweetie-hd.pair-policy.json to match (12 leaf entries
  + top-level pair). The old slug is deleted in the same change
  (no-legacy-compat: no alias map, no fallthrough).
deliverables:
  - apps/itotori/src/providers/dev-pair.ts: corrected modelId + rationale
    grounded in the ITOTORI-224 evidence JSON
  - presets/localize-sweetie-hd.pair-policy.json: 13 occurrences updated
  - fixtures/recorded-bundles/* re-keyed (script + a one-line note in
    the canonical doc)
  - Test: openrouter-provider.test.ts uses the corrected DEV_PAIR
acceptanceCriteria:
  - rg "deepseek/deepseek-chat-v4" returns 0 hits
  - rg "deepseek/deepseek-v4-flash" appears in dev-pair.ts and
    pair-policy.json
  - pnpm --filter @itotori/app test passes (recorded bundles match)
  - One toy live call to deepseek/deepseek-v4-flash via OR with
    provider.only=[<verified-providerId>] returns a successful response
    (capture under artifacts/openrouter-live-smoke/)
verification:
  - command: rg -n "deepseek/deepseek-chat-v4" .
  - command: pnpm --filter @itotori/app test
  - command: OPENROUTER_LIVE=1 pnpm exec vp run itotori:openrouter-live-smoke
auditFocus:
  - Slug aliased instead of replaced
  - Recorded bundles left with stale key
  - providerId pinned to a provider that does not host the model
```

### §4-3. ITOTORI-226 — Default ZDR-on, delete itotori-side data-handling registry (P0, alpha)

```
id: ITOTORI-226
title: itotori-agent-runtime: delete reinvented data-handling registry; default provider.zdr=true
status: planned
priority: P0
target: alpha
projects: [itotori]
dependsOn: [ITOTORI-224, ITOTORI-225]
summary: |
  Trust OR's account-wide ZDR enforcement as authoritative. Delete
  the itotori-side ProviderDataHandlingPolicy + OpenRouterAccountPrivacyState
  capability registry (types.ts:59-87) and the evaluateProviderInputPolicy
  gate (policy.ts). Replace the gate with a single, much simpler
  AccountZdrAssertion: "this process asserts the OR account is configured
  ZDR-only AND every private-corpus request body sends provider.zdr=true".
  The assertion fails LOUDLY on missing OPENROUTER_ZDR_ACCOUNT_ASSERTED=1
  env var rather than on each missing capability axis. Add
  provider.zdr=true to buildOpenRouterProviderRouting whenever
  request.inputClassification is non-public. Old policy.ts deletes in
  the same change (no-legacy-compat).
deliverables:
  - apps/itotori/src/providers/openrouter.ts: provider.zdr defaults to
    true when inputClassification != public; capability sheet's
    accountPrivacy field removed
  - apps/itotori/src/providers/policy.ts: deleted (old shape)
  - apps/itotori/src/providers/account-zdr.ts: new simple assertion
  - apps/itotori/src/providers/types.ts: ProviderDataHandlingPolicy and
    OpenRouterAccountPrivacyState removed; ProviderRunRecord no longer
    carries accountPrivacy
  - Ledger schema (migration 0039): remove now-stale columns if any
    (audit ledger writer to confirm none persist accountPrivacy)
  - Tests rewritten: no more "policy_blocked" code path; new
    AccountZdrAssertionError path
acceptanceCriteria:
  - With OPENROUTER_ZDR_ACCOUNT_ASSERTED unset, the OpenRouterModelProvider
    constructor throws AccountZdrAssertionError (proves the assertion is
    load-bearing, not optional)
  - With OPENROUTER_ZDR_ACCOUNT_ASSERTED=1, a private-corpus request
    sends provider.zdr=true on the wire (verified by mocked-HTTP
    table test)
  - rg "evaluateProviderInputPolicy" returns 0 hits (old gate deleted)
  - rg "accountPrivacy" returns 0 hits in apps/itotori/src
  - just localize-sweetie-hd --dry-run prints the assertion line and
    the provider.zdr=true posture
verification:
  - command: pnpm --filter @itotori/app test -- providers
  - command: rg -n "ProviderDataHandlingPolicy|accountPrivacy" apps/itotori/src
  - command: just localize-sweetie-hd --dry-run --project sweetie-hd-alpha-1
auditFocus:
  - Old policy.ts kept as a shim
  - provider.zdr only sent when caller asks (defeats the default)
  - AccountZdrAssertion downgraded to a warning instead of a refusal
  - Documenting "ZDR is on" without enforcing the env var assertion
```

### §4-4. ITOTORI-227 — Capture routing posture into the ledger + recorded bundles (P1, alpha)

```
id: ITOTORI-227
title: itotori-agent-runtime: persist OR routing posture (zdr=true, data_collection=deny, only=[providerId]) in the ledger and recorded bundles
status: planned
priority: P1
target: alpha
projects: [itotori]
dependsOn: [ITOTORI-226]
summary: |
  Persist the OR provider-routing block sent on each call into the
  ledger row (migration 0039: add routing_posture jsonb) AND mirror it
  on the RecordedProviderBundle responses so offline replays can prove
  the original call's routing posture. ProviderRunRecord gains a
  routingPosture field. RecordedModelProvider replay sets the
  ProviderRunRecord.routingPosture from the bundle; capture path writes
  it on live calls. Telemetry queries.ts adds a per-pair "ZDR-enforced
  call count" so a partial-coverage anomaly is visible in the dashboard.
deliverables:
  - migration 0039_provider_ledger_routing_posture.sql
  - apps/itotori/src/providers/types.ts: ProviderRunRecord.routingPosture
  - apps/itotori/src/providers/recorded.ts: bundle response.routingPosture
  - apps/itotori/src/telemetry/queries.ts: countZdrEnforcedCallsByPair
acceptanceCriteria:
  - A live OR call writes routing_posture { only:[providerId],
    allow_fallbacks:false, data_collection:"deny", zdr:true,
    require_parameters?:bool } to the ledger
  - A recorded bundle response carries routingPosture; replay sets it
    on the ProviderRunRecord
  - Telemetry CLI lists zdrEnforcedCount == invocationCount for the
    alpha pair over a non-trivial window (proves no call slipped through
    without ZDR)
verification:
  - command: pnpm --filter @itotori/app test -- telemetry
  - command: pnpm --filter @itotori/db test -- ledger
  - command: pnpm exec vp run itotori:telemetry-summary --since 2026-06-01
auditFocus:
  - routing_posture defaulted to null instead of typed
  - ZDR-enforced count includes recorded-bundle responses that didn't
    actually capture posture (silent partial coverage)
  - Migration backfill widens to "unknown" without an explicit audit row
```

### §4-5. ITOTORI-228 — Cost accounting respects prompt cache + endpoint pricing (P1, alpha)

```
id: ITOTORI-228
title: itotori-agent-runtime: prompt-cache aware cost cap + cache hit telemetry
status: planned
priority: P1
target: alpha
projects: [itotori]
dependsOn: [ITOTORI-224, ITOTORI-225, ITOTORI-227]
summary: |
  Resolve DOC-AMBIGUOUS-6 (does usage.cost include cache discount?)
  empirically via the ITOTORI-224 evidence JSON, then implement the
  correct math. Capture cached_input_tokens + cache_discount on every
  ledger row; expose cache hit rate per pair in telemetry queries.
  If the endpoint-pricing fallback (openrouter.ts:721-738) survives the
  empirical check on the X-OpenRouter-Metadata header (DOC-AMBIGUOUS-8),
  fix its math to subtract cached tokens at the implicit-cache discount
  rate; if the header is unsupported, delete the fallback path in the
  same change.
deliverables:
  - apps/itotori/src/providers/openrouter.ts: normalizeOpenRouterCost
    rewritten with cache-aware math + a code comment quoting the
    ITOTORI-224 evidence file
  - migration 0040_provider_ledger_cache_discount.sql
  - apps/itotori/src/telemetry/queries.ts: countCacheHitsByPair
acceptanceCriteria:
  - Live call against deepseek-v4-flash (which supports implicit
    caching per prompt-caching.md) writes cache_discount and
    cached_input_tokens to the ledger
  - The per-process cost cap deducts the cache discount before
    refusing a new call
  - rg "selectedOpenRouterPricing" in apps/itotori/src returns the
    expected result (kept-and-fixed OR deleted-as-dead based on
    ITOTORI-224 evidence)
verification:
  - command: pnpm --filter @itotori/app test -- providers/openrouter
  - command: OPENROUTER_LIVE=1 pnpm exec vp run itotori:openrouter-live-smoke
auditFocus:
  - Cost cap math double-counts the discount
  - Endpoint-pricing fallback left in place if the metadata header
    is empirically unsupported
  - cache_discount columns left nullable when the upstream guarantees
    the field
```

### §4-6. ITOTORI-229 — Pair-policy schema v0.2 (P1, alpha/beta hinge)

```
id: ITOTORI-229
title: itotori-agent-runtime: pair-policy schema v0.2 carrying ZDR posture + fallback models + seed
status: planned
priority: P1
target: alpha
projects: [itotori]
dependsOn: [ITOTORI-226, ITOTORI-227]
summary: |
  Widen the pair-policy JSON schema (presets/*.pair-policy.json) to a
  versioned v0.2 shape carrying:
    - per-stage `(modelId, providerId)` pair (unchanged from v0.1)
    - per-stage zdr posture (default: true; non-default requires a
      stage-local OPENROUTER_ZDR_DOWNGRADE env var assertion)
    - per-stage fallbackModels array (default: empty)
    - per-stage seed (default: deterministic based on stage name; the
      bounded-repair loop uses seed+attempt)
    - per-stage maxPrice cap (default: derived from per-process cap /
      stage count)
    - top-level openrouterPresetSlug (optional; when set, OR-side
      preset is referenced and overlapping fields are removed from the
      per-stage block per presets.md "request-level overrides" rule)
  Rename presets/localize-sweetie-hd.pair-policy.json's schemaVersion
  and update the parser; old v0.1 files do NOT load (no-legacy-compat).
deliverables:
  - presets/localize-sweetie-hd.pair-policy.json: v0.2 shape
  - apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts:
    parser updated; v0.1 path deleted
  - packages/itotori-shared/src/pair-policy.v0.2.ts: schema + types
acceptanceCriteria:
  - just localize-sweetie-hd --dry-run prints the per-stage zdr+seed
    posture
  - A pair-policy with schemaVersion 0.1 is rejected with a typed
    PairPolicyVersionMismatchError
  - The agentic-loop bundle records per-stage zdr posture + seed
verification:
  - command: pnpm --filter @itotori/app test -- orchestrator/localize-sweetie-hd
  - command: just localize-sweetie-hd --dry-run --project sweetie-hd-alpha-1
auditFocus:
  - v0.1 path silently accepted
  - Default zdr posture not applied to repair stage
  - seed defaulted to 0 instead of deterministic-per-stage
```

### §4-7. UTSUSHI-231 — Re-run the alpha closer end-to-end (P0, alpha)

```
id: UTSUSHI-231
title: suite: re-run localize-sweetie-hd end-to-end after ITOTORI-225..229; capture replay-log proving ZDR posture
status: planned
priority: P0
target: alpha
projects: [suite]
dependsOn: [ITOTORI-225, ITOTORI-226, ITOTORI-227, UTSUSHI-228]
summary: |
  Re-execute `just localize-sweetie-hd --project sweetie-hd-alpha-1`
  against the corrected slug + new ZDR posture + posture-aware ledger.
  Capture artifacts/localize-sweetie-hd/<timestamp>/ with all four
  files (bridge-bundle, agentic-loop-bundle, patch-report, replay-log)
  AND the new routing_posture in the agentic-loop-bundle invocation
  records. The acceptance criterion lifts the §3 corrective deltas
  from in-progress to "demonstrably end-to-end".
deliverables:
  - artifacts/localize-sweetie-hd/<2026-06-25-rerun>/
  - docs/openrouter-integration.md: appended evidence cite for the rerun
acceptanceCriteria:
  - agentic-loop-bundle.v0.json invocation records carry
    routingPosture.zdr === true on every entry
  - Recorded patch-report.json contains the corrected modelId
  - replay-log.json has the en-US sentinel TextLine (same UTSUSHI-228
    contract)
  - The ledger after the run shows zdrEnforcedCount ==
    invocationCount over the run window
verification:
  - command: just localize-sweetie-hd --project sweetie-hd-alpha-1
  - command: pnpm exec vp run itotori:telemetry-summary --since <run-start>
auditFocus:
  - Run re-uses a stale recorded bundle (no live call)
  - routing_posture defaulted to true without actually being sent
```

(Lower-priority cleanups — §3-H — fold into ITOTORI-226 / ITOTORI-228 to
keep node count manageable. We do NOT mint separate nodes for §3-H-1..6.)

---

## §5 What to retroactively fix on already-merged code

### §5.1 ITOTORI-220 (pair refactor)

- **Verdict**: largely correct. The pair-required-everywhere change is
  what makes the §4 corrective work tractable.
- **In-place fix needed**: none. The pair plumbing stands.
- **Acceptance amendment**: add `statusReason` note that the original
  `acceptanceCriteria` was met with the wrong DEV_PAIR slug; the slug
  defect is tracked in ITOTORI-225 (does not regress ITOTORI-220).
- **What would have caught it at merge**: a one-shot live call against
  the OR endpoint with the asserted modelId would have surfaced the 404. That check did not run because the verification list (`pnpm
--filter @itotori/app test -- providers/pair`) is mock-only.

### §5.2 ITOTORI-221 (OpenRouter provider)

- **Verdict**: largely correct, but the capability sheet's "every axis
  is unknown" default is the §3-B / §3-C structural defect.
- **In-place fix**: ITOTORI-226 deletes the wrong shape; ITOTORI-221
  stays `complete` but acquires `statusReason` continuation noting
  "data-handling registry deleted per ITOTORI-226". NOT marked
  `regressed`.
- **Acceptance amendment**: the original `acceptanceCriteria` row "Cost-
  cap excess raises policy_blocked BEFORE the HTTP request fires" still
  holds — the cost cap path is correct; only the
  `assertProviderInputAllowed` gate is wrong-shaped. Amend the audit
  trail with a one-line note that the gate's removal is by design.
- **What would have caught it at merge**: a live call against OR with
  `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1` and `inputClassification:
"private_corpus"` would have hit the same eight-reason failure mode
  the alpha closer hit on 2026-06-25 — but the live-smoke test uses
  `inputClassification: "synthetic_public"` (test fixture line 37), so
  the gate is never exercised in CI.

### §5.3 ITOTORI-222 (agentic loop)

- **Verdict**: shape is right. The orchestrator is provider-agnostic
  and correctly takes a `PairPolicy`.
- **In-place fix**: none directly. Once §4-6 (ITOTORI-229) lands, the
  loop's stage records gain the zdr/seed surface but the orchestrator
  doesn't need structural changes — only the type for `PairChoice`
  widens.
- **Acceptance amendment**: none required.

### §5.4 ITOTORI-223 (telemetry)

- **Verdict**: shape is right; missing the ZDR-enforced-count axis.
- **In-place fix**: ITOTORI-227 adds the new column + telemetry method
  in a forward-only migration. ITOTORI-223 stays `complete`; not
  `regressed`.
- **What would have caught it at merge**: an acceptance criterion of
  the form "telemetry exposes a per-pair zdrEnforcedCount". That
  criterion was missing because the audit didn't yet exist.

### §5.5 UTSUSHI-228 (alpha closer)

- **Verdict**: currently `in_progress` per the DAG. Its statusReason
  cites the alpha-gap proposal as the parent. The audit's findings
  mean the merge bar for UTSUSHI-228 includes ITOTORI-225 / 226 / 227
  landing first. The UTSUSHI-228 acceptance criterion "Every
  artifact's (modelId, providerId) field matches a pair from
  presets/localize-sweetie-hd.pair-policy.json byte-for-byte" passes
  trivially today because the wrong slug is consistent across files —
  this is a defect the audit calls out for ITOTORI-225.
- **In-place fix**: UTSUSHI-228's existing `dependsOn` already lists
  ITOTORI-221/222/223. Add ITOTORI-225/226/227 to `dependsOn`. **Do
  NOT mark `regressed`** — UTSUSHI-228 was never `complete`.
- **Acceptance amendment**: add an explicit criterion "agentic-loop-
  bundle.v0.json carries routingPosture.zdr === true on every
  invocation" so the rerun (UTSUSHI-231) is the merge gate, not the
  current `in_progress` work.

### §5.6 UTSUSHI-227 (replay-and-verify smoke)

- **Verdict**: correct as merged. Not affected by the audit.

---

## §6 Re-run plan for the alpha closer

After §4 nodes land:

**Required env state (Trevor's shell)**:

- `OPENROUTER_API_KEY=<sk-or-...>` — the live OR API key.
- `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1` — the new ITOTORI-226 assertion
  declaring "I have logged into OR's dashboard, confirmed ZDR-only is
  on for every model group I might route to, and accept that this
  process refuses to start without that assertion".
- `ITOTORI_REAL_GAME_ROOT=<source>` — unchanged.
- `TARGET=<writable-target>` — unchanged.
- `ITOTORI_LIVE_PROVIDER=1` — unchanged (mirrors the smoke command's refusal).

**Required OR dashboard state**:

- Privacy settings → ZDR toggles ON for every model group the
  pair-policy might route to (DeepSeek group, at minimum).
- Privacy settings → "OpenRouter Use of Inputs/Outputs" OFF (this
  is the default; explicit verification is part of §4-1 / docs).
- Privacy settings → Private Input/Output Logging OFF (default).

**Command**:

```
just localize-sweetie-hd --project sweetie-hd-alpha-1
```

**Expected artifacts under `artifacts/localize-sweetie-hd/<timestamp>/`**:

1. `bridge-bundle.json` — from KAIFUU-210 extract.
2. `agentic-loop-bundle.v0.json` — invocation records each carrying
   `routingPosture.zdr === true`, `routingPosture.only === [providerId]`,
   `routingPosture.allow_fallbacks === false`,
   `routingPosture.data_collection === "deny"`. The pair on every
   invocation record byte-equals
   `("deepseek/deepseek-v4-flash", "<verified-provider-id>")`.
3. `patch-report.json` — pair matches the (corrected) pair-policy.
4. `replay-log.json` — contains a TextLine event whose body has the
   en-US sentinel substring.

**Ledger state**:

- `pnpm exec vp run itotori:telemetry-summary --since <run-start>` shows
  one row per pair with `zdrEnforcedCount === invocationCount` (every
  call was ZDR-enforced) and `cache_discount`-aware `cost_amount`.

**ZDR proof posture** (per §1.2 + DOC-AMBIGUOUS-1 resolution from §4-1):
since OR doesn't expose a per-response "ZDR was in effect" field, the
proof is the combination of:

- env assertion (`OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`),
- ledger-captured `routing_posture.zdr === true` on every row,
- account-side audit log (the OR dashboard's request log shows the
  call under the ZDR-only model groups; this is human verification,
  not automated).

The integration doc ITOTORI-224 publishes captures this three-part
proof posture so future auditors can reproduce it without re-reading
the OR docs.

---

## Closing — the audit doc's role

This file is the baseline ITOTORI-224 references. After Trevor signs
off, the parent agent mints ITOTORI-224..ITOTORI-229 + UTSUSHI-231 from
§4, and the corrective work proceeds in numeric order.

The most important thing this audit changes: itotori stops modelling OR
as a thin HTTP relay and starts modelling it as a **policy authority**
whose enforcement is account-wide. Most of the load-bearing itotori-side
code becomes thinner, not thicker, as a result. The cleanups are
forward-only (no shims) per the standing no-legacy-compat rule.
