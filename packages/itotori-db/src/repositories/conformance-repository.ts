import { asc, eq, inArray } from "drizzle-orm";
import type {
  ConformanceEvidenceRefV01,
  ConformanceManifestV01,
  ConformanceResultV01,
  ConformanceResultOutcomeV01,
} from "@itotori/localization-bridge-schema";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  conformanceEvidenceRefs,
  conformanceFindings,
  conformanceResults,
  conformanceRuns,
  type ConformanceEvidenceRefKindValue,
  type ConformanceFindingSeverityValue,
  type ConformanceOutcomeKind,
  type ConformanceProfileIdValue,
} from "../schema.js";

export type ConformanceIngestFindingInput = {
  conformanceFindingId: string;
  findingCode: string;
  severity: ConformanceFindingSeverityValue;
  message: string;
  metadata?: Record<string, unknown>;
};

export type SaveConformanceRunInput = {
  conformanceRunId: string;
  projectId: string;
  localeBranchId?: string | null;
  manifestArtifactId?: string | null;
  reportArtifactId: string;
  manifest?: ConformanceManifestV01;
  manifestFidelityTier?: string | null;
  results: ReadonlyArray<{ conformanceResultId: string; result: ConformanceResultV01 }>;
  findings?: ReadonlyArray<ConformanceIngestFindingInput>;
  metadata?: Record<string, unknown>;
  recordedAt: Date;
};

export type SaveConformanceRunResult = {
  conformanceRunId: string;
  resultIds: string[];
  findingIds: string[];
};

export type ConformanceEvidenceRefRecord = {
  conformanceEvidenceRefId: string;
  evidenceKind: ConformanceEvidenceRefKindValue;
  ordinal: number;
  artifactKind: string | null;
  uri: string | null;
  artifactId: string | null;
  lineId: string | null;
  frameId: string | null;
  runId: string | null;
  fixtureId: string | null;
  bridgeUnitId: string | null;
  statePath: string | null;
};

export type ConformanceResultRecord = {
  conformanceResultId: string;
  conformanceRunId: string;
  projectId: string;
  adapterId: string;
  profileId: ConformanceProfileIdValue;
  outcomeKind: ConformanceOutcomeKind;
  passEvidenceTier: string | null;
  semanticCode: string | null;
  outcomeMessage: string | null;
  declaredInManifest: boolean | null;
  recordedAt: Date;
  metadata: Record<string, unknown>;
  evidenceRefs: ConformanceEvidenceRefRecord[];
};

export type ConformanceFindingRecord = {
  conformanceFindingId: string;
  findingCode: string;
  severity: ConformanceFindingSeverityValue;
  message: string;
  metadata: Record<string, unknown>;
};

export type ConformanceRunRecord = {
  conformanceRunId: string;
  projectId: string;
  localeBranchId: string | null;
  manifestArtifactId: string | null;
  reportArtifactId: string;
  adapterId: string;
  abiVersion: number;
  schemaVersion: string;
  manifestFidelityTier: string | null;
  resultCount: number;
  passCount: number;
  failCount: number;
  skipCount: number;
  unsupportedCount: number;
  recordedAt: Date;
  metadata: Record<string, unknown>;
  results: ConformanceResultRecord[];
  findings: ConformanceFindingRecord[];
};

export interface ItotoriConformanceRepositoryPort {
  saveConformanceRun(
    actor: AuthorizationActor,
    input: SaveConformanceRunInput,
  ): Promise<SaveConformanceRunResult>;
  loadConformanceRun(
    actor: AuthorizationActor,
    conformanceRunId: string,
  ): Promise<ConformanceRunRecord | null>;
}

export class ItotoriConformanceRepository implements ItotoriConformanceRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async saveConformanceRun(
    actor: AuthorizationActor,
    input: SaveConformanceRunInput,
  ): Promise<SaveConformanceRunResult> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);

    const counts = countOutcomes(input.results.map((entry) => entry.result.outcome));
    const adapterId = input.manifest?.adapterId ?? input.results[0]?.result.adapterId;
    if (adapterId === undefined) {
      throw new Error("saveConformanceRun requires at least one result or a manifest");
    }
    const schemaVersion =
      input.manifest?.schemaVersion ?? input.results[0]?.result.schemaVersion ?? "0.2.0-alpha";
    const abiVersion = input.manifest?.abiVersion ?? 1;

    await this.db.transaction(async (tx) => {
      await tx.insert(conformanceRuns).values({
        conformanceRunId: input.conformanceRunId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId ?? null,
        manifestArtifactId: input.manifestArtifactId ?? null,
        reportArtifactId: input.reportArtifactId,
        adapterId,
        abiVersion,
        schemaVersion,
        manifestFidelityTier: input.manifestFidelityTier ?? null,
        resultCount: input.results.length,
        passCount: counts.pass,
        failCount: counts.fail,
        skipCount: counts.skip,
        unsupportedCount: counts.unsupported,
        recordedAt: input.recordedAt,
        metadata: input.metadata ?? {},
      });

      if (input.results.length > 0) {
        await tx.insert(conformanceResults).values(
          input.results.map((entry) => ({
            conformanceResultId: entry.conformanceResultId,
            conformanceRunId: input.conformanceRunId,
            projectId: input.projectId,
            adapterId: entry.result.adapterId,
            profileId: entry.result.profileId,
            outcomeKind: entry.result.outcome.kind,
            passEvidenceTier:
              entry.result.outcome.kind === "pass" ? entry.result.outcome.evidenceTier : null,
            semanticCode:
              entry.result.outcome.kind === "pass" ? null : entry.result.outcome.semanticCode,
            outcomeMessage: outcomeMessage(entry.result.outcome),
            declaredInManifest:
              entry.result.outcome.kind === "unsupported"
                ? entry.result.outcome.declaredInManifest
                : null,
            recordedAt: new Date(entry.result.recordedAt),
            metadata: {},
          })),
        );

        const evidenceRows = input.results.flatMap((entry) =>
          entry.result.evidence.map((evidence, ordinal) =>
            evidenceRefRow(entry.conformanceResultId, evidence, ordinal),
          ),
        );
        if (evidenceRows.length > 0) {
          await tx.insert(conformanceEvidenceRefs).values(evidenceRows);
        }
      }

      const findings = input.findings ?? [];
      if (findings.length > 0) {
        await tx.insert(conformanceFindings).values(
          findings.map((finding) => ({
            conformanceFindingId: finding.conformanceFindingId,
            conformanceRunId: input.conformanceRunId,
            findingCode: finding.findingCode,
            severity: finding.severity,
            message: finding.message,
            metadata: finding.metadata ?? {},
          })),
        );
      }
    });

    return {
      conformanceRunId: input.conformanceRunId,
      resultIds: input.results.map((entry) => entry.conformanceResultId),
      findingIds: (input.findings ?? []).map((finding) => finding.conformanceFindingId),
    };
  }

  async loadConformanceRun(
    actor: AuthorizationActor,
    conformanceRunId: string,
  ): Promise<ConformanceRunRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const runRows = await this.db
      .select()
      .from(conformanceRuns)
      .where(eq(conformanceRuns.conformanceRunId, conformanceRunId))
      .limit(1);
    const runRow = runRows[0];
    if (runRow === undefined) {
      return null;
    }

    const resultRows = await this.db
      .select()
      .from(conformanceResults)
      .where(eq(conformanceResults.conformanceRunId, conformanceRunId))
      .orderBy(asc(conformanceResults.conformanceResultId));

    const evidenceRows =
      resultRows.length === 0
        ? []
        : await this.db
            .select()
            .from(conformanceEvidenceRefs)
            .where(
              inArray(
                conformanceEvidenceRefs.conformanceResultId,
                resultRows.map((row) => row.conformanceResultId),
              ),
            )
            .orderBy(
              asc(conformanceEvidenceRefs.conformanceResultId),
              asc(conformanceEvidenceRefs.ordinal),
            );

    const findingRows = await this.db
      .select()
      .from(conformanceFindings)
      .where(eq(conformanceFindings.conformanceRunId, conformanceRunId))
      .orderBy(asc(conformanceFindings.conformanceFindingId));

    const evidenceByResult = new Map<string, ConformanceEvidenceRefRecord[]>();
    for (const row of evidenceRows) {
      const bucket = evidenceByResult.get(row.conformanceResultId) ?? [];
      bucket.push({
        conformanceEvidenceRefId: row.conformanceEvidenceRefId,
        evidenceKind: row.evidenceKind as ConformanceEvidenceRefKindValue,
        ordinal: row.ordinal,
        artifactKind: row.artifactKind,
        uri: row.uri,
        artifactId: row.artifactId,
        lineId: row.lineId,
        frameId: row.frameId,
        runId: row.runId,
        fixtureId: row.fixtureId,
        bridgeUnitId: row.bridgeUnitId,
        statePath: row.statePath,
      });
      evidenceByResult.set(row.conformanceResultId, bucket);
    }

    return {
      conformanceRunId: runRow.conformanceRunId,
      projectId: runRow.projectId,
      localeBranchId: runRow.localeBranchId,
      manifestArtifactId: runRow.manifestArtifactId,
      reportArtifactId: runRow.reportArtifactId,
      adapterId: runRow.adapterId,
      abiVersion: runRow.abiVersion,
      schemaVersion: runRow.schemaVersion,
      manifestFidelityTier: runRow.manifestFidelityTier,
      resultCount: runRow.resultCount,
      passCount: runRow.passCount,
      failCount: runRow.failCount,
      skipCount: runRow.skipCount,
      unsupportedCount: runRow.unsupportedCount,
      recordedAt: runRow.recordedAt,
      metadata: runRow.metadata,
      results: resultRows.map((row) => ({
        conformanceResultId: row.conformanceResultId,
        conformanceRunId: row.conformanceRunId,
        projectId: row.projectId,
        adapterId: row.adapterId,
        profileId: row.profileId as ConformanceProfileIdValue,
        outcomeKind: row.outcomeKind as ConformanceOutcomeKind,
        passEvidenceTier: row.passEvidenceTier,
        semanticCode: row.semanticCode,
        outcomeMessage: row.outcomeMessage,
        declaredInManifest: row.declaredInManifest,
        recordedAt: row.recordedAt,
        metadata: row.metadata,
        evidenceRefs: (evidenceByResult.get(row.conformanceResultId) ?? []).sort(
          (a, b) => a.ordinal - b.ordinal,
        ),
      })),
      findings: findingRows.map((row) => ({
        conformanceFindingId: row.conformanceFindingId,
        findingCode: row.findingCode,
        severity: row.severity as ConformanceFindingSeverityValue,
        message: row.message,
        metadata: row.metadata,
      })),
    };
  }
}

function countOutcomes(outcomes: ReadonlyArray<ConformanceResultOutcomeV01>): {
  pass: number;
  fail: number;
  skip: number;
  unsupported: number;
} {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let unsupported = 0;
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case "pass":
        pass += 1;
        break;
      case "fail":
        fail += 1;
        break;
      case "skip":
        skip += 1;
        break;
      case "unsupported":
        unsupported += 1;
        break;
    }
  }
  return { pass, fail, skip, unsupported };
}

function outcomeMessage(outcome: ConformanceResultOutcomeV01): string | null {
  switch (outcome.kind) {
    case "fail":
      return outcome.detail;
    case "skip":
      return outcome.reason;
    case "pass":
    case "unsupported":
      return null;
  }
}

function evidenceRefRow(
  conformanceResultId: string,
  evidence: ConformanceEvidenceRefV01,
  ordinal: number,
): typeof conformanceEvidenceRefs.$inferInsert {
  const base = {
    conformanceEvidenceRefId: `${conformanceResultId}:${String(ordinal).padStart(3, "0")}`,
    conformanceResultId,
    evidenceKind: evidence.artifactKind as ConformanceEvidenceRefKindValue,
    artifactKind: null as string | null,
    uri: null as string | null,
    artifactId: null as string | null,
    lineId: null as string | null,
    frameId: null as string | null,
    runId: null as string | null,
    fixtureId: null as string | null,
    bridgeUnitId: null as string | null,
    statePath: null as string | null,
    ordinal,
  };
  switch (evidence.artifactKind) {
    case "runtimeArtifact":
      return {
        ...base,
        artifactKind: evidence.kind,
        uri: evidence.uri,
        artifactId: evidence.artifactId ?? null,
      };
    case "textLine":
      return { ...base, lineId: evidence.lineId };
    case "frameArtifactRef":
      return { ...base, frameId: evidence.frameId };
    case "replayLogRef":
      return { ...base, runId: evidence.runId };
    case "implMapFixture":
      return { ...base, fixtureId: evidence.fixtureId };
    case "bridgeUnit":
      return { ...base, bridgeUnitId: evidence.bridgeUnitId };
    case "statePath":
      return { ...base, statePath: evidence.path };
  }
}
