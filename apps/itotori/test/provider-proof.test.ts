import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AccountZdrAssertionError } from "../src/providers/index.js";
import {
  PROVIDER_PROOF_LIVE_FLAG,
  PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS_CEILING,
  ProviderProofConfigurationError,
  readProviderProofFixture,
  recordedAttemptSource,
  runProviderProof,
  runProviderProofCommand,
  runRecordedProviderProof,
  type ProviderProofAttemptSource,
  type ProviderProofFixture,
} from "../src/provider-proof/index.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("provider-proof harness (recorded mode)", () => {
  it("accepts draft+QA over the public fixture with bounded schema-repair", async () => {
    const result = await runRecordedProviderProof();
    expect(result.status).toBe("passed");
    if (result.status !== "passed") {
      throw new Error("recorded proof should pass");
    }
    const bundle = result.bundle;
    expect(bundle.mode).toBe("recorded");
    expect(bundle.proofId).toBe("provider-proof:recorded:provider-proof-recorded-v0");
    expect(bundle.zdr).toEqual({ accountAssertion: "recorded_fixture", perRequestZdr: true });

    const draft = bundle.roles.find((r) => r.role === "draft")!;
    // bounded repair: attempt 0 rejected (missing confidenceFloor), attempt 1 accepted.
    expect(draft.terminalStatus).toBe("accepted");
    expect(draft.attempts).toHaveLength(2);
    expect(draft.attempts[0]).toMatchObject({
      attemptIndex: 0,
      retryState: "initial",
      retryReason: null,
      outcome: "rejected_schema_invalid",
      rejection: { rule: "required" },
    });
    expect(draft.attempts[1]).toMatchObject({
      attemptIndex: 1,
      retryState: "repair",
      retryReason: "schema_invalid:required",
      outcome: "accepted",
      rejection: null,
    });
    expect(draft.acceptedProviderProofId).toBe("recorded:pp-draft-attempt-1");

    const qa = bundle.roles.find((r) => r.role === "qa")!;
    expect(qa.terminalStatus).toBe("accepted");
    expect(qa.attempts).toHaveLength(1);

    // reject-before-record: ONE ledger row per accepted role (the rejected
    // draft attempt produced no row).
    expect(bundle.ledger).toHaveLength(2);
    expect(bundle.ledger.map((row) => row.providerProofId)).toEqual([
      "recorded:pp-draft-attempt-1",
      "recorded:pp-qa-attempt-0",
    ]);
    expect(bundle.ledger[0]).toMatchObject({
      role: "draft",
      tokensIn: 40,
      tokensOut: 28,
      costAmount: "0.000012",
      costMicrosUsd: 12,
      zdr: true,
    });
  });

  it("scores QA findings against the seeded oracle with FN/FP accounting", async () => {
    const result = await runRecordedProviderProof();
    if (result.status !== "passed") throw new Error("expected pass");
    expect(result.bundle.qaOracle).toEqual({
      seededDefectCount: 2,
      emittedFindingCount: 1,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 1,
      precision: 1,
      recall: 0.5,
      f1: 0.666667,
      severityCalibration: 1,
      matchedSeededDefectIds: ["seed-tone-001"],
      falseNegativeSeededDefectIds: ["seed-mistranslation-001"],
      falsePositiveBridgeUnitIds: [],
    });
  });

  it("is deterministic across repeated recorded runs", async () => {
    const a = await runRecordedProviderProof();
    const b = await runRecordedProviderProof();
    if (a.status !== "passed" || b.status !== "passed") throw new Error("expected pass");
    expect(a.bundle).toEqual(b.bundle);
  });

  it("matches the committed golden recorded proof bundle", async () => {
    const result = await runRecordedProviderProof();
    if (result.status !== "passed") throw new Error("expected pass");
    const golden = JSON.parse(
      readFileSync(
        new URL(
          "../../../fixtures/provider-proof/expected-recorded-proof-bundle.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(result.bundle).toEqual(golden);
  });

  it("uses IDENTICAL schema validation in recorded and live mode", async () => {
    const fixture = readProviderProofFixture();
    const source = recordedAttemptSource(fixture);
    const recorded = await runProviderProof({
      mode: "recorded",
      fixtureId: fixture.fixtureId,
      seededDefects: fixture.seededDefects,
      source,
      accountZdrAssertion: "recorded_fixture",
    });
    const live = await runProviderProof({
      mode: "live",
      fixtureId: fixture.fixtureId,
      seededDefects: fixture.seededDefects,
      source: recordedAttemptSource(fixture),
      accountZdrAssertion: "asserted",
    });
    // The validation outcome (accept/reject, item counts, rejection rules) is
    // identical; only the mode-derived proofId prefix + ZDR assertion differ.
    const stripPrefix = (bundle: typeof recorded) =>
      bundle.roles.map((role) => ({
        role: role.role,
        terminalStatus: role.terminalStatus,
        acceptedItemCount: role.acceptedItemCount,
        outcomes: role.attempts.map((a) => ({ outcome: a.outcome, rejection: a.rejection })),
      }));
    expect(stripPrefix(live)).toEqual(stripPrefix(recorded));
  });

  it("terminally rejects (no ledger row) when the schema-repair budget is exhausted", async () => {
    const fixture = clone(readProviderProofFixture());
    // Replace the draft's repair attempt with a SECOND invalid response.
    const invalid = clone(fixture.roles.draft.attempts[0]!);
    invalid.providerRun.runId = "pp-draft-attempt-1-invalid";
    fixture.roles.draft.attempts[1] = invalid;
    const result = await runProviderProof({
      mode: "recorded",
      fixtureId: fixture.fixtureId,
      seededDefects: fixture.seededDefects,
      source: recordedAttemptSource(fixture),
      accountZdrAssertion: "recorded_fixture",
    });
    const draft = result.roles.find((r) => r.role === "draft")!;
    expect(draft.terminalStatus).toBe("rejected_schema_invalid");
    expect(draft.attempts).toHaveLength(2);
    expect(draft.attempts.every((a) => a.outcome === "rejected_schema_invalid")).toBe(true);
    expect(draft.acceptedProviderProofId).toBeNull();
    // No draft ledger row; QA still accepted.
    expect(result.ledger.map((row) => row.role)).toEqual(["qa"]);
  });

  it("refuses an unbounded repair budget above the hard ceiling", async () => {
    const fixture = readProviderProofFixture();
    await expect(
      runProviderProof({
        mode: "recorded",
        fixtureId: fixture.fixtureId,
        seededDefects: fixture.seededDefects,
        source: recordedAttemptSource(fixture),
        maxRepairAttempts: PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS_CEILING + 1,
        accountZdrAssertion: "recorded_fixture",
      }),
    ).rejects.toBeInstanceOf(ProviderProofConfigurationError);
  });
});

describe("provider-proof harness (live mode opt-in)", () => {
  it("skips without explicit opt-in and credentials", async () => {
    await expect(runProviderProofCommand({ mode: "live", env: {} })).resolves.toEqual({
      status: "skipped",
      mode: "live",
      reason: "missing_opt_in",
    });
    await expect(
      runProviderProofCommand({ mode: "live", env: { [PROVIDER_PROOF_LIVE_FLAG]: "1" } }),
    ).resolves.toEqual({ status: "skipped", mode: "live", reason: "missing_provider_credential" });
  });

  it("refuses opted-in live mode before any fetch without the ZDR account assertion", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    await expect(
      runProviderProofCommand({
        mode: "live",
        env: { [PROVIDER_PROOF_LIVE_FLAG]: "1", OPENROUTER_API_KEY: "test-key" },
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(AccountZdrAssertionError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a bounded live proof against a mocked ZDR OpenRouter with real billed cost", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const isDraft = body.messages[0]!.content.includes("StructuredTranslationDraftOutput");
      const content = isDraft
        ? JSON.stringify({
            schemaVersion: "itotori.structured-translation-draft-output.v1",
            drafts: [
              {
                bridgeUnitId: "019ed064-0000-7000-8000-0000000000aa",
                sourceLocale: "ja-JP",
                targetLocale: "en-US",
                draftText: "Hello, traveler. The gate is now open.",
                protectedSpanRefs: [],
                citationRefs: [],
                agentRationale: "live mock draft",
                confidenceFloor: "medium",
              },
            ],
          })
        : JSON.stringify({
            schemaVersion: "itotori.structured-qa-finding-output.v1",
            findings: [],
          });
      return jsonResponse({
        id: "gen-provider-proof",
        model: "deepseek/deepseek-v4-flash",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 30, completion_tokens: 18, total_tokens: 48, cost: 0.00001 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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

    const result = await runProviderProofCommand({
      mode: "live",
      env: {
        [PROVIDER_PROOF_LIVE_FLAG]: "1",
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      },
      fetch: fetchMock,
    });

    expect(result.status).toBe("passed");
    if (result.status !== "passed") throw new Error("expected pass");
    expect(result.bundle.mode).toBe("live");
    expect(result.bundle.zdr).toEqual({ accountAssertion: "asserted", perRequestZdr: true });
    expect(result.bundle.ledger).toHaveLength(2);
    for (const row of result.bundle.ledger) {
      expect(row.costAmount).toBe("0.00001");
      expect(row.tokensIn).toBe(30);
      expect(row.tokensOut).toBe(18);
      expect(row.servedProvider).toBe("fireworks");
    }
    // 2 calls: one draft, one QA (a single bounded unit).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
