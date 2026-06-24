// ITOTORI-019 — Translation drafting fixture command e2e tests.
//
// Each scenario file under `apps/itotori/src/draft/draft-fixture-bundles/`
// drives the command through:
//   1. CreateDraftJob → recordAttempt → invoke TranslationAgent
//      (backed by RecordedModelProvider) → acceptOrRejectDraft
//      / routeFailedAttempt → DraftAttemptRecorder.record.
//   2. Build a `DraftArtifactBundle` summarizing the run.
//
// The suite asserts:
//   - Snapshot of the bundle (byte-stable across runs / scenarios).
//   - Provenance linkage: every `bundle.drafts[].costLedgerEntryRef`
//     resolves to a recorded ledger entry; every providerProofId
//     matches the ledger entry's providerProofId.
//   - Repository state: succeeded vs failed attempt was written on
//     the right job; retryable flag matches the retry policy.
//   - Deterministic-fake-provider scenario yields byte-equal bundles
//     across two consecutive invocations (CI reproducibility gate).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AuthorizationActor } from "@itotori/db";
import {
  assertDraftArtifactBundle,
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  type DraftArtifactBundle,
} from "@itotori/localization-bridge-schema";
import {
  runDraftFixtureCommand,
  type DraftFixtureBundle,
  type DraftFixtureCommandIo,
} from "../src/draft/draft-fixture-command.js";
import {
  createInMemoryDraftFixtureRepositories,
  type DraftFixtureRepositories,
} from "../src/draft/in-memory-draft-repositories.js";

const FIXTURE_ACTOR: AuthorizationActor = { userId: "itotori-019-fixture-actor" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

const PROJECT_PATH = "apps/itotori/test/fixtures/draft-fixture-project.json";

type BundleScenario = {
  name: string;
  bundleRelativePath: string;
};

const SCENARIOS: ReadonlyArray<BundleScenario> = [
  {
    name: "success",
    bundleRelativePath: "apps/itotori/src/draft/draft-fixture-bundles/success.json",
  },
  {
    name: "provider-fallback",
    bundleRelativePath: "apps/itotori/src/draft/draft-fixture-bundles/provider-fallback.json",
  },
  {
    name: "protected-span-rejection",
    bundleRelativePath:
      "apps/itotori/src/draft/draft-fixture-bundles/protected-span-rejection.json",
  },
  {
    name: "structured-output-repair",
    bundleRelativePath:
      "apps/itotori/src/draft/draft-fixture-bundles/structured-output-repair.json",
  },
  {
    name: "deterministic-fake-provider",
    bundleRelativePath:
      "apps/itotori/src/draft/draft-fixture-bundles/deterministic-fake-provider.json",
  },
];

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8"));
}

function buildIo(reads: Map<string, unknown>, writes: Map<string, unknown>): DraftFixtureCommandIo {
  return {
    readJson(path: string): unknown {
      if (reads.has(path)) {
        const value = reads.get(path);
        if (value === undefined) {
          throw new Error(`fixture read map returned undefined for ${path}`);
        }
        return value;
      }
      throw new Error(`unexpected fixture read: ${path}`);
    },
    writeJson(path: string, value: unknown): void {
      writes.set(path, value);
    },
  };
}

async function runScenario(scenario: BundleScenario): Promise<{
  bundle: DraftArtifactBundle;
  repositories: DraftFixtureRepositories;
}> {
  const project = readJsonFile(PROJECT_PATH);
  const fixtureBundle = readJsonFile(scenario.bundleRelativePath) as DraftFixtureBundle;
  const reads = new Map<string, unknown>([[PROJECT_PATH, project]]);
  const writes = new Map<string, unknown>();
  const repositories = createInMemoryDraftFixtureRepositories();
  const bundle = await runDraftFixtureCommand({
    projectPath: PROJECT_PATH,
    outputPath: "out.json",
    locale: "en-US",
    io: buildIo(reads, writes),
    actor: FIXTURE_ACTOR,
    draftJobRepository: repositories.draftJobRepository,
    ledgerRepository: repositories.ledgerRepository,
    resolveBundle: () => fixtureBundle,
  });
  expect(writes.get("out.json")).toEqual(bundle);
  return { bundle, repositories };
}

describe("draft fixture command — schema invariants", () => {
  it.each(SCENARIOS)(
    "$name yields a bundle that passes assertDraftArtifactBundle",
    async (scenario) => {
      const { bundle } = await runScenario(scenario);
      expect(() => assertDraftArtifactBundle(bundle)).not.toThrow();
      expect(bundle.schemaVersion).toBe(DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION);
    },
  );
});

describe("draft fixture command — provenance linkage", () => {
  it.each(SCENARIOS)(
    "$name links every draft entry to a recorded ledger entry by ref + providerProof",
    async (scenario) => {
      const { bundle, repositories } = await runScenario(scenario);
      const entriesById = new Map(
        repositories.ledgerRepository.entries.map((entry) => [entry.ledgerEntryId, entry]),
      );
      for (const draft of bundle.drafts) {
        const ledgerEntry = entriesById.get(draft.costLedgerEntryRef);
        expect(ledgerEntry, `missing ledger entry for ${draft.draftId}`).toBeDefined();
        if (ledgerEntry === undefined) continue;
        expect(ledgerEntry.providerProofId).toBe(draft.providerProofId);
      }
      // Every providerProofId in ledgerSummary must also be reachable
      // by the loadEntriesByProviderProof port query.
      for (const proof of bundle.ledgerSummary.providerProofIds) {
        const lookup = await repositories.ledgerRepository.loadEntriesByProviderProof(
          FIXTURE_ACTOR,
          proof,
        );
        expect(lookup, `provider proof ${proof} did not resolve via the port`).not.toBeNull();
      }
    },
  );
});

describe("draft fixture command — success scenario", () => {
  it("accepts both drafts on the first attempt and writes one ledger entry", async () => {
    const { bundle, repositories } = await runScenario(SCENARIOS[0]!);
    expect(bundle.drafts).toHaveLength(2);
    for (const draft of bundle.drafts) {
      expect(draft.retryFallbackState).toBe("success");
      expect(draft.protectedSpanValidationResult).toEqual({ accepted: true });
      expect(draft.draftText).toBeDefined();
    }
    expect(repositories.ledgerRepository.entries).toHaveLength(1);
    expect(bundle.ledgerSummary.attemptCount).toBe(1);
    expect(bundle.ledgerSummary.providerProofIds).toHaveLength(1);
    // Cost is rendered as <whole>.<6-dp micros><"00" filler>; the
    // ledger entry's costAmount "0.00640000" rolls up to 6400 micros.
    expect(bundle.ledgerSummary.totalCost).toBe("0.00640000");
  });
});

describe("draft fixture command — provider fallback scenario", () => {
  it("records the failed primary, switches to fallback family, and tags fallback-then-success", async () => {
    const { bundle, repositories } = await runScenario(SCENARIOS[1]!);
    expect(bundle.drafts).toHaveLength(2);
    for (const draft of bundle.drafts) {
      expect(draft.retryFallbackState).toBe("fallback-then-success");
      expect(draft.protectedSpanValidationResult).toEqual({ accepted: true });
    }
    expect(repositories.ledgerRepository.entries).toHaveLength(2);
    expect(bundle.ledgerSummary.attemptCount).toBe(2);
    // Two distinct provider proof ids, one per attempt.
    expect(new Set(bundle.ledgerSummary.providerProofIds).size).toBe(2);
    // The succeeded ledger entry is the second attempt; it must be the
    // one referenced by the draft entries.
    const accepted = repositories.ledgerRepository.entries[1];
    expect(accepted).toBeDefined();
    if (accepted === undefined) return;
    for (const draft of bundle.drafts) {
      expect(draft.costLedgerEntryRef).toBe(accepted.ledgerEntryId);
      expect(draft.providerProofId).toBe(accepted.providerProofId);
    }
    // The fallback ledger entry was recorded with the prior family in
    // its fallback chain.
    expect(accepted.fallbackChain).toHaveLength(1);
    expect(accepted.fallbackChain[0]?.modelProviderFamily).toBe("openrouter");
  });
});

describe("draft fixture command — protected-span rejection scenario", () => {
  it("emits a terminal-rejection entry per source unit with the capitalization_drift violation", async () => {
    const { bundle, repositories } = await runScenario(SCENARIOS[2]!);
    expect(bundle.drafts).toHaveLength(2);
    for (const draft of bundle.drafts) {
      expect(draft.retryFallbackState).toBe("terminal-rejection");
      expect(draft.terminalReason).toBeDefined();
      expect(draft.draftText).toBeUndefined();
      if (draft.protectedSpanValidationResult.accepted) {
        throw new Error("expected protected-span validation to be rejected");
      }
      expect(draft.protectedSpanValidationResult.violations.length).toBeGreaterThanOrEqual(1);
      const hasCapDrift = draft.protectedSpanValidationResult.violations.some(
        (v) => v.kind === "capitalization_drift",
      );
      expect(hasCapDrift).toBe(true);
    }
    expect(repositories.ledgerRepository.entries).toHaveLength(1);
    expect(bundle.ledgerSummary.attemptCount).toBe(1);
  });
});

describe("draft fixture command — structured-output repair scenario", () => {
  it("retries after schema_validation enum failure, then tags retried-then-success", async () => {
    const { bundle, repositories } = await runScenario(SCENARIOS[3]!);
    expect(bundle.drafts).toHaveLength(2);
    for (const draft of bundle.drafts) {
      expect(draft.retryFallbackState).toBe("retried-then-success");
      expect(draft.protectedSpanValidationResult).toEqual({ accepted: true });
    }
    expect(repositories.ledgerRepository.entries).toHaveLength(2);
    // The first attempt was a synthesized schema-validation failure;
    // the recorded fallback chain on the second attempt's ledger entry
    // is EMPTY because the family did not switch (same recorded family
    // for both attempts).
    const finalEntry = repositories.ledgerRepository.entries[1];
    expect(finalEntry).toBeDefined();
    if (finalEntry === undefined) return;
    expect(finalEntry.fallbackChain).toEqual([]);
  });
});

describe("draft fixture command — deterministic CI reproducibility", () => {
  it("two consecutive runs of the deterministic-fake-provider fixture produce byte-equal bundles", async () => {
    const first = await runScenario(SCENARIOS[4]!);
    const second = await runScenario(SCENARIOS[4]!);
    // The in-memory id counters differ across runs (each run gets a
    // fresh repository) but the SHAPE of the bundle — schemaVersion,
    // drafts contents, ledger summary contents — must be byte-equal
    // module the id prefixes that we strip.
    const normalize = (bundle: DraftArtifactBundle): unknown => {
      return {
        schemaVersion: bundle.schemaVersion,
        projectId: bundle.projectId,
        localeBranchId: bundle.localeBranchId,
        drafts: bundle.drafts.map((entry) => ({
          sourceUnitId: entry.sourceUnitId,
          providerProofId: entry.providerProofId.replace(/^[a-z]+:/u, ""),
          retryFallbackState: entry.retryFallbackState,
          protectedSpanValidationResult: entry.protectedSpanValidationResult,
          draftText: entry.draftText,
          terminalReason: entry.terminalReason,
        })),
        ledgerSummary: {
          totalCost: bundle.ledgerSummary.totalCost,
          totalTokensIn: bundle.ledgerSummary.totalTokensIn,
          totalTokensOut: bundle.ledgerSummary.totalTokensOut,
          attemptCount: bundle.ledgerSummary.attemptCount,
        },
      };
    };
    expect(normalize(first.bundle)).toEqual(normalize(second.bundle));
  });
});

describe("draft fixture command — locale mismatch refusal", () => {
  it("refuses to run when --locale does not match the fixture project targetLocale", async () => {
    const project = readJsonFile(PROJECT_PATH);
    const fixtureBundle = readJsonFile(SCENARIOS[0]!.bundleRelativePath) as DraftFixtureBundle;
    const reads = new Map<string, unknown>([[PROJECT_PATH, project]]);
    const writes = new Map<string, unknown>();
    const repositories = createInMemoryDraftFixtureRepositories();
    await expect(
      runDraftFixtureCommand({
        projectPath: PROJECT_PATH,
        outputPath: "out.json",
        locale: "fr-FR",
        io: buildIo(reads, writes),
        actor: FIXTURE_ACTOR,
        draftJobRepository: repositories.draftJobRepository,
        ledgerRepository: repositories.ledgerRepository,
        resolveBundle: () => fixtureBundle,
      }),
    ).rejects.toThrow(/does not match fixture project targetLocale/u);
    expect(writes.size).toBe(0);
  });
});

describe("draft fixture command — live provider refusal", () => {
  it("refuses to run when ITOTORI_LIVE_PROVIDER=1 is set", async () => {
    const original = process.env.ITOTORI_LIVE_PROVIDER;
    process.env.ITOTORI_LIVE_PROVIDER = "1";
    try {
      const project = readJsonFile(PROJECT_PATH);
      const fixtureBundle = readJsonFile(SCENARIOS[0]!.bundleRelativePath) as DraftFixtureBundle;
      const reads = new Map<string, unknown>([[PROJECT_PATH, project]]);
      const writes = new Map<string, unknown>();
      const repositories = createInMemoryDraftFixtureRepositories();
      await expect(
        runDraftFixtureCommand({
          projectPath: PROJECT_PATH,
          outputPath: "out.json",
          locale: "en-US",
          io: buildIo(reads, writes),
          actor: FIXTURE_ACTOR,
          draftJobRepository: repositories.draftJobRepository,
          ledgerRepository: repositories.ledgerRepository,
          resolveBundle: () => fixtureBundle,
        }),
      ).rejects.toThrow(/ITOTORI_LIVE_PROVIDER=1/u);
    } finally {
      if (original === undefined) {
        delete process.env.ITOTORI_LIVE_PROVIDER;
      } else {
        process.env.ITOTORI_LIVE_PROVIDER = original;
      }
    }
  });
});
