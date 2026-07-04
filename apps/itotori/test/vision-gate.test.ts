import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
  ProviderCost,
  ProviderRunRecord,
} from "../src/providers/index.js";
import {
  VisionGateRejectedError,
  VisionVerdictValidationError,
  assertVisionGatePassed,
  evaluateVisionGate,
  parseVisionVerdict,
  runVisionGate,
  runVisionGateCommand,
  type VisionVerdict,
} from "../src/render-gate/index.js";

// ---------------------------------------------------------------------------
// Fake vision provider — the fake-provider-in-tests pattern. The real vision
// call is LIVE-only + env-gated; the CI mechanism test must never make a
// billed call, so it drives the gate with canned content + a synthetic
// zero-cost provider run.
// ---------------------------------------------------------------------------

function goodVerdictJson(): string {
  return JSON.stringify({
    coherent: true,
    target_text_legible: true,
    redaction_correct: true,
    no_copyright_leak: true,
    notes: "real mansion background, readable localized line, intact frame",
  });
}

function fakeVisionProvider(
  content: string | null,
  options: { cost?: ProviderCost; upstreamProvider?: string; zdr?: boolean } = {},
): ModelProvider {
  const cost: ProviderCost = options.cost ?? {
    costKind: "zero",
    currency: "USD",
    amountUsd: "0",
    amountMicrosUsd: 0,
  };
  return {
    descriptor: {
      family: "fake",
      endpointFamily: "chat-completions",
      providerName: "fake-vision",
      defaultModelId: "fake-vision-model",
      capabilities: {
        structuredOutputs: {
          jsonSchema: "supported",
          jsonObject: "supported",
          toolCallArguments: "supported",
          plainJsonExtraction: "supported",
          preferredModes: ["plain_json"],
        },
        toolCalls: {
          support: "supported",
          parallelToolCalls: "unsupported",
          requiresSchemaPerRequest: false,
        },
        imageInput: { support: "supported", maxImagesPerRequest: 1 },
        routing: {
          providerRouting: "supported",
          modelFallbacks: "supported",
          presets: "supported",
          requireParameters: "supported",
          dataCollectionControl: "supported",
          zeroDataRetentionRouting: "supported",
        },
      },
    },
    async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
      const run: ProviderRunRecord = {
        runId: "fake-vision-run",
        taskKind: request.taskKind,
        startedAt: "1970-01-01T00:00:00.000Z",
        completedAt: "1970-01-01T00:00:01.000Z",
        latencyMs: 1000,
        status: "succeeded",
        provider: {
          providerFamily: "fake",
          endpointFamily: "chat-completions",
          providerName: "fake-vision",
          requestedModelId: request.modelId,
          requestedProviderId: request.providerId,
          actualModelId: request.modelId,
          ...(options.upstreamProvider === undefined
            ? {}
            : { upstreamProvider: options.upstreamProvider }),
        },
        structuredOutputMode: request.structuredOutput?.mode ?? "none",
        retryCount: 0,
        errorClasses: [],
        fallbackUsed: false,
        fallbackPlan: [request.modelId],
        tokenUsage: {
          tokenCountSource: "provider_reported",
          promptTokens: 800,
          completionTokens: 40,
        },
        cost,
        routingPosture: {
          order: [request.providerId],
          allow_fallbacks: true,
          data_collection: "deny",
          zdr: options.zdr ?? true,
          require_parameters: false,
        },
        usageResponseJson: { _fake_no_billing: true },
        prompt: request.prompt,
      };
      return { content, toolCalls: [], finishReason: "stop", providerRun: run };
    },
  };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe("parseVisionVerdict", () => {
  it("parses a clean JSON verdict", () => {
    const v = parseVisionVerdict(goodVerdictJson());
    expect(v).toEqual({
      coherent: true,
      target_text_legible: true,
      redaction_correct: true,
      no_copyright_leak: true,
      notes: "real mansion background, readable localized line, intact frame",
    });
  });

  it("tolerates code fences and surrounding prose but stays strict on the object", () => {
    const raw = "Here is my verdict:\n```json\n" + goodVerdictJson() + "\n```\nDone.";
    const v = parseVisionVerdict(raw);
    expect(v.coherent).toBe(true);
  });

  it("throws when a boolean field is missing", () => {
    const raw = JSON.stringify({
      coherent: true,
      target_text_legible: true,
      redaction_correct: true,
      // no_copyright_leak missing
      notes: "x",
    });
    expect(() => parseVisionVerdict(raw)).toThrow(VisionVerdictValidationError);
    expect(() => parseVisionVerdict(raw)).toThrow(/no_copyright_leak/);
  });

  it("throws when a field is the wrong type (string 'true' is not a boolean)", () => {
    const raw = JSON.stringify({
      coherent: "true",
      target_text_legible: true,
      redaction_correct: true,
      no_copyright_leak: true,
    });
    expect(() => parseVisionVerdict(raw)).toThrow(VisionVerdictValidationError);
  });

  it("throws on empty / non-JSON content", () => {
    expect(() => parseVisionVerdict("")).toThrow(VisionVerdictValidationError);
    expect(() => parseVisionVerdict("no json here")).toThrow(VisionVerdictValidationError);
    expect(() => parseVisionVerdict(null)).toThrow(VisionVerdictValidationError);
  });
});

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

const ALL_TRUE: VisionVerdict = {
  coherent: true,
  target_text_legible: true,
  redaction_correct: true,
  no_copyright_leak: true,
  notes: "",
};

describe("evaluateVisionGate", () => {
  it("PASSES on an all-true verdict", () => {
    expect(evaluateVisionGate(ALL_TRUE, { redactionMode: "on" })).toEqual({
      passed: true,
      failures: [],
    });
    expect(evaluateVisionGate(ALL_TRUE, { redactionMode: "off" })).toEqual({
      passed: true,
      failures: [],
    });
  });

  it("FAILS incoherent (the garbage-render case)", () => {
    const g = evaluateVisionGate({ ...ALL_TRUE, coherent: false }, { redactionMode: "off" });
    expect(g.passed).toBe(false);
    expect(g.failures).toContain("incoherent");
  });

  it("FAILS illegible target text (the EN-US tofu case)", () => {
    const g = evaluateVisionGate(
      { ...ALL_TRUE, target_text_legible: false },
      { redactionMode: "off" },
    );
    expect(g.passed).toBe(false);
    expect(g.failures).toContain("target_text_illegible");
  });

  it("FAILS wrong redaction", () => {
    const g = evaluateVisionGate(
      { ...ALL_TRUE, redaction_correct: false },
      { redactionMode: "on" },
    );
    expect(g.passed).toBe(false);
    expect(g.failures).toContain("redaction_incorrect");
  });

  it("gates copyright leak ONLY for a public (redaction on) frame", () => {
    const leaked = { ...ALL_TRUE, no_copyright_leak: false };
    // public frame: a leak fails the gate
    expect(evaluateVisionGate(leaked, { redactionMode: "on" }).failures).toContain(
      "copyright_leak",
    );
    // private full-fidelity frame: copyrighted art is expected → not gated
    expect(evaluateVisionGate(leaked, { redactionMode: "off" })).toEqual({
      passed: true,
      failures: [],
    });
  });
});

// ---------------------------------------------------------------------------
// runVisionGate mechanism (fake provider)
// ---------------------------------------------------------------------------

describe("runVisionGate (mechanism, fake provider)", () => {
  const baseArgs = {
    modelId: "qwen/qwen3-vl-235b-a22b-instruct",
    providerId: "parasail",
    framePng: PNG_BYTES,
    expectedText: "Fuu... it's a refreshing morning.",
    redactionMode: "off" as const,
    inputClassification: "synthetic_public" as ModelInvocationRequest["inputClassification"],
    maxPriceUsd: 0.02,
  };

  it("PASSES on a coherent all-true verdict and records the artifact", async () => {
    const provider = fakeVisionProvider(goodVerdictJson(), {
      upstreamProvider: "Parasail",
      zdr: true,
    });
    const result = await runVisionGate({ ...baseArgs, provider });
    expect(result.gate.passed).toBe(true);
    expect(() => assertVisionGatePassed(result)).not.toThrow();
    expect(result.artifact.schemaVersion).toBe("itotori.vision-gate-verdict.v0");
    expect(result.artifact.servedProviderId).toBe("Parasail");
    expect(result.artifact.requestedModelId).toBe("qwen/qwen3-vl-235b-a22b-instruct");
    expect(result.artifact.zdr).toBe(true);
    expect(result.artifact.expectedTextSha256).toMatch(/^sha256:/);
    expect(result.artifact.frameSha256).toMatch(/^sha256:/);
    // no raw expected text is stored in the artifact
    expect(JSON.stringify(result.artifact)).not.toContain("refreshing morning");
  });

  it("REJECTS an incoherent verdict (the gate catches garbage the metadata checks missed)", async () => {
    const garbage = JSON.stringify({
      coherent: false,
      target_text_legible: false,
      redaction_correct: true,
      no_copyright_leak: true,
      notes: "solid dark canvas, tofu boxes, no legible dialogue",
    });
    const provider = fakeVisionProvider(garbage, { upstreamProvider: "Parasail" });
    const result = await runVisionGate({ ...baseArgs, provider });
    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toEqual(
      expect.arrayContaining(["incoherent", "target_text_illegible"]),
    );
    expect(() => assertVisionGatePassed(result)).toThrow(VisionGateRejectedError);
  });

  it("records the REAL billed cost via cost-or-throw (never approximated)", async () => {
    const provider = fakeVisionProvider(goodVerdictJson(), {
      cost: { costKind: "billed", currency: "USD", amountUsd: "0.00001976", amountMicrosUsd: 20 },
    });
    const result = await runVisionGate({ ...baseArgs, provider });
    expect(result.artifact.costUsd).toBe("0.00001976");
    expect(result.artifact.costMicrosUsd).toBe(20);
  });

  it("propagates a malformed verdict as a validation error (fail-loud, no silent pass)", async () => {
    const provider = fakeVisionProvider("the frame looks fine to me");
    await expect(runVisionGate({ ...baseArgs, provider })).rejects.toThrow(
      VisionVerdictValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// command wiring (providerOverride bypasses the live path)
// ---------------------------------------------------------------------------

describe("runVisionGateCommand (render-validate wiring, fake provider)", () => {
  it("reads the frame, runs the gate, and reports rejected on a bad verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-gate-"));
    const framePath = join(dir, "frame.png");
    writeFileSync(framePath, Buffer.from(PNG_BYTES));
    try {
      return runVisionGateCommand({
        framePath,
        expectedText: "Fuu... it's a refreshing morning.",
        redactionMode: "off",
        inputClassification: "synthetic_public",
        providerOverride: fakeVisionProvider(
          JSON.stringify({
            coherent: false,
            target_text_legible: false,
            redaction_correct: true,
            no_copyright_leak: true,
            notes: "garbage",
          }),
        ),
      }).then((outcome) => {
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") throw new Error("expected rejected");
        expect(outcome.result.gate.failures).toContain("incoherent");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports passed on a coherent frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-gate-"));
    const framePath = join(dir, "frame.png");
    writeFileSync(framePath, Buffer.from(PNG_BYTES));
    try {
      const outcome = await runVisionGateCommand({
        framePath,
        expectedText: "Fuu... it's a refreshing morning.",
        redactionMode: "off",
        inputClassification: "synthetic_public",
        providerOverride: fakeVisionProvider(goodVerdictJson(), { upstreamProvider: "Parasail" }),
      });
      expect(outcome.status).toBe("passed");
      if (outcome.status !== "passed") throw new Error("expected passed");
      expect(outcome.result.artifact.servedProviderId).toBe("Parasail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
