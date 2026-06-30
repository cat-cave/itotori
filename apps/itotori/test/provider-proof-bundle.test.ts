// ALPHA-008 — sanitized provider-proof bundle: builder, renderer, fallback
// fixture, recorded/live parity, and CLI command regression suite.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertAlphaProviderProofSummary } from "@itotori/localization-bridge-schema";
import { README_BANNED_CLAIM_TERMS } from "../src/alpha-readiness/index.js";
import {
  buildAlphaProviderProofSummary,
  readProviderProofFixture,
  recordedAttemptSource,
  renderReadmeSafeProviderProofSummary,
  runProviderProof,
  runRecordedProviderProof,
} from "../src/provider-proof/index.js";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";

const FALLBACK_FIXTURE_PATH = fileURLToPath(
  new URL("../../../fixtures/provider-proof/recorded-fallback-proof-input.json", import.meta.url),
);

async function recordedSummary() {
  const result = await runRecordedProviderProof();
  if (result.status !== "passed") throw new Error("expected pass");
  return buildAlphaProviderProofSummary(result.bundle);
}

describe("alpha provider-proof summary (builder)", () => {
  it("projects the recorded bundle into validated structured-output + cost evidence", async () => {
    const summary = await recordedSummary();
    // The producer validates its own shape; assert it again from the test.
    expect(() => assertAlphaProviderProofSummary(summary)).not.toThrow();

    expect(summary.mode).toBe("recorded");
    expect(summary.dataPolicy).toEqual({
      zdrAccountAssertion: "recorded_fixture",
      perRequestZdr: true,
      allLedgerRoutesZdr: true,
    });

    // Structured-output support evidence: both roles accepted strict-schema output.
    const support = Object.fromEntries(
      summary.structuredOutputSupport.map((entry) => [entry.role, entry]),
    );
    expect(support.draft?.accepted).toBe(true);
    expect(support.qa?.accepted).toBe(true);
    expect(support.draft?.structuredOutputMode).toBe("json_object");
    expect(support.draft?.acceptedOutputHash).toMatch(/^sha256:[a-f0-9]{64}$/u);

    // Cost is summed from the real ledger; USD is exactly micros / 1e6.
    expect(summary.cost.rows).toHaveLength(2);
    const expectedMicros = summary.cost.rows.reduce((sum, row) => sum + row.costMicrosUsd, 0);
    expect(summary.cost.totalMicrosUsd).toBe(expectedMicros);
    expect(summary.cost.totalUsd).toBe(expectedMicros / 1e6);

    // Redaction guarantee is the literal false on every inclusion flag.
    expect(summary.redaction.rawPromptsIncluded).toBe(false);
    expect(summary.redaction.rawResponsesIncluded).toBe(false);
    expect(summary.redaction.apiKeysIncluded).toBe(false);
    expect(summary.redaction.privateCorpusTextIncluded).toBe(false);

    // No fallback on the default fixture: served provider == preferred head.
    for (const route of summary.servedRoutes) {
      expect(route.fallbackOccurred).toBe(false);
    }
  });

  it("surfaces OR-side fallback as data from the recorded fallback fixture", async () => {
    const fixture = readProviderProofFixture(FALLBACK_FIXTURE_PATH);
    const bundle = await runProviderProof({
      mode: "recorded",
      fixtureId: fixture.fixtureId,
      seededDefects: fixture.seededDefects,
      source: recordedAttemptSource(fixture),
      accountZdrAssertion: "recorded_fixture",
    });
    const summary = buildAlphaProviderProofSummary(bundle);

    const byRole = Object.fromEntries(summary.servedRoutes.map((route) => [route.role, route]));
    // Draft kept the preferred provider; QA fell back fireworks -> deepinfra.
    expect(byRole.draft?.servedProvider).toBe("fireworks");
    expect(byRole.draft?.fallbackOccurred).toBe(false);
    expect(byRole.qa?.fallbackChain).toEqual(["fireworks", "deepinfra"]);
    expect(byRole.qa?.servedProvider).toBe("deepinfra");
    expect(byRole.qa?.fallbackOccurred).toBe(true);
    // The fallback served route is still ZDR-enforced (fallback confined to ZDR).
    expect(summary.dataPolicy.allLedgerRoutesZdr).toBe(true);
  });
});

describe("alpha provider-proof summary (recorded/live parity)", () => {
  it("derives an identical evidence shape from recorded and live bundles (mode aside)", async () => {
    const fixture = readProviderProofFixture();
    const recorded = buildAlphaProviderProofSummary(
      await runProviderProof({
        mode: "recorded",
        fixtureId: fixture.fixtureId,
        seededDefects: fixture.seededDefects,
        source: recordedAttemptSource(fixture),
        accountZdrAssertion: "recorded_fixture",
      }),
    );
    const live = buildAlphaProviderProofSummary(
      await runProviderProof({
        mode: "live",
        fixtureId: fixture.fixtureId,
        seededDefects: fixture.seededDefects,
        source: recordedAttemptSource(fixture),
        accountZdrAssertion: "asserted",
      }),
    );
    // Structured-output support + fallback chains are identical; only the
    // mode-derived proofId prefix + ZDR account assertion differ.
    expect(live.structuredOutputSupport).toEqual(recorded.structuredOutputSupport);
    expect(live.servedRoutes.map((r) => ({ ...r, acceptedProviderProofId: null }))).toEqual(
      recorded.servedRoutes.map((r) => ({ ...r, acceptedProviderProofId: null })),
    );
    expect(live.mode).toBe("live");
    expect(live.dataPolicy.zdrAccountAssertion).toBe("asserted");
    expect(recorded.dataPolicy.zdrAccountAssertion).toBe("recorded_fixture");
  });
});

describe("alpha provider-proof summary (README-safe renderer)", () => {
  it("renders facts only, no banned claim term, and no raw payload", async () => {
    const summary = await recordedSummary();
    const markdown = renderReadmeSafeProviderProofSummary(summary);
    const lower = markdown.toLowerCase();
    for (const term of README_BANNED_CLAIM_TERMS) {
      expect(lower).not.toContain(term);
    }
    expect(markdown).toContain("# Provider proof bundle (sanitized)");
    expect(markdown).toContain("Data policy (ZDR) flags");
    expect(markdown).toContain("Structured-output support evidence");
    // No raw prompt/response text leaks into the render.
    expect(markdown).not.toContain("Hello, traveler");
    expect(markdown).not.toContain("agentRationale");
    expect(markdown).not.toContain("recommendation");
  });
});

describe("alpha provider-proof bundle (CLI command)", () => {
  function cliDependencies(io: {
    writeJson(p: string, v: unknown): void;
    writeText(p: string, c: string): void;
  }): ItotoriCliDependencies {
    return {
      io: {
        readJson: () => {
          throw new Error("provider-proof-bundle must not read project JSON");
        },
        writeJson: io.writeJson,
        writeText: io.writeText,
      },
      migrateDatabase: async () => {},
      withServices: async () => {
        throw new Error("provider-proof-bundle must not require database services");
      },
    } as unknown as ItotoriCliDependencies;
  }

  it("writes a validated summary JSON + README-safe Markdown in recorded mode", async () => {
    const jsonWrites = new Map<string, unknown>();
    const textWrites = new Map<string, string>();
    await runItotoriCliCommand(
      [
        "provider-proof-bundle",
        "--output",
        "artifacts/test/provider-proof-bundle/summary.json",
        "--markdown-output",
        "artifacts/test/provider-proof-bundle/README.md",
      ],
      cliDependencies({
        writeJson: (p, v) => jsonWrites.set(p, v),
        writeText: (p, c) => textWrites.set(p, c),
      }),
    );
    const summary = jsonWrites.get("artifacts/test/provider-proof-bundle/summary.json");
    expect(() => assertAlphaProviderProofSummary(summary)).not.toThrow();
    expect(textWrites.get("artifacts/test/provider-proof-bundle/README.md")).toContain(
      "# Provider proof bundle (sanitized)",
    );
  });
});
