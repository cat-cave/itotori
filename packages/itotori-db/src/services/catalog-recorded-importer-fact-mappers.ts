import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogConflictEvidenceInput,
  CatalogConflictInput,
  CatalogDemandFactInput,
  CatalogJsonRecord,
  CatalogLanguageStatusInput,
  CatalogReleaseMappingInput,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogLanguageStatusScopeValues,
  catalogRawContentRedactionClassValues,
} from "../schema.js";
import { type CatalogCrawlerIngestContext } from "./catalog-crawler-runner.js";

import { type CatalogRecordedImporterFact } from "./catalog-recorded-importer-dlsite.js";
import { optionalString } from "./catalog-recorded-importer-payload-parsing.js";
import {
  compactJson,
  type CrossSourceEvidenceAttribution,
  resolveCrossSourceEvidenceAttribution,
  stableCatalogId,
} from "./catalog-recorded-importer-utils.js";

export function releaseMappingInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
): CatalogReleaseMappingInput[] {
  const releaseId = (sourceReleaseId: string): string =>
    stableCatalogId("catalog-release", [
      context.adapter.catalogSource,
      fact.sourceId,
      sourceReleaseId,
    ]);
  return (fact.releaseMappings ?? []).map((mapping) => {
    const sourceReleaseId = releaseId(mapping.sourceReleaseId);
    const targetReleaseId = releaseId(mapping.targetReleaseId);
    const input: CatalogReleaseMappingInput = {
      releaseMappingId: stableCatalogId("catalog-release-mapping", [
        context.adapter.catalogSource,
        fact.sourceId,
        mapping.sourceReleaseId,
        mapping.targetReleaseId,
        mapping.relationKind,
      ]),
      sourceReleaseId,
      targetReleaseId,
      relationKind: mapping.relationKind,
      sourceProvenanceId,
      metadata: compactJson({ ...mapping.metadata, ...importMetadata }),
    };
    if (mapping.portability !== undefined) {
      input.portability = mapping.portability;
    }
    if (mapping.confidence !== undefined) {
      input.confidence = mapping.confidence;
    }
    if (mapping.observedAt !== undefined) {
      input.observedAt = mapping.observedAt;
    }
    return input;
  });
}

export function languageStatusInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
  releaseIdsBySourceId: ReadonlyMap<string, string>,
): CatalogLanguageStatusInput[] {
  return (fact.languageStatuses ?? []).map((status) => {
    const input: CatalogLanguageStatusInput = {
      languageStatusId: stableCatalogId("catalog-language-status", [
        context.adapter.catalogSource,
        fact.sourceId,
        status.language,
        status.statusScope ?? catalogLanguageStatusScopeValues.work,
        status.platform ?? "",
        status.releaseSourceId ?? "",
      ]),
      language: status.language,
      status: status.status,
      statusScope: status.statusScope ?? catalogLanguageStatusScopeValues.work,
      sourceProvenanceId,
      confidence: status.confidence ?? catalogConfidenceValues.high,
      observedAt: status.observedAt ?? context.step.fetchedAt,
      importedAt: context.step.fetchedAt,
      parserVersion: context.adapter.parserVersion,
      rawContentRedactionClass:
        status.rawContentRedactionClass ?? catalogRawContentRedactionClassValues.publicMetadata,
      metadata: compactJson({ ...status.metadata, ...importMetadata }),
    };
    if (status.platform !== undefined) {
      input.platform = status.platform;
    }
    if (status.releaseSourceId !== undefined) {
      const releaseId = releaseIdsBySourceId.get(status.releaseSourceId);
      if (releaseId !== undefined) {
        input.releaseId = releaseId;
      }
    }
    if (status.isCurrent !== undefined) {
      input.isCurrent = status.isCurrent;
    }
    return input;
  });
}

export function demandFactInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
): CatalogDemandFactInput[] {
  return (fact.demandFacts ?? []).map((demandFact, index) => {
    const sourceField = optionalString(demandFact.metadata, "sourceField") ?? String(index);
    const input: CatalogDemandFactInput = {
      demandFactId: stableCatalogId("catalog-demand-fact", [
        context.adapter.catalogSource,
        fact.sourceId,
        demandFact.factKind,
        sourceField,
      ]),
      catalogSource: context.adapter.catalogSource,
      sourceId: fact.sourceId,
      factKind: demandFact.factKind,
      factValue: demandFact.factValue,
      sourceProvenanceId,
      parserVersion: context.adapter.parserVersion,
      metadata: compactJson({ ...demandFact.metadata, ...importMetadata }),
    };
    // Rank demand facts carry their own recorded observed_at (a real per-snapshot
    // ranking timestamp). Non-rank demand facts (dl_count, rating summary/histogram,
    // wishlist_count, work_type, translation_tree) have no per-fact source timestamp,
    // so they MUST default to the recorded step fetchedAt (the recorded crawl/snapshot
    // time from the fixture) rather than insertion wall-clock time. Deriving from the
    // recorded input keeps observedAt deterministic under recorded-importer replay:
    // reprocessing the same recorded input yields identical observedAt. This mirrors
    // the languageStatusInputs contract (status.observedAt ?? context.step.fetchedAt).
    input.observedAt = demandFact.observedAt ?? context.step.fetchedAt;
    return input;
  });
}

export async function conflictInputs(
  catalogRepository: ItotoriCatalogRepositoryPort,
  actor: AuthorizationActor,
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
  workId: string,
): Promise<CatalogConflictInput[]> {
  // Cache of resolved cross-source attribution by `${catalogSource}:${sourceId}`,
  // so multiple evidence rows that cite the same original source share one lookup.
  const resolvedAttributionBySourceKey = new Map<string, CrossSourceEvidenceAttribution>();
  const inputs: CatalogConflictInput[] = [];
  for (const [index, conflict] of (fact.conflicts ?? []).entries()) {
    const conflictId =
      conflict.conflictId ??
      stableCatalogId("catalog-conflict", [
        context.adapter.catalogSource,
        fact.sourceId,
        conflict.reasonCode ?? "",
        conflict.summary,
        String(index),
      ]);
    let evidence: CatalogConflictEvidenceInput[];
    if (conflict.evidence !== undefined) {
      evidence = [];
      for (const [evidenceIndex, evidenceFact] of conflict.evidence.entries()) {
        // Per-evidence provenance pass-through: an explicit sourceProvenanceId on the
        // evidence fact wins. Otherwise, for evidence that cites a DIFFERENT source
        // than the importer's own payload, attribute the row to that original source's
        // stored provenance (so demotion output names IGDB/Wikidata/VNDB/EGS/DLsite/
        // local instead of collapsing every row to the importer-payload provenance).
        // A cross-source reference whose source is NOT yet ingested is a legitimate
        // FORWARD-REFERENCE (CATALOG-079): the conflict may cite a source before it is
        // ever crawled. Such a row keeps sourceProvenanceId null and carries its
        // `<catalogSource>:<sourceId>` subject identity so review/demotion names the
        // REAL cited source rather than mis-attributing the row to the importer.
        // Only OWN-SOURCE evidence (or evidence carrying no source identity)
        // legitimately defaults to the importer-payload provenance.
        const explicit = evidenceFact.sourceProvenanceId;
        let evidenceProvenanceId: string | null;
        let evidenceSubjectFallback: string;
        if (explicit !== undefined) {
          evidenceProvenanceId = explicit;
          evidenceSubjectFallback = explicit;
        } else {
          const attribution = await resolveCrossSourceEvidenceAttribution(
            catalogRepository,
            actor,
            context.adapter.catalogSource,
            fact.sourceId,
            evidenceFact.metadata,
            resolvedAttributionBySourceKey,
          );
          const sourceKey = attribution.sourceKey;
          if (sourceKey !== null && attribution.provenanceId === null) {
            // Cross-source FORWARD-REFERENCE: the cited source is not yet ingested.
            // Keep sourceProvenanceId null and carry the `<catalogSource>:<sourceId>`
            // subject identity so review/demotion names the REAL cited source.
            evidenceProvenanceId = null;
            evidenceSubjectFallback = sourceKey;
          } else {
            evidenceProvenanceId = attribution.provenanceId ?? sourceProvenanceId;
            evidenceSubjectFallback = evidenceProvenanceId;
          }
        }
        const evidenceSubjectId = evidenceFact.subjectId ?? evidenceSubjectFallback;
        const evidenceInput: CatalogConflictEvidenceInput = {
          conflictEvidenceId: stableCatalogId("catalog-conflict-evidence", [
            conflictId,
            String(evidenceIndex),
            evidenceFact.subjectKind ?? catalogConflictSubjectKindValues.sourceProvenance,
            evidenceSubjectId,
          ]),
          subjectKind:
            evidenceFact.subjectKind ?? catalogConflictSubjectKindValues.sourceProvenance,
          subjectId: evidenceSubjectId,
          evidencePosition: evidenceFact.evidencePosition ?? evidenceIndex,
          metadata: compactJson({ ...evidenceFact.metadata, ...importMetadata }),
        };
        if (evidenceProvenanceId !== null) {
          evidenceInput.sourceProvenanceId = evidenceProvenanceId;
        }
        evidence.push(evidenceInput);
      }
    } else {
      evidence = [
        {
          conflictEvidenceId: stableCatalogId("catalog-conflict-evidence", [
            conflictId,
            "0",
            catalogConflictSubjectKindValues.sourceProvenance,
            sourceProvenanceId,
          ]),
          subjectKind: catalogConflictSubjectKindValues.sourceProvenance,
          subjectId: sourceProvenanceId,
          sourceProvenanceId,
          evidencePosition: 0,
          metadata: importMetadata,
        },
        {
          conflictEvidenceId: stableCatalogId("catalog-conflict-evidence", [
            conflictId,
            "1",
            catalogConflictSubjectKindValues.work,
            workId,
          ]),
          subjectKind: catalogConflictSubjectKindValues.work,
          subjectId: workId,
          sourceProvenanceId,
          evidencePosition: 1,
          metadata: compactJson({ role: "imported_work", ...importMetadata }),
        },
      ];
    }
    inputs.push({
      conflictId,
      conflictKind: conflict.conflictKind ?? catalogConflictKindValues.unknown,
      status: conflict.status ?? catalogConflictStatusValues.open,
      summary: conflict.summary,
      detectedAt: conflict.detectedAt ?? context.step.fetchedAt,
      metadata: compactJson({
        reasonCode: conflict.reasonCode ?? "source_disagreement",
        severity: conflict.severity ?? "warning",
        ...conflict.metadata,
        ...importMetadata,
      }),
      evidence,
    });
  }
  return inputs;
}

// The cross-source attribution for a conflict-evidence row. `sourceKey` is the
// `<catalogSource>:<sourceId>` subject identity for a cross-source reference whose
// cited source is OTHER than the importer's own payload (null for own-source and
// for evidence carrying no source identity). `provenanceId` is the cited source's
// stored external-id provenance when persisted, or null when the source is not yet
// ingested — a legitimate FORWARD-REFERENCE (CATALOG-079).
