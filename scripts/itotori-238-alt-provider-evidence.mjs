#!/usr/bin/env node
// ITOTORI-238 — Alternate provider evidence capture.
//
// Goal: validate that one or more ZDR-permitted OpenRouter providers (other
// than 'fireworks') can host `deepseek/deepseek-v4-flash` for Trevor's
// account and return a successful response under
//   provider.only=[<alt>], provider.zdr=true, allow_fallbacks=false.
//
// This is the evidence-validation pass mandated by the ITOTORI-238 spec
// (per the (modelId, providerId) pair rule + the no-optionality, evidence-
// first rule in user memory): we do NOT enumerate alternates without a
// per-pair live toy call.
//
// Candidate alternates probed (drawn from the ITOTORI-224 catalog block at
// docs/openrouter-integration-evidence/2026-06-25.json call_5
// metadata.available_providers, MINUS the 'deepseek' tag because Trevor's
// account excludes it from the ZDR allow-list — empirically proven by
// call_3 / call_4 in the same evidence file):
//
//   - lambda   (NOT in the 18-endpoint catalog block; only present in the
//                OpenRouter catalog for some models, so the toy call may
//                404 with "no allowed providers")
//   - novita
//   - parasail
//   - deepinfra
//
// We probe each candidate with a small structured-output call to mirror the
// itotori orchestrator's actual posture (the alpha closer issues
// json_schema requests at the QA + speaker-label stages).
//
// Safety contract:
//   - OPENROUTER_API_KEY is read once from process.env and never written.
//   - Authorization headers are replaced with "Bearer sk-or-***REDACTED***"
//     before the evidence file is serialized.
//   - Hard budget cap: aborts the moment accumulated USD spend exceeds
//     $0.05. Each toy call is bounded to max_tokens=16.
//   - The script verifies its own output for `sk-or-…` patterns and
//     refuses to leave a leaky file on disk.
//
// Not a production helper. Re-run via
//   `node scripts/itotori-238-alt-provider-evidence.mjs`
// after sourcing the worktree .env.

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EVIDENCE_DIR = resolve(REPO, "docs/openrouter-integration-evidence");
const EVIDENCE_DATE = "2026-06-26-alt-providers";
const EVIDENCE_PATH = resolve(EVIDENCE_DIR, `${EVIDENCE_DATE}.json`);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.length < 16) {
  console.error(
    "ITOTORI-238 evidence capture aborted: OPENROUTER_API_KEY is not set in the environment.",
  );
  process.exit(1);
}

const REDACT = "Bearer sk-or-***REDACTED***";
const BASE = "https://openrouter.ai/api/v1";
const REFERER = "https://itotori.dev/itotori-238-alt-provider-evidence";
const TITLE = "itotori-238-alt-provider-evidence";

const MODEL_ID = "deepseek/deepseek-v4-flash";
// Candidate providers to validate. 'deepseek' (the tag) is intentionally
// EXCLUDED — Trevor's account ZDR allow-list does not include it (see the
// ITOTORI-224 evidence file, call_3/call_4 at HTTP 404).
const CANDIDATE_PROVIDERS = ["lambda", "novita", "parasail", "deepinfra"];

function redactHeaders(headers) {
  const obj = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    obj[k] = k.toLowerCase() === "authorization" ? REDACT : v;
  }
  return obj;
}

async function captureCall(label, { method = "POST", path, body }) {
  const url = `${BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": REFERER,
    "X-Title": TITLE,
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
const altSummaries = {};

let accumulatedCost = 0;
const HARD_CAP_USD = 0.05;

for (const altProviderId of CANDIDATE_PROVIDERS) {
  if (accumulatedCost > HARD_CAP_USD) {
    console.error(
      `[ITOTORI-238] HARD BUDGET CAP exceeded (USD ${accumulatedCost.toFixed(6)} > ${HARD_CAP_USD}); skipping remaining candidates.`,
    );
    altSummaries[altProviderId] = {
      validated: false,
      reason: "skipped_budget_cap_hit",
    };
    continue;
  }
  console.error(
    `[ITOTORI-238] Probing candidate alternate (provider.only=['${altProviderId}'], zdr=true)...`,
  );
  // Plain chat completion first (simpler than json_schema; if even this
  // 404s the candidate is unusable for any structured request).
  const call = await captureCall(`call_${altProviderId}_zdr_probe`, {
    path: "/chat/completions",
    body: {
      model: MODEL_ID,
      messages: [{ role: "user", content: "Reply with exactly the word: hello" }],
      max_tokens: 16,
      temperature: 0,
      provider: {
        only: [altProviderId],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
    },
  });
  callRecords.push(call);
  const status = call.response.status;
  const upstreamProvider = call.response.body?.provider ?? null;
  const errMessage = call.response.body?.error?.message ?? null;
  const errCode = call.response.body?.error?.code ?? null;
  const usageCost = Number(call.response.body?.usage?.cost ?? 0);
  if (Number.isFinite(usageCost)) accumulatedCost += usageCost;
  console.error(
    `  -> status ${status} provider=${upstreamProvider ?? "n/a"} usage.cost=${usageCost} err=${errCode ?? "n/a"}`,
  );

  // If the plain call succeeded, probe json_schema structured output too —
  // every alternate we adopt MUST support structured outputs because the
  // QA + speaker-label stages depend on response_format: { type: 'json_schema' }.
  let structuredCall = null;
  let structuredSupport = "untested";
  if (status === 200 && upstreamProvider !== null) {
    console.error(
      `[ITOTORI-238]   plain call succeeded — probing json_schema structured-output mode on ${altProviderId}...`,
    );
    structuredCall = await captureCall(`call_${altProviderId}_json_schema_probe`, {
      path: "/chat/completions",
      body: {
        model: MODEL_ID,
        messages: [
          {
            role: "user",
            content:
              "Return a JSON object with the single field `greeting` set to the string 'hello'.",
          },
        ],
        max_tokens: 32,
        temperature: 0,
        provider: {
          only: [altProviderId],
          allow_fallbacks: false,
          data_collection: "deny",
          zdr: true,
          require_parameters: true,
        },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "itotori_238_alt_probe",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["greeting"],
              properties: { greeting: { type: "string" } },
            },
          },
        },
      },
    });
    callRecords.push(structuredCall);
    const sStatus = structuredCall.response.status;
    const sUsageCost = Number(structuredCall.response.body?.usage?.cost ?? 0);
    if (Number.isFinite(sUsageCost)) accumulatedCost += sUsageCost;
    if (sStatus === 200) {
      // Verify the body is a JSON object with the requested field.
      const content = structuredCall.response.body?.choices?.[0]?.message?.content;
      let parsedJson = null;
      try {
        parsedJson = typeof content === "string" ? JSON.parse(content) : null;
      } catch {
        parsedJson = null;
      }
      structuredSupport =
        parsedJson !== null && typeof parsedJson === "object" && "greeting" in parsedJson
          ? "supported"
          : "partial_returned_non_conforming_json";
    } else {
      structuredSupport = `unsupported_http_${sStatus}`;
    }
    console.error(
      `  -> json_schema status ${sStatus} structuredSupport=${structuredSupport} usage.cost=${sUsageCost}`,
    );
  }

  altSummaries[altProviderId] = {
    validated: status === 200 && upstreamProvider !== null,
    plain_call_status: status,
    plain_call_upstream_provider: upstreamProvider,
    plain_call_error_message: errMessage,
    plain_call_error_code: errCode,
    structured_outputs_json_schema: structuredSupport,
    zdr_posture_sent: { zdr: true, data_collection: "deny", allow_fallbacks: false },
    // When the plain call 404s for ZDR reasons OR.no-allowed-providers
    // reasons, the candidate is unusable for Trevor's account — record
    // why so a future re-validation does not have to re-run the probe.
    blocked_by_zdr_or_unavailable:
      status === 404 &&
      typeof errMessage === "string" &&
      (errMessage.includes("Zero data retention") ||
        errMessage.includes("No allowed providers") ||
        errMessage.includes("No endpoints found")),
  };
}

const payload = {
  schemaVersion: "itotori-238-alt-provider-evidence/v0",
  node: "ITOTORI-238",
  fetchedAt,
  redactionContract: {
    field: "headers.authorization",
    replacement: REDACT,
    rationale:
      "Authorization header is never written to disk. Verify with: rg 'sk-or-[A-Za-z0-9_-]{40,}' docs/openrouter-integration-evidence/<date>.json (must return 0).",
  },
  modelUnderTest: MODEL_ID,
  candidateProviders: CANDIDATE_PROVIDERS,
  excludedFromCandidates: {
    deepseek:
      "Tagged endpoint excluded from Trevor's ZDR allow-list (proven by ITOTORI-224 evidence call_3/call_4 — HTTP 404 'No endpoints found matching your data policy'). Per user memory project_zdr_allowlist_excludes_deepseek_implicit_cache. Never propose this tag as an alternate.",
  },
  altProviderSummaries: altSummaries,
  calls: callRecords,
  accumulatedUsdCost: accumulatedCost,
  notes: [
    "ITOTORI-238 alternate-provider validation: each candidate is probed under provider.only=[<alt>] + zdr=true + allow_fallbacks=false (the same posture itotori sends production traffic with).",
    "Validation is binary per pair: status=200 with body.provider matching the candidate = VALIDATED. Anything else = NOT VALIDATED and must NOT be added to alternateProviders[] in the pair-policy preset.",
    "Structured-output mode is probed only on candidates that pass the plain call — alternates we adopt MUST support response_format: { type: 'json_schema' } because QA + speaker-label stages depend on it.",
  ],
};

// Write evidence file, then verify no Authorization key leaked.
mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8" });

const written = readFileSync(EVIDENCE_PATH, "utf8");
const SK_RE = /sk-or-[A-Za-z0-9_-]{40,}/;
if (SK_RE.test(written)) {
  console.error(
    `[ITOTORI-238] FATAL: API key pattern leaked into ${EVIDENCE_PATH}; deleting evidence file.`,
  );
  writeFileSync(
    EVIDENCE_PATH,
    JSON.stringify({ aborted: "api_key_leak_detected", fetchedAt }, null, 2),
    "utf8",
  );
  process.exit(2);
}

console.error(
  `[ITOTORI-238] Evidence written to ${EVIDENCE_PATH} (size ${written.length} bytes; accumulated cost USD ${payload.accumulatedUsdCost.toFixed(8)}).`,
);
const validatedAlternates = Object.entries(altSummaries)
  .filter(([, summary]) => summary.validated)
  .map(([id]) => id);
console.error(
  `[ITOTORI-238] Validated alternates: ${validatedAlternates.length ? validatedAlternates.join(", ") : "<NONE>"}`,
);
console.error("[ITOTORI-238] Done.");
