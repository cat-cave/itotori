#!/usr/bin/env node
// ITOTORI-226 — live-smoke verification that the corrected DEV_PAIR slug
// (deepseek/deepseek-v4-flash on fireworks) resolves to a billable
// OpenRouter endpoint under the ZDR-only alpha routing posture.
//
// Pattern: same as scripts/itotori-224-evidence-capture.mjs — single
// chat-completions call, full request+response captured, Authorization
// header redacted, post-write API-key leak check before exit.
//
// Output: artifacts/openrouter-live-smoke/<DATE>.json
//
// Safety contract:
//   - OPENROUTER_API_KEY is read once from process.env and never written.
//   - Every captured request body / response body / headers block has the
//     Authorization header replaced by "Bearer sk-or-***REDACTED***".
//   - One outgoing HTTP call only. Toy prompt; expected cost well under
//     USD 0.001.
//   - Refuses to write the captured payload if a stray API-key pattern
//     leaks into the serialized JSON.

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const ARTIFACT_DIR = resolve(REPO, "artifacts/openrouter-live-smoke");
const SMOKE_DATE = "2026-06-25";
const ARTIFACT_PATH = resolve(ARTIFACT_DIR, `${SMOKE_DATE}.json`);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.length < 16) {
  console.error(
    "ITOTORI-226 live-smoke aborted: OPENROUTER_API_KEY is not set in the environment.",
  );
  process.exit(1);
}

const REDACT = "Bearer sk-or-***REDACTED***";
const BASE = "https://openrouter.ai/api/v1";
const REFERER = "https://itotori.dev/itotori-226-live-smoke";
const TITLE = "itotori-226-live-smoke";

const MODEL_ID = "deepseek/deepseek-v4-flash";
const PROVIDER_ID = "fireworks";

const PROVIDER_ROUTING_ALPHA = {
  only: [PROVIDER_ID],
  allow_fallbacks: false,
  data_collection: "deny",
  zdr: true,
  require_parameters: true,
};

/** Redact the Authorization header on a captured headers object. */
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

console.error(
  `[ITOTORI-226] Firing toy chat-completions against ${MODEL_ID} on provider.only=[${PROVIDER_ID}] + provider.zdr=true ...`,
);
const call = await captureCall("call_1_dev_pair_corrected_slug_alpha_routing", {
  path: "/chat/completions",
  body: {
    model: MODEL_ID,
    messages: [
      {
        role: "user",
        content: "Reply with exactly the word: itotori",
      },
    ],
    max_tokens: 16,
    temperature: 0,
    provider: PROVIDER_ROUTING_ALPHA,
  },
});

console.error(
  `  -> status ${call.response.status} provider=${call.response.body?.provider ?? "n/a"} usage.cost=${call.response.body?.usage?.cost ?? "n/a"}`,
);

const status = call.response.status;
const providerEcho = call.response.body?.provider ?? null;

const payload = {
  schemaVersion: "itotori-226-live-smoke/v0",
  node: "ITOTORI-226",
  fetchedAt,
  redactionContract: {
    field: "headers.authorization",
    replacement: REDACT,
    rationale:
      "Authorization header is never written to disk. Verify with: rg 'sk-or-[A-Za-z0-9_-]{40,}' artifacts/openrouter-live-smoke/<date>.json (must return 0).",
  },
  devPair: {
    modelId: MODEL_ID,
    providerId: PROVIDER_ID,
    rationale:
      "ITOTORI-226 corrected DEV_PAIR.modelId to the catalog-correct deepseek/deepseek-v4-flash. This smoke proves the corrected pair resolves to a billable endpoint under provider.only=['fireworks'] + provider.zdr=true.",
  },
  routingPostureUsed: PROVIDER_ROUTING_ALPHA,
  acceptanceCheck: {
    expectedHttpStatus: 200,
    observedHttpStatus: status,
    expectedProviderEchoContains: "Fireworks",
    observedProviderEcho: providerEcho,
    pass:
      status === 200 &&
      typeof providerEcho === "string" &&
      providerEcho.toLowerCase().includes("fireworks"),
  },
  call,
};

mkdirSync(ARTIFACT_DIR, { recursive: true });
writeFileSync(ARTIFACT_PATH, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8" });

const written = readFileSync(ARTIFACT_PATH, "utf8");
const SK_RE = /sk-or-[A-Za-z0-9_-]{40,}/;
if (SK_RE.test(written)) {
  console.error(
    `[ITOTORI-226] FATAL: API key pattern leaked into ${ARTIFACT_PATH}; overwriting with abort sentinel.`,
  );
  writeFileSync(
    ARTIFACT_PATH,
    JSON.stringify({ aborted: "api_key_leak_detected", fetchedAt }, null, 2),
    "utf8",
  );
  process.exit(2);
}

console.error(
  `[ITOTORI-226] Live smoke captured to ${ARTIFACT_PATH} (size ${written.length} bytes; pass=${payload.acceptanceCheck.pass}).`,
);
if (!payload.acceptanceCheck.pass) {
  console.error("[ITOTORI-226] Acceptance check FAILED — see captured artifact for details.");
  process.exit(3);
}
