# OpenRouter audit consolidation — 2026-06-25

**Purpose.** Two parallel audits landed on the same day and propose
overlapping `ITOTORI-NNN` corrective nodes. This doc is the deduplicated,
collision-resolved mint plan the orchestrator agent feeds to
`scripts/spec-dag.mjs`. Do not edit the DAG from this doc directly; mint
sequentially in the order of §2.

**Sources:**

- `docs/audits/openrouter-wiring-audit-2026-06-25.md` (1256 lines, "Wiring")
- `docs/audits/openrouter-cost-tracking-audit-2026-06-25.md` (1004 lines, "Cost")

**Next free IDs at HEAD (`5a90a70`):** `ITOTORI-224`, `UTSUSHI-231`.
(Max existing: `ITOTORI-223`, `UTSUSHI-230`.)

---

## §1 — Collision map

Both audits independently consumed the `ITOTORI-224..229` block. Every
proposed number collides; resolution preserves the Wiring audit's
numbering for 224 (it is a docs/evidence node the Cost audit's nodes also
depend on) and renumbers the Cost audit's nodes forward. Cost-audit
ITOTORI-224 is **merged** with Wiring ITOTORI-224 only in the sense that
both belong inside the same epoch (the rip-out happens after the canonical
doc); functionally they are different so the rip-out gets a new id.

| Proposed ID | From | Title (verbatim from audit) | Disposition |
|---|---|---|---|
| `ITOTORI-224` | Wiring §4-1 | "Publish canonical OR integration doc + adopt audit as baseline" | **keep-as-is** (anchors the evidence the Cost rip-out depends on) |
| `ITOTORI-224` | Cost §3 N1 | "Rip out cost-tier abstraction and all estimated / hardcoded / unknown cost states" | **renumber-to-ITOTORI-225** |
| `ITOTORI-225` | Wiring §4-2 | "Fix DEV_PAIR to deepseek/deepseek-v4-flash + re-key recorded bundles" | **renumber-to-ITOTORI-226** (was 225; bumped one to make room for the Cost rip-out) |
| `ITOTORI-225` | Cost §3 N2 | "Recorded provider replays the captured real cost" | **renumber-to-ITOTORI-227** |
| `ITOTORI-226` | Wiring §4-3 | "Delete reinvented data-handling registry; default provider.zdr=true" | **renumber-to-ITOTORI-228** |
| `ITOTORI-226` | Cost §3 N3 | "Rename `costEstimate` → `costUsd`" | **renumber-to-ITOTORI-229** |
| `ITOTORI-227` | Wiring §4-4 | "Persist OR routing posture in ledger + recorded bundles" | **renumber-to-ITOTORI-230** |
| `ITOTORI-227` | Cost §3 N4 | "Single source of truth for `DEFAULT_COST_CAP_USD`" | **renumber-to-ITOTORI-231** |
| `ITOTORI-228` | Wiring §4-5 | "Prompt-cache aware cost cap + cache hit telemetry" | **merge-with-Cost-230** → final `ITOTORI-233` |
| `ITOTORI-228` | Cost §3 N5 | "Schema-level enforcement: ledger `cost_amount` is USD, mirrored from `usage.cost`, never null" | **renumber-to-ITOTORI-232** |
| `ITOTORI-229` | Wiring §4-6 | "Pair-policy schema v0.2 carrying ZDR posture + fallback models + seed" | **renumber-to-ITOTORI-234** |
| `ITOTORI-229` | Cost §3 N6 | "`/api/v1/generation` reconciliation endpoint" | **renumber-to-ITOTORI-235** |
| `ITOTORI-230` | Cost §3 N7 | "Mirror prompt-caching cost annotations through ledger and telemetry" | **merge-with-Wiring-228** → final `ITOTORI-233` (see merge note below) |
| `UTSUSHI-231` | Wiring §4-7 | "Re-run localize-sweetie-hd end-to-end; capture replay-log proving ZDR posture" | **keep-as-is** (UTSUSHI namespace, no collision) |

### Merges of genuinely overlapping nodes

**Wiring ITOTORI-228 ⊕ Cost ITOTORI-230 → final ITOTORI-233** ("cache-aware
cost cap, ledger annotations, and hit-rate telemetry").

- Wiring (§3-E, §4-5) deliverable: "rewrite `normalizeOpenRouterCost`
  with cache-aware math + comment quoting evidence file; migration
  0040_provider_ledger_cache_discount.sql; `countCacheHitsByPair`".
- Cost (§1.3, §3 N7) deliverable: "extend `TokenUsage` with
  `cacheReadTokens`, `cacheWriteTokens`; add optional
  `cacheDiscountMicrosUsd` on `ProviderCost`; surface a cache-savings
  line on the dashboard from real `cache_discount`".
- These overlap on (a) the new ledger columns and (b) the telemetry
  surface. Merged below in §2 node 10 with union deliverables.

Nothing else genuinely overlaps — the other apparent 228/229 collisions
are different jobs that happened to land on the same number.

---

## §2 — Unified mint order

Mint in this order; each entry is JSON-shaped for `scripts/spec-dag.mjs`.

### 1. ITOTORI-224 — Canonical OpenRouter integration doc + evidence capture

```json
{
  "id": "ITOTORI-224",
  "title": "itotori-agent-runtime: publish canonical OpenRouter integration doc + adopt both audits as baseline",
  "status": "planned",
  "priority": "P0",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-220", "ITOTORI-221", "ITOTORI-222", "ITOTORI-223"],
  "summary": "Land docs/openrouter-integration.md as the canonical itotori-side understanding of how OpenRouter routes / enforces ZDR / reports cost (real, never estimated, per cost-audit §1) / surfaces structured outputs / exposes the model catalog. Anchor every claim to a fetched OR docs URL and a fetched-date. Adopt docs/audits/openrouter-wiring-audit-2026-06-25.md and docs/audits/openrouter-cost-tracking-audit-2026-06-25.md as the audit baseline; subsequent corrective nodes (ITOTORI-225..235) reference their numbered findings. Fires one live toy call (private-corpus, provider.zdr=true) to docs/openrouter-integration-evidence/<date>.json to resolve DOC-AMBIGUOUS items.",
  "deliverables": [
    "docs/openrouter-integration.md (canonical)",
    "docs/openrouter-integration-evidence/<date>.json (captured live OR response)",
    "docs/audits/openrouter-wiring-audit-2026-06-25.md committed as baseline",
    "docs/audits/openrouter-cost-tracking-audit-2026-06-25.md committed as baseline"
  ],
  "acceptanceCriteria": [
    "docs/openrouter-integration.md cites every audit §1 doc URL + a fetched-date for each",
    "The evidence JSON shows usage.cost present, provider field present, and resolves DOC-AMBIGUOUS-1, -2, -6, -8 (wiring) and the cost-audit §1.3/§1.4 contract (cache_discount + /generation lookup behaviour)",
    "git log shows audit docs + integration doc + evidence JSON landed in the same commit (no-legacy-compat: dev-pair.ts's prior 'verified against published Fireworks endpoint' note is rewritten in the same commit to point at the evidence file)"
  ],
  "verification": [
    "rg -n 'deepseek/deepseek-chat-v4' . | wc -l    # expects 0 after node 3 lands; this node only adds the doc",
    "rg -n 'openrouter-integration\\.md' docs apps | head",
    "node scripts/spec-dag.mjs validate"
  ],
  "auditFocus": [
    "Documenting a posture instead of measuring it",
    "Evidence JSON committed with API key or PII present",
    "Cited URLs that 404 again (re-fetch on commit day)"
  ],
  "statusReason": "Per docs/audits/openrouter-wiring-audit-2026-06-25.md §4-1 (anchor for DOC-AMBIGUOUS resolution) and docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §1 (the 'usage.cost is real' contract this doc canonicalises)."
}
```

### 2. ITOTORI-225 — Rip out cost-tier; cost is always real OR-returned value

```json
{
  "id": "ITOTORI-225",
  "title": "itotori-agent-runtime: rip out cost-tier abstraction and all estimated / hardcoded / unknown cost states",
  "status": "planned",
  "priority": "P0",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-224"],
  "summary": "Delete ProviderCostTier, ProviderDataHandlingPolicy.costTier, the costTier field on every capability sheet, and the corresponding branches in evaluateProviderInputPolicy (policy.ts:23-25). Inside the OR provider, replace normalizeOpenRouterCost's five-branch ladder with a single branch: read usage.cost (USD number) and tag it costKind: 'billed'. If the response has no usage.cost, raise ModelProviderError(code='provider_response_invalid') — never write a row with costKind: 'unknown' or a ?? 0 fallback. Delete the 'unknown' / 'local_estimate' / 'provider_estimate' variants from ProviderCost.costKind. Delete unknownCost(). Delete the endpointPricing-driven token×price re-derivation branch. The orchestrator's four BigInt(providerRun.cost.amountMicrosUsd ?? 0) coercions become hard assertBilledCost(...) calls.",
  "deliverables": [
    "apps/itotori/src/providers/types.ts: delete ProviderCostTier and ProviderDataHandlingPolicy.costTier; narrow ProviderCost.costKind to 'billed' | 'zero'",
    "apps/itotori/src/providers/policy.ts: delete cost-tier gate (lines 23-25); privacy-only gate survives until node 4 (ITOTORI-227) replaces it wholesale",
    "apps/itotori/src/providers/openrouter.ts: rewrite normalizeOpenRouterCost to single usage.cost-or-error; delete unknownCost(); delete ?? unknownCost() in buildProviderRunRecord",
    "apps/itotori/src/orchestrator/agentic-loop.ts: replace BigInt(providerRun.cost.amountMicrosUsd ?? 0) at lines 698, 750, 823, 906 with assertBilledCost(providerRun.cost)",
    "apps/itotori/src/services/project-workflow.ts:938-946, batch-planner/cli.ts:126, dev-pair.ts:122,170,215, style-guide-provider-smoke.ts:339, fixtures/itotori-style-guide/provider-smoke-suggestion.json:210, every test fixture in apps/itotori/test/, packages/itotori-db/test/model-ledger-repository.test.ts:67,590: delete every costTier literal",
    "packages/itotori-db/migrations/0039_drop_unknown_cost_kind.sql: backfill rows tagged provider_estimate/local_estimate/unknown → billed where amount_micros_usd is non-null; refuse null amount_micros_usd rows (force operator review); narrow CHECK to cost_kind in ('billed', 'zero')",
    "scripts/audit-no-hardcoded-cost.mjs (Cost §5.1 guardrail)"
  ],
  "acceptanceCriteria": [
    "git grep -nE 'costTier|costKind:\\s*\"(unknown|provider_estimate|local_estimate)\"|unknownCost\\(\\)' returns zero hits across apps/, packages/, fixtures/, scripts/",
    "apps/itotori/test/openrouter-provider.test.ts asserts every recorded ProviderCost from a successful response has costKind === 'billed'",
    "The OR provider raises provider_response_invalid when usage.cost is missing (new test case)",
    "Migration 0039 runs cleanly on dev DB; CHECK excludes 'unknown'",
    "node scripts/audit-no-hardcoded-cost.mjs exits 0"
  ],
  "verification": [
    "pnpm -F itotori test -- openrouter-provider",
    "pnpm -F itotori test -- telemetry-queries",
    "pnpm -F @itotori/db test -- draft-attempt-provider-ledger",
    "node scripts/audit-no-hardcoded-cost.mjs"
  ],
  "auditFocus": [
    "costTier renamed instead of deleted (no-legacy-compat violation)",
    "?? 0 coercion left in any cost path",
    "provider_estimate kept in the enum 'just in case'",
    "Migration backfill widened to allow null amount_micros_usd",
    "Hardcoded-cost audit script left disabled in CI"
  ],
  "statusReason": "Per docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N1 (the foundational rip-out): §2.1 (costTier category error), §2.2 (default 'unknown' is the literal forbidden state), §2.3 (real cost mis-tagged provider_estimate), §2.4 (unknownCost() fallback), §2.9 (?? 0 coercion), §2.10/§2.11/§2.13 (costTier literal sites)."
}
```

### 3. ITOTORI-226 — Fix DEV_PAIR + propagate

```json
{
  "id": "ITOTORI-226",
  "title": "itotori-agent-runtime: fix DEV_PAIR to deepseek/deepseek-v4-flash + re-key recorded bundles",
  "status": "planned",
  "priority": "P0",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-224", "ITOTORI-225"],
  "summary": "Replace dev-pair.ts:47 modelId with the catalog-correct 'deepseek/deepseek-v4-flash'. Empirically confirm provider id ('fireworks' today) actually hosts this model with a one-shot toy call; if not, change the providerId to whatever the catalog reports as the canonical Fireworks-hosted endpoint (or a different provider). Rewrite the in-code rationale comment against real evidence captured by ITOTORI-224. Re-key every recorded bundle whose key contains the old modelId so RecordedBundleMissingError doesn't fire across offline CI. Update presets/localize-sweetie-hd.pair-policy.json to match (12 leaf entries + top-level pair). Old slug deleted in same change (no-legacy-compat).",
  "deliverables": [
    "apps/itotori/src/providers/dev-pair.ts: corrected modelId + rationale grounded in ITOTORI-224 evidence JSON",
    "presets/localize-sweetie-hd.pair-policy.json: 13 occurrences updated",
    "fixtures/recorded-bundles/* re-keyed (script + one-line note in canonical doc)",
    "Test: openrouter-provider.test.ts uses corrected DEV_PAIR"
  ],
  "acceptanceCriteria": [
    "rg 'deepseek/deepseek-chat-v4' returns 0 hits",
    "rg 'deepseek/deepseek-v4-flash' appears in dev-pair.ts and pair-policy.json",
    "pnpm --filter @itotori/app test passes (recorded bundles match)",
    "One toy live call to deepseek/deepseek-v4-flash via OR with provider.only=[<verified-providerId>] returns a successful response (capture under artifacts/openrouter-live-smoke/)"
  ],
  "verification": [
    "rg -n 'deepseek/deepseek-chat-v4' .",
    "pnpm --filter @itotori/app test",
    "OPENROUTER_LIVE=1 pnpm exec vp run itotori:openrouter-live-smoke"
  ],
  "auditFocus": [
    "Slug aliased instead of replaced",
    "Recorded bundles left with stale key",
    "providerId pinned to a provider that does not host the model"
  ],
  "statusReason": "Per docs/audits/openrouter-wiring-audit-2026-06-25.md §3-A (wrong DEV_PAIR model id, critical) + §3-A-2 (provider id pin unverified) + §3-H-3 (notes grounded in fiction)."
}
```

### 4. ITOTORI-227 — Default ZDR-on; delete itotori-side data-handling registry

```json
{
  "id": "ITOTORI-227",
  "title": "itotori-agent-runtime: delete reinvented data-handling registry; default provider.zdr=true",
  "status": "planned",
  "priority": "P0",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-224", "ITOTORI-225", "ITOTORI-226"],
  "summary": "Trust OR's account-wide ZDR enforcement as authoritative. Delete the itotori-side ProviderDataHandlingPolicy + OpenRouterAccountPrivacyState capability registry (types.ts:59-87) and the evaluateProviderInputPolicy gate (policy.ts). Replace the gate with a single AccountZdrAssertion: 'this process asserts the OR account is configured ZDR-only AND every private-corpus request body sends provider.zdr=true'. The assertion fails LOUDLY on missing OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 env var rather than on each missing capability axis. Add provider.zdr=true to buildOpenRouterProviderRouting whenever request.inputClassification is non-public. Old policy.ts deletes in the same change.",
  "deliverables": [
    "apps/itotori/src/providers/openrouter.ts: provider.zdr defaults to true when inputClassification != public; capability sheet's accountPrivacy field removed",
    "apps/itotori/src/providers/policy.ts: deleted (old shape)",
    "apps/itotori/src/providers/account-zdr.ts: new simple assertion",
    "apps/itotori/src/providers/types.ts: ProviderDataHandlingPolicy and OpenRouterAccountPrivacyState removed; ProviderRunRecord no longer carries accountPrivacy",
    "Ledger schema audit confirms no column persists accountPrivacy",
    "Tests rewritten: no more 'policy_blocked' code path; new AccountZdrAssertionError path"
  ],
  "acceptanceCriteria": [
    "With OPENROUTER_ZDR_ACCOUNT_ASSERTED unset, OpenRouterModelProvider constructor throws AccountZdrAssertionError",
    "With OPENROUTER_ZDR_ACCOUNT_ASSERTED=1, a private-corpus request sends provider.zdr=true on the wire (mocked-HTTP table test)",
    "rg 'evaluateProviderInputPolicy' returns 0 hits",
    "rg 'accountPrivacy' returns 0 hits in apps/itotori/src",
    "just localize-sweetie-hd --dry-run prints the assertion line and the provider.zdr=true posture"
  ],
  "verification": [
    "pnpm --filter @itotori/app test -- providers",
    "rg -n 'ProviderDataHandlingPolicy|accountPrivacy' apps/itotori/src",
    "just localize-sweetie-hd --dry-run --project sweetie-hd-alpha-1"
  ],
  "auditFocus": [
    "Old policy.ts kept as a shim",
    "provider.zdr only sent when caller asks (defeats the default)",
    "AccountZdrAssertion downgraded to a warning instead of refusal",
    "Documenting 'ZDR is on' without enforcing the env var assertion"
  ],
  "statusReason": "Per docs/audits/openrouter-wiring-audit-2026-06-25.md §3-B (itotori reinvents OR's account-wide ZDR, critical), §3-B-3 (private-corpus calls never set provider.zdr=true today), §3-C (capability shape is wrong), §3-D-1 (default zdr=true), §3-H-2/§3-H-5 (capability-guard simplification + zdr type tightening)."
}
```

### 5. ITOTORI-228 — Recorded provider replays original real cost

```json
{
  "id": "ITOTORI-228",
  "title": "itotori-agent-runtime: recorded provider replays captured real cost; remove hardcoded costKind: zero",
  "status": "planned",
  "priority": "P0",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-225"],
  "summary": "Today every recorded replay returns cost: { costKind: 'zero', amountMicrosUsd: 0 } regardless of what the original LIVE call cost. The recorded bundle format must carry the original usage.cost (USD micros) verbatim from the captured response, and the replay must surface it on the ProviderCost of the replayed ProviderRunRecord so cost-cap arithmetic, telemetry rollups, and the ledger are byte-equal to the LIVE run that produced the bundle. Bundle-key collisions (different costs under the same key) are surfaced as a typed RecordedCostMismatchError.",
  "deliverables": [
    "Extend RecordedProviderResponse (recorded.ts:33-41) with cost: ProviderCost (required; only 'billed' or 'zero' after ITOTORI-225)",
    "RecordedModelProvider.invoke (recorded.ts:106-165) returns response's captured cost rather than hardcoded zero",
    "Update apps/itotori/src/draft/draft-attempt-fixtures.ts:207-217 and every recorded fixture in apps/itotori/test/ and fixtures/ to carry real cost from originating recording session",
    "Recording capture path writes usage.cost into bundle file so future replays mirror it"
  ],
  "acceptanceCriteria": [
    "Unit test constructs recorded bundle from a captured LIVE-mode artifact, replays it, and asserts replayed ProviderCost.amountMicrosUsd equals captured value (not 0)",
    "git grep -nE 'costKind:\\s*\"zero\"' apps/ packages/ returns hits only in recorded-replay seam (and only for genuinely zero captured costs)",
    "The cost-cap test (openrouter-provider.test.ts:182) passes unchanged"
  ],
  "verification": [
    "pnpm -F itotori test -- recorded",
    "pnpm -F itotori test -- draft-attempt-recorder"
  ],
  "auditFocus": [
    "Hardcoded zero left in a 'transitional' code path",
    "Pre-ITOTORI-228 bundles silently replay as zero (schema-version bump must force recapture)",
    "RecordedCostMismatchError downgraded to a warning"
  ],
  "statusReason": "Per docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N2 / §2.12 (recorded provider replays hardcoded cost zero instead of captured real cost, high severity)."
}
```

### 6. ITOTORI-229 — Rename `costEstimate` → `costUsd` across bundle wire surface

```json
{
  "id": "ITOTORI-229",
  "title": "itotori-agent-runtime: rename costEstimate → costUsd in agentic-loop bundle and every downstream consumer",
  "status": "planned",
  "priority": "P1",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-225"],
  "summary": "The agentic-loop bundle field (packages/localization-bridge-schema/src/agentic-loop-bundle.ts:99,116,234,262,277,295) is named costEstimate even though it carries real billed cost. Rename to costUsd across schema package, the bundle, the smoke command, the fixtures, and the assertion paths. Bump AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION. No deprecation shim — delete the old name in the same change as the rename.",
  "deliverables": [
    "Rename in agentic-loop-bundle.ts (schema + assertions)",
    "Rename in agentic-loop.ts:605,622, agentic-loop-smoke-command.ts:173, draft-attempt-fixtures.ts:143,184,217, draft-attempt-recorder.ts:30-39,89-90",
    "Bump AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION"
  ],
  "acceptanceCriteria": [
    "git grep -n costEstimate returns zero hits",
    "Bundle JSON serialises costUsd and is deserialisable by the new schema"
  ],
  "verification": [
    "pnpm -F itotori test -- agentic-loop",
    "pnpm -F itotori test -- agentic-loop-smoke"
  ],
  "auditFocus": [
    "Field renamed in the schema but old name kept as alias (no-legacy-compat violation)",
    "Schema version not bumped",
    "Downstream consumer left reading the old name silently"
  ],
  "statusReason": "Per docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N3 / §2.8 (wire name lies: it's billed cost, not an estimate)."
}
```

### 7. ITOTORI-230 — Persist OR routing posture in ledger + recorded bundles

```json
{
  "id": "ITOTORI-230",
  "title": "itotori-agent-runtime: persist OR routing posture (zdr=true, data_collection=deny, only=[providerId]) in ledger and recorded bundles",
  "status": "planned",
  "priority": "P1",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-227", "ITOTORI-228"],
  "summary": "Persist the OR provider-routing block sent on each call into the ledger row (migration: add routing_posture jsonb) AND mirror it on RecordedProviderBundle responses so offline replays can prove the original call's routing posture. ProviderRunRecord gains a routingPosture field. RecordedModelProvider replay sets ProviderRunRecord.routingPosture from the bundle; capture path writes it on live calls. Telemetry queries.ts adds a per-pair 'ZDR-enforced call count' so a partial-coverage anomaly is visible in the dashboard.",
  "deliverables": [
    "Migration 0040_provider_ledger_routing_posture.sql (numbered after ITOTORI-225's 0039)",
    "apps/itotori/src/providers/types.ts: ProviderRunRecord.routingPosture",
    "apps/itotori/src/providers/recorded.ts: bundle response.routingPosture",
    "apps/itotori/src/telemetry/queries.ts: countZdrEnforcedCallsByPair"
  ],
  "acceptanceCriteria": [
    "A live OR call writes routing_posture { only:[providerId], allow_fallbacks:false, data_collection:'deny', zdr:true, require_parameters?:bool } to the ledger",
    "A recorded bundle response carries routingPosture; replay sets it on the ProviderRunRecord",
    "Telemetry CLI lists zdrEnforcedCount == invocationCount for the alpha pair over a non-trivial window"
  ],
  "verification": [
    "pnpm --filter @itotori/app test -- telemetry",
    "pnpm --filter @itotori/db test -- ledger",
    "pnpm exec vp run itotori:telemetry-summary --since 2026-06-01"
  ],
  "auditFocus": [
    "routing_posture defaulted to null instead of typed",
    "ZDR-enforced count includes recorded-bundle responses that didn't actually capture posture (silent partial coverage)",
    "Migration backfill widens to 'unknown' without explicit audit row"
  ],
  "statusReason": "Per docs/audits/openrouter-wiring-audit-2026-06-25.md §4-4 (routing posture in ledger + recorded bundles) + §3-G (recorded provider doesn't mirror OR routing metadata, high)."
}
```

### 8. ITOTORI-231 — Single source of truth for cost-cap default

```json
{
  "id": "ITOTORI-231",
  "title": "itotori-agent-runtime: single source of truth for DEFAULT_COST_CAP_USD; delete duplicated 0.5 in alpha closer",
  "status": "planned",
  "priority": "P1",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-225"],
  "summary": "DEFAULT_COST_CAP_USD = 1.0 in openrouter.ts:1162 and DEFAULT_COST_CAP_USD = 0.5 in localize-sweetie-hd-stage-command.ts:139 disagree. Pick one canonical default, export it from the provider module, import it everywhere. The CLI flag (--cost-cap-usd) remains and overrides per invocation.",
  "deliverables": [
    "Export DEFAULT_COST_CAP_USD from apps/itotori/src/providers/openrouter.ts",
    "Delete local constant in apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts:139 and import canonical",
    "Document chosen default (likely 0.5 USD per process for interactive runs) in comment citing Trevor's standing rule"
  ],
  "acceptanceCriteria": [
    "git grep -n 'DEFAULT_COST_CAP_USD\\s*=' returns exactly one hit",
    "Both alpha closer test and OR provider test pass with shared constant"
  ],
  "verification": [
    "pnpm -F itotori test -- localize-sweetie-hd",
    "pnpm -F itotori test -- openrouter-provider"
  ],
  "auditFocus": [
    "Default value picked unilaterally without justification comment",
    "Local constant left as a 'fallback'"
  ],
  "statusReason": "Per docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N4 / §2.5 (two different hardcoded defaults, high)."
}
```

### 9. ITOTORI-232 — Schema-level enforcement of real-cost in ledger

```json
{
  "id": "ITOTORI-232",
  "title": "itotori-agent-runtime: schema-level enforcement — ledger cost_amount is USD, mirrored from usage.cost, never null",
  "status": "planned",
  "priority": "P1",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-225", "ITOTORI-228", "ITOTORI-230"],
  "summary": "Tighten the itotori_draft_attempt_provider_ledger schema so a future code path cannot regress to fake cost: add check (cost_unit = 'usd'); add a new usage_response_json jsonb column (NOT NULL) holding the originating OR response's usage block (prompt_tokens, completion_tokens, cost, cost_details, prompt_tokens_details with caching annotations); add a CHECK constraint that cost_amount equals (usage_response_json->>'cost')::numeric within 1e-9. Drop the model-ledger cost_kind CHECK from migration 0006 and narrow to ('billed', 'zero').",
  "deliverables": [
    "packages/itotori-db/migrations/0041_ledger_real_cost_enforcement.sql (after ITOTORI-230's 0040)",
    "Repository update to write usage_response_json on every recordLedgerEntry (OR adapter already has the bytes — artifact recorder dropped them)",
    "Test that inserting a row with mismatching cost_amount vs usage_response_json->>'cost' fails the CHECK"
  ],
  "acceptanceCriteria": [
    "New migration runs cleanly; select cost_amount queries continue to work",
    "Regression test inserts row with fake cost and asserts CHECK rejects it"
  ],
  "verification": [
    "pnpm -F @itotori/db test -- draft-attempt-provider-ledger",
    "pnpm -F @itotori/db test -- migrations"
  ],
  "auditFocus": [
    "Migration leaves an escape hatch (nullable cost_unit, etc.)",
    "Tolerance widened beyond 1e-9 to 'work around' a flaky test",
    "Old model-ledger CHECK left in place"
  ],
  "statusReason": "Per docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N5 / §2.6 (no schema constraint tying cost_amount to usage.cost) + §2.7 (model-ledger CHECK enumerates 'unknown')."
}
```

### 10. ITOTORI-233 — Cache-aware cost math + cache annotations through ledger and telemetry (MERGED)

```json
{
  "id": "ITOTORI-233",
  "title": "itotori-agent-runtime: cache-aware cost cap + mirror prompt-caching annotations (cached_tokens, cache_write_tokens, cache_discount) through ledger and telemetry",
  "status": "planned",
  "priority": "P1",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-224", "ITOTORI-225", "ITOTORI-230", "ITOTORI-232"],
  "summary": "Merged node — combines wiring §4-5 (resolve DOC-AMBIGUOUS-6 + endpoint-pricing fallback survives-or-dies + cache-aware cost cap math) with cost §3 N7 (mirror caching annotations through TokenUsage + ProviderCost + telemetry). Resolve DOC-AMBIGUOUS-6 (does usage.cost include cache discount?) empirically via ITOTORI-224 evidence, then implement correct math. Capture cached_input_tokens + cache_write_tokens + cache_discount on every ledger row; expose cache hit rate + cache savings per pair in telemetry queries. If the endpoint-pricing fallback (openrouter.ts:721-738) survives the empirical check on X-OpenRouter-Metadata header (DOC-AMBIGUOUS-8), fix its math to subtract cached tokens at the implicit-cache discount rate; if the header is unsupported, delete the fallback path in the same change.",
  "deliverables": [
    "apps/itotori/src/providers/openrouter.ts: normalizeOpenRouterCost rewritten with cache-aware math + code comment quoting ITOTORI-224 evidence file",
    "Extend TokenUsage (types.ts:221-228) with cacheReadTokens, cacheWriteTokens",
    "Extend ProviderCost with optional cacheDiscountMicrosUsd",
    "Extend normalizeUsage to populate from usage.prompt_tokens_details and usage.cost_details.cache_discount",
    "Migration 0042_provider_ledger_cache_discount.sql (after ITOTORI-232's 0041) adding cache columns",
    "apps/itotori/src/telemetry/queries.ts: countCacheHitsByPair + cache_savings_usd",
    "apps/itotori/src/telemetry/cli.ts: prints cache_savings_usd=<real> for the window",
    "Either fix or delete openrouter.ts:721-738 endpoint-pricing fallback (decision logged in ITOTORI-224 doc)"
  ],
  "acceptanceCriteria": [
    "Live call against deepseek-v4-flash (which supports implicit caching per prompt-caching.md) writes cache_discount and cached_input_tokens to the ledger",
    "Per-process cost cap deducts cache discount before refusing a new call",
    "rg 'selectedOpenRouterPricing' in apps/itotori/src returns the expected result (kept-and-fixed OR deleted-as-dead based on ITOTORI-224 evidence)",
    "A live response with prompt_tokens_details.cached_tokens > 0 lands cache fields in the ledger row's usage_response_json",
    "apps/itotori/src/telemetry/cli.ts prints cache_savings_usd=<real> for the window"
  ],
  "verification": [
    "pnpm --filter @itotori/app test -- providers/openrouter",
    "pnpm --filter @itotori/app test -- telemetry-queries",
    "OPENROUTER_LIVE=1 pnpm exec vp run itotori:openrouter-live-smoke"
  ],
  "auditFocus": [
    "Cost cap math double-counts the discount",
    "Endpoint-pricing fallback left in place if metadata header empirically unsupported",
    "cache_discount columns left nullable when upstream guarantees the field",
    "Cache savings line on dashboard sourced from a derived/estimated value instead of the real cache_discount"
  ],
  "statusReason": "Merged from docs/audits/openrouter-wiring-audit-2026-06-25.md §4-5 / §3-E (cost math omits cache discount, DOC-AMBIGUOUS-6) and docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N7 / §1.3 (mirror real cache annotations through ledger + telemetry — never estimation, always real)."
}
```

### 11. ITOTORI-234 — Pair-policy schema v0.2

```json
{
  "id": "ITOTORI-234",
  "title": "itotori-agent-runtime: pair-policy schema v0.2 carrying ZDR posture + fallback models + seed",
  "status": "planned",
  "priority": "P1",
  "target": "alpha",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-227", "ITOTORI-230"],
  "summary": "Widen the pair-policy JSON schema (presets/*.pair-policy.json) to a versioned v0.2 shape carrying: per-stage (modelId, providerId) pair (unchanged from v0.1); per-stage zdr posture (default true; non-default requires stage-local OPENROUTER_ZDR_DOWNGRADE env var); per-stage fallbackModels array (default empty); per-stage seed (default deterministic from stage name; bounded-repair loop uses seed+attempt); per-stage maxPrice cap (default derived from per-process cap / stage count); top-level openrouterPresetSlug (optional; when set, OR-side preset is referenced and overlapping fields removed per presets.md 'request-level overrides' rule). Rename schemaVersion and update the parser; old v0.1 files do NOT load (no-legacy-compat).",
  "deliverables": [
    "presets/localize-sweetie-hd.pair-policy.json: v0.2 shape",
    "apps/itotori/src/orchestrator/localize-sweetie-hd-stage-command.ts: parser updated; v0.1 path deleted",
    "packages/itotori-shared/src/pair-policy.v0.2.ts: schema + types"
  ],
  "acceptanceCriteria": [
    "just localize-sweetie-hd --dry-run prints per-stage zdr+seed posture",
    "A pair-policy with schemaVersion 0.1 is rejected with typed PairPolicyVersionMismatchError",
    "Agentic-loop bundle records per-stage zdr posture + seed"
  ],
  "verification": [
    "pnpm --filter @itotori/app test -- orchestrator/localize-sweetie-hd",
    "just localize-sweetie-hd --dry-run --project sweetie-hd-alpha-1"
  ],
  "auditFocus": [
    "v0.1 path silently accepted",
    "Default zdr posture not applied to repair stage",
    "seed defaulted to 0 instead of deterministic-per-stage"
  ],
  "statusReason": "Per docs/audits/openrouter-wiring-audit-2026-06-25.md §4-6 / §3-D-2 (no fallbackModels) / §3-D-3 (no seed) / §3-F (pair-policy schema too narrow)."
}
```

### 12. ITOTORI-235 — `/api/v1/generation` cost reconciliation (beta)

```json
{
  "id": "ITOTORI-235",
  "title": "itotori-agent-runtime: optional cost reconciliation — replay-fetch billed cost via /api/v1/generation?id={runId}",
  "status": "planned",
  "priority": "P2",
  "target": "beta",
  "projects": ["itotori"],
  "dependsOn": ["ITOTORI-225", "ITOTORI-232"],
  "summary": "OR exposes GET /api/v1/generation?id={genId} to re-fetch canonical real cost (with total_cost, upstream_inference_cost, cache_discount) for any prior generation. itotori captures the generation id today (it lands in adapter_metadata.openrouterMetadata.id); add a small reconciliation helper that, given a ledger row, re-fetches canonical cost and raises if ledger's cost_amount drifts. This closes the 'billed-later' gap (some providers true up costs after the response, e.g. caching adjustments). Not required for alpha (single-run); cheap insurance for beta and full release.",
  "deliverables": [
    "apps/itotori/src/providers/openrouter-cost-reconciler.ts (fetchBilledCostByGenerationId(generationId) → { totalCostUsd, upstreamInferenceCostUsd | null, cacheDiscountUsd | null })",
    "CLI command 'itotori cost reconcile --project <id> --window <...>' that walks recent ledger rows and surfaces drift"
  ],
  "acceptanceCriteria": [
    "Reconciler hits real generation id end-to-end in live OR test suite; returned total_cost matches ledger's cost_amount (within 1e-9)",
    "CLI surfaces non-zero exit when any ledger row drifts"
  ],
  "verification": [
    "pnpm -F itotori test -- openrouter-cost-reconciler",
    "OPENROUTER_API_KEY=... pnpm -F itotori test -- openrouter-live"
  ],
  "auditFocus": [
    "Drift tolerance widened beyond 1e-9 to 'work around' provider-side rounding",
    "CLI silently exits 0 when ledger rows are missing generationId"
  ],
  "statusReason": "Per docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N6 / §1.4 (/generation endpoint exists specifically for after-the-fact real-cost re-fetch)."
}
```

### 13. UTSUSHI-231 — Re-run alpha closer end-to-end with new posture

```json
{
  "id": "UTSUSHI-231",
  "title": "suite: re-run localize-sweetie-hd end-to-end after ITOTORI-226..233; capture replay-log proving ZDR posture",
  "status": "planned",
  "priority": "P0",
  "target": "alpha",
  "projects": ["suite"],
  "dependsOn": ["ITOTORI-226", "ITOTORI-227", "ITOTORI-230", "UTSUSHI-228"],
  "summary": "Re-execute just localize-sweetie-hd --project sweetie-hd-alpha-1 against the corrected slug + new ZDR posture + posture-aware ledger + cache-aware cost math. Capture artifacts/localize-sweetie-hd/<timestamp>/ with all four files (bridge-bundle, agentic-loop-bundle, patch-report, replay-log) AND the new routing_posture in the agentic-loop-bundle invocation records. The acceptance criterion lifts the corrective deltas from in-progress to 'demonstrably end-to-end'.",
  "deliverables": [
    "artifacts/localize-sweetie-hd/<2026-06-25-rerun>/",
    "docs/openrouter-integration.md: appended evidence cite for the rerun"
  ],
  "acceptanceCriteria": [
    "agentic-loop-bundle.v0.json invocation records carry routingPosture.zdr === true on every entry",
    "Recorded patch-report.json contains the corrected modelId",
    "replay-log.json has the en-US sentinel TextLine (same UTSUSHI-228 contract)",
    "Ledger after the run shows zdrEnforcedCount == invocationCount over the run window",
    "Ledger after the run shows every cost_kind === 'billed' (no 'provider_estimate', no 'unknown')"
  ],
  "verification": [
    "just localize-sweetie-hd --project sweetie-hd-alpha-1",
    "pnpm exec vp run itotori:telemetry-summary --since <run-start>"
  ],
  "auditFocus": [
    "Run re-uses a stale recorded bundle (no live call)",
    "routing_posture defaulted to true without actually being sent",
    "Ledger row's cost_kind quietly slipped back to provider_estimate"
  ],
  "statusReason": "Per docs/audits/openrouter-wiring-audit-2026-06-25.md §4-7 (alpha closer rerun); cost-audit acceptance criterion added per §3 N1 retroactive section ('every cost_kind === billed')."
}
```

---

## §3 — Already-merged code dispositions (unified)

Both audits made suggestions; merged below. **No node below is marked
`regressed` unless explicitly noted.**

### ITOTORI-220 — pair refactor

- **Disposition:** stay `complete`.
- **dependsOn extension:** none.
- **statusReason continuation to append:**
  > "Wiring audit (2026-06-25 §5.1) confirms pair plumbing is correct;
  > the audit-noted wrong DEV_PAIR slug is tracked in ITOTORI-226 and
  > does not regress ITOTORI-220. Cost audit (§4) notes none — the
  > requestedProviderId column is cost-attribution-correct."

### ITOTORI-221 — OpenRouterModelProvider

- **Disposition:** stay `complete`.
- **dependsOn extension:** none.
- **statusReason continuation to append:**
  > "Wiring audit (§5.2): cost-cap path is correct; the data-handling
  > capability gate's 'every axis unknown' default is structurally wrong
  > and is deleted wholesale by ITOTORI-227. Cost audit (§4): the
  > normalizeOpenRouterCost five-branch ladder mis-tags real billed
  > cost as provider_estimate; rewritten to a single branch by
  > ITOTORI-225. Both fixes are forward-only (no shims). The original
  > acceptance criterion 'cost-cap excess raises policy_blocked BEFORE
  > the HTTP request fires' still holds — only the
  > assertProviderInputAllowed gate is wrong-shaped."

### ITOTORI-222 — agentic loop

- **Disposition:** stay `complete`.
- **dependsOn extension:** none.
- **statusReason continuation to append:**
  > "Wiring audit (§5.3): orchestrator shape is correct; PairChoice
  > widens (zdr/seed surface) under ITOTORI-234 without structural
  > change. Cost audit (§4): four BigInt(... ?? 0) coercions at
  > lines 698, 750, 823, 906 become hard assertBilledCost(...) calls
  > under ITOTORI-225."

### ITOTORI-223 — telemetry

- **Disposition:** stay `complete`.
- **dependsOn extension:** none.
- **statusReason continuation to append:**
  > "Wiring audit (§5.4): missing the ZDR-enforced-count axis; added by
  > ITOTORI-230 as a forward-only migration. Cost audit (§4 / §2.15):
  > aggregations are real-cost-faithful by construction once the ledger
  > is forced to real cost via ITOTORI-225 + ITOTORI-232 — no change to
  > queries.ts logic, only a doc-comment clarifying that totalCostUsd
  > is by construction the sum of usage.cost values mirrored from OR
  > responses."

### UTSUSHI-227 — replay-and-verify smoke

- **Disposition:** stay `complete`.
- **dependsOn extension:** none.
- **statusReason continuation to append:** none (neither audit touches it
  — wiring §5.6: "correct as merged. Not affected by the audit"; cost
  audit makes no mention).

### UTSUSHI-228 — alpha closer

See §5 for the structural decision. **Outcome:** stay `in_progress`,
extend `dependsOn`, add a new acceptance criterion.

- **Disposition:** stay `in_progress`.
- **dependsOn extension:** add `ITOTORI-225`, `ITOTORI-226`,
  `ITOTORI-227`, `ITOTORI-230`, `ITOTORI-231`, `ITOTORI-232`,
  `ITOTORI-233` (the corrective nodes that must land before the alpha
  closer's live-fire is meaningful). Cost-cap default unification
  (ITOTORI-231) and ledger schema (ITOTORI-232) are non-optional for
  live-fire.
- **New acceptance criterion to append:**
  > "agentic-loop-bundle.v0.json carries routingPosture.zdr === true on
  > every invocation record AND every ledger row written by the closer
  > has cost_kind === 'billed' (no provider_estimate, no unknown)."
- **statusReason continuation to append:**
  > "2026-06-25 audits (wiring §5.5 + cost §4) extended dependsOn to
  > include ITOTORI-225..233 and added a routing-posture + billed-cost
  > acceptance criterion. The pre-audit live-fire failure mode (eight-
  > reason policy_blocked + wrong slug + provider_estimate mistag) is
  > the proof that this closer must wait. The real demonstrable
  > end-to-end is captured under the new UTSUSHI-231 rerun node."

---

## §4 — DOC-AMBIGUOUS list

The wiring audit named eight. The cost audit's §6 "Open questions" raised
three additional ones (which Trevor flagged as non-blocking and assigned
to corrective nodes); listed below as DOC-AMBIGUOUS-9..11 for parity.

| # | From | Question | Empirical resolution |
|---|---|---|---|
| 1 | Wiring §1.2 | Is there a response field declaring "ZDR was in effect for this call"? | One toy call with `provider.zdr=true` against the alpha pair under Trevor's ZDR-only account; capture full response body to `docs/openrouter-integration-evidence/<date>.json`. Resolved by ITOTORI-224. The proof is the combination of (a) account ZDR-only, (b) `provider.zdr=true` on request, (c) non-error response — not a single field. |
| 2 | Wiring §1.2 | What happens when no ZDR provider is available for a model? | Toy call to a model whose providers are non-ZDR while `provider.zdr=true`; observe the error envelope. Resolved by ITOTORI-224. |
| 3 | Wiring §1.3 | Do `:nitro` / `:floor` / `:online` / `:free` suffixes still work? Detail page is missing. | Catalog query + one suffixed call against a public model; document outcome in `openrouter-integration.md`. Resolved by ITOTORI-224. |
| 4 | Wiring §1.3 | What is the "Auto Router" — is it usable from chat-completions? | Fetch the (currently missing) router page or capture an Auto-Router response and document. Resolved by ITOTORI-224. |
| 5 | Wiring §1.4 | Does the `structured_outputs: true` boolean parameter do anything useful alone (without `response_format`)? | Mock and live call comparing `{structured_outputs:true}` alone vs `{response_format:{type:'json_schema',...}}`. Resolved by ITOTORI-224. |
| 6 | Wiring §1.5 | Does `usage.cost` already net out `cache_discount`, or must it be computed as `usage.cost - cache_discount`? | Toy call against an implicit-cache provider (DeepSeek V4 Flash, second call with same prompt); compare `usage.cost` vs `usage.cost_details.cache_discount`. Resolved by ITOTORI-224; cache-aware math implemented in ITOTORI-233. |
| 7 | Wiring §1.8 | Is there an idempotency key? | Two consecutive identical requests with the same speculated key; observe whether OR dedupes. Resolved by ITOTORI-224 (likely "no idempotency"). |
| 8 | Wiring §3-D | Does the `X-OpenRouter-Metadata: enabled` header actually surface the `openrouter_metadata.endpoints` echo block? | Two toy calls — one with header, one without — diff the response body shape. Resolved by ITOTORI-224; endpoint-pricing fallback path either fixed or deleted in ITOTORI-233. |
| 9 | Cost §6.1 | Currency: assume USD-only for alpha? OR returns USD; ledger has `cost_unit text` permitting arbitrary strings. | ITOTORI-232's `check (cost_unit = 'usd')` is the proposed resolution — confirm in node deliverables that USD-only is correct for alpha. |
| 10 | Cost §6.2 | Catalog-driven pre-flight forecasting from `/api/v1/models` (cost-cap expressed as "max N translation calls of K tokens"), or only post-hoc real-cost accounting? | Defer to beta; ITOTORI-235 (`/generation` reconciliation) is the post-hoc path. If catalog-driven forecasting becomes a need, mint a follow-on node at that time. |
| 11 | Cost §6.3 | Existing recorded bundles do not carry original `usage.cost`. Do we re-record from live runs, or accept that pre-fix bundles replay with cost=0 until each is refreshed? | Cost audit's preference (Trevor confirm): mark old bundles schemaVersion-incompatible and force recapture. ITOTORI-228 captures this — the bundle format bump is non-optional. |

---

## §5 — UTSUSHI-228 disposition

**Decision: (a) — stay `in_progress`, extend `dependsOn`, add a new
acceptance criterion.**

Justification:

1. UTSUSHI-228 was never `complete`; the `in_progress` state already
   correctly reflects "the closer landed but live-fire is blocked". The
   audits did not invalidate the closer's *shape* (the wiring audit
   §5.5 explicitly says the orchestration is correct; only the inputs
   it consumes are wrong).
2. Marking `regressed: true` would imply a previously-passing state has
   broken — which is not what happened. The closer's live-fire never
   passed.
3. Minting a new UTSUSHI-231 as the alpha gate (option b) is already
   the right move for the *rerun proof artifact*, but UTSUSHI-228
   itself is the substrate; deleting it and re-minting would erase the
   dependency edges from UTSUSHI-231 → UTSUSHI-228 (since UTSUSHI-231
   re-runs the *same* command UTSUSHI-228 defines).
4. The cleanest posture: UTSUSHI-228 remains the "this command exists
   and is wired" milestone; UTSUSHI-231 becomes the "this command was
   demonstrably run end-to-end against live OR with the corrected
   posture" milestone. Both target alpha.
5. The new acceptance criterion (routingPosture proof + billed-cost
   proof) is added to UTSUSHI-228 itself so even if UTSUSHI-231 is
   skipped, the closer cannot mark complete without proving the
   posture.

---

## §6 — Two-line summary

- **Total corrective nodes to mint after collision resolution: 13.**
  (12 `ITOTORI-` nodes: 224, 225, 226, 227, 228, 229, 230, 231, 232,
  233 (merged), 234, 235 + 1 `UTSUSHI-` node: 231.)
- **First node to mint:** `ITOTORI-224` — every other corrective node
  depends transitively on the canonical OpenRouter integration doc +
  evidence JSON it lands.
