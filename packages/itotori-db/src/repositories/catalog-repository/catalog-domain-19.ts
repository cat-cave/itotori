import {
  CatalogSource,
  ItotoriDatabase,
  and,
  catalogConflictSubjectKindValues,
  catalogExternalIds,
  catalogLanguageStatuses,
  catalogReleases,
  catalogSourceProvenance,
  catalogWorks,
  inArray,
} from "./dependencies.js";
import {
  CatalogArtifactMappingError,
  CatalogArtifactMappingErrorCode,
} from "./catalog-domain-01.js";
import { CatalogConflictReviewSourceId } from "./catalog-domain-02.js";
import { catalogSources } from "./catalog-domain-04.js";
import { NormalizedCatalogWorkInput } from "./catalog-domain-17.js";

export async function assertConflictEvidenceSubjectReferences(
  db: ItotoriDatabase,
  input: NormalizedCatalogWorkInput,
): Promise<void> {
  const externalIdSubjects = new Set<string>();
  const releaseSubjects = new Set<string>();
  const languageStatusSubjects = new Set<string>();
  const workSubjects = new Set<string>();
  const sourceProvenanceSubjects = new Set<string>();

  for (const conflict of input.conflicts) {
    for (const evidence of conflict.evidence) {
      switch (evidence.subjectKind) {
        case catalogConflictSubjectKindValues.externalId:
          externalIdSubjects.add(evidence.subjectId);
          break;
        case catalogConflictSubjectKindValues.release:
          releaseSubjects.add(evidence.subjectId);
          break;
        case catalogConflictSubjectKindValues.languageStatus:
          languageStatusSubjects.add(evidence.subjectId);
          break;
        case catalogConflictSubjectKindValues.work:
          workSubjects.add(evidence.subjectId);
          break;
        case catalogConflictSubjectKindValues.sourceProvenance:
          sourceProvenanceSubjects.add(evidence.subjectId);
          break;
      }
    }
  }

  // CHILD kinds (externalId/release/languageStatus) are PARENT-SCOPED BY CONTRACT
  // (CATALOG-079). A child subject names a LOCAL row of the parent work — either created
  // in this same upsert or already persisted under `input.workId`. Unlike `sourceProvenance`
  // (below), a child kind NEVER accepts a `<catalogSource>:<sourceId>` cross-source identity:
  // cross-source disagreement evidence must route through the `sourceProvenance` kind. The
  // sole cross-source emitter enforces exactly this — `catalog-platform-language-conflicts`
  // emits the `languageStatus` child kind only when it holds a real local `languageStatusId`,
  // and falls back to the `sourceProvenance` kind (carrying the cross-source identity) when it
  // does not. `assertWorkScopedConflictSubjects` PINS this asymmetry: a child subject bearing a
  // cross-source identity is rejected as a CALLER ERROR with a clear message, not silently
  // over-rejected as a dangling id.
  await assertWorkScopedConflictSubjects(
    externalIdSubjects,
    new Set(input.externalIds.map((externalId) => externalId.externalIdId)),
    input.workId,
    "external id",
    async (ids) => {
      const rows = await db
        .select({ id: catalogExternalIds.externalIdId, workId: catalogExternalIds.workId })
        .from(catalogExternalIds)
        .where(inArray(catalogExternalIds.externalIdId, ids));
      return new Map(rows.map((row) => [row.id, row.workId]));
    },
  );

  await assertWorkScopedConflictSubjects(
    releaseSubjects,
    new Set(input.releases.map((release) => release.releaseId)),
    input.workId,
    "release",
    async (ids) => {
      const rows = await db
        .select({ id: catalogReleases.releaseId, workId: catalogReleases.workId })
        .from(catalogReleases)
        .where(inArray(catalogReleases.releaseId, ids));
      return new Map(rows.map((row) => [row.id, row.workId]));
    },
  );

  await assertWorkScopedConflictSubjects(
    languageStatusSubjects,
    new Set(input.languageStatuses.map((languageStatus) => languageStatus.languageStatusId)),
    input.workId,
    "language status",
    async (ids) => {
      const rows = await db
        .select({
          id: catalogLanguageStatuses.languageStatusId,
          workId: catalogLanguageStatuses.workId,
        })
        .from(catalogLanguageStatuses)
        .where(inArray(catalogLanguageStatuses.languageStatusId, ids));
      return new Map(rows.map((row) => [row.id, row.workId]));
    },
  );

  // `work`-kind subjects name a work directly. Two identities are legitimate:
  //   1. The parent work being upserted (inserted in this same transaction).
  //   2. A DIFFERENT known work — competing/duplicate-work conflicts inherently
  //      reference the OTHER work they compete with (e.g. a duplicate-detection
  //      conflict on work A cites the competing work B). Cross-work references
  //      are therefore accepted as long as the referenced work EXISTS. This
  //      mirrors the `sourceProvenance` fix (commit b8d3fd0e): conflict evidence
  //      legitimately references entities other than the parent, so the guard
  //      only rejects DANGLING/UNKNOWN ids, never known cross-references.
  // Anything that names neither the parent nor a persisted work is dangling and
  // is rejected (CATALOG-079 dangling protection).
  const otherWorkSubjects = [...workSubjects].filter((id) => id !== input.workId);
  if (otherWorkSubjects.length > 0) {
    const rows = await db
      .select({ id: catalogWorks.workId })
      .from(catalogWorks)
      .where(inArray(catalogWorks.workId, otherWorkSubjects));
    const knownWorkIds = new Set(rows.map((row) => row.id));
    for (const subjectId of otherWorkSubjects) {
      if (knownWorkIds.has(subjectId)) {
        continue;
      }
      throw new CatalogArtifactMappingError(
        "conflict_evidence_subject_unknown",
        `conflict.evidence subjectId must reference a known work (${subjectId})`,
      );
    }
  }

  // `sourceProvenance` subjects are global (work-agnostic). They arrive in two
  // legitimate shapes:
  //   1. A real `sourceProvenanceId` (a crawler/source provenance row's primary
  //      key), which is recorded before this upsert (e.g. `recordFetchedStep`
  //      commits the crawl provenance ahead of the work upsert). These MUST
  //      exist in committed state.
  //   2. A free-text `<catalogSource>:<sourceId>` source-record identity emitted
  //      by cross-source disagreement evidence (platform-language conflicts name
  //      the disagreeing source directly, e.g. `igdb:252001` / `vndb:v1002`).
  //      The named source may not be catalogued locally (the conflict can cite a
  //      source we have not ingested), so existence is NOT required for it — only
  //      that it is a well-formed identity of a known catalog source.
  // Anything that is neither a known provenance id nor a well-formed source
  // identity is a dangling reference and is rejected (CATALOG-079).
  if (sourceProvenanceSubjects.size > 0) {
    const rows = await db
      .select({ id: catalogSourceProvenance.sourceProvenanceId })
      .from(catalogSourceProvenance)
      .where(inArray(catalogSourceProvenance.sourceProvenanceId, [...sourceProvenanceSubjects]));
    const knownProvenanceIds = new Set(rows.map((row) => row.id));
    for (const subjectId of sourceProvenanceSubjects) {
      if (knownProvenanceIds.has(subjectId) || isCatalogSourceRecordIdentity(subjectId)) {
        continue;
      }
      throw new CatalogArtifactMappingError(
        "conflict_evidence_subject_unknown",
        `conflict.evidence subjectId must reference a known source provenance (${subjectId})`,
      );
    }
  }
}

/**
 * True when `subjectId` is a well-formed `<catalogSource>:<sourceId>` source
 * record identity for a known catalog source. Cross-source disagreement evidence
 * names the disagreeing source by this identity (e.g. `igdb:252001`,
 * `vndb:v1002`) rather than by a provenance row primary key; the named source
 * may not be catalogued locally, so this identity is accepted without requiring
 * a persisted provenance row.
 */
export function isCatalogSourceRecordIdentity(subjectId: string): boolean {
  const parsed = parseCatalogSourceRecordIdentity(subjectId);
  return parsed !== null;
}

/**
 * Parse a `<catalogSource>:<sourceId>` source-record identity into its
 * `{ catalogSource, sourceId }` components, or return null when the identity is
 * not well-formed or names an unknown catalog source. Used to surface a
 * provenance-less cross-source evidence subject (a forward-reference to a source
 * not yet ingested — CATALOG-079) into the review/demotion `sourceIds` so the
 * REAL cited source is named rather than silently dropped for lack of a row.
 */
export function parseCatalogSourceRecordIdentity(
  subjectId: string,
): CatalogConflictReviewSourceId | null {
  const separator = subjectId.indexOf(":");
  if (separator <= 0 || separator === subjectId.length - 1) {
    return null;
  }
  const catalogSource = subjectId.slice(0, separator);
  if (!(catalogSources as string[]).includes(catalogSource)) {
    return null;
  }
  return {
    catalogSource: catalogSource as CatalogSource,
    sourceId: subjectId.slice(separator + 1),
  };
}

/**
 * Validates a set of work-scoped conflict-evidence subject ids: each must exist
 * (either created in this upsert or already persisted) and belong to the parent
 * work. Subjects present in `inputIds` are created in the same transaction and
 * therefore belong to `workId` by construction.
 *
 * Child kinds are PARENT-SCOPED BY CONTRACT (CATALOG-079): a subject bearing a
 * `<catalogSource>:<sourceId>` cross-source identity is a CALLER ERROR — such
 * cross-source evidence must route through the `sourceProvenance` kind, which
 * accepts the well-formed identity. This is reported distinctly (with a message
 * pointing the caller to `sourceProvenance`) rather than being conflated with a
 * dangling/unknown local id.
 */
export async function assertWorkScopedConflictSubjects(
  subjectIds: Set<string>,
  inputIds: Set<string>,
  workId: string,
  subjectLabel: string,
  fetchWorkIds: (ids: string[]) => Promise<Map<string, string>>,
): Promise<void> {
  const lookupIds = [...subjectIds].filter((id) => !inputIds.has(id));
  const existingWorkIds = lookupIds.length > 0 ? await fetchWorkIds(lookupIds) : new Map();
  for (const subjectId of subjectIds) {
    if (inputIds.has(subjectId)) {
      continue;
    }
    if (isCatalogSourceRecordIdentity(subjectId)) {
      throw new CatalogArtifactMappingError(
        "conflict_evidence_child_subject_cross_source",
        `conflict.evidence ${subjectLabel} subjectId is parent-scoped by contract and cannot be a ` +
          `<catalogSource>:<sourceId> cross-source identity (${subjectId}); route cross-source ` +
          `disagreement evidence through the sourceProvenance subject kind`,
      );
    }
    const ownerWorkId = existingWorkIds.get(subjectId);
    if (ownerWorkId === undefined) {
      throw new CatalogArtifactMappingError(
        "conflict_evidence_subject_unknown",
        `conflict.evidence subjectId must reference a known ${subjectLabel} (${subjectId})`,
      );
    }
    if (ownerWorkId !== workId) {
      throw new CatalogArtifactMappingError(
        "conflict_evidence_subject_belongs_to_other_work",
        `conflict.evidence subjectId must reference a ${subjectLabel} in the parent work (${subjectId})`,
      );
    }
  }
}

export function assertReleaseBelongsToWork(
  releaseId: string,
  fieldName: string,
  workId: string,
  inputReleaseIds: Set<string>,
  existingReleaseWorkIds: Map<string, string>,
  belongsToOtherWorkCode: CatalogArtifactMappingErrorCode,
  notInWorkCode: CatalogArtifactMappingErrorCode,
): void {
  const existingWorkId = existingReleaseWorkIds.get(releaseId);
  if (existingWorkId === workId) {
    return;
  }
  if (existingWorkId !== undefined) {
    throw new CatalogArtifactMappingError(
      belongsToOtherWorkCode,
      `${fieldName} must belong to the parent work`,
    );
  }
  if (inputReleaseIds.has(releaseId)) {
    return;
  }
  throw new CatalogArtifactMappingError(
    notInWorkCode,
    `${fieldName} must reference a release for the parent work`,
  );
}
