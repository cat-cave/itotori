// visual-inspection-gate-for-all-render-nodes — the eyes-on-pixels gate.
//
// WHY THIS EXISTS (the whole point): metadata checks (redaction flag,
// line-counts, blank-guard pixels>0) did NOT catch a garbage render (a
// solid/near-solid canvas with EN-US tofu boxes and no legible dialogue).
// Only VIEWING the pixels caught it. This module encodes "an orchestrator
// looked at the frame" as a pipeline MECHANISM: a rendered proof frame is
// sent to a vision-capable model via the existing ZDR-routed OpenRouter
// path, which returns a STRUCTURED verdict; the render proof FAILS when the
// verdict marks the frame incoherent / target-text-illegible / redaction-
// wrong. There is no parallel HTTP path — the call goes through the same
// `OpenRouterProvider` (real (model, providerId) pair, `usage.cost`-or-throw,
// per-request `provider.zdr=true`) the drafting path uses.

import { createHash } from "node:crypto";
import { executeModelInvocation } from "../orchestrator/invocation-supervisor.js";
import {
  assertBilledCost,
  openRouterDefaultCapabilities,
  type JsonObject,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelProvider,
  type ProviderRunRecord,
} from "../providers/index.js";

export const VISION_GATE_VERDICT_SCHEMA_VERSION = "itotori.vision-gate-verdict.v0" as const;

/**
 * The redaction posture the frame was emitted under (mirrors the utsushi
 * render-validate `--redaction on|off` toggle). `on` = a PUBLIC frame whose
 * copyright-sensitive regions are masked; `off` = a PRIVATE full-fidelity
 * frame (uncommitted, e.g. under /scratch or .private-render).
 */
export type RedactionMode = "on" | "off";

/**
 * The structured verdict the vision model returns. Every field is
 * load-bearing for the gate except `notes` (free-form rationale).
 *
 *  - coherent: the frame shows a real, composited scene (background art +
 *    UI), NOT a solid/near-solid fill, blank canvas, or noise.
 *  - target_text_legible: the expected localized (target-language) text is
 *    present and readable — NOT tofu/mojibake boxes, NOT clipped, NOT the
 *    wrong script.
 *  - redaction_correct: the frame matches the declared redaction mode —
 *    for `on`, the copyright-sensitive regions are masked; for `off`, the
 *    full-fidelity frame is intact/unmasked.
 *  - no_copyright_leak: for a PUBLIC (redaction `on`) frame, no copyrighted
 *    source art or source-language text is visible. (Not gated for a private
 *    `off` frame, which legitimately shows full-fidelity copyrighted art.)
 *  - notes: short free-form rationale from the model.
 */
export type VisionVerdict = {
  coherent: boolean;
  target_text_legible: boolean;
  redaction_correct: boolean;
  no_copyright_leak: boolean;
  notes: string;
};

const VERDICT_BOOLEAN_FIELDS = [
  "coherent",
  "target_text_legible",
  "redaction_correct",
  "no_copyright_leak",
] as const;

/** Thrown when the vision model's response cannot be parsed into a strict verdict. */
export class VisionVerdictValidationError extends Error {
  constructor(
    readonly rule: string,
    readonly detail: string,
  ) {
    super(`vision verdict invalid (${rule}): ${detail}`);
    this.name = "VisionVerdictValidationError";
  }
}

/** Thrown when the gate REJECTS a frame (the eyes-on-pixels check failed). */
export class VisionGateRejectedError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`vision gate REJECTED the frame: ${failures.join(", ")}`);
    this.name = "VisionGateRejectedError";
  }
}

/**
 * Extract the first balanced top-level JSON object from a model response and
 * strict-parse it into a {@link VisionVerdict}. Tolerates surrounding prose
 * and ```json fences (plain-JSON extraction mode is provider-robust under
 * ZDR — no `response_format` on the wire), but is STRICT about the object
 * itself: every boolean field must be a real boolean, `notes` a string.
 * A missing/mistyped field throws rather than silently defaulting — a gate
 * that guessed would defeat its purpose.
 */
export function parseVisionVerdict(content: string | null): VisionVerdict {
  if (content === null || content.trim().length === 0) {
    throw new VisionVerdictValidationError("empty", "model returned no content");
  }
  const objectText = extractFirstJsonObject(content);
  if (objectText === undefined) {
    throw new VisionVerdictValidationError(
      "no_json_object",
      "response did not contain a JSON object",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch (error) {
    throw new VisionVerdictValidationError(
      "json_parse",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VisionVerdictValidationError("type", "verdict must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  for (const field of VERDICT_BOOLEAN_FIELDS) {
    if (typeof record[field] !== "boolean") {
      throw new VisionVerdictValidationError(
        "required",
        `field '${field}' must be a boolean (got ${describeType(record[field])})`,
      );
    }
  }
  if (record.notes !== undefined && typeof record.notes !== "string") {
    throw new VisionVerdictValidationError(
      "type",
      `field 'notes' must be a string when present (got ${describeType(record.notes)})`,
    );
  }
  return {
    coherent: record.coherent as boolean,
    target_text_legible: record.target_text_legible as boolean,
    redaction_correct: record.redaction_correct as boolean,
    no_copyright_leak: record.no_copyright_leak as boolean,
    notes: typeof record.notes === "string" ? record.notes : "",
  };
}

export type VisionGateEvaluation = {
  passed: boolean;
  failures: string[];
};

/**
 * The gate. A frame PASSES only when the human-equivalent visual checks all
 * hold. Failure codes are structured (not prose) so an audit can key on them:
 *
 *  - `incoherent`             — not a real composited scene (the garbage case).
 *  - `target_text_illegible`  — localized text missing/unreadable/tofu.
 *  - `redaction_incorrect`    — frame does not match the declared redaction mode.
 *  - `copyright_leak`         — PUBLIC (`on`) frame shows copyrighted source art/text.
 *
 * `no_copyright_leak` is only gated for a PUBLIC frame (`redactionMode:"on"`):
 * a PRIVATE full-fidelity frame (`off`) legitimately shows copyrighted art,
 * so gating it there would be wrong.
 */
export function evaluateVisionGate(
  verdict: VisionVerdict,
  options: { redactionMode: RedactionMode },
): VisionGateEvaluation {
  const failures: string[] = [];
  if (!verdict.coherent) {
    failures.push("incoherent");
  }
  if (!verdict.target_text_legible) {
    failures.push("target_text_illegible");
  }
  if (!verdict.redaction_correct) {
    failures.push("redaction_incorrect");
  }
  if (options.redactionMode === "on" && !verdict.no_copyright_leak) {
    failures.push("copyright_leak");
  }
  return { passed: failures.length === 0, failures };
}

/**
 * Capability sheet for the ZDR vision pair. The default OpenRouter sheet
 * marks `imageInput` UNTESTED, which the invoke-time guard refuses — the
 * gate needs it SUPPORTED (verified live: qwen3-vl accepts image input via
 * a ZDR provider). Structured output uses `plain_json` extraction (no
 * `response_format` on the wire) which is the provider-robust mode under
 * ZDR routing, so `plainJsonExtraction` stays supported.
 */
export function visionGateCapabilities(): ModelCapabilities {
  return {
    ...openRouterDefaultCapabilities,
    imageInput: { support: "supported", maxImagesPerRequest: 1 },
    structuredOutputs: {
      ...openRouterDefaultCapabilities.structuredOutputs,
      plainJsonExtraction: "supported",
      preferredModes: ["plain_json"],
    },
    routing: {
      ...openRouterDefaultCapabilities.routing,
      providerRouting: "supported",
      dataCollectionControl: "supported",
      zeroDataRetentionRouting: "supported",
    },
  };
}

const VISION_GATE_SYSTEM_PROMPT =
  "You are a strict visual-QA inspector for a localized visual-novel render. " +
  "You are shown ONE rendered frame plus the localized target-language text that " +
  "SHOULD appear in it and the redaction mode it was emitted under. Judge ONLY " +
  "what the pixels actually show — do not assume, do not be charitable. Return " +
  "ONLY a single JSON object (no markdown, no prose outside it) with EXACTLY " +
  "these keys: coherent (boolean: true iff the frame shows a real composited " +
  "scene with background art and UI, false if it is a solid/near-solid fill, a " +
  "blank/dark canvas, noise, or has no legible content), target_text_legible " +
  "(boolean: true iff the expected localized text is present and readable — " +
  "false if it is tofu/box glyphs, mojibake, the wrong script, clipped, or " +
  "absent), redaction_correct (boolean: for redaction 'on' true iff the " +
  "copyright-sensitive regions are masked; for 'off' true iff the frame is " +
  "intact and unmasked), no_copyright_leak (boolean: true iff NO copyrighted " +
  "source-language text or source art is exposed that should have been " +
  "redacted; for a private 'off' frame this is true when nothing was required " +
  "to be redacted), and notes (a short string explaining your judgment). " +
  "Base every field strictly on the visible pixels.";

export type VisionGateRequestArgs = {
  modelId: string;
  providerId: string;
  /** `data:image/png;base64,...` URL for the rendered frame. */
  framePngDataUrl: string;
  /** The localized target-language text expected to appear (model input only). */
  expectedText: string;
  redactionMode: RedactionMode;
  /**
   * Provider input classification. A real game frame is PRIVATE
   * (`private_corpus`), which — combined with `routing.zdr=true` on the
   * provider — forces `provider.zdr=true` on the wire (the ZDR gate). Tests
   * may pass `synthetic_public`.
   */
  inputClassification: ModelInvocationRequest["inputClassification"];
  /** Per-request USD ceiling mirrored to `provider.max_price.request`. */
  maxPriceUsd: number;
  /** Deterministic prompt identity for the ledger/artifact. */
  promptHash: string;
};

/**
 * Build the `ModelInvocationRequest` for the vision verdict. The frame is an
 * `image_url` content part (a base64 data URL); the user text carries the
 * expected localized text + redaction mode so the model can check legibility
 * and redaction against ground truth. Plain-JSON extraction mode keeps the
 * wire free of `response_format` (ZDR-robust); the strict parse happens in
 * {@link parseVisionVerdict}.
 */
export function buildVisionVerdictRequest(args: VisionGateRequestArgs): ModelInvocationRequest {
  return {
    taskKind: "llm_qa",
    modelId: args.modelId,
    providerId: args.providerId,
    inputClassification: args.inputClassification,
    messages: [
      { role: "system", content: VISION_GATE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Redaction mode: ${args.redactionMode}.\n` +
              `Expected localized target-language text in this frame:\n` +
              `<<<\n${args.expectedText}\n>>>\n` +
              `Inspect the frame below and return the JSON verdict.`,
          },
          { type: "image_url", imageUrl: args.framePngDataUrl, detail: "high" },
        ],
      },
    ],
    structuredOutput: { mode: "plain_json" },
    generation: { temperature: 0, maxOutputTokens: 600 },
    maxPriceUsd: args.maxPriceUsd,
    prompt: {
      presetId: "itotori-vision-gate",
      templateVersion: "1.0.0",
      promptHash: args.promptHash,
      schemaVersion: "itotori.prompt-preset.v0",
      configSnapshot: { redactionMode: args.redactionMode },
    },
    fallbackModels: [],
  };
}

/**
 * The recorded verdict artifact — emitted ALONGSIDE render-evidence. It
 * carries the same real-cost discipline as the drafting path: the served
 * (model, providerId) pair read verbatim from the response, the real
 * `usage.cost` (cost-or-throw via {@link assertBilledCost}, NEVER
 * approximated), and the ZDR posture. Copyright note: `expectedText` is NOT
 * stored (only its sha256); the frame is identified by sha256 + byte length,
 * never inlined. The `verdict.notes` string CAN contain the model's rationale
 * — write this artifact to a PRIVATE/uncommitted location for real frames.
 */
export type VisionGateArtifact = {
  schemaVersion: typeof VISION_GATE_VERDICT_SCHEMA_VERSION;
  frameSha256: string;
  frameByteLength: number;
  redactionMode: RedactionMode;
  expectedTextSha256: string;
  verdict: VisionVerdict;
  gate: VisionGateEvaluation;
  requestedModelId: string;
  requestedProviderId: string;
  servedModelId: string;
  servedProviderId: string | null;
  structuredOutputMode: string;
  tokensIn: number | null;
  tokensOut: number | null;
  tokenCountSource: string;
  costUsd: string;
  costMicrosUsd: number;
  latencyMs: number;
  zdr: boolean;
  promptHash: string;
};

export type VisionGateResult = {
  verdict: VisionVerdict;
  gate: VisionGateEvaluation;
  providerRun: ProviderRunRecord;
  artifact: VisionGateArtifact;
};

export type RunVisionGateArgs = {
  provider: ModelProvider;
  modelId: string;
  providerId: string;
  /** Raw PNG bytes of the rendered frame. */
  framePng: Uint8Array;
  expectedText: string;
  redactionMode: RedactionMode;
  inputClassification: ModelInvocationRequest["inputClassification"];
  maxPriceUsd: number;
};

/**
 * Run the vision gate end to end: build the request, invoke the (ZDR-routed)
 * provider, strict-parse the verdict, evaluate the gate, and assemble the
 * recorded artifact with the REAL served pair + `usage.cost` + ZDR posture.
 * Does NOT throw on a REJECT verdict — the caller decides (see
 * {@link assertVisionGatePassed}) so the verdict is always recordable.
 */
export async function runVisionGate(args: RunVisionGateArgs): Promise<VisionGateResult> {
  const frameSha256 = sha256Bytes(args.framePng);
  const expectedTextSha256 = sha256Text(args.expectedText);
  const framePngDataUrl = pngDataUrl(args.framePng);
  const promptHash = sha256Text(
    `vision-gate:${args.modelId}:${args.providerId}:${args.redactionMode}:${frameSha256}:${expectedTextSha256}`,
  );

  const request = buildVisionVerdictRequest({
    modelId: args.modelId,
    providerId: args.providerId,
    framePngDataUrl,
    expectedText: args.expectedText,
    redactionMode: args.redactionMode,
    inputClassification: args.inputClassification,
    maxPriceUsd: args.maxPriceUsd,
    promptHash,
  });

  const result = await executeModelInvocation(args.provider, request);
  const verdict = parseVisionVerdict(result.content);
  const gate = evaluateVisionGate(verdict, { redactionMode: args.redactionMode });

  const run = result.providerRun;
  // cost-or-throw: a `billed` cost with no real amount throws here; a genuine
  // zero-cost (fake/test) call returns 0. Never approximated.
  const costMicrosUsd = Number(assertBilledCost(run.cost));

  const artifact: VisionGateArtifact = {
    schemaVersion: VISION_GATE_VERDICT_SCHEMA_VERSION,
    frameSha256,
    frameByteLength: args.framePng.byteLength,
    redactionMode: args.redactionMode,
    expectedTextSha256,
    verdict,
    gate,
    requestedModelId: run.provider.requestedModelId,
    requestedProviderId: run.provider.requestedProviderId,
    servedModelId: run.provider.actualModelId,
    servedProviderId: run.provider.upstreamProvider ?? null,
    structuredOutputMode: run.structuredOutputMode,
    tokensIn: run.tokenUsage.promptTokens ?? null,
    tokensOut: run.tokenUsage.completionTokens ?? null,
    tokenCountSource: run.tokenUsage.tokenCountSource,
    costUsd: run.cost.amountUsd,
    costMicrosUsd,
    latencyMs: run.latencyMs,
    zdr: run.routingPosture.zdr,
    promptHash,
  };

  return { verdict, gate, providerRun: run, artifact };
}

/** Fail-loud enforcement: throw {@link VisionGateRejectedError} on a REJECT. */
export function assertVisionGatePassed(result: VisionGateResult): void {
  if (!result.gate.passed) {
    throw new VisionGateRejectedError(result.gate.failures);
  }
}

/** A sanitized one-line summary safe to print (no raw text, no key). */
export function visionGateSummary(artifact: VisionGateArtifact): JsonObject {
  return {
    schemaVersion: artifact.schemaVersion,
    frameSha256: artifact.frameSha256,
    redactionMode: artifact.redactionMode,
    gate: { passed: artifact.gate.passed, failures: artifact.gate.failures },
    verdict: {
      coherent: artifact.verdict.coherent,
      target_text_legible: artifact.verdict.target_text_legible,
      redaction_correct: artifact.verdict.redaction_correct,
      no_copyright_leak: artifact.verdict.no_copyright_leak,
    },
    servedRoute: `${artifact.servedProviderId ?? "?"}::${artifact.servedModelId}`,
    requestedRoute: `${artifact.requestedProviderId}::${artifact.requestedModelId}`,
    costUsd: artifact.costUsd,
    zdr: artifact.zdr,
  } as JsonObject;
}

function pngDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/**
 * Scan for the first balanced top-level `{...}` (brace-aware, string-aware so
 * braces inside JSON string literals don't miscount). Returns undefined when
 * no complete object is present.
 */
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}
