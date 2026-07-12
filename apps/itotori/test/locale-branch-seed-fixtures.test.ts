// ITOTORI-059 — Branch-aware seed fixtures: two target locale branches whose
// draft + benchmark + cost state never conflate, and which fail loudly if a
// branch identity is dropped or merged.

import {
  asNonBlankTargetText,
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  type BenchmarkReportV02,
  type DraftArtifactBundle,
} from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";
import { benchmarkReportFixture } from "./api-fixtures.js";
import { ApiValidationError, parseRecordBenchmarkRequest } from "../src/api-schema.js";
import {
  buildLocaleBranchSeedFixture,
  LocaleBranchSeedConflationError,
  type LocaleBranchSeedSpec,
} from "../src/services/locale-branch-seed-fixtures.js";

const PROJECT_ID = "019ed059-0000-7000-8000-000000000001";

const BRANCH_A: LocaleBranchSeedSpec = {
  localeBranchId: "019ed059-0000-7000-8000-0000000000a1",
  localeBranchKey: "fr-FR/primary",
  targetLocale: "fr-FR",
  draftJobId: "019ed059-0000-7000-8000-0000000000d1",
  benchmarkRunId: "019ed059-0000-7000-8000-0000000000e1",
  draftText: "Bonjour, joueur — branche primaire.",
};

// Branch B shares branch A's TARGET LOCALE on purpose: only the locale-branch
// identity distinguishes them, so anything keyed on target locale alone would
// (wrongly) merge them.
const BRANCH_B: LocaleBranchSeedSpec = {
  localeBranchId: "019ed059-0000-7000-8000-0000000000a2",
  localeBranchKey: "fr-FR/alternate",
  targetLocale: "fr-FR",
  draftJobId: "019ed059-0000-7000-8000-0000000000d2",
  benchmarkRunId: "019ed059-0000-7000-8000-0000000000e2",
  draftText: "Salut, joueur — branche alternative.",
};

function baseDraftBundle(): DraftArtifactBundle {
  return {
    schemaVersion: DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    draftJobId: "draft-job-base",
    projectId: "project-base",
    localeBranchId: "locale-branch-base",
    drafts: [
      {
        sourceUnitId: "019ed001-0000-7000-8000-000000000201",
        draftId: "draft-001",
        providerProofId: "proof-001",
        costLedgerEntryRef: "ledger-entry-001",
        writtenOutcome: {
          id: "outcome-001",
          status: "written",
          unitId: "019ed001-0000-7000-8000-000000000201",
          targetLocale: "fr-FR",
          selectedCandidateId: "candidate-001",
          candidates: [
            {
              id: "candidate-001",
              outcomeId: "outcome-001",
              body: asNonBlankTargetText("base draft text"),
              producedBy: { modelId: "fixture-model", providerId: "fixture-provider" },
              attemptId: "attempt-001",
              kind: "primary",
            },
          ],
          findings: [],
          qualityFlags: [],
          provenance: { fixture: true },
          writtenAt: "2026-07-11T00:00:00.000Z",
        },
      },
    ],
    ledgerSummary: {
      totalCost: "0",
      totalTokensIn: 0,
      totalTokensOut: 0,
      attemptCount: 1,
      providerProofIds: ["proof-001"],
    },
  };
}

function baseBenchmarkReport(): BenchmarkReportV02 {
  return structuredClone(benchmarkReportFixture);
}

function buildSeed(specs: LocaleBranchSeedSpec[] = [BRANCH_A, BRANCH_B]) {
  return buildLocaleBranchSeedFixture({
    projectId: PROJECT_ID,
    baseDraftArtifactBundle: baseDraftBundle(),
    baseBenchmarkReport: baseBenchmarkReport(),
    branchSpecs: specs,
  });
}

describe("locale-branch seed fixtures (ITOTORI-059)", () => {
  it("seeds two locale branches that share a target locale yet stay distinct", () => {
    const seed = buildSeed();

    expect(seed.branches).toHaveLength(2);
    const [a, b] = seed.branches;
    expect(a!.targetLocale).toBe(b!.targetLocale);
    expect(a!.localeBranchId).not.toBe(b!.localeBranchId);
  });

  it("keeps draft state per branch without conflation", () => {
    const seed = buildSeed();
    const [a, b] = seed.branches;

    expect(a!.draftArtifactBundle.localeBranchId).toBe(BRANCH_A.localeBranchId);
    expect(b!.draftArtifactBundle.localeBranchId).toBe(BRANCH_B.localeBranchId);
    expect(a!.draftArtifactBundle.projectId).toBe(PROJECT_ID);
    expect(a!.draftArtifactBundle.draftJobId).not.toBe(b!.draftArtifactBundle.draftJobId);
    expect(selectedBody(a!.draftArtifactBundle)).toBe(BRANCH_A.draftText);
    expect(selectedBody(b!.draftArtifactBundle)).toBe(BRANCH_B.draftText);
    expect(selectedBody(a!.draftArtifactBundle)).not.toBe(selectedBody(b!.draftArtifactBundle));
  });

  it("keeps benchmark + cost state per branch without conflation", () => {
    const seed = buildSeed();
    const [a, b] = seed.branches;

    expect(a!.benchmarkReport.localeBranchId).toBe(BRANCH_A.localeBranchId);
    expect(a!.benchmarkReport.costLedger.localeBranchId).toBe(BRANCH_A.localeBranchId);
    expect(b!.benchmarkReport.localeBranchId).toBe(BRANCH_B.localeBranchId);
    expect(b!.benchmarkReport.costLedger.localeBranchId).toBe(BRANCH_B.localeBranchId);
    expect(a!.benchmarkReport.benchmarkRunId).not.toBe(b!.benchmarkReport.benchmarkRunId);
    expect(a!.benchmarkReport.costLedger.localeBranchId).not.toBe(
      b!.benchmarkReport.costLedger.localeBranchId,
    );
  });

  it("exposes a parseable API record-benchmark request per branch that self-identifies its branch", () => {
    const seed = buildSeed();

    for (const branch of seed.branches) {
      const parsed = parseRecordBenchmarkRequest(branch.recordBenchmarkRequest);
      expect(parsed.benchmarkReport.localeBranchId).toBe(branch.localeBranchId);
    }
  });

  it("exposes one dashboard row per branch keyed by locale-branch identity", () => {
    const seed = buildSeed();

    expect(seed.dashboardRows).toHaveLength(2);
    const byBranch = new Map(seed.dashboardRows.map((row) => [row.localeBranchId, row]));
    expect(byBranch.size).toBe(2);
    const rowA = byBranch.get(BRANCH_A.localeBranchId);
    const rowB = byBranch.get(BRANCH_B.localeBranchId);
    expect(rowA?.benchmarkRunId).toBe(BRANCH_A.benchmarkRunId);
    expect(rowA?.draftJobId).toBe(BRANCH_A.draftJobId);
    expect(rowB?.benchmarkRunId).toBe(BRANCH_B.benchmarkRunId);
    expect(rowB?.draftJobId).toBe(BRANCH_B.draftJobId);
  });

  it("rejects a seed that reuses a locale-branch identity (conflated branches)", () => {
    expect(() =>
      buildSeed([BRANCH_A, { ...BRANCH_B, localeBranchId: BRANCH_A.localeBranchId }]),
    ).toThrow(LocaleBranchSeedConflationError);
  });

  it("rejects a seed that shows fewer than two branches", () => {
    expect(() => buildSeed([BRANCH_A])).toThrow(LocaleBranchSeedConflationError);
  });

  it("API rejects a benchmark record that drops its locale-branch identity", () => {
    const seed = buildSeed();
    const request = structuredClone(seed.branches[0]!.recordBenchmarkRequest);
    // Drop the branch identity entirely (report + cost ledger): the bridge
    // schema then accepts the shape, but the itotori API boundary must still
    // reject it rather than fall back to project-level scope.
    delete request.benchmarkReport.localeBranchId;
    delete request.benchmarkReport.costLedger.localeBranchId;

    expect(() => parseRecordBenchmarkRequest(request)).toThrow(ApiValidationError);
    expect(() => parseRecordBenchmarkRequest(request)).toThrow(/localeBranchId is required/);
  });

  it("API rejects a benchmark record whose cost ledger is merged onto another branch", () => {
    const seed = buildSeed();
    const request = structuredClone(seed.branches[0]!.recordBenchmarkRequest);
    request.benchmarkReport.costLedger.localeBranchId = BRANCH_B.localeBranchId;

    expect(() => parseRecordBenchmarkRequest(request)).toThrow(
      /cost cannot be merged across target locale branches/,
    );
  });
});

function selectedBody(bundle: DraftArtifactBundle): string {
  const outcome = bundle.drafts[0]!.writtenOutcome;
  return outcome.candidates.find((candidate) => candidate.id === outcome.selectedCandidateId)!.body;
}
