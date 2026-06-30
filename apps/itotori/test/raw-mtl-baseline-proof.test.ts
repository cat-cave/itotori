import { describe, expect, it, vi } from "vitest";
import {
  assertProviderProofBundle,
  assertRawMtlBaselineProofArtifact,
  RawMtlBaselineProofValidationError,
} from "@itotori/localization-bridge-schema";
import { AccountZdrAssertionError } from "../src/providers/index.js";
import {
  RAW_MTL_BASELINE_LIVE_FLAG,
  readRawMtlBaselineFixture,
  runRawMtlBaselineProofCommand,
  runRecordedRawMtlBaselineProof,
} from "../src/raw-mtl-baseline-proof/index.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("raw-mtl-baseline proof (recorded mode)", () => {
  it("emits systemKind raw_mtl_baseline in the benchmark AND quality artifacts", async () => {
    const result = await runRecordedRawMtlBaselineProof();
    expect(result.status).toBe("passed");
    if (result.status !== "passed") throw new Error("expected pass");
    const artifact = result.artifact;
    expect(artifact.systemKind).toBe("raw_mtl_baseline");
    expect(artifact.benchmark.systemKind).toBe("raw_mtl_baseline");
    expect(artifact.quality.systemKind).toBe("raw_mtl_baseline");
    expect(artifact.mode).toBe("recorded");
    expect(artifact.proofId).toBe("raw-mtl-baseline-proof:recorded:raw-mtl-baseline-recorded-v0");
  });

  it("reuses the ITOTORI-116 ledger schema and copies its provenance verbatim", async () => {
    const result = await runRecordedRawMtlBaselineProof();
    if (result.status !== "passed") throw new Error("expected pass");
    const { artifact } = result;

    // The embedded bundle is validated by the SAME shared contract as a
    // structured-draft proof (one ledger + quality-report schema).
    expect(() => assertProviderProofBundle(artifact.baselineBundle)).not.toThrow();

    // Benchmark ledger == bundle ledger verbatim (no re-derived/fabricated cost).
    expect(artifact.benchmark.ledger).toEqual(artifact.baselineBundle.ledger);
    expect(artifact.benchmark.ledger).toHaveLength(2);
    expect(artifact.benchmark.ledger.map((row) => row.role)).toEqual(["draft", "qa"]);

    // Provider/route/cost/token/latency/prompt-hash provenance is present.
    const draftRow = artifact.benchmark.ledger[0]!;
    expect(draftRow).toMatchObject({
      modelId: "deepseek/deepseek-v4-flash",
      providerId: "fireworks",
      servedProvider: "fireworks",
      servedModel: "deepseek/deepseek-v4-flash",
      tokensIn: 36,
      tokensOut: 22,
      costAmount: "0.000010",
      costMicrosUsd: 10,
      zdr: true,
    });
    expect(draftRow.promptHash.startsWith("sha256:")).toBe(true);

    // Cost + routes are derived only from the ledger.
    expect(artifact.benchmark.totalCostMicrosUsd).toBe(10 + 18);
    expect(artifact.benchmark.servedRoutes).toEqual([
      "fireworks::deepseek/deepseek-v4-flash",
      "fireworks::deepseek/deepseek-v4-flash",
    ]);
  });

  it("seeded oracle can compare raw MTL baseline, Itotori draft, deterministic QA, and LLM QA", async () => {
    const result = await runRecordedRawMtlBaselineProof();
    if (result.status !== "passed") throw new Error("expected pass");
    const byId = new Map(
      result.artifact.quality.comparisons.map((entry) => [entry.comparisonId, entry]),
    );

    // All four required labels are present across the systemKind/detectorKind axes.
    expect([...byId.keys()].sort()).toEqual([
      "itotori_draft:llm_qa",
      "raw_mtl_baseline:deterministic_qa",
      "raw_mtl_baseline:llm_qa",
    ]);

    // raw-MTL baseline LLM-QA caught the seeded mistranslation only.
    expect(byId.get("raw_mtl_baseline:llm_qa")!.oracle).toMatchObject({
      recall: 0.5,
      matchedSeededDefectIds: ["seed-mistranslation-001"],
      falseNegativeSeededDefectIds: ["seed-tone-001"],
    });
    // Itotori draft LLM-QA caught the seeded tone defect only.
    expect(byId.get("itotori_draft:llm_qa")!.oracle).toMatchObject({
      recall: 0.5,
      matchedSeededDefectIds: ["seed-tone-001"],
      falseNegativeSeededDefectIds: ["seed-mistranslation-001"],
    });
    // Deterministic QA caught both seeds.
    expect(byId.get("raw_mtl_baseline:deterministic_qa")!.oracle).toMatchObject({
      recall: 1,
      precision: 1,
      matchedSeededDefectIds: ["seed-mistranslation-001", "seed-tone-001"],
    });
  });

  it("is deterministic across repeated recorded runs", async () => {
    const a = await runRecordedRawMtlBaselineProof();
    const b = await runRecordedRawMtlBaselineProof();
    if (a.status !== "passed" || b.status !== "passed") throw new Error("expected pass");
    expect(a.artifact).toEqual(b.artifact);
  });

  it("the emitted artifact passes its strict shared contract", async () => {
    const result = await runRecordedRawMtlBaselineProof();
    if (result.status !== "passed") throw new Error("expected pass");
    expect(() => assertRawMtlBaselineProofArtifact(result.artifact)).not.toThrow();
  });

  it("rejects a fabricated benchmark cost (cost cannot be faked)", async () => {
    const result = await runRecordedRawMtlBaselineProof();
    if (result.status !== "passed") throw new Error("expected pass");
    const tampered = clone(result.artifact);
    tampered.benchmark.totalCostMicrosUsd += 1;
    expect(() => assertRawMtlBaselineProofArtifact(tampered)).toThrow(
      RawMtlBaselineProofValidationError,
    );
  });

  it("rejects a benchmark ledger diverging from the embedded bundle ledger", async () => {
    const result = await runRecordedRawMtlBaselineProof();
    if (result.status !== "passed") throw new Error("expected pass");
    const tampered = clone(result.artifact);
    tampered.benchmark.ledger[0]!.servedProvider = "not-the-served-provider";
    expect(() => assertRawMtlBaselineProofArtifact(tampered)).toThrow(
      RawMtlBaselineProofValidationError,
    );
  });
});

describe("raw-mtl-baseline proof (live mode opt-in)", () => {
  it("skips without explicit opt-in and credentials", async () => {
    await expect(runRawMtlBaselineProofCommand({ mode: "live", env: {} })).resolves.toEqual({
      status: "skipped",
      mode: "live",
      reason: "missing_opt_in",
    });
    await expect(
      runRawMtlBaselineProofCommand({ mode: "live", env: { [RAW_MTL_BASELINE_LIVE_FLAG]: "1" } }),
    ).resolves.toEqual({ status: "skipped", mode: "live", reason: "missing_provider_credential" });
  });

  it("refuses opted-in live mode before any fetch without the ZDR account assertion", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    await expect(
      runRawMtlBaselineProofCommand({
        mode: "live",
        env: { [RAW_MTL_BASELINE_LIVE_FLAG]: "1", OPENROUTER_API_KEY: "test-key" },
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(AccountZdrAssertionError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a bounded live baseline against a mocked ZDR OpenRouter with real billed cost", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const isDraft = body.messages[0]!.content.includes("raw machine-translation baseline");
      const content = isDraft
        ? JSON.stringify({
            schemaVersion: "itotori.structured-translation-draft-output.v1",
            drafts: [
              {
                bridgeUnitId: "019ed064-0000-7000-8000-0000000000aa",
                sourceLocale: "ja-JP",
                targetLocale: "en-US",
                draftText: "hello traveler the gate is open now",
                protectedSpanRefs: [],
                citationRefs: [],
                agentRationale: "live mock raw-mtl baseline",
                confidenceFloor: "low",
              },
            ],
          })
        : JSON.stringify({
            schemaVersion: "itotori.structured-qa-finding-output.v1",
            findings: [],
          });
      return jsonResponse({
        id: "gen-raw-mtl-baseline",
        model: "deepseek/deepseek-v4-flash",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 30, completion_tokens: 18, total_tokens: 48, cost: 0.00001 },
        openrouter_metadata: {
          requested: "deepseek/deepseek-v4-flash",
          strategy: "direct",
          attempt: 0,
          endpoints: {
            available: [
              { provider: "Fireworks", model: "deepseek/deepseek-v4-flash", selected: true },
            ],
          },
        },
      });
    }) as unknown as typeof fetch;

    const result = await runRawMtlBaselineProofCommand({
      mode: "live",
      env: {
        [RAW_MTL_BASELINE_LIVE_FLAG]: "1",
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      },
      fetch: fetchMock,
    });

    expect(result.status).toBe("passed");
    if (result.status !== "passed") throw new Error("expected pass");
    const { artifact } = result;
    // Same artifact + ledger + quality schema as recorded mode, just live.
    expect(artifact.mode).toBe("live");
    expect(artifact.systemKind).toBe("raw_mtl_baseline");
    expect(() => assertRawMtlBaselineProofArtifact(artifact)).not.toThrow();
    expect(artifact.baselineBundle.zdr).toEqual({
      accountAssertion: "asserted",
      perRequestZdr: true,
    });
    expect(artifact.benchmark.ledger).toHaveLength(2);
    for (const row of artifact.benchmark.ledger) {
      expect(row.costAmount).toBe("0.00001");
      expect(row.tokensIn).toBe(30);
      expect(row.tokensOut).toBe(18);
      expect(row.servedProvider).toBe("fireworks");
    }
    // 2 calls: one draft, one QA (a single bounded unit).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("raw-mtl-baseline fixture", () => {
  it("loads the public baseline fixture with its deterministic-QA anchor", () => {
    const fixture = readRawMtlBaselineFixture();
    expect(fixture.fixtureId).toBe("raw-mtl-baseline-recorded-v0");
    expect(fixture.deterministicBaselineQa.findings).toHaveLength(2);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
