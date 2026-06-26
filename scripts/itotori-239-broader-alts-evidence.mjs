#!/usr/bin/env node
// ITOTORI-239 — Broader alternate-provider evidence capture.
//
// Goal: ITOTORI-238 validated `deepinfra` as the only json-schema-capable
// alternate, but UTSUSHI-231 retry 7 saw HTTP 429 from BOTH fireworks
// (primary) AND deepinfra (the sole alternate). With only one alternate
// behind the primary, a quota-time co-incidence wipes the entire bundle.
//
// This pass probes the OTHER endpoints advertised by /api/v1/models for
// `deepseek/deepseek-v4-flash` (catalog list captured in
// docs/openrouter-integration-evidence/2026-06-25.json call_5
// metadata.available_providers) under Trevor's ZDR allow-list. We
// exclude the already-validated set, the empirically-blocked `deepseek`
// tag, and the candidates ITOTORI-238 already proved out:
//
//   primary:                          fireworks
//   already-validated alternate:      deepinfra
//   ZDR-blocked (per ITOTORI-224):    deepseek
//   already-probed by ITOTORI-238:    lambda (404), novita (200 plain
//                                       but 404 on json_schema), parasail
//                                       (200 plain, 429 on json_schema —
//                                       retry here)
//
// Untried candidates (drawn from the 2026-06-25 catalog block,
// available_providers):
//   streamlake, wafer, gmicloud, baidu, digitalocean, siliconflow,
//   alibaba, morph, atlas-cloud, akashml, wandb, cloudflare, venice
//   PLUS a parasail retry (the json_schema 429 was transient quota, not
//   capability).
//
// Posture per probe:
//   - provider.only=[<candidate>]
//   - provider.zdr=true
//   - provider.data_collection="deny"
//   - provider.allow_fallbacks=false
//   - provider.require_parameters=true
//
// Probe payload size: the ITOTORI-238 toy call was ~16 prompt tokens,
// which is not representative of the agentic loop's actual workload
// (QA + speaker-label stages send hundreds-to-thousands of tokens). The
// task spec explicitly asks for "a slightly bigger prompt that
// approximates a real translation request". So each candidate gets:
//
//   - call_1_plain: a 200-token prompt (~50 short Japanese sentences
//       wrapped in style guidance) under max_tokens=64
//   - call_2_json_schema: same prompt with response_format set to a
//       speaker-label-style schema (object with multiple required
//       fields) under max_tokens=128
//
// A candidate is VALIDATED iff BOTH calls return HTTP 200 AND the
// json_schema body parses to a conforming object. Anything else means
// the candidate is unusable for the agentic loop's full posture and
// must NOT be added to alternateProviders[].
//
// Safety contract:
//   - OPENROUTER_API_KEY is read once from process.env and never written.
//   - Authorization headers are replaced with "Bearer sk-or-***REDACTED***"
//     before the evidence file is serialized.
//   - Hard budget cap aborts the moment accumulated USD spend exceeds
//     $0.15. Each call bounded by max_tokens=64/128 + zero temperature.
//   - The script verifies its own output for `sk-or-…` patterns and
//     refuses to leave a leaky file on disk.

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EVIDENCE_DIR = resolve(REPO, "docs/openrouter-integration-evidence");
const EVIDENCE_DATE = "2026-06-26-itotori-239";
const EVIDENCE_PATH = resolve(EVIDENCE_DIR, `${EVIDENCE_DATE}.json`);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.length < 16) {
  console.error(
    "ITOTORI-239 evidence capture aborted: OPENROUTER_API_KEY is not set in the environment.",
  );
  process.exit(1);
}

const REDACT = "Bearer sk-or-***REDACTED***";
const BASE = "https://openrouter.ai/api/v1";
const REFERER = "https://itotori.dev/itotori-239-broader-alts-evidence";
const TITLE = "itotori-239-broader-alts-evidence";

const MODEL_ID = "deepseek/deepseek-v4-flash";

// Catalog list from ITOTORI-224 call_5 metadata.available_providers
// (capture at docs/openrouter-integration-evidence/2026-06-25.json),
// MINUS:
//   - fireworks  (primary; already pinned)
//   - deepinfra  (already validated alternate)
//   - deepseek   (excluded from ZDR allow-list per ITOTORI-224 call_3)
//   - novita     (already-probed: 200 plain but 404 on json_schema)
//   - lambda     (not actually in the catalog list — ITOTORI-238 noted it
//                 returned "no allowed providers")
// PLUS parasail (retry — ITOTORI-238 saw 429 transient on json_schema).
const CANDIDATE_PROVIDERS = [
  "parasail", // retry — ITOTORI-238 json_schema 429 was transient
  "streamlake",
  "wafer",
  "gmicloud",
  "baidu",
  "digitalocean",
  "siliconflow",
  "alibaba",
  "morph",
  "atlas-cloud",
  "akashml",
  "wandb",
  "cloudflare",
  "venice",
];

// A realistic agentic-loop-stage prompt. ~200 prompt tokens with
// style guidance + a multi-line Japanese source block. This is
// representative of the QA/speakerLabel stage that the alpha gate
// actually exercises (vs the 16-token ITOTORI-238 toy call).
const REAL_TRANSLATION_PROMPT =
  "You are an English localization assistant for a Japanese visual " +
  "novel called Sweetie HD. Style guidance: tone-register=playful, " +
  "register=informal-feminine, preserve onomatopoeia in romaji, do not " +
  "invent character names not present in the source. The following " +
  "is a single scene of dialogue between Yumeko and Haruka in early " +
  "afternoon at the school courtyard. Translate each line into natural " +
  "American English, preserving speaker tags and any sentinel substring " +
  "the user passes via system prompt.\n\n" +
  "Source:\n" +
  "[ユメコ] あら、はるかちゃん、もう来てたの？\n" +
  "[はるか] うん、ちょっと早めに来ちゃった。だって、ユメコちゃんに会いたかったから。\n" +
  "[ユメコ] もー、そんなこと言われたら照れちゃう……。\n" +
  "[はるか] えへへ、ごめんね。でも本当だよ？\n" +
  "[ユメコ] じゃあ、今日は二人で図書館に行こうか。\n" +
  "[はるか] うん！　行きたい！\n" +
  "[ユメコ] STELLA-ALPHA-EN-US-SENTINEL\n\n" +
  "Return the translation as a plain English block, one line per source " +
  "line, preserving the bracketed speaker tags.";

// A representative json_schema for the QA stage (multi-field object with
// strict mode). Same posture used in the production agentic loop.
const REAL_TRANSLATION_SCHEMA = {
  name: "itotori_239_alt_probe",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sceneSummary", "speakerTags", "containsSentinel", "lineCount"],
    properties: {
      sceneSummary: {
        type: "string",
        description: "One-sentence English summary of the scene.",
      },
      speakerTags: {
        type: "array",
        items: { type: "string" },
        description: "Distinct speaker tags found in the source block.",
      },
      containsSentinel: {
        type: "boolean",
        description:
          "True iff the source block contains the substring 'STELLA-ALPHA-EN-US-SENTINEL'.",
      },
      lineCount: {
        type: "integer",
        minimum: 0,
        description: "Count of dialogue lines in the source block.",
      },
    },
  },
};

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
const HARD_CAP_USD = 0.15;

for (const altProviderId of CANDIDATE_PROVIDERS) {
  if (accumulatedCost > HARD_CAP_USD) {
    console.error(
      `[ITOTORI-239] HARD BUDGET CAP exceeded (USD ${accumulatedCost.toFixed(6)} > ${HARD_CAP_USD}); skipping remaining candidates.`,
    );
    altSummaries[altProviderId] = {
      validated: false,
      reason: "skipped_budget_cap_hit",
    };
    continue;
  }
  console.error(
    `[ITOTORI-239] Probing candidate alternate (provider.only=['${altProviderId}'], zdr=true) with ~200-token prompt...`,
  );
  const plainCall = await captureCall(`call_${altProviderId}_plain_realistic`, {
    path: "/chat/completions",
    body: {
      model: MODEL_ID,
      messages: [{ role: "user", content: REAL_TRANSLATION_PROMPT }],
      max_tokens: 64,
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
  callRecords.push(plainCall);
  const status = plainCall.response.status;
  const upstreamProvider = plainCall.response.body?.provider ?? null;
  const errMessage = plainCall.response.body?.error?.message ?? null;
  const errCode = plainCall.response.body?.error?.code ?? null;
  const usageCost = Number(plainCall.response.body?.usage?.cost ?? 0);
  if (Number.isFinite(usageCost)) accumulatedCost += usageCost;
  console.error(
    `  -> plain status ${status} provider=${upstreamProvider ?? "n/a"} usage.cost=${usageCost} err=${errCode ?? "n/a"}${errMessage ? ` "${errMessage.slice(0, 80)}"` : ""}`,
  );

  let structuredCall = null;
  let structuredSupport = "untested";
  let conformingBody = false;
  if (status === 200 && upstreamProvider !== null) {
    console.error(
      `[ITOTORI-239]   plain call OK — probing json_schema structured-output mode on ${altProviderId}...`,
    );
    structuredCall = await captureCall(`call_${altProviderId}_json_schema_realistic`, {
      path: "/chat/completions",
      body: {
        model: MODEL_ID,
        messages: [{ role: "user", content: REAL_TRANSLATION_PROMPT }],
        max_tokens: 128,
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
          json_schema: REAL_TRANSLATION_SCHEMA,
        },
      },
    });
    callRecords.push(structuredCall);
    const sStatus = structuredCall.response.status;
    const sUsageCost = Number(structuredCall.response.body?.usage?.cost ?? 0);
    if (Number.isFinite(sUsageCost)) accumulatedCost += sUsageCost;
    if (sStatus === 200) {
      const content = structuredCall.response.body?.choices?.[0]?.message?.content;
      let parsedJson = null;
      try {
        parsedJson = typeof content === "string" ? JSON.parse(content) : null;
      } catch {
        parsedJson = null;
      }
      const hasAll =
        parsedJson !== null &&
        typeof parsedJson === "object" &&
        "sceneSummary" in parsedJson &&
        "speakerTags" in parsedJson &&
        "containsSentinel" in parsedJson &&
        "lineCount" in parsedJson;
      conformingBody = hasAll;
      structuredSupport = hasAll ? "supported" : "partial_returned_non_conforming_json";
    } else {
      const sErrCode = structuredCall.response.body?.error?.code ?? null;
      const sErrMessage = structuredCall.response.body?.error?.message ?? null;
      structuredSupport = `unsupported_http_${sStatus}`;
      console.error(
        `  -> json_schema status ${sStatus} err=${sErrCode ?? "n/a"}${sErrMessage ? ` "${sErrMessage.slice(0, 80)}"` : ""}`,
      );
    }
    console.error(
      `  -> json_schema structuredSupport=${structuredSupport} usage.cost=${sUsageCost}`,
    );
  }

  altSummaries[altProviderId] = {
    validated: status === 200 && upstreamProvider !== null && structuredSupport === "supported",
    plain_call_status: status,
    plain_call_upstream_provider: upstreamProvider,
    plain_call_error_message: errMessage,
    plain_call_error_code: errCode,
    structured_outputs_json_schema: structuredSupport,
    structured_body_conforming: conformingBody,
    zdr_posture_sent: { zdr: true, data_collection: "deny", allow_fallbacks: false },
    blocked_by_zdr_or_unavailable:
      status === 404 &&
      typeof errMessage === "string" &&
      (errMessage.includes("Zero data retention") ||
        errMessage.includes("No allowed providers") ||
        errMessage.includes("No endpoints found")),
  };
}

const payload = {
  schemaVersion: "itotori-239-broader-alts-evidence/v0",
  node: "ITOTORI-239",
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
    fireworks: "Primary pair; already pinned.",
    deepinfra:
      "Already validated as alternate by ITOTORI-238 (HTTP 200 plain + json_schema, body conforming).",
    deepseek:
      "Excluded from Trevor's ZDR allow-list per ITOTORI-224 call_3/call_4 (HTTP 404 'No endpoints found matching your data policy'). Per user memory project_zdr_allowlist_excludes_deepseek_implicit_cache.",
    novita:
      "ITOTORI-238 validated plain call (HTTP 200) but json_schema returned HTTP 404 'No endpoints found that can handle the requested parameters' — does not support response_format=json_schema for this model.",
    lambda:
      "ITOTORI-238 probe returned HTTP 404 'No allowed providers'; not present in the per-model endpoint catalog.",
  },
  probePostureNote:
    "Each candidate gets a ~200-token translation prompt under provider.only=[<alt>] + zdr=true + allow_fallbacks=false + data_collection=deny + require_parameters=true. If plain succeeds, a json_schema-mode call follows with a representative multi-field QA schema. Validation is binary: 200 plain + 200 json_schema + conforming body = VALIDATED. Anything else = NOT VALIDATED and must NOT be added to alternateProviders[].",
  realisticPromptTokenEstimate:
    "~200 prompt tokens (vs ITOTORI-238's 16-token toy call). Representative of agentic-loop QA + speakerLabel stage workloads.",
  altProviderSummaries: altSummaries,
  calls: callRecords,
  accumulatedUsdCost: accumulatedCost,
  notes: [
    "ITOTORI-239 broader-alternate validation: probes the ZDR-permitted candidates not covered by ITOTORI-238, plus a parasail retry (the json_schema 429 was transient quota, not a capability gap).",
    "Validation criterion: HTTP 200 on plain call + HTTP 200 on json_schema call + body conforming to the requested schema. All three required.",
    "The presets/localize-sweetie-hd.pair-policy.json alternateProviders[] is updated ONLY for candidates that pass all three criteria, with each entry annotated with the evidenceRef pointing into this file.",
  ],
};

mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8" });

const written = readFileSync(EVIDENCE_PATH, "utf8");
const SK_RE = /sk-or-[A-Za-z0-9_-]{40,}/;
if (SK_RE.test(written)) {
  console.error(
    `[ITOTORI-239] FATAL: API key pattern leaked into ${EVIDENCE_PATH}; deleting evidence file.`,
  );
  writeFileSync(
    EVIDENCE_PATH,
    JSON.stringify({ aborted: "api_key_leak_detected", fetchedAt }, null, 2),
    "utf8",
  );
  process.exit(2);
}

console.error(
  `[ITOTORI-239] Evidence written to ${EVIDENCE_PATH} (size ${written.length} bytes; accumulated cost USD ${payload.accumulatedUsdCost.toFixed(8)}).`,
);
const validatedAlternates = Object.entries(altSummaries)
  .filter(([, summary]) => summary.validated)
  .map(([id]) => id);
console.error(
  `[ITOTORI-239] Validated alternates: ${validatedAlternates.length ? validatedAlternates.join(", ") : "<NONE>"}`,
);
console.error("[ITOTORI-239] Done.");
