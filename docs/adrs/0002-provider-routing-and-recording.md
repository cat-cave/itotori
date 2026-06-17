# ADR 0002: Provider Routing And Recording

## Status

Accepted for ITOTORI-031.

## Context

Itotori needs LLM-backed drafting, QA, repair, experiment, and benchmark work,
but the framework must not depend on live credentials, a single router, or
frontier model behavior. Public CI must remain deterministic and must run with
fake or recorded providers only.

OpenRouter is useful because it exposes many models through one OpenAI-style
API, but it is still a router with provider-specific behavior behind a shared
surface. The same requested model can be served by different upstream providers
with different pricing, data policy, rate limits, structured output support,
token accounting, context windows, and tool-call behavior. Itotori must record
those facts instead of treating the requested model id as the whole execution
identity.

Local OpenAI-compatible servers are also a required boundary. They let agents
test low-cost or private workflows against local inference without changing
Itotori's core agent, prompt, retry, fixture, or cost-recording logic.

## OpenRouter References

This ADR uses the following OpenRouter docs as current adapter references:

- [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)
- [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Presets](https://openrouter.ai/docs/guides/features/presets)
- [Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection)
- [Input & Output Logging](https://openrouter.ai/docs/guides/features/input-output-logging)
- [Provider Logging](https://openrouter.ai/docs/guides/privacy/provider-logging)

These references inform the OpenRouter adapter checklist, but they are not the
Itotori provider abstraction. OpenRouter request shapes should stay adapter
metadata unless the concept is provider-neutral.

## Decision

All model calls are provider-boundary calls. Core Itotori workflows must depend
on a provider-neutral interface and capability record, not on OpenRouter
response quirks, local server quirks, or direct SDK types.

The initial provider families are:

- `fake`: deterministic test provider used by unit tests and public CI.
- `recorded`: fixture-backed provider used by deterministic integration tests.
- `openrouter`: live OpenRouter-compatible provider used only by explicit
  opt-in runs.
- `local-openai-compatible`: local or private endpoint that speaks an
  OpenAI-compatible chat or responses API shape.

CI must use `fake` or `recorded` only. `just check`, `just ci`, roadmap
validation, unit tests, and fixture tests must not require OpenRouter, OpenAI,
local inference servers, or any other live credential.

## Secret Handling Rules

`.env` may contain a limited OpenRouter key for a developer or runner, but
agents, docs, scripts, tests, and application code must not read, print,
display, expose, or commit `.env`.

Provider credentials may be supplied only through one of these channels:

- Process environment that the user or invoking shell has already loaded.
- Explicit local-only config under an ignored path such as `.tmp/`.
- A secret manager used by a deployment environment, once deployment exists.

Provider credentials must not be supplied through committed config, test
fixtures, prompt presets, roadmap nodes, audit reports, markdown examples, URL
query strings, or provider run artifacts.

Repository code must not auto-load `.env` with `dotenv` or equivalent behavior.
If a live run needs a missing secret, the command should fail with a message
asking the owner to export the secret or run from an environment where it is
already loaded. The failure message must not print secret names together with
surrounding environment dumps.

When OpenRouter keys are used, they should be limited, rotatable, and scoped to
cheap experiment budgets. A leaked or over-permissive key is a security incident,
not a benchmark anomaly.

## Model And Cost Policy

Prefer cheap, light, modern models for Itotori experiments. Suitable examples
include:

- `inclusionai/ring-2.6-1t`;
- `ibm-granite/granite-4.1-8b`;
- `deepseek/deepseek-v4-flash`;
- `deepseek/deepseek-v4-flash/pro`;
- `inclusionai/ling-2.6-flash`;
- `google/gemma-4-26b-a4b-it`;
- `google/gemma-4-31b-it`;
- `nvidia/nemotron-3-super-120b-a12b`;
- similar low-cost current models with documented pricing and capability.

The goal is framework quality, retries, prompting, tool use, evidence loops,
and cost discipline, not frontier model dependence. If cheap models appear
unusably weak, first suspect provider routing, prompting, structured-output
handling, retries, context construction, missing deterministic tools, or
framework design before blaming model size.

Every live run must record:

- provider family and endpoint family;
- requested model id;
- actual routed model id when the provider reports one;
- actual upstream provider when the router reports one;
- router allow-list, deny-list, sorting, fallback, provider-routing privacy
  settings, and the source of each default or override;
- OpenRouter account/workspace logging and privacy states when OpenRouter is
  used, recorded separately from provider-routing fields: Input & Output
  Logging, OpenRouter Use of Inputs/Outputs, account-wide provider data policy
  filters for paid and free routes, OpenRouter account data-collection opt-in
  state, metadata collection expectation, and EU routing domain when relevant;
- model fallback plan and actual model used for pricing;
- prompt preset id and prompt template version;
- remote preset slug, version, and config snapshot if a provider preset is used;
- input fixture or corpus id and hash, with private paths redacted;
- structured-output mode and fallback path;
- retry count, error classes, and final status;
- start time, latency, token counts, and cost when available;
- cost estimate source when billed cost is unavailable.

Cost ledgers must separate billed usage, provider-reported estimates, local
endpoint estimates, and unknown usage. Local endpoint runs must record cost as
zero or estimated without mixing those numbers into OpenRouter billed reports.

## Prompt And Output Logging

Raw prompts and raw completions are sensitive by default. Logs, committed
fixtures, audit reports, and benchmark summaries should record prompt preset
identity, prompt hashes, model/provider metadata, token counts, cost, validation
results, and sanitized findings instead of raw prompt text.

Raw prompt or completion text may be stored only when all of these are true:

- The input is synthetic or otherwise approved for redistribution.
- The artifact is local-only under an ignored path, unless a reviewer promotes a
  sanitized public fixture.
- The artifact contains no provider key, account id, private corpus path,
  proprietary source text, local username, or prompt injection sample that would
  be unsafe to publish.
- The artifact records that raw text capture was enabled.

Free or logging providers must be treated as public or semi-public execution
surfaces. Do not send private corpora, customer data, secrets, unreleased source
material, or confidential prompts to providers whose logging, retention,
training, or human-review policy is unknown or incompatible with the data.

OpenRouter has account and workspace prompt/completion handling settings in
addition to upstream provider routing. Input & Output Logging can store prompts
and completions in OpenRouter logs for private review. OpenRouter Use of
Inputs/Outputs can permit OpenRouter to use prompt and completion content for
product improvement through an account data-collection opt-in. OpenRouter also
stores request metadata such as token counts, latency, model, provider, and
cost. Live OpenRouter artifacts must record each of these states as enabled,
disabled, not applicable, or unknown. Unknown account/workspace state is
acceptable only for synthetic or public inputs.

For OpenRouter source-text, game-script, private-corpus, or unreleased-material
runs, `provider.data_collection: "deny"` is the default. This field is only an
upstream provider-routing constraint; it does not disable OpenRouter Input &
Output Logging, OpenRouter Use of Inputs/Outputs, account-wide privacy settings,
or OpenRouter's own request metadata handling. A human may explicitly opt into a
route that allows provider data collection only for public or approved inputs,
and the run metadata must record that decision separately from the OpenRouter
account/workspace states above. Use ZDR routing when the data policy or owner
requires it.

Benchmarks must label runs that used free providers, logging providers, or
unknown-retention routes. Those runs are useful for cost and reliability
experiments, but they must not be merged into private-data quality claims.

## OpenRouter Provider Selection Checklist

OpenRouter runs must capture a capability checklist before the output can be
used for benchmark, quality, or default-model decisions.

| Area                       | Required Record                                                                                                                                                                                                               | Policy                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Route identity             | Requested model, actual routed model, upstream provider, route settings                                                                                                                                                       | A requested model id alone is insufficient evidence.                                         |
| Provider request object    | `order`, `allow_fallbacks`, `require_parameters`, `data_collection`, `zdr`, `enforce_distillable_text`, `only`, `ignore`, `quantizations`, `sort`, throughput/latency preferences, and `max_price` when set                   | Store these as OpenRouter adapter metadata, not core contract fields.                        |
| Load balancing             | Whether default load balancing, explicit `sort`, or explicit `order` was used                                                                                                                                                 | Explicit `sort` or `order` disables OpenRouter default load balancing; record why.           |
| Provider privacy           | Free/paid status, logging policy, retention policy, training policy when known                                                                                                                                                | Unknown or logging routes may process only public or synthetic inputs.                       |
| OpenRouter account privacy | Input & Output Logging, OpenRouter Use of Inputs/Outputs account data-collection opt-in, account-wide provider data policy filters for paid/free routes, metadata collection expectation, and EU routing domain when relevant | Record this separately from `provider.data_collection`; unknown state blocks private inputs. |
| Structured output          | JSON schema, JSON object mode, tool calls, plain JSON, or unsupported                                                                                                                                                         | Use the strongest verified mode, then record fallback.                                       |
| Parameter support          | Whether `require_parameters` was used and which strict parameters were required                                                                                                                                               | Strict JSON Schema requests must require parameter support before routing.                   |
| Tool calling               | Supported, unsupported, partially supported, or untested                                                                                                                                                                      | Tool-heavy agents must not assume OpenRouter-wide parity.                                    |
| Model fallbacks            | `models` list, trigger error, final model, and final provider                                                                                                                                                                 | Fallback cost and quality attach to the actual model used.                                   |
| Presets                    | Preset slug, version id, active version, and config snapshot when used                                                                                                                                                        | Remote presets are not the sole source of truth for Itotori behavior.                        |
| Context limits             | Advertised context, effective prompt limit, output limit                                                                                                                                                                      | Truncation must be explicit and auditable.                                                   |
| Token accounting           | Prompt tokens, completion tokens, reasoning tokens, cached tokens, unknown fields                                                                                                                                             | Unknown usage cannot be reported as billed precision.                                        |
| Pricing                    | Billed cost, estimated cost, free route, or unknown                                                                                                                                                                           | Free routes must still report latency and quality separately.                                |
| Retry behavior             | Retry count, error classes, fallback route, final route                                                                                                                                                                       | Silent route fallback invalidates benchmark evidence.                                        |
| Streaming                  | Enabled, disabled, unsupported, or untested                                                                                                                                                                                   | Streaming parse failures must fall back to non-streaming before blaming quality.             |
| Refusal/safety             | Refusal fields, content-filter markers, or provider-specific safety response                                                                                                                                                  | Safety output must be represented without provider-specific branching in core logic.         |

OpenRouter-specific response fields may be stored in provider metadata, but core
Itotori contracts should use neutral fields. When an OpenRouter quirk becomes
important, add it to the capability record rather than branching product logic
directly on OpenRouter fields.

By default, OpenRouter load balances across stable, lower-cost provider
candidates and keeps other providers available as fallbacks. Explicit `sort` or
`order` changes that behavior and must be treated as a run parameter, not an
invisible optimization. Throughput and latency preferences can steer routing,
but they are still preferences; `max_price` is a hard ceiling that may prevent a
request from running.

OpenRouter routing can be affected by tool and structured-output parameters. If
Itotori sends strict `response_format` JSON Schema, the OpenRouter adapter must
also set `provider.require_parameters: true` so providers that would ignore or
drop unsupported parameters are excluded. If that leaves no compatible provider,
the adapter should fall back through Itotori's structured-output strategy rather
than pretending provider-native strict JSON was available.

OpenRouter model failover through the `models` array may trigger on context
length errors, moderation filtering, rate limits, and downtime. Itotori should
model this as a provider-neutral fallback plan, with OpenRouter `models` as one
adapter implementation. Anthropic-style `fallbacks` on OpenRouter's Messages
endpoint have narrower shape limits and cannot be combined with `models`, so
they must not leak into the shared fallback abstraction.

OpenRouter presets can manage routing preferences, model selection, system
prompts, generation parameters, and provider inclusion/exclusion rules. They
are useful for managed configuration, but mutable remote presets must not be
Itotori's only source of truth. If used, record the preset slug, active version,
and config snapshot in run metadata, and keep the Itotori prompt preset or
experiment definition reviewable in the repository.

## Local OpenAI-Compatible Endpoint Rules

Local endpoints must be selected through the same provider-neutral interface as
OpenRouter. The endpoint base URL, provider family, model id, and capability
record must be explicit for each run.

Local endpoints must not be treated as OpenRouter routes. They have separate
cost, privacy, latency, hardware, model-build, quantization, and context-window
facts. Reports should capture:

- endpoint family and base URL label, with host details redacted when needed;
- model id or local model alias;
- model build, quantization, and serving engine when known;
- hardware class when it affects benchmark claims;
- supported structured-output and tool-call modes;
- token accounting source or estimate method.

Local endpoint tests should run only when explicitly opted in. Public CI should
use fake or recorded providers even if a developer machine happens to have a
local server running.

## Structured-Output Fallback

Structured output must be validated by deterministic parsers before downstream
workflow state changes. Itotori should prefer the strongest verified mode for a
provider/model pair:

1. Provider-native JSON Schema or equivalent strict schema mode.
2. Tool-call arguments validated against the same schema.
3. JSON object mode with deterministic schema validation.
4. Plain text JSON extraction with strict parsing, schema validation, and
   bounded repair retries.

Provider-native structured outputs are not universal. For OpenRouter, strict
JSON Schema should be attempted only for models and providers with verified
support, and the request must require provider support for the strict parameters
being sent.

Fallback is allowed only when it is recorded. A successful fallback output must
record the attempted mode, fallback mode, validation errors, retry count, and
final schema version. A failed output must fail closed with evidence; it must
not be silently coerced, partially applied, or accepted because the prose looked
reasonable.

Repair prompts should include only the minimum validation error details needed
to fix structure. They must not echo secrets or private corpus text into logs.

## Recorded Fixture Policy

There are two kinds of provider records:

- Committed provider fixtures: deterministic, reviewable fixtures derived from
  fake providers or sanitized public inputs.
- Live provider run artifacts: opt-in local records from real providers that
  stay under ignored paths such as `.tmp/provider-runs/<run-id>/`.

Committed provider fixtures may be used by CI only when they meet all of these
requirements:

- No live credential was required to replay them.
- Inputs are synthetic, public, or approved for redistribution.
- Raw prompts and completions are absent or explicitly reviewed as safe public
  fixture content.
- Provider/model metadata is sanitized and contains no account ids, request ids
  that reveal account history, private hostnames, or local paths.
- The fixture records schema version, prompt preset id, fixture id, hashes, and
  deterministic validation result.

Live provider run artifacts must be non-committed by default. They should record
enough metadata to reproduce routing and cost analysis, but raw request and
response bodies should be redacted unless the run used public fixtures and raw
capture was explicitly enabled.

Promoting a live artifact into a committed fixture requires a manual secret and
copyright review. Promotion should prefer compact normalized fixtures over raw
provider transcripts.

## Review Checklist

Before merging provider-related work:

1. Confirm `just check` and public CI pass without live provider credentials.
2. Confirm code and scripts do not read `.env` or auto-load `.env` files.
3. Confirm live provider paths require an explicit opt-in flag or local-only
   config.
4. Confirm raw prompt logging is disabled by default and visibly labeled when
   enabled.
5. Confirm OpenRouter runs record route identity and capability facts instead
   of assuming requested model identity.
6. Confirm OpenRouter live runs record Input & Output Logging, OpenRouter Use
   of Inputs/Outputs, account-wide provider data policy filters, OpenRouter
   account data-collection opt-in state, and unknown account/workspace states
   separately from `provider.data_collection`.
7. Confirm free or unknown-logging providers cannot receive private corpora or
   confidential prompts.
8. Confirm source-text and game-script OpenRouter runs default to
   `data_collection: "deny"` as an upstream provider-routing constraint unless
   a human explicitly opted in.
9. Confirm model fallback records the actual model used for pricing and quality
   evidence.
10. Confirm remote presets are represented by reviewable Itotori config plus a
    provider preset snapshot, not by a mutable slug alone.
11. Confirm structured-output fallback is deterministic, bounded, and recorded.
12. Confirm live run artifacts are ignored by git and committed fixtures are
    sanitized.

## Alternatives Considered

### OpenRouter As The Core Abstraction

This would make early implementation fast, but it would leak router behavior
into prompts, structured-output parsing, cost reports, and tests. It would also
make local endpoint parity harder.

### Direct SDK Per Provider

Direct SDKs can expose provider-specific features, but they multiply behavior
surfaces before Itotori has stable prompts, fixtures, and benchmark schemas.
Provider-specific adapters can be added later behind the same neutral boundary.

### Commit Live Provider Transcripts

Raw transcripts are useful for debugging, but they are high risk for secret
leakage, prompt logging surprises, private corpus leakage, and provider-account
metadata exposure. Sanitized fixtures and local ignored artifacts preserve the
debugging path without making live transcripts part of public CI.

## Consequences

- ITOTORI-009 should implement provider interfaces and capability records from
  this ADR before adding live OpenRouter behavior.
- ITOTORI-010 should model provider identity, route settings, structured-output
  mode, token accounting, and billed-versus-estimated cost separately.
- Benchmark and QA nodes should reject unrecorded provider fallback as
  insufficient evidence.
- Future provider docs should link to this ADR instead of re-declaring secret,
  logging, or recording policy in divergent language.
