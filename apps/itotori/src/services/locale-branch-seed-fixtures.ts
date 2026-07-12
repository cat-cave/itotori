// ITOTORI-059 — Branch-aware seed fixtures for the API + dashboard surfaces.
//
// A project can carry MORE THAN ONE target locale branch at once (e.g. two
// competing drafts of the same target locale, or distinct localization
// branches). The drafting, export, benchmark, and cost records each already
// self-identify the locale branch they belong to (DraftArtifactBundle,
// PatchExportBundle, BenchmarkReportV02 + its cost ledger). This module
// PROJECTS a single base draft bundle + benchmark report onto N branches and
// returns the API record-benchmark requests and the dashboard rows for each,
// WITHOUT changing any drafting/export/scoring behaviour — it is pure metadata
// propagation.
//
// The builder is the place a UI/test "seeds" two locale branches. It refuses
// to emit a seed that CONFLATES branches: every record must self-identify its
// own branch, and the branch identities must be distinct. A seed that merged
// draft or benchmark state across target locale branches (the project-level /
// JP-to-EN-only assumption) is a structured error, never a silent rollup.

import {
  asNonBlankTargetText,
  assertBenchmarkReportV02,
  assertDraftArtifactBundle,
  type BenchmarkReportV02,
  type DraftArtifactBundle,
} from "@itotori/localization-bridge-schema";
import type { ApiRecordBenchmarkRequest } from "../api-schema.js";

/** One target locale branch to seed. */
export type LocaleBranchSeedSpec = {
  /** Itotori locale-branch identity (UUID7). Distinct per branch. */
  localeBranchId: string;
  /** Human-readable branch label (shown in the dashboard). */
  localeBranchKey: string;
  /** BCP-47 target locale. Two branches MAY share a target locale. */
  targetLocale: string;
  /** Draft job id for this branch's draft artifact bundle. */
  draftJobId: string;
  /** Benchmark run id for this branch's benchmark report. */
  benchmarkRunId: string;
  /** Source text for the fixture unit; prevents emitting a source replay as a draft. */
  sourceText: string;
  /** Distinct draft text so the two branches' draft state never collapses. */
  draftText: string;
};

export type LocaleBranchSeed = {
  localeBranchId: string;
  localeBranchKey: string;
  targetLocale: string;
  /** Draft record, self-identifying this branch. */
  draftArtifactBundle: DraftArtifactBundle;
  /** Benchmark + cost record, self-identifying this branch. */
  benchmarkReport: BenchmarkReportV02;
  /** API seed surface: the exact record-benchmark request for this branch. */
  recordBenchmarkRequest: ApiRecordBenchmarkRequest;
};

/** Dashboard seed surface: one row per branch, keyed by locale-branch identity. */
export type LocaleBranchDashboardRow = {
  localeBranchId: string;
  localeBranchKey: string;
  targetLocale: string;
  draftJobId: string;
  draftUnitCount: number;
  benchmarkRunId: string;
  benchmarkCostMicrosUsd: number;
};

export type LocaleBranchSeedFixture = {
  projectId: string;
  branches: LocaleBranchSeed[];
  dashboardRows: LocaleBranchDashboardRow[];
};

/** Raised when a seed would conflate two locale branches. */
export class LocaleBranchSeedConflationError extends Error {
  constructor(detail: string) {
    super(`locale-branch seed conflation: ${detail}`);
    this.name = "LocaleBranchSeedConflationError";
  }
}

export type BuildLocaleBranchSeedInput = {
  projectId: string;
  baseDraftArtifactBundle: DraftArtifactBundle;
  baseBenchmarkReport: BenchmarkReportV02;
  branchSpecs: LocaleBranchSeedSpec[];
};

/**
 * Project the base draft bundle + benchmark report onto each branch spec and
 * return the per-branch API requests + dashboard rows. Throws
 * {@link LocaleBranchSeedConflationError} if the seed would conflate branches.
 */
export function buildLocaleBranchSeedFixture(
  input: BuildLocaleBranchSeedInput,
): LocaleBranchSeedFixture {
  const { projectId, baseDraftArtifactBundle, baseBenchmarkReport, branchSpecs } = input;
  if (branchSpecs.length < 2) {
    throw new LocaleBranchSeedConflationError(
      `a branch-aware seed must show at least two locale branches (got ${branchSpecs.length})`,
    );
  }

  const seenLocaleBranchIds = new Set<string>();
  const seenDraftJobIds = new Set<string>();
  const seenBenchmarkRunIds = new Set<string>();
  const branches: LocaleBranchSeed[] = [];

  for (const spec of branchSpecs) {
    if (seenLocaleBranchIds.has(spec.localeBranchId)) {
      throw new LocaleBranchSeedConflationError(
        `localeBranchId ${spec.localeBranchId} is reused across branches`,
      );
    }
    if (seenDraftJobIds.has(spec.draftJobId)) {
      throw new LocaleBranchSeedConflationError(
        `draftJobId ${spec.draftJobId} is reused across branches`,
      );
    }
    if (seenBenchmarkRunIds.has(spec.benchmarkRunId)) {
      throw new LocaleBranchSeedConflationError(
        `benchmarkRunId ${spec.benchmarkRunId} is reused across branches`,
      );
    }
    seenLocaleBranchIds.add(spec.localeBranchId);
    seenDraftJobIds.add(spec.draftJobId);
    seenBenchmarkRunIds.add(spec.benchmarkRunId);

    const draftArtifactBundle = projectDraftOntoBranch(baseDraftArtifactBundle, projectId, spec);
    assertDraftArtifactBundle(draftArtifactBundle);

    const benchmarkReport = projectBenchmarkOntoBranch(baseBenchmarkReport, spec);
    assertBenchmarkReportV02(benchmarkReport);

    // Each record self-identifies THIS branch — never the project at large and
    // never another branch. assertDraftArtifactBundle / assertBenchmarkReportV02
    // already validate shape + the report↔cost-ledger branch match; here we
    // bind the records to the branch they were seeded for.
    if (draftArtifactBundle.localeBranchId !== spec.localeBranchId) {
      throw new LocaleBranchSeedConflationError(
        `draft bundle localeBranchId ${draftArtifactBundle.localeBranchId} does not match branch ${spec.localeBranchId}`,
      );
    }
    if (benchmarkReport.localeBranchId !== spec.localeBranchId) {
      throw new LocaleBranchSeedConflationError(
        `benchmark report localeBranchId ${String(benchmarkReport.localeBranchId)} does not match branch ${spec.localeBranchId}`,
      );
    }
    if (benchmarkReport.costLedger.localeBranchId !== spec.localeBranchId) {
      throw new LocaleBranchSeedConflationError(
        `benchmark cost ledger localeBranchId ${String(benchmarkReport.costLedger.localeBranchId)} does not match branch ${spec.localeBranchId}`,
      );
    }

    branches.push({
      localeBranchId: spec.localeBranchId,
      localeBranchKey: spec.localeBranchKey,
      targetLocale: spec.targetLocale,
      draftArtifactBundle,
      benchmarkReport,
      recordBenchmarkRequest: { benchmarkReport },
    });
  }

  const dashboardRows: LocaleBranchDashboardRow[] = branches.map((branch) => ({
    localeBranchId: branch.localeBranchId,
    localeBranchKey: branch.localeBranchKey,
    targetLocale: branch.targetLocale,
    draftJobId: branch.draftArtifactBundle.draftJobId,
    draftUnitCount: branch.draftArtifactBundle.drafts.length,
    benchmarkRunId: branch.benchmarkReport.benchmarkRunId,
    benchmarkCostMicrosUsd: branch.benchmarkReport.costLedger.reportTotalMicrosUsd,
  }));

  return { projectId, branches, dashboardRows };
}

function projectDraftOntoBranch(
  base: DraftArtifactBundle,
  projectId: string,
  spec: LocaleBranchSeedSpec,
): DraftArtifactBundle {
  const bundle = structuredClone(base);
  bundle.projectId = projectId;
  bundle.localeBranchId = spec.localeBranchId;
  bundle.draftJobId = spec.draftJobId;
  // Distinct selected bodies per branch: branch state must never be shared.
  const selectedBody = asNonBlankTargetText(spec.draftText);
  if (selectedBody === spec.sourceText.trim()) {
    throw new LocaleBranchSeedConflationError(
      `draftText for branch ${spec.localeBranchId} must not echo sourceText`,
    );
  }
  bundle.drafts = bundle.drafts.map((draft) => {
    const selectedCandidate = draft.writtenOutcome.candidates.find(
      (candidate) => candidate.id === draft.writtenOutcome.selectedCandidateId,
    );
    if (selectedCandidate === undefined) {
      throw new LocaleBranchSeedConflationError(
        `draft ${draft.draftId} has no selected written candidate`,
      );
    }
    return {
      ...draft,
      writtenOutcome: {
        ...draft.writtenOutcome,
        targetLocale: spec.targetLocale,
        candidates: draft.writtenOutcome.candidates.map((candidate) =>
          candidate.id === selectedCandidate.id ? { ...candidate, body: selectedBody } : candidate,
        ),
      },
    };
  });
  return bundle;
}

function projectBenchmarkOntoBranch(
  base: BenchmarkReportV02,
  spec: LocaleBranchSeedSpec,
): BenchmarkReportV02 {
  const report = structuredClone(base);
  report.benchmarkRunId = spec.benchmarkRunId;
  report.targetLocale = spec.targetLocale;
  report.localeBranchId = spec.localeBranchId;
  // The cost ledger names the SAME branch as its report (enforced by the
  // schema asserter) — cost is never merged across target locale branches.
  report.costLedger = { ...report.costLedger, localeBranchId: spec.localeBranchId };
  return report;
}
