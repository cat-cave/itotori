# OpenRouter integration (canonical)

Status: short reference for itotori’s **surviving OpenRouter API contracts**.
Implementation lives under `apps/itotori/src/llm/` (entry:
[`dispatch.ts`](../apps/itotori/src/llm/dispatch.ts)). Provider policy shapes
live in [`contracts/shared.ts`](../apps/itotori/src/contracts/shared.ts).

> **Scope.** The legacy `apps/itotori/src/providers/**` tree,
> `render-gate/`, and any `openrouter-generation-lookup.ts` path are **gone**
> (no-legacy LLM cutover). Do not follow old audit line numbers that cite them.
> Captured live responses used for ambiguous-doc resolution sit under
> `docs/openrouter-integration-evidence/`; longer historical audits remain under
> `docs/audits/` and are not current wiring docs.

---

## §1 — Code home

| Concern                            | Path                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Dispatch entry                     | `apps/itotori/src/llm/dispatch.ts`                                              |
| Generation lookup / cost reconcile | `apps/itotori/src/llm/generation-metadata.ts`                                   |
| Provider policy (strict)           | `apps/itotori/src/contracts/shared.ts` (`ProviderPolicySchema`)                 |
| ZDR account assertion              | `apps/itotori/src/zdr-admission/`                                               |
| Role profiles / parameter compat   | `apps/itotori/src/llm/role-model-profiles.ts`, `openrouter-parameter-compat.ts` |

---

## §2 — Privacy posture (Zero Data Retention)

OpenRouter documents three enforcement levels (account, guardrail, per-request
`zdr`). **If any is enabled, ZDR applies** — levels compose as an **OR**. A
per-request `zdr: false` cannot disable account-wide ZDR.

itotori posture:

- Always send `provider.zdr: true` (and `dataCollection: "deny"`) on live
  non-public calls via `ProviderPolicySchema` (`zdr: z.literal(true)`,
  `dataCollection: z.literal("deny")`).
- Assert account-level ZDR-only honesty at process start
  (`OPENROUTER_ZDR_ACCOUNT_ASSERTED`).
- Never widen the candidate set or downgrade ZDR on a policy 404.

When no ZDR endpoint matches, OpenRouter returns a 404-style envelope (e.g.
“No endpoints found matching your data policy”). Surface as a typed provider
HTTP error; do not retry with a looser policy.

OR’s conservative stance: endpoints it cannot classify as ZDR are dropped when
`zdr: true` is in force. Dashboard privacy settings must match the asserted
account posture (ZDR-only filters; OpenRouter use of I/O off).

---

## §3 — Cost — `usage.cost` is authoritative

Per OpenRouter usage-accounting docs, full usage (including **`usage.cost` in
USD as a number**) is returned on every chat-completions response. itotori:

- **Treats `usage.cost` as billed truth** — never recomputes from token
  tables, endpoint pricing, or local estimates.
- Does **not** re-subtract `cache_discount` from `usage.cost` (that field is
  already net of cache savings when present). Cache fields may be recorded as
  annotations only.
- Does not send deprecated `usage: { include: true }` /
  `stream_options.include_usage` flags (no effect upstream).

Ledger / cap accounting charges the reported cost as-is (`decimal-usd.ts` and
generation billing helpers).

---

## §4 — Generation lookup — eventual consistency

Authoritative post-hoc route + cost reconciliation uses

`GET https://openrouter.ai/api/v1/generation?id=<generation-id>`

Implemented in `generation-metadata.ts`
(`createOpenRouterGenerationLookup`, `reconcileGenerationMetadata`), consumed
from dispatch / physical-step completion — **not** a separate
`openrouter-generation-lookup.ts` module.

Contracts:

- **One-shot lookup**, no retry loop on 404: generation records can lag the
  chat response (eventual consistency). A failed or missing lookup leaves the
  served pair / cost as explicitly unknown rather than inventing a route.
- Prefer lookup `total_cost` for billing reconciliation when the lookup
  succeeds; ignore divergences in secondary fields (e.g. lookup
  `upstream_inference_cost` vs chat `cost_details`).
- Bind the response `id` to the generation id we observed; mismatch → unknown.

---

## §5 — `require_parameters` and routing posture

`ProviderPolicySchema` is **strict** and fixed:

```ts
{
  allowFallbacks: true,
  zdr: true,
  dataCollection: "deny",
  requireParameters: true,
}
```

- **`require_parameters: true`** — only route to endpoints that honor the
  request’s structured-output / tool parameters (OpenRouter structured outputs
  - provider-selection docs).
- **`allowFallbacks: true`** — ZDR bounds the pool; no provider `only` / `order`
  pin (structurally rejected). The actually-served `(model, provider)` pair is
  **recorded** as telemetry after the fact (generation reconciliation), never
  pinned as request input.

---

## §6 — Evidence and external docs

| Kind                                         | Location                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| Live captures                                | `docs/openrouter-integration-evidence/`                                 |
| Historical wiring/cost audits                | `docs/audits/openrouter-*-2026-06-25.md`                                |
| OR ZDR                                       | https://openrouter.ai/docs/guides/features/zdr                          |
| OR usage                                     | https://openrouter.ai/docs/cookbook/administration/usage-accounting     |
| OR generation                                | https://openrouter.ai/docs/api/api-reference/generations/get-generation |
| OR structured outputs / `require_parameters` | https://openrouter.ai/docs/guides/features/structured-outputs           |

When OpenRouter docs change, update this file against live
`apps/itotori/src/llm/` behaviour — not against deleted provider-layer paths.
