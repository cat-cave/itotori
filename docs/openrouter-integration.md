# OpenRouter integration (canonical) — fetched 2026-06-25

Status: canonical reference for itotori's OpenRouter wiring. Every claim
about OR behaviour anchors to a fetched doc URL + a fetched-date OR to a
captured live response stored under
`docs/openrouter-integration-evidence/`. When a doc is silent or
ambiguous, the gap is named **DOC-AMBIGUOUS-N** and the empirical
resolution (or the explicit "deferred" verdict) is cited.

This doc is the artefact ITOTORI-224 publishes. Subsequent corrective
nodes (ITOTORI-225..235 + UTSUSHI-231) reference its sections by number.

---

## §1 — Authority and dates

### §1.1 — OR documentation pages fetched 2026-06-25

| Doc URL                                                                    | Fetched    | Notes                                                                         |
| -------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `https://openrouter.ai/docs/quickstart/llms-full.txt`                      | 2026-06-25 | LLM-friendly doc index (master list).                                         |
| `https://openrouter.ai/docs/guides/routing/provider-selection`             | 2026-06-25 | Provider object field reference.                                              |
| `https://openrouter.ai/docs/guides/features/zdr`                           | 2026-06-25 | Zero Data Retention enforcement levels.                                       |
| `https://openrouter.ai/docs/guides/routing/model-fallbacks`                | 2026-06-25 | `models` fallback array, `model` echo.                                        |
| `https://openrouter.ai/docs/guides/routing/routers/latest-resolution`      | 2026-06-25 | `~author/family-latest` alias scheme.                                         |
| `https://openrouter.ai/docs/guides/best-practices/prompt-caching`          | 2026-06-25 | `cached_tokens`, `cache_write_tokens`, `cache_discount`.                      |
| `https://openrouter.ai/docs/guides/features/structured-outputs`            | 2026-06-25 | `response_format.type=json_schema` contract.                                  |
| `https://openrouter.ai/docs/guides/features/presets`                       | 2026-06-25 | Reusable bundles of routing + params.                                         |
| `https://openrouter.ai/docs/api/reference/overview`                        | 2026-06-25 | Chat-completions response shape.                                              |
| `https://openrouter.ai/docs/api/reference/parameters`                      | 2026-06-25 | Sampling + structured-output params.                                          |
| `https://openrouter.ai/docs/api/reference/streaming`                       | 2026-06-25 | SSE shape + final-chunk usage delivery.                                       |
| `https://openrouter.ai/docs/api/api-reference/generations/get-generation`  | 2026-06-25 | `GET /api/v1/generation?id=...` field set.                                    |
| `https://openrouter.ai/docs/cookbook/administration/usage-accounting`      | 2026-06-25 | "Full usage details are now always included automatically in every response." |
| `https://openrouter.ai/api/v1/models`                                      | 2026-06-25 | Live model catalog JSON.                                                      |
| `https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints` | 2026-06-25 | Per-model endpoint list (18 endpoints).                                       |

### §1.2 — Audits adopted as baseline

- `docs/audits/openrouter-wiring-audit-2026-06-25.md` (1256 lines) — the
  ZDR + provider-routing + structured-outputs + recorded-bundle audit.
- `docs/audits/openrouter-cost-tracking-audit-2026-06-25.md` (1004 lines)
  — the no-hardcoded-cost + no-estimation + no-unknown-cost audit.

Both audits' §1 source quotes are upstream-canonical here; this doc is the
canonical merge.

### §1.3 — Evidence file

- `docs/openrouter-integration-evidence/2026-06-25.json` — the captured
  live OR responses (six toy calls + one /generation lookup) used to
  resolve the DOC-AMBIGUOUS items in §11. Authorization header is
  redacted to `Bearer sk-or-***REDACTED***`; the capture script
  (`scripts/itotori-224-evidence-capture.mjs`) verifies the output is
  key-free before exiting.

### §1.4 — Resolution stance

- **Single source of truth** for each behavioral claim: the OR doc URL +
  fetched-date. When the doc is silent, the empirical capture is the
  source. The audits are the bridge between the doc and itotori's code,
  not a parallel authority.
- **No fabrication.** Where a doc page is unreachable (a "Page Not Found"
  redirect or a moved sub-path), this doc says so verbatim and either
  cites the evidence file or marks the question DOC-AMBIGUOUS-N
  deferred. The list of unreachable/moved pages we encountered on
  2026-06-25 is in §11.5.

---

## §2 — Privacy posture (Zero Data Retention)

### §2.1 — Three enforcement levels

Per `https://openrouter.ai/docs/guides/features/zdr` (fetched 2026-06-25):

> "Account-level privacy settings, guardrail-level settings, and
> per-request basis using the `zdr` parameter."

Per the same doc:

> "if any is enabled, ZDR enforcement will be applied."

That is, the three levels compose as an **OR**: a per-request `zdr: true`
**cannot** disable an account-wide ZDR setting, and a `zdr: false` is a
no-op if any higher level enables ZDR. itotori's posture is to never
send `zdr: false`; always send `zdr: true` for non-public input and
verify the account is configured ZDR-only at the dashboard.

### §2.2 — OR's conservative posture

Per the same doc:

> "we take a conservative stance and assume that the endpoint both
> retains and trains on data."

Implication: any endpoint OR cannot positively classify as ZDR is
**dropped from the candidate set** when `zdr: true` is in force.

### §2.3 — What happens when no ZDR provider is available

**Empirically resolved (DOC-AMBIGUOUS-2).** The OR doc page does not
state this explicitly, so it was probed via toy call. From
`docs/openrouter-integration-evidence/2026-06-25.json` call_3 (status
404):

```
{
  "error": {
    "message": "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy",
    "code": 404
  }
}
```

This is the authoritative routing-layer rejection envelope. itotori
**must** surface this 404 as a typed `ModelProviderError` (code
`provider_http_error`) — never retry, never widen the candidate set,
never downgrade `zdr`. (The related process-startup ZDR gate is a
separate `AccountZdrAssertionError`, thrown when
`OPENROUTER_ZDR_ACCOUNT_ASSERTED` is unset.)

Note the differently-shaped envelope from call_5 (pinning to a
nonexistent provider tag):

```
{
  "error": {
    "message": "No allowed providers are available for the selected model.",
    "code": 404,
    "metadata": {
      "available_providers": [<18 catalog tags>],
      "requested_providers": ["this-provider-does-not-exist-itotori-224"]
    }
  }
}
```

OR's error envelope **distinguishes** "no provider matches the policy"
from "no provider matches the explicit `only` list". Since ITOTORI-243
dropped the `only` list (OR-side fallback, §3.2), itotori no longer
emits the second variant; the policy-rejection 404 surfaces through the
coded `ModelProviderError` (`provider_http_error`) HTTP-error path, with
the startup `AccountZdrAssertionError` gate as the separate load-bearing
posture check.

### §2.4 — Response shape under ZDR

**DOC-AMBIGUOUS-1 resolved.** OR's `/chat/completions` response carries
no dedicated "zdr_enforced: true" field — the keys captured on call_1
(account ZDR-on, `provider.zdr=true`; this evidence call ran under the
now-superseded pre-ITOTORI-241 hard-pin request posture, replaced by the
§3.2 `order` + `allow_fallbacks:true` model — the recorded RESPONSE keys
are unaffected) were:

```
["choices", "created", "id", "model", "object", "provider", "service_tier", "system_fingerprint", "usage"]
```

The proof posture is the **combination** of:

1. **Account-level ZDR-only enforcement.** itotori asserts this at
   process startup via the `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1` env var
   (ITOTORI-227); the dashboard URL the §2.3 error envelope echoes
   (`https://openrouter.ai/settings/privacy`) is the human-verification
   surface.
2. **Per-request `provider.zdr: true`.** itotori sends this on every
   non-public-input call (ITOTORI-227).
3. **A non-error response from a provider known to be in the ZDR
   allow-list.** The response's top-level `provider` field echoes the
   upstream that answered. That upstream had to satisfy every active
   ZDR filter to be selected, by §2.2.

Itotori's recorded-bundle layer (ITOTORI-230) persists this three-part
proof on each ledger row so offline replays can reconstruct it.

### §2.5 — Account-side dashboard state required

Per `https://openrouter.ai/docs/guides/features/zdr` + the alpha closer
rerun plan in
`docs/audits/openrouter-wiring-audit-2026-06-25.md` §6:

- **Privacy → Provider Data Policy Filters**: ZDR-only on for every
  model group the pair-policy might route to (DeepSeek group, at
  minimum).
- **Privacy → "OpenRouter Use of Inputs/Outputs"**: OFF (default).
- **Privacy → Private Input/Output Logging**: OFF (default).

These are the conditions under which `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`
is honest.

---

## §3 — Provider routing

Source: `https://openrouter.ai/docs/guides/provider-selection` (fetched
2026-06-25; verified empirically by call_1's success).

### §3.1 — Every documented `provider` object field

| Field                      | Type                | Default   | Verbatim semantic                                                   |
| -------------------------- | ------------------- | --------- | ------------------------------------------------------------------- |
| `order`                    | `string[]`          | —         | "List of provider slugs to try in order"                            |
| `allow_fallbacks`          | `boolean`           | `true`    | "Whether to allow backup providers when the primary is unavailable" |
| `require_parameters`       | `boolean`           | `false`   | "Only use providers that support all parameters in your request"    |
| `data_collection`          | `"allow" \| "deny"` | `"allow"` | "Control whether to use providers that may store data"              |
| `only`                     | `string[]`          | —         | "List of provider slugs to allow for this request"                  |
| `ignore`                   | `string[]`          | —         | "List of provider slugs to skip for this request"                   |
| `quantizations`            | `string[]`          | —         | "List of quantization levels to filter by"                          |
| `sort`                     | `string \| object`  | —         | "Sort providers by price, throughput, or latency"                   |
| `preferred_min_throughput` | `number \| object`  | —         | "Preferred minimum throughput (tokens/sec)"                         |
| `preferred_max_latency`    | `number \| object`  | —         | "Preferred maximum latency (seconds)"                               |
| `max_price`                | `object`            | —         | "The maximum pricing you want to pay for this request"              |
| `zdr`                      | `boolean`           | —         | "Restrict routing to only ZDR (Zero Data Retention) endpoints"      |
| `enforce_distillable_text` | `boolean`           | —         | "Restrict routing to only models that allow text distillation"      |

### §3.2 — itotori's standard alpha posture

OpenRouter-side automatic fallback IS the model: itotori expresses a
provider PREFERENCE and lets OpenRouter route within the ZDR allow-list,
then RECORDS whichever provider actually served. It does NOT hard-pin the
served provider (ITOTORI-241; confirmed live by UTSUSHI-231, where OR
served DigitalOcean and Fireworks within the ZDR allow-list and the run
completed). For every non-public-input call:

```json
{
  "provider": {
    "order": ["<preferredProviderTag>"],
    "allow_fallbacks": true,
    "data_collection": "deny",
    "zdr": true,
    "require_parameters": true
  }
}
```

When a pair-policy stage leaf sets `maxPriceUsd`, itotori sends the value
as `provider.max_price.request` and also enforces it locally after the
response by refusing any completed invocation whose reported `usage.cost`
exceeds that stage cap.

Rationale per knob:

- `order: [preferredProviderTag]` — provider PREFERENCE, NOT a hard pin.
  `order[0]` is the pair's `providerId` (tried first); with
  `allow_fallbacks: true` OpenRouter may route to another ZDR-allow-list
  provider when the preferred one is transiently unavailable. There is no
  `only` enumeration: `zdr: true` is what bounds the routable set, so
  membership self-updates as the account ZDR set changes — no
  itotori-side provider registry to drift
  (`apps/itotori/src/providers/openrouter.ts` `buildOpenRouterProviderRouting`,
  which emits `order` and never `only`).
- `allow_fallbacks: true` — a transient upstream error on the preferred
  provider must not fail the whole call; `zdr: true` confines the
  fallback pool to the account ZDR allow-list. itotori RECORDS the real
  served `(model, providerId)` pair from the response (top-level `model`
  - `provider` fields) into the ledger; whichever ZDR-allow-list provider
    answered is a valid serve. The old `pair_mismatch` guard that rejected
    a served provider other than the requested one was DELETED — provider
    identity is no longer a failure axis
    (`apps/itotori/src/providers/types.ts`, `ModelProviderError`). The
    `(modelId, providerId)` pair rule still holds at the REQUEST layer (the
    pair we ask for, per `memory/feedback_model_provider_pair.md`) and at
    the LEDGER layer (the pair we record); it is no longer a wire-level
    rejection knob.
- `data_collection: "deny"` — independent of ZDR, ensures the provider
  cannot retain for training even when ZDR is satisfied.
- `zdr: true` — `OR`s with the account-wide ZDR setting per §2.1. This is
  the PRIVACY GATE that bounds the fallback pool; it also serves as
  belt-and-suspenders against account state drift.
- `require_parameters: true` — recommended by the structured-outputs
  doc (§6.1) when `response_format` is in play; itotori emits it whenever
  the request carries a `response_format` (json_schema or json_object) so
  a silently-incapable endpoint is filtered out at routing time rather
  than returning unformatted text.

### §3.3 — Knobs itotori does NOT default

`ignore`, `quantizations`, `sort`, `preferred_min_throughput`,
`preferred_max_latency`, `enforce_distillable_text` — caller-supplied
only. (`order` is NOT in this list: per §3.2 it is always populated with
the pair's `providerId` leading; `max_price` is emitted from a stage
leaf's `maxPriceUsd` when set.) The pair-policy schema (ITOTORI-238 v0.3)
widens to carry the relevant ones per stage.

---

## §4 — Model routing and fallback array

### §4.1 — `models` fallback array

Per `https://openrouter.ai/docs/guides/routing/model-fallbacks` (fetched
2026-06-25):

> "Requests are priced using the model that was ultimately used, which
> will be returned in the `model` attribute of the response body."

OR tries each entry on context-length / rate-limit / moderation /
downtime errors. The response's top-level `model` field is the
authoritative "which model actually answered" surface. itotori records
this in the ledger (`provider_id` column from ITOTORI-220 + `model_id`).

### §4.2 — Latest-resolution aliases

Per `https://openrouter.ai/docs/guides/routing/routers/latest-resolution`
(fetched 2026-06-25):

> "When a model author ships a new version (for example Anthropic
> releasing `claude-opus-4.8`), OpenRouter automatically starts routing
> `~anthropic/claude-opus-latest` to it."
>
> "The response's `model` field reflects the concrete model that
> actually served the request, not the alias you sent."

itotori MUST NOT use `~author/family-latest` for recorded-bundle keys
(they violate the deterministic-replay assumption per ITOTORI-220).
For live calls they're permitted but discouraged — the pair-policy
schema (ITOTORI-234) refuses `~` prefixes at parse time.

### §4.3 — Routing suffixes (`:nitro` / `:floor` / `:online` / `:free`)

**DOC-AMBIGUOUS-3 status: deferred-to-docs.** The currently-accessible
docs at `/docs/guides/routing/model-fallbacks` (fetched 2026-06-25)
explicitly do not mention these suffixes. The wiring audit noted the
same. The same job is configurable via `provider.sort` and `max_price`,
which ARE documented; itotori prefers those over suffixes.

### §4.4 — Auto Router

**DOC-AMBIGUOUS-4 status: deferred-to-docs / out-of-scope.** Mentioned
obliquely in `llms-full.txt` but no deep doc page is reachable as of
2026-06-25. Auto-routing violates the pair-pinning rule
(`feedback_model_provider_pair.md`); itotori will never use it
regardless of doc availability.

---

## §5 — Cost reporting (the real-cost contract)

Sources:
`https://openrouter.ai/docs/cookbook/administration/usage-accounting`
and `https://openrouter.ai/docs/guides/best-practices/prompt-caching`
(both fetched 2026-06-25), plus the evidence file.

### §5.1 — `usage.cost` is always returned

Per the usage-accounting cookbook:

> "Full usage details are now always included automatically in every
> response."

The deprecated request flags `usage: { include: true }` and
`stream_options: { include_usage: true }` "have no effect." itotori
does not send them.

### §5.2 — Verified response shape

From `docs/openrouter-integration-evidence/2026-06-25.json` call_1
(a successful baseline against `deepseek/deepseek-v4-flash` on
Fireworks):

```json
{
  "usage": {
    "prompt_tokens": 11,
    "completion_tokens": 16,
    "total_tokens": 27,
    "cost": 0.00000602,
    "is_byok": false,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 0,
      "audio_tokens": 0,
      "video_tokens": 0
    },
    "cost_details": {
      "upstream_inference_cost": 0.00000602,
      "upstream_inference_prompt_cost": 0.00000154,
      "upstream_inference_completions_cost": 0.00000448
    },
    "completion_tokens_details": {
      "reasoning_tokens": 19,
      "image_tokens": 0,
      "audio_tokens": 0
    }
  }
}
```

`cost` is in **USD as a `number`** (not a string, not credits). The
verified value of `usage.cost` byte-equals the `/generation` lookup's
`total_cost` (§5.4).

### §5.3 — Cache annotations

Per `https://openrouter.ai/docs/guides/best-practices/prompt-caching`
(fetched 2026-06-25):

- `usage.prompt_tokens_details.cached_tokens` — "Number of tokens read
  from the cache (cache hit)."
- `usage.prompt_tokens_details.cache_write_tokens` — "Number of tokens
  written to the cache."
- `usage.cost_details.cache_discount` — "tells you how much the
  response saved" (verbatim).

**DOC-AMBIGUOUS-6: posture.** The docs are not crisp on whether
`usage.cost` is gross or net of `cache_discount`. Empirically: this
audit's evidence file does NOT contain a call where implicit caching
hit (the implicit-cache-supporting `deepseek`-tagged endpoint is
excluded from Trevor's ZDR allow-list — see call_3/call_4's 404 ZDR
envelopes). Resolution by doc + audit consensus: **treat `usage.cost`
as authoritative billed cost; never recompute**. The cost-tracking
audit §1.2 anchors this rule:

> "[`usage.cost`] must be read as the source of truth, never
> recomputed."

ITOTORI-233 (cache-aware ledger annotations) writes `cache_discount`
to the ledger AS its own column without modifying the `cost_amount`
column — `cost_amount` mirrors `usage.cost` byte-for-byte; the
`cache_discount` column is an additional annotation for dashboards.

### §5.4 — Generation-lookup re-fetch contract

Per `https://openrouter.ai/docs/api/api-reference/generations/get-generation`
(fetched 2026-06-25), `GET /api/v1/generation?id={genId}` returns the
canonical real cost after the fact. **Cost-audit §1.4 RESOLVED.** From
call_6 of the evidence file (issued ~8s after call_1; first attempt at
3s returned 404 with "not found" — eventual consistency is the
behaviour):

Cost-relevant fields (extract):

```json
{
  "data": {
    "id": "gen-1782395748-RbpAzhCNny8TxgUgPC4P",
    "model": "deepseek/deepseek-v4-flash-20260423",
    "provider_name": "Fireworks",
    "total_cost": 0.00000602,
    "usage": 0.00000602,
    "upstream_inference_cost": 0,
    "cache_discount": null,
    "is_byok": false,
    "tokens_prompt": 9,
    "tokens_completion": 19,
    "native_tokens_prompt": 11,
    "native_tokens_completion": 16,
    "native_tokens_completion_images": null,
    "native_tokens_reasoning": 19,
    "native_tokens_cached": 0,
    "latency": 5314,
    "generation_time": 6036,
    "provider_responses": [
      {
        "endpoint_id": "955a2bd9-841c-4cec-a92e-dbfd93111b24",
        "id": "chatcmpl-b768a9f4d0f64b9cbe49654f67b034c6",
        "is_byok": false,
        "latency": 5314,
        "model_permaslug": "deepseek/deepseek-v4-flash-20260423",
        "provider_name": "Fireworks",
        "status": 200
      }
    ],
    "data_region": "global"
  }
}
```

Two notable observations:

1. **`total_cost == usage.cost`**: $0.00000602 in both the original
   response and the lookup. The reconciliation contract holds within
   1e-9 USD; ITOTORI-235's reconciler can tolerance-check at 1e-9.
2. **`upstream_inference_cost == 0` in the lookup, but ==
   `0.00000602` in the original `cost_details`**. This is an
   off-the-edge discovery: the lookup endpoint reports a DIFFERENT
   number for `upstream_inference_cost` than the chat-completions
   `cost_details.upstream_inference_cost`. ITOTORI-235 must consume
   `total_cost` only and ignore the lookup's `upstream_inference_cost`
   for billing-truth purposes (or document the divergence as
   expected). ⚠ Note for ITOTORI-235's spec.
3. **`provider_responses[]`** carries `endpoint_id` (a stable
   per-endpoint UUID), `latency`, `model_permaslug` (the canonical
   slug), and per-attempt `status`. This is richer than the
   chat-completions response's top-level `provider` echo string and
   is the better source for routing-posture proofs in long-term
   audit replay.

### §5.5 — Streaming and final-chunk usage

Per `https://openrouter.ai/docs/api/reference/streaming` (fetched
2026-06-25):

> "Final chunk includes usage stats."

itotori today does not stream (per `openrouter.ts:139` and the agentic
loop's non-streaming default). When streaming is added (future), the
ledger writer must consume the final chunk's `usage` block; ad-hoc
mid-stream cost estimates are forbidden by Trevor's standing rule.

---

## §6 — Structured outputs

Source: `https://openrouter.ai/docs/guides/features/structured-outputs`
(fetched 2026-06-25), plus `parameters` doc.

### §6.1 — `response_format.json_schema` is the production path

Per the doc:

> "include a `response_format` parameter in your request, with `type`
> set to `json_schema` and the `json_schema` object containing your
> schema"

Schema object shape: `{ name, strict, schema }`. `strict: true`
enforces schema adherence (when supported by the upstream provider).

Per the same doc:

> "Set `require_parameters: true` in your provider preferences...to
> ensure your chosen model supports structured outputs"

itotori sends `provider.require_parameters: true` whenever the request
opts into `json_schema` / `tool_call_arguments` / tools (the existing
`openrouter.ts:468` behaviour is correct; preserved post-ITOTORI-227).

### §6.2 — `response_format.json_object`

Mentioned by the doc as an alternative ("type: 'json_object'") without
schema enforcement. itotori treats `json_object` as a weaker mode for
recorded-bundle compatibility but prefers `json_schema` for live calls.

### §6.3 — Standalone `structured_outputs: true` boolean

**DOC-AMBIGUOUS-5 status: deferred + posture decided.** The doc page
does not address the standalone boolean; the catalog's
`supported_parameters` array for `deepseek/deepseek-v4-flash` does
include it. itotori's posture: **never send `structured_outputs: true`
alone.** Always send `response_format` when structured output is
required. The boolean appears to be a capability declaration, not a
behaviour switch — sending it without `response_format` would be
ambiguous in code review and is forbidden by the post-ITOTORI-225
linter.

### §6.4 — Tool-call enforcement

Per the API parameters reference: `tool_choice: "required"` /
`{type: "function", function: {name}}` / `parallel_tool_calls: false`.
itotori's `tool_call_arguments` structured-output mode wires
`tool_choice: {type: "function", ...}` which lines up with the OpenAI
shape OR mirrors. No change after this audit.

---

## §7 — Headers and metadata echo

### §7.1 — Required headers

Per `https://openrouter.ai/docs/api/reference/overview` (fetched
2026-06-25), recognised headers include `Authorization`, `HTTP-Referer`,
`X-OpenRouter-Title`, `X-OpenRouter-Categories`. itotori sends:

- `Authorization: Bearer ${OPENROUTER_API_KEY}`
- `Content-Type: application/json`
- `HTTP-Referer: <itotori-canonical-attribution-url>`
- `X-Title: <agentLabel>` (the OpenAI-style alias OR also accepts).

### §7.2 — `X-OpenRouter-Metadata: enabled`

**DOC-AMBIGUOUS-8 RESOLVED.** Not documented in any reachable OR docs
page as of 2026-06-25 — but EMPIRICALLY proven by comparing call_1
(no header) against call_2 (header set) in
`docs/openrouter-integration-evidence/2026-06-25.json`:

- Call_1 top-level keys (9):
  `choices, created, id, model, object, provider, service_tier, system_fingerprint, usage`.
- Call_2 top-level keys (10):
  `choices, created, id, model, object, openrouter_metadata, provider, service_tier, system_fingerprint, usage`.

The extra key is `openrouter_metadata`, whose own keys are
`requested, strategy, region, summary, attempt, is_byok, endpoints`.
**The header is the gate.** itotori's OR provider today sends this
header by default (`apps/itotori/src/providers/openrouter.ts:139`);
this audit confirms that posture is functional, not dead code.
ITOTORI-233's decision tree: **keep + fix** the
endpoint-pricing-fallback path (`openrouter.ts:721-738`) because the
metadata block IS available when itotori asks for it.

### §7.3 — Idempotency

**DOC-AMBIGUOUS-7 status: no documented key.** Neither
`/docs/api/reference/overview` nor `/docs/api/reference/parameters`
list an idempotency-key parameter. itotori does not assume OR
dedupes by id; each retry is a fresh billed call.

---

## §8 — Errors and retries

### §8.1 — Error envelope

Per `https://openrouter.ai/docs/api/reference/overview` (fetched
2026-06-25):

```
error?: {
  code: number;
  message: string;
  metadata?: Record<string, unknown>;
}
```

Empirically confirmed by call_5 of the evidence file (a 404 with
`metadata.available_providers + metadata.requested_providers`) and
call_3 (a 404 ZDR envelope without a `metadata` field — the `metadata`
is optional).

### §8.2 — itotori's typed-error mapping

| OR error envelope                                                             | itotori typed error                                                                                                    | Source      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| 404 + "No endpoints found matching your data policy (Zero data retention)..." | `ModelProviderError` (code `provider_http_error`); the process-startup ZDR gate is `AccountZdrAssertionError`          | ITOTORI-227 |
| 404 + "Generation <id> not found"                                             | `ModelProviderError` (code `provider_http_error`, `retryable`; the documented /generation eventual-consistency window) | ITOTORI-235 |
| non-2xx + missing/invalid `usage.cost` field                                  | `ModelProviderError` (code `provider_response_invalid`)                                                                | ITOTORI-225 |
| pre-flight per-process cost-cap hit                                           | `OpenRouterCostCapError`                                                                                               | ITOTORI-225 |
| recorded-bundle merge with a colliding, non-equal captured cost               | `RecordedCostMismatchError`                                                                                            | ITOTORI-228 |

The `only`-list "No allowed providers are available for the selected
model." 404 no longer applies: ITOTORI-243 relaxed provider pinning to
OR-side fallback (`order` + `allow_fallbacks:true`, no `only` list), so
provider identity is no longer a failure axis — see §3.2.

No silent retries on any of these except the generation-lookup 404
(which is a documented eventual-consistency window, surfaced `retryable`).

### §8.3 — Rate limits

`https://openrouter.ai/docs/faq#how-are-rate-limits-calculated` — not
deeply mirrored on a per-feature page. itotori's existing token-bucket
at 1 rps (`openrouter.ts:1163, 1190`) is well below documented OR
limits. No change after this audit.

---

## §9 — Model catalog

### §9.1 — `GET /api/v1/models`

The live catalog JSON is the authoritative source for slug existence
and per-model `pricing` data. Per `usage-accounting`,
`pricing.prompt` / `pricing.completion` are USD per token as decimal
strings.

Per the per-model `pricing` block (verified for
`deepseek/deepseek-v4-flash`):

```
prompt, completion, web_search, image, audio,
input_cache_read, input_cache_write, internal_reasoning,
image_output, image_token, input_audio_cache,
audio_output, request, discount
```

Top-level model entries also carry `top_provider` (NOT a slug — a
summary stats object), `supported_parameters`, `context_length`,
`pricing`, and a `links.details` URL pointing at the endpoint sub-resource.

### §9.2 — `GET /api/v1/models/{author}/{family}/endpoints`

The per-model endpoint sub-resource lists every provider currently
serving the model. Each endpoint object carries:

- `provider_name` (human-readable) + `tag` (the slug used in
  `provider.order` / `provider.ignore`).
- `pricing` (per-endpoint, may differ from the top-level model
  pricing).
- `context_length`, `max_completion_tokens`, `max_prompt_tokens`.
- `supported_parameters` (subset of the model-level array; the
  per-endpoint set is authoritative for `provider.require_parameters`).
- `status`, `uptime_last_30m`, `uptime_last_5m`, `uptime_last_1d`.
- `supports_implicit_caching` (boolean).
- `quantization`.

NB: as of 2026-06-25 the per-endpoint record does **not** include a
`zero_data_retention: boolean` flag — that classification appears to
be account-side state, not catalog-side. itotori cannot pre-filter
on ZDR from the catalog; the routing-time enforcement (§2) is the
only mechanism.

### §9.3 — DEV_PAIR confirmation (slug + provider)

Verified against `/api/v1/models` and `/api/v1/models/deepseek/deepseek-v4-flash/endpoints` on 2026-06-25:

- **`deepseek/deepseek-v4-flash`** EXISTS. Canonical slug
  `deepseek/deepseek-v4-flash-20260423`. Context: 1,048,576. Supported
  parameters include `response_format`, `structured_outputs`, `tools`,
  `tool_choice`, `reasoning`.
- **`deepseek/deepseek-chat-v4`** DOES NOT EXIST. ITOTORI-226 owns
  replacing the invented slug.
- **Fireworks IS in the endpoint list** for `deepseek-v4-flash`
  (`tag: "fireworks"`, `provider_name: "Fireworks"`, pricing:
  prompt=$0.00000014/token, completion=$0.00000028/token,
  input_cache_read=$0.000000028/token). The audit's planned providerId
  pin (`fireworks`) is catalog-correct.
- **Fireworks does NOT support implicit caching** for this model
  (`supports_implicit_caching: false`). Only the DeepSeek-tagged
  endpoint advertises implicit caching (`supports_implicit_caching:
true`), and as proven by the evidence file's call_3/call_4 404
  envelopes, the DeepSeek-tagged endpoint is excluded from Trevor's
  ZDR allow-list. **ITOTORI-226's evidence-grounded comment must
  document the cache trade-off**: pinning to Fireworks gives up
  implicit caching to keep ZDR-routing. Switching to a different
  ZDR-permitted provider would require empirical evidence ITOTORI-226
  is not authorised to gather.
- **Live call success**: `docs/openrouter-integration-evidence/2026-06-25.json`
  call_1 (POST /chat/completions, `model:"deepseek/deepseek-v4-flash"`,
  `provider.zdr:true`, `provider.data_collection:"deny"`; captured under
  the now-superseded pre-ITOTORI-241 hard-pin request posture — the
  current wire posture is §3.2's `order` + `allow_fallbacks:true`)
  returned 200, `provider:"Fireworks"`, `usage.cost: 0.00000602`. The
  pair routes; the audit can land without further verification.

### §9.4 — Other catalog endpoints with v4 family

- `deepseek/deepseek-v4-pro` (canonical `deepseek-v4-pro-20260423`) —
  same parameter set, context 1M, max completion 384K. Candidate for
  the pair-policy fallback array in ITOTORI-234.

---

## §10 — Cross-references to itotori code

This doc anchors the corrective-node landing surface. Per-node hooks:

| Section                         | Node                                  | Hook                                                                                                                                      |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| §5.2 — `usage.cost` is real     | ITOTORI-225                           | `normalizeOpenRouterCost` returns `costKind: "billed"` from `usage.cost`, raises on missing.                                              |
| §5.3 — cache annotations        | ITOTORI-233                           | `TokenUsage.cacheReadTokens/cacheWriteTokens`; `ProviderCost.cacheDiscountMicrosUsd`.                                                     |
| §5.4 — `/generation` reconciler | ITOTORI-235                           | `openrouter-cost-reconciler.ts` honours the eventual-consistency window (call_6 succeeded after ~8s; reconciler must back off similarly). |
| §2.3 — ZDR rejection envelope   | ITOTORI-227                           | Runtime 404 typed as a coded `ModelProviderError` (`provider_http_error`) at the seam; startup gate is `AccountZdrAssertionError`.        |
| §2.4 — ZDR proof posture        | ITOTORI-230                           | `ProviderRunRecord.routingPosture` mirrors `{order, allow_fallbacks, data_collection, zdr, require_parameters}`.                          |
| §7.2 — metadata header gate     | ITOTORI-233                           | Endpoint-pricing fallback path kept-and-fixed (header IS the gate, header IS sent today).                                                 |
| §3.2 — alpha routing posture    | ITOTORI-227                           | `buildOpenRouterProviderRouting` defaults `provider.zdr=true` for non-public input.                                                       |
| §9.3 — slug + providerId        | ITOTORI-226                           | `dev-pair.ts`, retired `presets/localize-sweetie-hd.pair-policy.json` move to `deepseek/deepseek-v4-flash` + `fireworks`.                 |
| §9.4 — fallback model           | ITOTORI-234                           | Pair-policy schema v0.2 allows `fallbackModels: ["deepseek/deepseek-v4-pro"]`.                                                            |
| §8.2 — typed errors             | ITOTORI-225, ITOTORI-227, ITOTORI-235 | Each error envelope maps to a typed itotori error; no silent retries.                                                                     |

ITOTORI-224 itself rewrites the misleading `dev-pair.ts:133` note (a
comment claiming the pair was "verified against OpenRouter's published
Fireworks-hosted deepseek-v4 endpoint as of 2026-06") to point at this
evidence file. The slug correction is deferred to ITOTORI-226 per the
collision plan.

---

## §11 — DOC-AMBIGUOUS resolutions index

For machine-readable resolutions see `docs/openrouter-integration-evidence/2026-06-25.json` `docAmbiguousResolutions`.

| #   | From                                                                                     | Resolution                                                                                                                                                                                                                              | Source                                            |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Wiring §1.2 — single "ZDR enforced" response field?                                      | **NO_SINGLE_FIELD.** Three-part proof posture (account + per-request + non-error response).                                                                                                                                             | §2.4 (this doc) + evidence call_1 top-level keys. |
| 2   | Wiring §1.2 — behaviour when no ZDR provider?                                            | **CONFIRMED 404 envelope.** "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy"                                                                                     | §2.3 (this doc) + evidence call_3 body.           |
| 3   | Wiring §1.3 — `:nitro` / `:floor` / `:online` / `:free` suffixes?                        | **DEFERRED-TO-DOCS.** Not mentioned in reachable model-fallbacks doc; use `provider.sort` + `max_price` instead.                                                                                                                        | §4.3.                                             |
| 4   | Wiring §1.3 — Auto Router?                                                               | **DEFERRED-TO-DOCS / OUT-OF-SCOPE.** Pair-pinning rule forbids regardless.                                                                                                                                                              | §4.4.                                             |
| 5   | Wiring §1.4 — standalone `structured_outputs: true` boolean?                             | **DEFERRED + POSTURE.** Never send alone; always pair with `response_format`.                                                                                                                                                           | §6.3.                                             |
| 6   | Wiring §1.5 — `usage.cost` gross or net of `cache_discount`?                             | **POSTURE: TREAT AS NET (authoritative).** Empirical implicit-cache evidence not obtainable (DeepSeek endpoint excluded from ZDR allow-list); resolved by cost-audit §1.2 rule "must be read as the source of truth, never recomputed." | §5.3.                                             |
| 7   | Wiring §1.8 — idempotency key?                                                           | **NO DOCUMENTED KEY.** Each retry is a fresh billed call.                                                                                                                                                                               | §7.3.                                             |
| 8   | Wiring §3-D — `X-OpenRouter-Metadata: enabled` surfaces `openrouter_metadata.endpoints`? | **CONFIRMED.** Header is the gate; without it the key is absent.                                                                                                                                                                        | §7.2 + evidence call_1 vs call_2 keys.            |
| 9   | Cost §6.1 — USD-only for alpha?                                                          | **CONFIRMED.** `/generation` lookup states `total_cost: number` in USD; chat-completions `usage.cost: number` in USD. ITOTORI-232's `check (cost_unit = 'usd')` is correct.                                                             | §5.2, §5.4.                                       |
| 10  | Cost §6.2 — catalog-driven pre-flight forecasting?                                       | **DEFERRED TO BETA.** Post-hoc real-cost (§5.4 + ITOTORI-235) is the alpha posture.                                                                                                                                                     | §9.1.                                             |
| 11  | Cost §6.3 — pre-fix recorded bundles cost-zero?                                          | **MARK SCHEMA-INCOMPATIBLE, FORCE RECAPTURE.** ITOTORI-228 implements; no shim.                                                                                                                                                         | Cross-reference to ITOTORI-228 deliverables.      |

### §11.5 — Doc pages that 404'd or moved (2026-06-25)

For audit-trail honesty: when this doc was being written, the
following URLs returned a "Page Not Found" via the WebFetch path,
and resolution was sourced from the alternative URL listed:

| Tried URL                                                   | Outcome | Working alternative                                                       |
| ----------------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `https://openrouter.ai/docs/features/provider-routing`      | 404     | `https://openrouter.ai/docs/guides/routing/provider-selection`            |
| `https://openrouter.ai/docs/features/zero-data-retention`   | 404     | `https://openrouter.ai/docs/guides/features/zdr`                          |
| `https://openrouter.ai/docs/features/model-routing`         | 404     | `https://openrouter.ai/docs/guides/routing/model-fallbacks`               |
| `https://openrouter.ai/docs/features/prompt-caching`        | 404     | `https://openrouter.ai/docs/guides/best-practices/prompt-caching`         |
| `https://openrouter.ai/docs/features/structured-outputs`    | 404     | `https://openrouter.ai/docs/guides/features/structured-outputs`           |
| `https://openrouter.ai/docs/api-reference/overview`         | 404     | `https://openrouter.ai/docs/api/reference/overview`                       |
| `https://openrouter.ai/docs/api-reference/get-a-generation` | 404     | `https://openrouter.ai/docs/api/api-reference/generations/get-generation` |
| `https://openrouter.ai/docs/use-cases/usage-accounting`     | 404     | `https://openrouter.ai/docs/cookbook/administration/usage-accounting`     |

If OR moves these again, the working alternatives listed above are the
current source; this table will be updated on the next evidence
capture pass (a future ITOTORI-224-follow-on).

---

## §12 — Reproducing the evidence

The evidence file is reproducible by anyone with an OR API key whose
account is configured ZDR-only:

1. Source the worktree env (`direnv allow` once, then it's automatic).
2. Run `node scripts/itotori-224-evidence-capture.mjs`.
3. The script writes
   `docs/openrouter-integration-evidence/<DATE>.json` and verifies
   no `sk-or-...` pattern appears in its own output before exiting.
4. Hard-capped at 6 outbound calls and < $0.01 total spend (the
   2026-06-25 capture cost $0.0000182).

Re-fetching this doc's cited URLs is the responsibility of the next
auditor on the next major rev.
