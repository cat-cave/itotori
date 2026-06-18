import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import { createUuid7 } from "./event-queue-repository.js";
import {
  catalogConfidenceValues,
  catalogCandidateMatches,
  catalogCandidateMatchStatusValues,
  catalogConflictEvidence,
  catalogConflictKindValues,
  catalogConflicts,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogExternalIds,
  catalogLanguageStatuses,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogLocalScanEntries,
  catalogLocalScanExternalIds,
  catalogLocalScans,
  catalogPathRedactionClassValues,
  catalogReleaseKindValues,
  catalogReleases,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSeedTargets,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  catalogWorks,
  type CatalogConfidence,
  type CatalogCandidateMatchStatus,
  type CatalogConflictKind,
  type CatalogConflictStatus,
  type CatalogConflictSubjectKind,
  type CatalogEngineSource,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogPathRedactionClass,
  type CatalogReleaseKind,
  type CatalogSeedOrigin,
  type CatalogSeedStatus,
  type CatalogSource,
  type CatalogSourceRecordKind,
} from "../schema.js";

export type CatalogJsonRecord = Record<string, unknown>;
export type CatalogDateInput = string | Date;

export type CatalogSourceProvenanceInput = {
  sourceProvenanceId?: string;
  catalogSource: CatalogSource;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceId: string;
  sourceVersion?: string;
  requestId?: string;
  httpStatus?: number;
  ok?: boolean;
  payloadHash?: string;
  payload?: CatalogJsonRecord;
  fetchedAt: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogSourceProvenanceRecord = {
  sourceProvenanceId: string;
  catalogSource: CatalogSource;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceId: string;
  sourceVersion: string | null;
  requestId: string | null;
  httpStatus: number | null;
  ok: boolean;
  payloadHash: string | null;
  payload: CatalogJsonRecord;
  fetchedAt: Date;
  metadata: CatalogJsonRecord;
  recordedAt: Date;
};

export type CatalogEngineInput = {
  engineName: string;
  engineSource: CatalogEngineSource;
  engineConfidence?: CatalogConfidence;
  engineProvenanceId?: string;
};

export type CatalogExternalIdInput = {
  externalIdId?: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  sourceProvenanceId?: string;
  confidence?: CatalogConfidence;
  discoveredAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogExternalIdRecord = {
  externalIdId: string;
  workId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  discoveredAt: Date;
  metadata: CatalogJsonRecord;
};

export type CatalogReleaseInput = {
  releaseId?: string;
  catalogSource: CatalogSource;
  sourceReleaseId?: string;
  releaseTitle: string;
  releaseKind?: CatalogReleaseKind;
  platform?: string;
  language?: string;
  releaseDate?: string;
  releaseYear?: number;
  isOfficial?: boolean;
  sourceProvenanceId?: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogReleaseRecord = {
  releaseId: string;
  workId: string;
  catalogSource: CatalogSource;
  sourceReleaseId: string | null;
  releaseTitle: string;
  releaseKind: CatalogReleaseKind;
  platform: string | null;
  language: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  isOfficial: boolean;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogLanguageStatusInput = {
  languageStatusId?: string;
  language: string;
  status: CatalogLanguageStatus;
  statusScope?: CatalogLanguageStatusScope;
  platform?: string;
  releaseId?: string;
  sourceProvenanceId?: string;
  confidence?: CatalogConfidence;
  isCurrent?: boolean;
  observedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogLanguageStatusRecord = {
  languageStatusId: string;
  workId: string;
  language: string;
  status: CatalogLanguageStatus;
  statusScope: CatalogLanguageStatusScope;
  platform: string | null;
  releaseId: string | null;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  isCurrent: boolean;
  observedAt: Date;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogConflictEvidenceInput = {
  conflictEvidenceId?: string;
  subjectKind: CatalogConflictSubjectKind;
  subjectId: string;
  sourceProvenanceId?: string;
  evidencePosition?: number;
  metadata?: CatalogJsonRecord;
};

export type CatalogConflictInput = {
  conflictId?: string;
  conflictKind: CatalogConflictKind;
  status?: CatalogConflictStatus;
  summary: string;
  detectedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
  evidence?: CatalogConflictEvidenceInput[];
};

export type CatalogConflictEvidenceRecord = {
  conflictEvidenceId: string;
  conflictId: string;
  subjectKind: CatalogConflictSubjectKind;
  subjectId: string;
  sourceProvenanceId: string | null;
  evidencePosition: number;
  metadata: CatalogJsonRecord;
  createdAt: Date;
};

export type CatalogConflictRecord = {
  conflictId: string;
  workId: string;
  conflictKind: CatalogConflictKind;
  status: CatalogConflictStatus;
  summary: string;
  detectedAt: Date;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
  evidence: CatalogConflictEvidenceRecord[];
};

export type CatalogWorkInput = {
  workId?: string;
  canonicalTitle: string;
  originalLanguage?: string;
  firstReleaseYear?: number;
  workKind?: string;
  engine?: CatalogEngineInput;
  metadata?: CatalogJsonRecord;
  externalIds?: CatalogExternalIdInput[];
  releases?: CatalogReleaseInput[];
  languageStatuses?: CatalogLanguageStatusInput[];
  conflicts?: CatalogConflictInput[];
};

export type CatalogWorkRecord = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  firstReleaseYear: number | null;
  workKind: string;
  engineName: string | null;
  engineSource: CatalogEngineSource | null;
  engineConfidence: CatalogConfidence | null;
  engineProvenanceId: string | null;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogWorkSnapshot = CatalogWorkRecord & {
  externalIds: CatalogExternalIdRecord[];
  releases: CatalogReleaseRecord[];
  languageStatuses: CatalogLanguageStatusRecord[];
  conflicts: CatalogConflictRecord[];
  localScanEntries: CatalogLocalScanEntryRecord[];
  seedTargets: CatalogSeedTargetRecord[];
};

export type CatalogSeedTargetInput = {
  seedTargetId?: string;
  catalogSource: CatalogSource;
  sourceId: string;
  seedOrigin?: CatalogSeedOrigin;
  originRef?: string;
  localScanEntryId?: string;
  sourceProvenanceId?: string;
  status?: CatalogSeedStatus;
  priority?: number;
  addedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogSeedTargetRecord = {
  seedTargetId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  seedOrigin: CatalogSeedOrigin;
  originRef: string | null;
  localScanEntryId: string | null;
  sourceProvenanceId: string | null;
  status: CatalogSeedStatus;
  priority: number;
  addedAt: Date;
  metadata: CatalogJsonRecord;
  updatedAt: Date;
};

export type CatalogLocalScanDetectedExternalIdInput = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  sourceProvenanceId?: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogLocalScanEntryInput = {
  localScanEntryId?: string;
  workId?: string;
  pathHash: string;
  pathRedactionClass?: CatalogPathRedactionClass;
  owned?: boolean;
  engineName?: string;
  engineSource?: CatalogEngineSource;
  engineConfidence?: CatalogConfidence;
  signals?: CatalogJsonRecord;
  sourceProvenanceId?: string;
  scannedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
  detectedExternalIds?: CatalogLocalScanDetectedExternalIdInput[];
  seedTargets?: CatalogSeedTargetInput[];
};

export type CatalogLocalScanInput = {
  localScanId?: string;
  scanRootLabel: string;
  scanRootPathHash: string;
  scannerName: string;
  scannerVersion: string;
  startedAt?: CatalogDateInput;
  completedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
  entries: CatalogLocalScanEntryInput[];
};

export type CatalogLocalScanEntryRecord = {
  localScanEntryId: string;
  localScanId: string;
  workId: string | null;
  pathHash: string;
  pathRedactionClass: CatalogPathRedactionClass;
  owned: boolean;
  engineName: string | null;
  engineSource: CatalogEngineSource | null;
  engineConfidence: CatalogConfidence | null;
  signals: CatalogJsonRecord;
  sourceProvenanceId: string | null;
  scannedAt: Date;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
  detectedExternalIds: CatalogLocalScanDetectedExternalIdRecord[];
  seedTargets: CatalogSeedTargetRecord[];
};

export type CatalogLocalScanDetectedExternalIdRecord = {
  localScanEntryId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
  createdAt: Date;
};

export type CatalogLocalScanRecord = {
  localScanId: string;
  scanRootLabel: string;
  scanRootPathHash: string;
  scannerName: string;
  scannerVersion: string;
  startedAt: Date;
  completedAt: Date;
  createdByUserId: string | null;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  entries: CatalogLocalScanEntryRecord[];
};

export type CatalogCandidateMatchInput = {
  candidateId?: string;
  sourceCatalogSource: CatalogSource;
  sourceId: string;
  sourceTitle: string;
  sourceProvenanceId?: string;
  targetWorkId: string;
  score: number;
  matchedFields: CatalogJsonRecord;
  status?: CatalogCandidateMatchStatus;
  diagnosticCode: string;
  generatorVersion: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogCandidateMatchRecord = {
  candidateId: string;
  sourceCatalogSource: CatalogSource;
  sourceId: string;
  sourceTitle: string;
  sourceProvenanceId: string | null;
  targetWorkId: string;
  score: number;
  matchedFields: CatalogJsonRecord;
  status: CatalogCandidateMatchStatus;
  diagnosticCode: string;
  generatorVersion: string;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogCandidateTargetWorkRecord = Pick<
  CatalogWorkRecord,
  "workId" | "canonicalTitle" | "firstReleaseYear" | "originalLanguage" | "workKind"
>;

export interface ItotoriCatalogRepositoryPort {
  recordSourceProvenance(
    actor: AuthorizationActor,
    input: CatalogSourceProvenanceInput,
  ): Promise<CatalogSourceProvenanceRecord>;
  upsertWork(actor: AuthorizationActor, input: CatalogWorkInput): Promise<CatalogWorkSnapshot>;
  recordLocalScan(
    actor: AuthorizationActor,
    input: CatalogLocalScanInput,
  ): Promise<CatalogLocalScanRecord>;
  recordSeedTarget(
    actor: AuthorizationActor,
    input: CatalogSeedTargetInput,
  ): Promise<CatalogSeedTargetRecord>;
  getWorkSnapshot(actor: AuthorizationActor, workId: string): Promise<CatalogWorkSnapshot | null>;
  getWorkByExternalId(
    actor: AuthorizationActor,
    catalogSource: CatalogSource,
    sourceId: string,
    externalIdKind?: CatalogExternalIdKind,
  ): Promise<CatalogWorkSnapshot | null>;
  listSeedTargets(
    actor: AuthorizationActor,
    status?: CatalogSeedStatus,
  ): Promise<CatalogSeedTargetRecord[]>;
  listCatalogCandidateTargetWorks(
    actor: AuthorizationActor,
  ): Promise<CatalogCandidateTargetWorkRecord[]>;
  recordCatalogCandidateMatch(
    actor: AuthorizationActor,
    input: CatalogCandidateMatchInput,
  ): Promise<CatalogCandidateMatchRecord>;
  listCatalogCandidateMatches(
    actor: AuthorizationActor,
    status?: CatalogCandidateMatchStatus,
  ): Promise<CatalogCandidateMatchRecord[]>;
}

const catalogSources = Object.values(catalogSourceValues) as CatalogSource[];
const catalogSourceRecordKinds = Object.values(
  catalogSourceRecordKindValues,
) as CatalogSourceRecordKind[];
const catalogExternalIdKinds = Object.values(
  catalogExternalIdKindValues,
) as CatalogExternalIdKind[];
const catalogConfidences = Object.values(catalogConfidenceValues) as CatalogConfidence[];
const catalogEngineSources = Object.values(catalogEngineSourceValues) as CatalogEngineSource[];
const catalogReleaseKinds = Object.values(catalogReleaseKindValues) as CatalogReleaseKind[];
const catalogLanguageStatusEnums = Object.values(
  catalogLanguageStatusValues,
) as CatalogLanguageStatus[];
const catalogLanguageStatusScopes = Object.values(
  catalogLanguageStatusScopeValues,
) as CatalogLanguageStatusScope[];
const catalogConflictKinds = Object.values(catalogConflictKindValues) as CatalogConflictKind[];
const catalogConflictStatuses = Object.values(
  catalogConflictStatusValues,
) as CatalogConflictStatus[];
const catalogConflictSubjectKinds = Object.values(
  catalogConflictSubjectKindValues,
) as CatalogConflictSubjectKind[];
const catalogPathRedactionClasses = Object.values(
  catalogPathRedactionClassValues,
) as CatalogPathRedactionClass[];
const catalogSeedOrigins = Object.values(catalogSeedOriginValues) as CatalogSeedOrigin[];
const catalogSeedStatuses = Object.values(catalogSeedStatusValues) as CatalogSeedStatus[];
const catalogCandidateMatchStatuses = Object.values(
  catalogCandidateMatchStatusValues,
) as CatalogCandidateMatchStatus[];

export class ItotoriCatalogRepository implements ItotoriCatalogRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async recordSourceProvenance(
    actor: AuthorizationActor,
    input: CatalogSourceProvenanceInput,
  ): Promise<CatalogSourceProvenanceRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    return recordSourceProvenanceUnchecked(this.db, assertSourceProvenanceInput(input));
  }

  async upsertWork(
    actor: AuthorizationActor,
    input: CatalogWorkInput,
  ): Promise<CatalogWorkSnapshot> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertCatalogWorkInput(input);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(catalogWorks)
        .values({
          workId: normalized.workId,
          canonicalTitle: normalized.canonicalTitle,
          originalLanguage: normalized.originalLanguage,
          firstReleaseYear: normalized.firstReleaseYear,
          workKind: normalized.workKind,
          engineName: normalized.engine?.engineName ?? null,
          engineSource: normalized.engine?.engineSource ?? null,
          engineConfidence: normalized.engine?.engineConfidence ?? null,
          engineProvenanceId: normalized.engine?.engineProvenanceId ?? null,
          metadata: normalized.metadata,
        })
        .onConflictDoUpdate({
          target: catalogWorks.workId,
          set: {
            canonicalTitle: normalized.canonicalTitle,
            originalLanguage: normalized.originalLanguage,
            firstReleaseYear: normalized.firstReleaseYear,
            workKind: normalized.workKind,
            engineName: normalized.engine?.engineName ?? null,
            engineSource: normalized.engine?.engineSource ?? null,
            engineConfidence: normalized.engine?.engineConfidence ?? null,
            engineProvenanceId: normalized.engine?.engineProvenanceId ?? null,
            metadata: normalized.metadata,
            updatedAt: sql`now()`,
          },
        });

      for (const externalId of normalized.externalIds) {
        await tx
          .insert(catalogExternalIds)
          .values({
            externalIdId: externalId.externalIdId,
            workId: normalized.workId,
            catalogSource: externalId.catalogSource,
            sourceId: externalId.sourceId,
            externalIdKind: externalId.externalIdKind,
            sourceProvenanceId: externalId.sourceProvenanceId,
            confidence: externalId.confidence,
            discoveredAt: externalId.discoveredAt,
            metadata: externalId.metadata,
          })
          .onConflictDoUpdate({
            target: [
              catalogExternalIds.catalogSource,
              catalogExternalIds.sourceId,
              catalogExternalIds.externalIdKind,
            ],
            set: {
              workId: normalized.workId,
              catalogSource: externalId.catalogSource,
              sourceId: externalId.sourceId,
              externalIdKind: externalId.externalIdKind,
              sourceProvenanceId: externalId.sourceProvenanceId,
              confidence: externalId.confidence,
              metadata: externalId.metadata,
            },
          });
      }

      for (const release of normalized.releases) {
        await tx
          .insert(catalogReleases)
          .values({
            releaseId: release.releaseId,
            workId: normalized.workId,
            catalogSource: release.catalogSource,
            sourceReleaseId: release.sourceReleaseId,
            releaseTitle: release.releaseTitle,
            releaseKind: release.releaseKind,
            platform: release.platform,
            language: release.language,
            releaseDate: release.releaseDate,
            releaseYear: release.releaseYear,
            isOfficial: release.isOfficial,
            sourceProvenanceId: release.sourceProvenanceId,
            metadata: release.metadata,
          })
          .onConflictDoUpdate({
            target: catalogReleases.releaseId,
            set: {
              catalogSource: release.catalogSource,
              sourceReleaseId: release.sourceReleaseId,
              releaseTitle: release.releaseTitle,
              releaseKind: release.releaseKind,
              platform: release.platform,
              language: release.language,
              releaseDate: release.releaseDate,
              releaseYear: release.releaseYear,
              isOfficial: release.isOfficial,
              sourceProvenanceId: release.sourceProvenanceId,
              metadata: release.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const languageStatus of normalized.languageStatuses) {
        await tx
          .insert(catalogLanguageStatuses)
          .values({
            languageStatusId: languageStatus.languageStatusId,
            workId: normalized.workId,
            language: languageStatus.language,
            status: languageStatus.status,
            statusScope: languageStatus.statusScope,
            platform: languageStatus.platform,
            releaseId: languageStatus.releaseId,
            sourceProvenanceId: languageStatus.sourceProvenanceId,
            confidence: languageStatus.confidence,
            isCurrent: languageStatus.isCurrent,
            observedAt: languageStatus.observedAt,
            metadata: languageStatus.metadata,
          })
          .onConflictDoUpdate({
            target: catalogLanguageStatuses.languageStatusId,
            set: {
              language: languageStatus.language,
              status: languageStatus.status,
              statusScope: languageStatus.statusScope,
              platform: languageStatus.platform,
              releaseId: languageStatus.releaseId,
              sourceProvenanceId: languageStatus.sourceProvenanceId,
              confidence: languageStatus.confidence,
              isCurrent: languageStatus.isCurrent,
              observedAt: languageStatus.observedAt,
              metadata: languageStatus.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const conflict of normalized.conflicts) {
        await tx
          .insert(catalogConflicts)
          .values({
            conflictId: conflict.conflictId,
            workId: normalized.workId,
            conflictKind: conflict.conflictKind,
            status: conflict.status,
            summary: conflict.summary,
            detectedAt: conflict.detectedAt,
            metadata: conflict.metadata,
          })
          .onConflictDoUpdate({
            target: catalogConflicts.conflictId,
            set: {
              conflictKind: conflict.conflictKind,
              status: conflict.status,
              summary: conflict.summary,
              detectedAt: conflict.detectedAt,
              metadata: conflict.metadata,
              updatedAt: sql`now()`,
            },
          });

        for (const evidence of conflict.evidence) {
          await tx
            .insert(catalogConflictEvidence)
            .values({
              conflictEvidenceId: evidence.conflictEvidenceId,
              conflictId: conflict.conflictId,
              subjectKind: evidence.subjectKind,
              subjectId: evidence.subjectId,
              sourceProvenanceId: evidence.sourceProvenanceId,
              evidencePosition: evidence.evidencePosition,
              metadata: evidence.metadata,
            })
            .onConflictDoUpdate({
              target: catalogConflictEvidence.conflictEvidenceId,
              set: {
                subjectKind: evidence.subjectKind,
                subjectId: evidence.subjectId,
                sourceProvenanceId: evidence.sourceProvenanceId,
                evidencePosition: evidence.evidencePosition,
                metadata: evidence.metadata,
              },
            });
        }
      }
    });

    return requiredSnapshot(await readWorkSnapshot(this.db, normalized.workId), normalized.workId);
  }

  async recordLocalScan(
    actor: AuthorizationActor,
    input: CatalogLocalScanInput,
  ): Promise<CatalogLocalScanRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertLocalScanInput(input);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(catalogLocalScans)
        .values({
          localScanId: normalized.localScanId,
          scanRootLabel: normalized.scanRootLabel,
          scanRootPathHash: normalized.scanRootPathHash,
          scannerName: normalized.scannerName,
          scannerVersion: normalized.scannerVersion,
          startedAt: normalized.startedAt,
          completedAt: normalized.completedAt,
          createdByUserId: actor.userId,
          metadata: normalized.metadata,
        })
        .onConflictDoUpdate({
          target: catalogLocalScans.localScanId,
          set: {
            scanRootLabel: normalized.scanRootLabel,
            scanRootPathHash: normalized.scanRootPathHash,
            scannerName: normalized.scannerName,
            scannerVersion: normalized.scannerVersion,
            startedAt: normalized.startedAt,
            completedAt: normalized.completedAt,
            metadata: normalized.metadata,
          },
        });

      for (const entry of normalized.entries) {
        const entryRows = await tx
          .insert(catalogLocalScanEntries)
          .values({
            localScanEntryId: entry.localScanEntryId,
            localScanId: normalized.localScanId,
            workId: entry.workId,
            pathHash: entry.pathHash,
            pathRedactionClass: entry.pathRedactionClass,
            owned: entry.owned,
            engineName: entry.engineName,
            engineSource: entry.engineSource,
            engineConfidence: entry.engineConfidence,
            signals: entry.signals,
            sourceProvenanceId: entry.sourceProvenanceId,
            scannedAt: entry.scannedAt,
            metadata: entry.metadata,
          })
          .onConflictDoUpdate({
            target: [catalogLocalScanEntries.localScanId, catalogLocalScanEntries.pathHash],
            set: {
              workId: entry.workId,
              pathHash: entry.pathHash,
              pathRedactionClass: entry.pathRedactionClass,
              owned: entry.owned,
              engineName: entry.engineName,
              engineSource: entry.engineSource,
              engineConfidence: entry.engineConfidence,
              signals: entry.signals,
              sourceProvenanceId: entry.sourceProvenanceId,
              scannedAt: entry.scannedAt,
              metadata: entry.metadata,
              updatedAt: sql`now()`,
            },
          })
          .returning({ localScanEntryId: catalogLocalScanEntries.localScanEntryId });
        const persistedLocalScanEntryId = requiredRow(
          entryRows,
          entry.localScanEntryId,
        ).localScanEntryId;

        for (const detectedExternalId of entry.detectedExternalIds) {
          await tx
            .insert(catalogLocalScanExternalIds)
            .values({
              localScanEntryId: persistedLocalScanEntryId,
              catalogSource: detectedExternalId.catalogSource,
              sourceId: detectedExternalId.sourceId,
              externalIdKind: detectedExternalId.externalIdKind,
              sourceProvenanceId: detectedExternalId.sourceProvenanceId,
              metadata: detectedExternalId.metadata,
            })
            .onConflictDoUpdate({
              target: [
                catalogLocalScanExternalIds.localScanEntryId,
                catalogLocalScanExternalIds.catalogSource,
                catalogLocalScanExternalIds.sourceId,
                catalogLocalScanExternalIds.externalIdKind,
              ],
              set: {
                sourceProvenanceId: detectedExternalId.sourceProvenanceId,
                metadata: detectedExternalId.metadata,
              },
            });
        }

        for (const seedTarget of entry.seedTargets) {
          const usesParentLocalScanEntry =
            seedTarget.localScanEntryId === null ||
            seedTarget.localScanEntryId === entry.localScanEntryId;
          await recordSeedTargetUnchecked(tx as ItotoriDatabase, {
            ...seedTarget,
            localScanEntryId: usesParentLocalScanEntry
              ? persistedLocalScanEntryId
              : seedTarget.localScanEntryId,
          });
        }
      }
    });

    return requiredLocalScan(
      await readLocalScan(this.db, normalized.localScanId),
      normalized.localScanId,
    );
  }

  async recordSeedTarget(
    actor: AuthorizationActor,
    input: CatalogSeedTargetInput,
  ): Promise<CatalogSeedTargetRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    return recordSeedTargetUnchecked(this.db, assertSeedTargetInput(input));
  }

  async getWorkSnapshot(
    actor: AuthorizationActor,
    workId: string,
  ): Promise<CatalogWorkSnapshot | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readWorkSnapshot(this.db, requiredString(workId, "workId"));
  }

  async getWorkByExternalId(
    actor: AuthorizationActor,
    catalogSource: CatalogSource,
    sourceId: string,
    externalIdKind: CatalogExternalIdKind = catalogExternalIdKindValues.sourceRecord,
  ): Promise<CatalogWorkSnapshot | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertEnumValue(catalogSource, catalogSources, "catalogSource");
    assertEnumValue(externalIdKind, catalogExternalIdKinds, "externalIdKind");
    const externalRows = await this.db
      .select({ workId: catalogExternalIds.workId })
      .from(catalogExternalIds)
      .where(
        and(
          eq(catalogExternalIds.catalogSource, catalogSource),
          eq(catalogExternalIds.sourceId, requiredString(sourceId, "sourceId")),
          eq(catalogExternalIds.externalIdKind, externalIdKind),
        ),
      )
      .limit(1);
    const externalRow = externalRows[0];
    if (externalRow === undefined) {
      return null;
    }
    return readWorkSnapshot(this.db, externalRow.workId);
  }

  async listSeedTargets(
    actor: AuthorizationActor,
    status?: CatalogSeedStatus,
  ): Promise<CatalogSeedTargetRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (status !== undefined) {
      assertEnumValue(status, catalogSeedStatuses, "status");
    }
    const rows =
      status === undefined
        ? await this.db
            .select()
            .from(catalogSeedTargets)
            .orderBy(desc(catalogSeedTargets.priority), catalogSeedTargets.addedAt)
        : await this.db
            .select()
            .from(catalogSeedTargets)
            .where(eq(catalogSeedTargets.status, status))
            .orderBy(desc(catalogSeedTargets.priority), catalogSeedTargets.addedAt);
    return rows.map(seedTargetFromRow);
  }

  async listCatalogCandidateTargetWorks(
    actor: AuthorizationActor,
  ): Promise<CatalogCandidateTargetWorkRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select({
        workId: catalogWorks.workId,
        canonicalTitle: catalogWorks.canonicalTitle,
        firstReleaseYear: catalogWorks.firstReleaseYear,
        originalLanguage: catalogWorks.originalLanguage,
        workKind: catalogWorks.workKind,
      })
      .from(catalogWorks)
      .orderBy(catalogWorks.canonicalTitle, catalogWorks.workId);
    return rows;
  }

  async recordCatalogCandidateMatch(
    actor: AuthorizationActor,
    input: CatalogCandidateMatchInput,
  ): Promise<CatalogCandidateMatchRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertCandidateMatchInput(input);
    const rows = await this.db
      .insert(catalogCandidateMatches)
      .values(normalized)
      .onConflictDoUpdate({
        target: [
          catalogCandidateMatches.sourceCatalogSource,
          catalogCandidateMatches.sourceId,
          catalogCandidateMatches.targetWorkId,
          catalogCandidateMatches.generatorVersion,
        ],
        set: {
          sourceTitle: normalized.sourceTitle,
          sourceProvenanceId: normalized.sourceProvenanceId,
          score: normalized.score,
          matchedFields: normalized.matchedFields,
          status: normalized.status,
          diagnosticCode: normalized.diagnosticCode,
          metadata: normalized.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return candidateMatchFromRow(requiredRow(rows, normalized.candidateId));
  }

  async listCatalogCandidateMatches(
    actor: AuthorizationActor,
    status?: CatalogCandidateMatchStatus,
  ): Promise<CatalogCandidateMatchRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (status !== undefined) {
      assertEnumValue(status, catalogCandidateMatchStatuses, "status");
    }
    const rows =
      status === undefined
        ? await this.db
            .select()
            .from(catalogCandidateMatches)
            .orderBy(desc(catalogCandidateMatches.score), catalogCandidateMatches.createdAt)
        : await this.db
            .select()
            .from(catalogCandidateMatches)
            .where(eq(catalogCandidateMatches.status, status))
            .orderBy(desc(catalogCandidateMatches.score), catalogCandidateMatches.createdAt);
    return rows.map(candidateMatchFromRow);
  }
}

async function recordSourceProvenanceUnchecked(
  db: ItotoriDatabase,
  input: NormalizedSourceProvenanceInput,
): Promise<CatalogSourceProvenanceRecord> {
  const rows = await db
    .insert(catalogSourceProvenance)
    .values(input)
    .onConflictDoUpdate({
      target: catalogSourceProvenance.sourceProvenanceId,
      set: {
        catalogSource: input.catalogSource,
        sourceRecordKind: input.sourceRecordKind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        requestId: input.requestId,
        httpStatus: input.httpStatus,
        ok: input.ok,
        payloadHash: input.payloadHash,
        payload: input.payload,
        fetchedAt: input.fetchedAt,
        metadata: input.metadata,
      },
    })
    .returning();
  return sourceProvenanceFromRow(requiredRow(rows, input.sourceProvenanceId));
}

async function recordSeedTargetUnchecked(
  db: ItotoriDatabase,
  input: NormalizedSeedTargetInput,
): Promise<CatalogSeedTargetRecord> {
  const result = await db.execute<typeof catalogSeedTargets.$inferSelect>(sql`
    insert into ${catalogSeedTargets} (
      seed_target_id,
      catalog_source,
      source_id,
      seed_origin,
      origin_ref,
      local_scan_entry_id,
      source_provenance_id,
      status,
      priority,
      added_at,
      metadata
    )
    values (
      ${input.seedTargetId},
      ${input.catalogSource},
      ${input.sourceId},
      ${input.seedOrigin},
      ${input.originRef},
      ${input.localScanEntryId},
      ${input.sourceProvenanceId},
      ${input.status},
      ${input.priority},
      ${input.addedAt},
      ${input.metadata}::jsonb
    )
    on conflict (catalog_source, source_id, seed_origin, coalesce(origin_ref, ''))
    do update set
      catalog_source = excluded.catalog_source,
      source_id = excluded.source_id,
      seed_origin = excluded.seed_origin,
      origin_ref = excluded.origin_ref,
      local_scan_entry_id = excluded.local_scan_entry_id,
      source_provenance_id = excluded.source_provenance_id,
      status = excluded.status,
      priority = excluded.priority,
      added_at = excluded.added_at,
      metadata = excluded.metadata,
      updated_at = now()
    returning
      seed_target_id as "seedTargetId",
      catalog_source as "catalogSource",
      source_id as "sourceId",
      seed_origin as "seedOrigin",
      origin_ref as "originRef",
      local_scan_entry_id as "localScanEntryId",
      source_provenance_id as "sourceProvenanceId",
      status,
      priority,
      added_at as "addedAt",
      metadata,
      updated_at as "updatedAt"
  `);
  return seedTargetFromRow(requiredRow(result.rows, input.seedTargetId));
}

async function readWorkSnapshot(
  db: ItotoriDatabase,
  workId: string,
): Promise<CatalogWorkSnapshot | null> {
  const workRows = await db
    .select()
    .from(catalogWorks)
    .where(eq(catalogWorks.workId, workId))
    .limit(1);
  const workRow = workRows[0];
  if (workRow === undefined) {
    return null;
  }

  const [externalIdRows, releaseRows, languageStatusRows, conflictRows, localScanEntryRows] =
    await Promise.all([
      db.select().from(catalogExternalIds).where(eq(catalogExternalIds.workId, workId)),
      db.select().from(catalogReleases).where(eq(catalogReleases.workId, workId)),
      db.select().from(catalogLanguageStatuses).where(eq(catalogLanguageStatuses.workId, workId)),
      db.select().from(catalogConflicts).where(eq(catalogConflicts.workId, workId)),
      db.select().from(catalogLocalScanEntries).where(eq(catalogLocalScanEntries.workId, workId)),
    ]);
  const localScanEntryIds = localScanEntryRows.map((row) => row.localScanEntryId);
  const seedTargetRows =
    localScanEntryIds.length === 0
      ? []
      : await db
          .select()
          .from(catalogSeedTargets)
          .where(inArray(catalogSeedTargets.localScanEntryId, localScanEntryIds));

  const conflictEvidenceRows =
    conflictRows.length === 0
      ? []
      : await db
          .select()
          .from(catalogConflictEvidence)
          .where(
            inArray(
              catalogConflictEvidence.conflictId,
              conflictRows.map((row) => row.conflictId),
            ),
          );
  const evidenceByConflict = new Map<string, CatalogConflictEvidenceRecord[]>();
  for (const row of conflictEvidenceRows) {
    const evidence = conflictEvidenceFromRow(row);
    const existing = evidenceByConflict.get(evidence.conflictId) ?? [];
    existing.push(evidence);
    evidenceByConflict.set(evidence.conflictId, existing);
  }

  const localScanEntries = await localScanEntriesWithChildren(db, localScanEntryRows);

  return {
    ...workFromRow(workRow),
    externalIds: externalIdRows.map(externalIdFromRow),
    releases: releaseRows.map(releaseFromRow),
    languageStatuses: languageStatusRows.map(languageStatusFromRow),
    conflicts: conflictRows.map((row) => ({
      ...conflictFromRow(row),
      evidence: evidenceByConflict.get(row.conflictId) ?? [],
    })),
    localScanEntries,
    seedTargets: seedTargetRows.map(seedTargetFromRow),
  };
}

async function readLocalScan(
  db: ItotoriDatabase,
  localScanId: string,
): Promise<CatalogLocalScanRecord | null> {
  const scanRows = await db
    .select()
    .from(catalogLocalScans)
    .where(eq(catalogLocalScans.localScanId, localScanId))
    .limit(1);
  const scanRow = scanRows[0];
  if (scanRow === undefined) {
    return null;
  }

  const entryRows = await db
    .select()
    .from(catalogLocalScanEntries)
    .where(eq(catalogLocalScanEntries.localScanId, localScanId));
  return {
    ...localScanFromRow(scanRow),
    entries: await localScanEntriesWithChildren(db, entryRows),
  };
}

async function localScanEntriesWithChildren(
  db: ItotoriDatabase,
  entries: (typeof catalogLocalScanEntries.$inferSelect)[],
): Promise<CatalogLocalScanEntryRecord[]> {
  const records: CatalogLocalScanEntryRecord[] = [];
  for (const entry of entries) {
    const [detectedExternalIdRows, seedTargetRows] = await Promise.all([
      db
        .select()
        .from(catalogLocalScanExternalIds)
        .where(eq(catalogLocalScanExternalIds.localScanEntryId, entry.localScanEntryId)),
      db
        .select()
        .from(catalogSeedTargets)
        .where(eq(catalogSeedTargets.localScanEntryId, entry.localScanEntryId)),
    ]);
    records.push({
      ...localScanEntryFromRow(entry),
      detectedExternalIds: detectedExternalIdRows.map(localScanDetectedExternalIdFromRow),
      seedTargets: seedTargetRows.map(seedTargetFromRow),
    });
  }
  return records;
}

type NormalizedSourceProvenanceInput = {
  sourceProvenanceId: string;
  catalogSource: CatalogSource;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceId: string;
  sourceVersion: string | null;
  requestId: string | null;
  httpStatus: number | null;
  ok: boolean;
  payloadHash: string | null;
  payload: CatalogJsonRecord;
  fetchedAt: Date;
  metadata: CatalogJsonRecord;
};

function assertSourceProvenanceInput(
  input: CatalogSourceProvenanceInput,
): NormalizedSourceProvenanceInput {
  assertEnumValue(input.catalogSource, catalogSources, "catalogSource");
  assertEnumValue(input.sourceRecordKind, catalogSourceRecordKinds, "sourceRecordKind");
  const httpStatus = input.httpStatus ?? null;
  if (
    httpStatus !== null &&
    (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
  ) {
    throw new Error("httpStatus must be a valid HTTP status code");
  }
  if (input.payloadHash !== undefined) {
    assertSha256(input.payloadHash, "payloadHash");
  }
  return {
    sourceProvenanceId: input.sourceProvenanceId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceRecordKind: input.sourceRecordKind,
    sourceId: requiredString(input.sourceId, "sourceId"),
    sourceVersion: optionalString(input.sourceVersion, "sourceVersion"),
    requestId: optionalString(input.requestId, "requestId"),
    httpStatus,
    ok: input.ok ?? true,
    payloadHash: input.payloadHash ?? null,
    payload: jsonRecord(input.payload ?? {}, "payload"),
    fetchedAt: dateInput(input.fetchedAt, "fetchedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
  };
}

type NormalizedCatalogWorkInput = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  firstReleaseYear: number | null;
  workKind: string;
  engine: NormalizedCatalogEngineInput | null;
  metadata: CatalogJsonRecord;
  externalIds: NormalizedExternalIdInput[];
  releases: NormalizedReleaseInput[];
  languageStatuses: NormalizedLanguageStatusInput[];
  conflicts: NormalizedConflictInput[];
};

type NormalizedCatalogEngineInput = {
  engineName: string;
  engineSource: CatalogEngineSource;
  engineConfidence: CatalogConfidence;
  engineProvenanceId: string | null;
};

type NormalizedExternalIdInput = {
  externalIdId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  discoveredAt: Date;
  metadata: CatalogJsonRecord;
};

type NormalizedReleaseInput = {
  releaseId: string;
  catalogSource: CatalogSource;
  sourceReleaseId: string | null;
  releaseTitle: string;
  releaseKind: CatalogReleaseKind;
  platform: string | null;
  language: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  isOfficial: boolean;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
};

type NormalizedLanguageStatusInput = {
  languageStatusId: string;
  language: string;
  status: CatalogLanguageStatus;
  statusScope: CatalogLanguageStatusScope;
  platform: string | null;
  releaseId: string | null;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  isCurrent: boolean;
  observedAt: Date;
  metadata: CatalogJsonRecord;
};

type NormalizedConflictInput = {
  conflictId: string;
  conflictKind: CatalogConflictKind;
  status: CatalogConflictStatus;
  summary: string;
  detectedAt: Date;
  metadata: CatalogJsonRecord;
  evidence: NormalizedConflictEvidenceInput[];
};

type NormalizedConflictEvidenceInput = {
  conflictEvidenceId: string;
  subjectKind: CatalogConflictSubjectKind;
  subjectId: string;
  sourceProvenanceId: string | null;
  evidencePosition: number;
  metadata: CatalogJsonRecord;
};

function assertCatalogWorkInput(input: CatalogWorkInput): NormalizedCatalogWorkInput {
  const firstReleaseYear = optionalYear(input.firstReleaseYear, "firstReleaseYear");
  let engine: NormalizedCatalogEngineInput | null = null;
  if (input.engine !== undefined) {
    assertEnumValue(input.engine.engineSource, catalogEngineSources, "engine.engineSource");
    if (input.engine.engineConfidence !== undefined) {
      assertEnumValue(input.engine.engineConfidence, catalogConfidences, "engine.engineConfidence");
    }
    engine = {
      engineName: requiredString(input.engine.engineName, "engine.engineName"),
      engineSource: input.engine.engineSource,
      engineConfidence: input.engine.engineConfidence ?? catalogConfidenceValues.unknown,
      engineProvenanceId: input.engine.engineProvenanceId ?? null,
    };
  }

  return {
    workId: input.workId ?? createUuid7(),
    canonicalTitle: requiredString(input.canonicalTitle, "canonicalTitle"),
    originalLanguage: optionalString(input.originalLanguage, "originalLanguage"),
    firstReleaseYear,
    workKind: input.workKind === undefined ? "game" : requiredString(input.workKind, "workKind"),
    engine,
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
    externalIds: (input.externalIds ?? []).map(assertExternalIdInput),
    releases: (input.releases ?? []).map(assertReleaseInput),
    languageStatuses: (input.languageStatuses ?? []).map(assertLanguageStatusInput),
    conflicts: (input.conflicts ?? []).map(assertConflictInput),
  };
}

function assertExternalIdInput(input: CatalogExternalIdInput): NormalizedExternalIdInput {
  assertEnumValue(input.catalogSource, catalogSources, "externalId.catalogSource");
  if (input.externalIdKind !== undefined) {
    assertEnumValue(input.externalIdKind, catalogExternalIdKinds, "externalId.externalIdKind");
  }
  if (input.confidence !== undefined) {
    assertEnumValue(input.confidence, catalogConfidences, "externalId.confidence");
  }
  return {
    externalIdId: input.externalIdId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceId: requiredString(input.sourceId, "externalId.sourceId"),
    externalIdKind: input.externalIdKind ?? catalogExternalIdKindValues.sourceRecord,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    confidence: input.confidence ?? catalogConfidenceValues.high,
    discoveredAt:
      input.discoveredAt === undefined ? new Date() : dateInput(input.discoveredAt, "discoveredAt"),
    metadata: jsonRecord(input.metadata ?? {}, "externalId.metadata"),
  };
}

function assertReleaseInput(input: CatalogReleaseInput): NormalizedReleaseInput {
  assertEnumValue(input.catalogSource, catalogSources, "release.catalogSource");
  if (input.releaseKind !== undefined) {
    assertEnumValue(input.releaseKind, catalogReleaseKinds, "release.releaseKind");
  }
  return {
    releaseId: input.releaseId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceReleaseId: optionalString(input.sourceReleaseId, "release.sourceReleaseId"),
    releaseTitle: requiredString(input.releaseTitle, "release.releaseTitle"),
    releaseKind: input.releaseKind ?? catalogReleaseKindValues.unknown,
    platform: optionalString(input.platform, "release.platform"),
    language: optionalString(input.language, "release.language"),
    releaseDate: optionalString(input.releaseDate, "release.releaseDate"),
    releaseYear: optionalYear(input.releaseYear, "release.releaseYear"),
    isOfficial: input.isOfficial ?? false,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    metadata: jsonRecord(input.metadata ?? {}, "release.metadata"),
  };
}

function assertLanguageStatusInput(
  input: CatalogLanguageStatusInput,
): NormalizedLanguageStatusInput {
  assertEnumValue(input.status, catalogLanguageStatusEnums, "languageStatus.status");
  if (input.statusScope !== undefined) {
    assertEnumValue(input.statusScope, catalogLanguageStatusScopes, "languageStatus.statusScope");
  }
  if (input.confidence !== undefined) {
    assertEnumValue(input.confidence, catalogConfidences, "languageStatus.confidence");
  }
  return {
    languageStatusId: input.languageStatusId ?? createUuid7(),
    language: requiredString(input.language, "languageStatus.language"),
    status: input.status,
    statusScope: input.statusScope ?? catalogLanguageStatusScopeValues.work,
    platform: optionalString(input.platform, "languageStatus.platform"),
    releaseId: input.releaseId ?? null,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    confidence: input.confidence ?? catalogConfidenceValues.high,
    isCurrent: input.isCurrent ?? true,
    observedAt:
      input.observedAt === undefined ? new Date() : dateInput(input.observedAt, "observedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "languageStatus.metadata"),
  };
}

function assertConflictInput(input: CatalogConflictInput): NormalizedConflictInput {
  assertEnumValue(input.conflictKind, catalogConflictKinds, "conflict.conflictKind");
  if (input.status !== undefined) {
    assertEnumValue(input.status, catalogConflictStatuses, "conflict.status");
  }
  return {
    conflictId: input.conflictId ?? createUuid7(),
    conflictKind: input.conflictKind,
    status: input.status ?? catalogConflictStatusValues.open,
    summary: requiredString(input.summary, "conflict.summary"),
    detectedAt:
      input.detectedAt === undefined ? new Date() : dateInput(input.detectedAt, "detectedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "conflict.metadata"),
    evidence: (input.evidence ?? []).map(assertConflictEvidenceInput),
  };
}

function assertConflictEvidenceInput(
  input: CatalogConflictEvidenceInput,
): NormalizedConflictEvidenceInput {
  assertEnumValue(input.subjectKind, catalogConflictSubjectKinds, "conflict.evidence.subjectKind");
  const evidencePosition = input.evidencePosition ?? 0;
  if (!Number.isInteger(evidencePosition) || evidencePosition < 0) {
    throw new Error("conflict.evidence.evidencePosition must be a non-negative integer");
  }
  return {
    conflictEvidenceId: input.conflictEvidenceId ?? createUuid7(),
    subjectKind: input.subjectKind,
    subjectId: requiredString(input.subjectId, "conflict.evidence.subjectId"),
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    evidencePosition,
    metadata: jsonRecord(input.metadata ?? {}, "conflict.evidence.metadata"),
  };
}

type NormalizedLocalScanInput = {
  localScanId: string;
  scanRootLabel: string;
  scanRootPathHash: string;
  scannerName: string;
  scannerVersion: string;
  startedAt: Date;
  completedAt: Date;
  metadata: CatalogJsonRecord;
  entries: NormalizedLocalScanEntryInput[];
};

type NormalizedLocalScanEntryInput = {
  localScanEntryId: string;
  workId: string | null;
  pathHash: string;
  pathRedactionClass: CatalogPathRedactionClass;
  owned: boolean;
  engineName: string | null;
  engineSource: CatalogEngineSource | null;
  engineConfidence: CatalogConfidence | null;
  signals: CatalogJsonRecord;
  sourceProvenanceId: string | null;
  scannedAt: Date;
  metadata: CatalogJsonRecord;
  detectedExternalIds: NormalizedLocalScanDetectedExternalIdInput[];
  seedTargets: NormalizedSeedTargetInput[];
};

type NormalizedLocalScanDetectedExternalIdInput = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
};

type NormalizedSeedTargetInput = {
  seedTargetId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  seedOrigin: CatalogSeedOrigin;
  originRef: string | null;
  localScanEntryId: string | null;
  sourceProvenanceId: string | null;
  status: CatalogSeedStatus;
  priority: number;
  addedAt: Date;
  metadata: CatalogJsonRecord;
};

type NormalizedCandidateMatchInput = {
  candidateId: string;
  sourceCatalogSource: CatalogSource;
  sourceId: string;
  sourceTitle: string;
  sourceProvenanceId: string | null;
  targetWorkId: string;
  score: number;
  matchedFields: CatalogJsonRecord;
  status: CatalogCandidateMatchStatus;
  diagnosticCode: string;
  generatorVersion: string;
  metadata: CatalogJsonRecord;
};

function assertLocalScanInput(input: CatalogLocalScanInput): NormalizedLocalScanInput {
  assertSha256(input.scanRootPathHash, "scanRootPathHash");
  const startedAt =
    input.startedAt === undefined ? new Date() : dateInput(input.startedAt, "startedAt");
  const completedAt =
    input.completedAt === undefined ? startedAt : dateInput(input.completedAt, "completedAt");
  if (completedAt.getTime() < startedAt.getTime()) {
    throw new Error("completedAt must not be before startedAt");
  }
  return {
    localScanId: input.localScanId ?? createUuid7(),
    scanRootLabel: requiredString(input.scanRootLabel, "scanRootLabel"),
    scanRootPathHash: input.scanRootPathHash,
    scannerName: requiredString(input.scannerName, "scannerName"),
    scannerVersion: requiredString(input.scannerVersion, "scannerVersion"),
    startedAt,
    completedAt,
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
    entries: input.entries.map((entry) => assertLocalScanEntryInput(entry, completedAt)),
  };
}

function assertLocalScanEntryInput(
  input: CatalogLocalScanEntryInput,
  defaultScannedAt: Date,
): NormalizedLocalScanEntryInput {
  assertSha256(input.pathHash, "entry.pathHash");
  if (input.pathRedactionClass !== undefined) {
    assertEnumValue(
      input.pathRedactionClass,
      catalogPathRedactionClasses,
      "entry.pathRedactionClass",
    );
  }
  if (input.engineSource !== undefined) {
    assertEnumValue(input.engineSource, catalogEngineSources, "entry.engineSource");
  }
  if (input.engineConfidence !== undefined) {
    assertEnumValue(input.engineConfidence, catalogConfidences, "entry.engineConfidence");
  }
  const normalizedEntryId = input.localScanEntryId ?? createUuid7();
  return {
    localScanEntryId: normalizedEntryId,
    workId: input.workId ?? null,
    pathHash: input.pathHash,
    pathRedactionClass: input.pathRedactionClass ?? catalogPathRedactionClassValues.privatePathHash,
    owned: input.owned ?? true,
    engineName: optionalString(input.engineName, "entry.engineName"),
    engineSource: input.engineSource ?? null,
    engineConfidence: input.engineConfidence ?? null,
    signals: jsonRecord(input.signals ?? {}, "entry.signals"),
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    scannedAt:
      input.scannedAt === undefined
        ? defaultScannedAt
        : dateInput(input.scannedAt, "entry.scannedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "entry.metadata"),
    detectedExternalIds: (input.detectedExternalIds ?? []).map(
      assertLocalScanDetectedExternalIdInput,
    ),
    seedTargets: (input.seedTargets ?? []).map((seedTarget) =>
      assertSeedTargetInput({
        ...seedTarget,
        localScanEntryId: seedTarget.localScanEntryId ?? normalizedEntryId,
      }),
    ),
  };
}

function assertLocalScanDetectedExternalIdInput(
  input: CatalogLocalScanDetectedExternalIdInput,
): NormalizedLocalScanDetectedExternalIdInput {
  assertEnumValue(input.catalogSource, catalogSources, "detectedExternalId.catalogSource");
  if (input.externalIdKind !== undefined) {
    assertEnumValue(
      input.externalIdKind,
      catalogExternalIdKinds,
      "detectedExternalId.externalIdKind",
    );
  }
  return {
    catalogSource: input.catalogSource,
    sourceId: requiredString(input.sourceId, "detectedExternalId.sourceId"),
    externalIdKind: input.externalIdKind ?? catalogExternalIdKindValues.localDetection,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    metadata: jsonRecord(input.metadata ?? {}, "detectedExternalId.metadata"),
  };
}

function assertSeedTargetInput(input: CatalogSeedTargetInput): NormalizedSeedTargetInput {
  assertEnumValue(input.catalogSource, catalogSources, "seedTarget.catalogSource");
  if (input.seedOrigin !== undefined) {
    assertEnumValue(input.seedOrigin, catalogSeedOrigins, "seedTarget.seedOrigin");
  }
  if (input.status !== undefined) {
    assertEnumValue(input.status, catalogSeedStatuses, "seedTarget.status");
  }
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority)) {
    throw new Error("seedTarget.priority must be an integer");
  }
  return {
    seedTargetId: input.seedTargetId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceId: requiredString(input.sourceId, "seedTarget.sourceId"),
    seedOrigin: input.seedOrigin ?? catalogSeedOriginValues.manual,
    originRef: optionalString(input.originRef, "seedTarget.originRef"),
    localScanEntryId: input.localScanEntryId ?? null,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    status: input.status ?? catalogSeedStatusValues.pending,
    priority,
    addedAt:
      input.addedAt === undefined ? new Date() : dateInput(input.addedAt, "seedTarget.addedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "seedTarget.metadata"),
  };
}

function assertCandidateMatchInput(
  input: CatalogCandidateMatchInput,
): NormalizedCandidateMatchInput {
  assertEnumValue(input.sourceCatalogSource, catalogSources, "candidate.sourceCatalogSource");
  if (input.status !== undefined) {
    assertEnumValue(input.status, catalogCandidateMatchStatuses, "candidate.status");
  }
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 1000) {
    throw new Error("candidate.score must be an integer between 0 and 1000");
  }
  return {
    candidateId: input.candidateId ?? createUuid7(),
    sourceCatalogSource: input.sourceCatalogSource,
    sourceId: requiredString(input.sourceId, "candidate.sourceId"),
    sourceTitle: requiredString(input.sourceTitle, "candidate.sourceTitle"),
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    targetWorkId: requiredString(input.targetWorkId, "candidate.targetWorkId"),
    score: input.score,
    matchedFields: jsonRecord(input.matchedFields, "candidate.matchedFields"),
    status: input.status ?? catalogCandidateMatchStatusValues.reviewPending,
    diagnosticCode: requiredString(input.diagnosticCode, "candidate.diagnosticCode"),
    generatorVersion: requiredString(input.generatorVersion, "candidate.generatorVersion"),
    metadata: jsonRecord(input.metadata ?? {}, "candidate.metadata"),
  };
}

function sourceProvenanceFromRow(
  row: typeof catalogSourceProvenance.$inferSelect,
): CatalogSourceProvenanceRecord {
  return {
    sourceProvenanceId: row.sourceProvenanceId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceRecordKind: row.sourceRecordKind as CatalogSourceRecordKind,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    requestId: row.requestId,
    httpStatus: row.httpStatus,
    ok: row.ok,
    payloadHash: row.payloadHash,
    payload: row.payload,
    fetchedAt: row.fetchedAt,
    metadata: row.metadata,
    recordedAt: row.recordedAt,
  };
}

function workFromRow(row: typeof catalogWorks.$inferSelect): CatalogWorkRecord {
  return {
    workId: row.workId,
    canonicalTitle: row.canonicalTitle,
    originalLanguage: row.originalLanguage,
    firstReleaseYear: row.firstReleaseYear,
    workKind: row.workKind,
    engineName: row.engineName,
    engineSource: row.engineSource as CatalogEngineSource | null,
    engineConfidence: row.engineConfidence as CatalogConfidence | null,
    engineProvenanceId: row.engineProvenanceId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function externalIdFromRow(row: typeof catalogExternalIds.$inferSelect): CatalogExternalIdRecord {
  return {
    externalIdId: row.externalIdId,
    workId: row.workId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceId: row.sourceId,
    externalIdKind: row.externalIdKind as CatalogExternalIdKind,
    sourceProvenanceId: row.sourceProvenanceId,
    confidence: row.confidence as CatalogConfidence,
    discoveredAt: row.discoveredAt,
    metadata: row.metadata,
  };
}

function releaseFromRow(row: typeof catalogReleases.$inferSelect): CatalogReleaseRecord {
  return {
    releaseId: row.releaseId,
    workId: row.workId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceReleaseId: row.sourceReleaseId,
    releaseTitle: row.releaseTitle,
    releaseKind: row.releaseKind as CatalogReleaseKind,
    platform: row.platform,
    language: row.language,
    releaseDate: row.releaseDate,
    releaseYear: row.releaseYear,
    isOfficial: row.isOfficial,
    sourceProvenanceId: row.sourceProvenanceId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function languageStatusFromRow(
  row: typeof catalogLanguageStatuses.$inferSelect,
): CatalogLanguageStatusRecord {
  return {
    languageStatusId: row.languageStatusId,
    workId: row.workId,
    language: row.language,
    status: row.status as CatalogLanguageStatus,
    statusScope: row.statusScope as CatalogLanguageStatusScope,
    platform: row.platform,
    releaseId: row.releaseId,
    sourceProvenanceId: row.sourceProvenanceId,
    confidence: row.confidence as CatalogConfidence,
    isCurrent: row.isCurrent,
    observedAt: row.observedAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function conflictFromRow(
  row: typeof catalogConflicts.$inferSelect,
): Omit<CatalogConflictRecord, "evidence"> {
  return {
    conflictId: row.conflictId,
    workId: row.workId,
    conflictKind: row.conflictKind as CatalogConflictKind,
    status: row.status as CatalogConflictStatus,
    summary: row.summary,
    detectedAt: row.detectedAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function conflictEvidenceFromRow(
  row: typeof catalogConflictEvidence.$inferSelect,
): CatalogConflictEvidenceRecord {
  return {
    conflictEvidenceId: row.conflictEvidenceId,
    conflictId: row.conflictId,
    subjectKind: row.subjectKind as CatalogConflictSubjectKind,
    subjectId: row.subjectId,
    sourceProvenanceId: row.sourceProvenanceId,
    evidencePosition: row.evidencePosition,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function localScanFromRow(
  row: typeof catalogLocalScans.$inferSelect,
): Omit<CatalogLocalScanRecord, "entries"> {
  return {
    localScanId: row.localScanId,
    scanRootLabel: row.scanRootLabel,
    scanRootPathHash: row.scanRootPathHash,
    scannerName: row.scannerName,
    scannerVersion: row.scannerVersion,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdByUserId: row.createdByUserId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function localScanEntryFromRow(
  row: typeof catalogLocalScanEntries.$inferSelect,
): Omit<CatalogLocalScanEntryRecord, "detectedExternalIds" | "seedTargets"> {
  return {
    localScanEntryId: row.localScanEntryId,
    localScanId: row.localScanId,
    workId: row.workId,
    pathHash: row.pathHash,
    pathRedactionClass: row.pathRedactionClass as CatalogPathRedactionClass,
    owned: row.owned,
    engineName: row.engineName,
    engineSource: row.engineSource as CatalogEngineSource | null,
    engineConfidence: row.engineConfidence as CatalogConfidence | null,
    signals: row.signals,
    sourceProvenanceId: row.sourceProvenanceId,
    scannedAt: row.scannedAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function localScanDetectedExternalIdFromRow(
  row: typeof catalogLocalScanExternalIds.$inferSelect,
): CatalogLocalScanDetectedExternalIdRecord {
  return {
    localScanEntryId: row.localScanEntryId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceId: row.sourceId,
    externalIdKind: row.externalIdKind as CatalogExternalIdKind,
    sourceProvenanceId: row.sourceProvenanceId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function seedTargetFromRow(row: typeof catalogSeedTargets.$inferSelect): CatalogSeedTargetRecord {
  return {
    seedTargetId: row.seedTargetId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceId: row.sourceId,
    seedOrigin: row.seedOrigin as CatalogSeedOrigin,
    originRef: row.originRef,
    localScanEntryId: row.localScanEntryId,
    sourceProvenanceId: row.sourceProvenanceId,
    status: row.status as CatalogSeedStatus,
    priority: row.priority,
    addedAt: row.addedAt,
    metadata: row.metadata,
    updatedAt: row.updatedAt,
  };
}

function candidateMatchFromRow(
  row: typeof catalogCandidateMatches.$inferSelect,
): CatalogCandidateMatchRecord {
  return {
    candidateId: row.candidateId,
    sourceCatalogSource: row.sourceCatalogSource as CatalogSource,
    sourceId: row.sourceId,
    sourceTitle: row.sourceTitle,
    sourceProvenanceId: row.sourceProvenanceId,
    targetWorkId: row.targetWorkId,
    score: row.score,
    matchedFields: row.matchedFields,
    status: row.status as CatalogCandidateMatchStatus,
    diagnosticCode: row.diagnosticCode,
    generatorVersion: row.generatorVersion,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requiredSnapshot(
  snapshot: CatalogWorkSnapshot | null,
  workId: string,
): CatalogWorkSnapshot {
  if (snapshot === null) {
    throw new Error(`catalog work ${workId} was not persisted`);
  }
  return snapshot;
}

function requiredLocalScan(
  scan: CatalogLocalScanRecord | null,
  localScanId: string,
): CatalogLocalScanRecord {
  if (scan === null) {
    throw new Error(`local scan ${localScanId} was not persisted`);
  }
  return scan;
}

function requiredRow<T>(rows: T[], id: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`record ${id} was not persisted`);
  }
  return row;
}

function requiredString(value: string | undefined, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function optionalString(value: string | undefined, fieldName: string): string | null {
  if (value === undefined) {
    return null;
  }
  return requiredString(value, fieldName);
}

function optionalYear(value: number | undefined, fieldName: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1970 || value > 2200) {
    throw new Error(`${fieldName} must be an integer year`);
  }
  return value;
}

function dateInput(value: CatalogDateInput, fieldName: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

function jsonRecord(value: CatalogJsonRecord, fieldName: string): CatalogJsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return value;
}

function assertSha256(value: string, fieldName: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${fieldName} must be a sha256 hash`);
  }
}

function assertEnumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  fieldName: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${fieldName} must be one of ${allowed.join(", ")}`);
  }
}
