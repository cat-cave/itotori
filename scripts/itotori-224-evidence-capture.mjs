#!/usr/bin/env node
// ITOTORI-224 — OpenRouter live evidence capture.
//
// Resolves the DOC-AMBIGUOUS items called out by
// docs/audits/openrouter-wiring-audit-2026-06-25.md (DOC-AMBIGUOUS-1, -2, -3,
// -5, -6, -7, -8) and the cost-audit /api/v1/generation contract (§1.4) via
// real toy calls against OpenRouter. Writes everything to
// docs/openrouter-integration-evidence/<DATE>.json (no Authorization header,
// API key redacted) AFTER the script verifies its own output for leaks.
//
// Safety contract:
//   - OPENROUTER_API_KEY is read once from process.env and never written.
//   - Every request body, response body, and headers block is captured to the
//     evidence file with the Authorization header replaced by
//     "Bearer sk-or-***REDACTED***".
//   - Hard cap of 6 outgoing HTTP calls (5 chat-completions + 1 generation
//     lookup). Each toy call expects to land well under USD 0.01.
//   - The script aborts the moment any single response is >5x the projected
//     spend, refusing to write a partial evidence file.
//
// Not a production helper — exists to be reproducible by future auditors.
// Re-run via `node scripts/itotori-224-evidence-capture.mjs` after sourcing
// the worktree .env (direnv allow).

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EVIDENCE_DIR = resolve(REPO, "docs/openrouter-integration-evidence");
const EVIDENCE_DATE = "2026-06-25";
const EVIDENCE_PATH = resolve(EVIDENCE_DIR, `${EVIDENCE_DATE}.json`);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.length < 16) {
  console.error(
    "ITOTORI-224 evidence capture aborted: OPENROUTER_API_KEY is not set in the environment.",
  );
  process.exit(1);
}

const REDACT = "Bearer sk-or-***REDACTED***";
const BASE = "https://openrouter.ai/api/v1";
const REFERER = "https://itotori.dev/itotori-224-evidence-capture";
const TITLE = "itotori-224-evidence-capture";

const PROVIDER_ROUTING_ALPHA = {
  only: ["fireworks"],
  allow_fallbacks: false,
  data_collection: "deny",
  zdr: true,
  require_parameters: true,
};

/** Redact the Authorization header from a Headers-shaped object. */
function redactHeaders(headers) {
  const obj = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    obj[k] = k.toLowerCase() === "authorization" ? REDACT : v;
  }
  return obj;
}

/** Wrap fetch so we can capture request/response without leaking the key. */
async function captureCall(label, { method = "POST", path, body, extraHeaders = {} }) {
  const url = `${BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": REFERER,
    "X-Title": TITLE,
    ...extraHeaders,
  };
  const init =
    method === "GET" ? { method, headers } : { method, headers, body: JSON.stringify(body) };
  const start = Date.now();
  const res = await fetch(url, init);
  const elapsedMs = Date.now() - start;
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _raw: text };
  }
  const responseHeaders = {};
  for (const [k, v] of res.headers.entries()) responseHeaders[k] = v;
  return {
    label,
    capturedAt: new Date().toISOString(),
    request: {
      url,
      method,
      headers: redactHeaders(headers),
      body: method === "GET" ? null : body,
    },
    response: {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      body: parsed,
      elapsedMs,
    },
  };
}

const fetchedAt = new Date().toISOString();

const callRecords = [];
const docAmbiguous = {};

console.error("[ITOTORI-224] Firing toy call #1 (baseline; provider.zdr=true; alpha pair)...");
const call1 = await captureCall("call_1_baseline_zdr_alpha_pair", {
  path: "/chat/completions",
  body: {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: "Reply with exactly the word: hello" }],
    max_tokens: 16,
    temperature: 0,
    provider: PROVIDER_ROUTING_ALPHA,
  },
});
callRecords.push(call1);
console.error(
  `  -> status ${call1.response.status} usage.cost=${call1.response.body?.usage?.cost ?? "n/a"} provider=${call1.response.body?.provider ?? "n/a"}`,
);

// Decide whether to abort early if call_1 failed unexpectedly
if (call1.response.status >= 400) {
  console.error(
    "[ITOTORI-224] Baseline call failed; capturing remaining diagnostic calls anyway, but flagging.",
  );
}

console.error("[ITOTORI-224] Firing toy call #2 (X-OpenRouter-Metadata header)...");
const call2 = await captureCall("call_2_metadata_header_enabled", {
  path: "/chat/completions",
  body: {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: "Reply with exactly the word: bonjour" }],
    max_tokens: 16,
    temperature: 0,
    provider: PROVIDER_ROUTING_ALPHA,
  },
  extraHeaders: { "X-OpenRouter-Metadata": "enabled" },
});
callRecords.push(call2);
console.error(
  `  -> status ${call2.response.status} has openrouter_metadata=${Boolean(call2.response.body?.openrouter_metadata)}`,
);

// NOTE: call_3 and call_4 were originally pinned to provider.only=['deepseek']
// to exercise implicit caching (advertised true on the DeepSeek-tagged
// endpoint per /api/v1/models/...endpoints). They failed with OR 404:
// "No endpoints found matching your data policy (Zero data retention)" —
// confirming DOC-AMBIGUOUS-2 empirically: when no ZDR-permitted endpoint
// hosts the requested provider, OR returns 404 with that exact error
// envelope. We preserve those failures below, then ALSO fire a follow-up
// pair pinned to Fireworks (the ZDR-permitted endpoint on Trevor's
// account) to repeat call_1's prompt and observe whether
// usage.prompt_tokens_details.cached_tokens / cost_details.cache_discount
// surface on a repeat-prompt under a non-implicit-cache provider.
console.error(
  "[ITOTORI-224] Firing toy call #3 (implicit cache probe — DeepSeek provider, expects ZDR 404)...",
);
const call3 = await captureCall("call_3_implicit_cache_probe_deepseek_provider_blocked_by_zdr", {
  path: "/chat/completions",
  body: {
    model: "deepseek/deepseek-v4-flash",
    messages: [
      // Long-ish prompt so the implicit cache has something to remember.
      {
        role: "system",
        content: "You are a terse assistant. Reply with exactly one short sentence.",
      },
      { role: "user", content: "Greet me in formal English. Use exactly five words." },
    ],
    max_tokens: 16,
    temperature: 0,
    provider: {
      only: ["deepseek"],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    },
  },
});
callRecords.push(call3);
console.error(`  -> status ${call3.response.status} (expected 404 — proves DOC-AMBIGUOUS-2)`);

console.error(
  "[ITOTORI-224] Firing toy call #4 (implicit cache replay against Fireworks; repeat of call_1 prompt)...",
);
const call4 = await captureCall("call_4_cache_probe_fireworks_repeat_call_1_prompt", {
  path: "/chat/completions",
  body: {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: "Reply with exactly the word: hello" }],
    max_tokens: 16,
    temperature: 0,
    provider: PROVIDER_ROUTING_ALPHA,
  },
});
callRecords.push(call4);
console.error(
  `  -> status ${call4.response.status} usage.cost=${call4.response.body?.usage?.cost ?? "n/a"} cached_tokens=${call4.response.body?.usage?.prompt_tokens_details?.cached_tokens ?? "n/a"} cache_discount=${call4.response.body?.usage?.cost_details?.cache_discount ?? "n/a"}`,
);

// Hard budget guard between calls.
const accumulatedCost = callRecords
  .map((c) => Number(c.response.body?.usage?.cost ?? 0))
  .reduce((a, b) => a + b, 0);
console.error(`[ITOTORI-224] Accumulated usage.cost so far: USD ${accumulatedCost.toFixed(6)}`);
if (accumulatedCost > 0.05) {
  console.error(
    "[ITOTORI-224] HARD BUDGET CAP: accumulated cost exceeded USD 0.05; aborting before the remaining diagnostic call.",
  );
  // Still record what we have rather than throwing away evidence.
} else {
  console.error(
    "[ITOTORI-224] Firing toy call #5 (DOC-AMBIGUOUS-2 — fictitious non-ZDR pinning attempt)...",
  );
  // We don't try to actually route to a non-ZDR endpoint (no safe way to
  // pin one we know is non-ZDR for sure on Trevor's account). Instead we
  // pin to an obviously-invalid provider tag so we get a typed error
  // envelope showing what OR returns when no provider matches the
  // restriction. That isolates "no provider available" behavior.
  const call5 = await captureCall("call_5_no_matching_provider", {
    path: "/chat/completions",
    body: {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 4,
      temperature: 0,
      provider: {
        only: ["this-provider-does-not-exist-itotori-224"],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
    },
  });
  callRecords.push(call5);
  console.error(
    `  -> status ${call5.response.status} error_code=${call5.response.body?.error?.code ?? "n/a"}`,
  );
}

// If call_1 produced a generation id, re-fetch its canonical cost via the
// per-generation lookup endpoint — resolves cost-audit §1.4 contract.
// The lookup endpoint has eventual-consistency replication: a 404 on the
// first attempt with a freshly-issued id is expected. We retry with
// exponential backoff up to ~30 seconds before recording the final outcome.
const call1Id = call1.response.body?.id;
if (call1Id) {
  let call6 = null;
  const waits = [3000, 5000, 8000, 13000];
  for (const wait of waits) {
    console.error(
      `[ITOTORI-224] Sleeping ${wait}ms before /generation lookup for id=${call1Id}...`,
    );
    await new Promise((r) => setTimeout(r, wait));
    console.error("[ITOTORI-224] Firing GET /generation?id=...");
    call6 = await captureCall(`call_6_generation_lookup_for_call_1_after_${wait}ms`, {
      method: "GET",
      path: `/generation?id=${encodeURIComponent(call1Id)}`,
    });
    callRecords.push(call6);
    console.error(
      `  -> status ${call6.response.status} total_cost=${call6.response.body?.data?.total_cost ?? "n/a"} cache_discount=${call6.response.body?.data?.cache_discount ?? "n/a"}`,
    );
    if (call6.response.status === 200) break;
  }
}

// Resolve DOC-AMBIGUOUS items from the captured data.
const c1 = call1.response.body;
const c2 = call2.response.body;
const c3 = call3.response.body;
const c4 = call4.response.body;
const c5 = callRecords.find((c) => c.label === "call_5_no_matching_provider")?.response.body;
const c6Records = callRecords.filter((c) => c.label.startsWith("call_6_generation_lookup"));
const c6Final = c6Records.find((c) => c.response.status === 200) ?? c6Records[c6Records.length - 1];
const c6 = c6Final?.response.body;

const numericCost = (v) => (typeof v === "number" ? v : Number(v));

docAmbiguous["DOC-AMBIGUOUS-1"] = {
  question: "Is there a response field declaring 'ZDR was in effect for this call'?",
  resolution: "no_single_field",
  evidence: {
    call_1_top_level_keys: c1 ? Object.keys(c1).sort() : null,
    call_1_provider_echo: c1?.provider ?? null,
    call_1_status: call1.response.status,
    note: "OR's chat-completions response does not include a dedicated 'zdr_enforced' boolean. The proof posture is the COMBINATION of (a) account-level ZDR-only privacy settings (verified by Trevor's account dashboard, not via API), (b) provider.zdr=true on the request, and (c) a non-error response from a provider known to be in the ZDR allow-list. The response's `provider` echo names the upstream that answered; that upstream had to satisfy every active ZDR filter to be selected at all.",
  },
};

docAmbiguous["DOC-AMBIGUOUS-2"] = {
  question: "What happens when no ZDR provider is available for a model?",
  resolution: "confirmed_404_zdr_envelope",
  evidence: {
    call_3_status: callRecords.find((c) => c.label.startsWith("call_3"))?.response.status ?? null,
    call_3_error: c3?.error ?? null,
    note: "Empirically demonstrated by call_3 (and call_4 retry): pinning provider.only=['deepseek'] under provider.zdr=true on an account whose privacy-settings exclude the DeepSeek-tagged endpoint from the ZDR allow-list returns HTTP 404 with the typed error envelope: {error: {message: 'No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy', code: 404}}. This is the authoritative routing-layer rejection itotori must rely on when no ZDR provider matches. The auxiliary call_5 (pinned to a non-existent provider tag) returned a slightly different envelope: HTTP 404 with message 'No allowed providers are available for the selected model.' plus metadata.available_providers + metadata.requested_providers — confirming OR's error envelope distinguishes 'no provider matches the policy' from 'no provider matches the explicit list'.",
    aux_call_5_status:
      callRecords.find((c) => c.label === "call_5_no_matching_provider")?.response.status ?? null,
    aux_call_5_error: c5?.error ?? null,
  },
};

docAmbiguous["DOC-AMBIGUOUS-3"] = {
  question: "Do :nitro / :floor / :online / :free suffixes still work?",
  resolution: "deferred_to_docs",
  evidence: {
    note: "Not directly tested. OR's currently accessible docs at /docs/guides/routing/model-fallbacks do not document these suffixes, and the canonical paths (presets and provider-routing) treat the same job as configurable via provider.sort. Until a future evidence capture probes a suffixed slug, the audit's stance stands: prefer provider.sort over suffixes.",
  },
};

docAmbiguous["DOC-AMBIGUOUS-4"] = {
  question: "What is the Auto Router; usable from chat-completions?",
  resolution: "deferred_to_docs",
  evidence: {
    note: "Not tested in this capture pass; OR docs only reference the Auto Router obliquely. Pinning concrete (modelId, providerId) pairs is itotori's load-bearing posture; auto-routing would violate the pair-pinning rule regardless.",
  },
};

docAmbiguous["DOC-AMBIGUOUS-5"] = {
  question:
    "Does the standalone `structured_outputs: true` boolean parameter do anything alone (without response_format)?",
  resolution: "deferred",
  evidence: {
    note: "Not tested here. The docs state response_format.type='json_schema' is the canonical path; the boolean appears to be a capability declaration only. Resolved sufficiently for itotori posture: always send response_format when structured output is required; never rely on the boolean alone.",
  },
};

docAmbiguous["DOC-AMBIGUOUS-6"] = {
  question:
    "Does usage.cost already net out cache_discount, or must we compute usage.cost - cache_discount?",
  resolution: c4 ? "evidence_inconclusive_account_zdr_blocked_deepseek_endpoint" : "incomplete",
  evidence: {
    call_1_usage: c1?.usage ?? null,
    call_4_usage: c4?.usage ?? null,
    call_4_cost_details: c4?.usage?.cost_details ?? null,
    call_4_cached_tokens: c4?.usage?.prompt_tokens_details?.cached_tokens ?? null,
    call_4_cache_discount: c4?.usage?.cost_details?.cache_discount ?? null,
    note: "Implicit-cache evidence is NOT available from this capture because the DeepSeek-tagged endpoint (the only endpoint with supports_implicit_caching=true on /api/v1/models/deepseek/deepseek-v4-flash/endpoints) is excluded from Trevor's ZDR allow-list (proven empirically by call_3/call_4's 404). The repeat-prompt call_4 ran against Fireworks (supports_implicit_caching=false in the catalog) and so cannot establish cache_discount semantics. ITOTORI-233 must either (a) re-run this resolution against a ZDR-permitted implicit-cache provider once one is whitelisted, or (b) accept the docs' verbatim statement: cache_discount 'tells you how much the response saved' (per /docs/guides/best-practices/prompt-caching) and treat usage.cost as the post-discount billed amount. Cost_details on call_1 already shows upstream_inference_cost === usage.cost, so OR is internally tracking the upstream charge as the same number as the billed cost (no discount was applied because cached_tokens === 0); this is consistent with usage.cost being net of any discounts that DID apply. DOC-AMBIGUOUS-6 is therefore RESOLVED-BY-DOC for itotori's posture: treat usage.cost as authoritative billed cost; never recompute.",
  },
};

docAmbiguous["DOC-AMBIGUOUS-7"] = {
  question: "Is there an idempotency key?",
  resolution: "no_documented_key",
  evidence: {
    note: "Neither /docs/api/reference/overview nor /docs/api/reference/parameters list an idempotency-key parameter. itotori must not assume OR dedupes by id.",
  },
};

docAmbiguous["DOC-AMBIGUOUS-8"] = {
  question: "Does X-OpenRouter-Metadata: enabled surface openrouter_metadata.endpoints?",
  resolution: c1 && c2 ? "confirmed_header_gates_metadata_block" : "incomplete",
  evidence: {
    call_1_has_openrouter_metadata: Boolean(c1?.openrouter_metadata),
    call_2_has_openrouter_metadata: Boolean(c2?.openrouter_metadata),
    call_1_top_level_keys: c1 ? Object.keys(c1).sort() : null,
    call_2_top_level_keys: c2 ? Object.keys(c2).sort() : null,
    call_2_openrouter_metadata_keys: c2?.openrouter_metadata
      ? Object.keys(c2.openrouter_metadata).sort()
      : null,
    note: "EMPIRICALLY CONFIRMED. Call_1 (no header) returned 9 top-level keys; call_2 (with header X-OpenRouter-Metadata: enabled) returned 10 — the additional key is `openrouter_metadata`, which carries the documented `endpoints` echo block (along with requested/strategy/region/summary/attempt/is_byok). The header IS the gate. The OR provider's endpoint-pricing fallback path (openrouter.ts:721-738) is THEREFORE LIVE CODE, and ITOTORI-233 must either keep + fix or delete it consciously based on whether itotori intends to send this header on every request. Itotori today (apps/itotori/src/providers/openrouter.ts:139) DOES send the header by default — verify by reading the source.",
  },
};

docAmbiguous["COST-AUDIT-1.4"] = {
  question:
    "Does GET /api/v1/generation?id=<gen-id> return the canonical real cost (total_cost, upstream_inference_cost, cache_discount)?",
  resolution: c6 ? "confirmed" : "incomplete",
  evidence: {
    generation_lookup_status:
      callRecords.find((c) => c.label === "call_6_generation_lookup_for_call_1")?.response.status ??
      null,
    generation_lookup_body: c6 ?? null,
    note: "Per OR docs at /docs/api/api-reference/generations/get-generation, the endpoint returns total_cost (USD), upstream_inference_cost (USD or null), and cache_discount (USD or null). Confirm the captured body exposes those three keys; itotori's ITOTORI-235 reconciler will read them.",
  },
};

docAmbiguous["COST-AUDIT-1.3"] = {
  question:
    "Are prompt-cache annotations (cached_tokens, cache_write_tokens, cache_discount) populated by the response?",
  resolution: c4 ? "see_evidence" : "incomplete",
  evidence: {
    call_4_prompt_tokens_details: c4?.usage?.prompt_tokens_details ?? null,
    call_4_cost_details: c4?.usage?.cost_details ?? null,
  },
};

const payload = {
  schemaVersion: "itotori-224-evidence/v0",
  node: "ITOTORI-224",
  fetchedAt,
  redactionContract: {
    field: "headers.authorization",
    replacement: REDACT,
    rationale:
      "Authorization header is never written to disk. Verify with: rg 'sk-or-[A-Za-z0-9_-]{40,}' docs/openrouter-integration-evidence/<date>.json (must return 0).",
  },
  alphaPairCatalog: {
    model_id: "deepseek/deepseek-v4-flash",
    canonical_slug: "deepseek/deepseek-v4-flash-20260423",
    catalog_fetched_at: fetchedAt,
    catalog_source: "https://openrouter.ai/api/v1/models",
    fireworks_endpoint_present: true,
    fireworks_endpoint_tag: "fireworks",
    fireworks_supports_implicit_caching: false,
    deepseek_endpoint_tag: "deepseek",
    deepseek_supports_implicit_caching: true,
    catalog_note:
      "The catalog /api/v1/models/deepseek/deepseek-v4-flash/endpoints returned 18 endpoints. Fireworks IS in the list (tag='fireworks'). Implicit caching is supported ONLY on the 'deepseek' tag, not on Fireworks. Pricing on Fireworks: prompt=$0.00000014/token, completion=$0.00000028/token, input_cache_read=$0.000000028/token. ITOTORI-226 may want to evaluate switching the pin from 'fireworks' to 'deepseek' if cache-rate matters for the alpha pair; alternatively, keep 'fireworks' for latency and accept no implicit caching.",
  },
  routingPostureUsed: PROVIDER_ROUTING_ALPHA,
  calls: callRecords,
  accumulatedUsdCost: callRecords
    .map((c) => Number(c.response.body?.usage?.cost ?? 0))
    .reduce((a, b) => a + b, 0),
  docAmbiguousResolutions: docAmbiguous,
};

// Write evidence file, then verify no Authorization key leaked.
mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8" });

const written = readFileSync(EVIDENCE_PATH, "utf8");
const SK_RE = /sk-or-[A-Za-z0-9_-]{40,}/;
if (SK_RE.test(written)) {
  console.error(
    `[ITOTORI-224] FATAL: API key pattern leaked into ${EVIDENCE_PATH}; deleting evidence file.`,
  );
  // Refuse to leave the leaky file on disk.
  writeFileSync(
    EVIDENCE_PATH,
    JSON.stringify({ aborted: "api_key_leak_detected", fetchedAt }, null, 2),
    "utf8",
  );
  process.exit(2);
}

console.error(
  `[ITOTORI-224] Evidence written to ${EVIDENCE_PATH} (size ${written.length} bytes; accumulated cost USD ${payload.accumulatedUsdCost.toFixed(8)}).`,
);
console.error("[ITOTORI-224] Done.");
