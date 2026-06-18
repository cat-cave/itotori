import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type {
  CatalogCandidateMatchInput,
  CatalogCandidateMatchRecord,
  CatalogCandidateTargetWorkRecord,
  CatalogWorkSnapshot,
  ItotoriCatalogRepositoryPort,
} from "../src/repositories/catalog-repository.js";
import {
  catalogFuzzyCandidateDiagnosticCodeValues,
  catalogFuzzyCandidateStatusValues,
  ItotoriCatalogFuzzyCandidateGeneratorService,
  type CatalogFuzzyCandidateRequest,
} from "../src/services/catalog-fuzzy-candidate-generator.js";
import { catalogExternalIdKindValues, type CatalogExternalIdKind } from "../src/schema.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriCatalogFuzzyCandidateGeneratorService", () => {
  it("skips fuzzy output when exact external-id linking can handle the source", async () => {
    const repository = fakeRepository();
    repository.exactMatches.set(
      exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
      workSnapshot("work-dlsite", "DLsite-only fixture"),
    );
    const service = new ItotoriCatalogFuzzyCandidateGeneratorService(repository, localActor);

    const result = await service.generateFuzzyCandidates(
      fixtureRequest("exactExternalIdSkipsFuzzy"),
    );

    expect(result.status).toBe(catalogFuzzyCandidateStatusValues.exactMatchSkipped);
    expect(result.candidates).toEqual([]);
    expect(repository.recordedCandidates).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: catalogFuzzyCandidateDiagnosticCodeValues.exactExternalIdMatch,
        reasonCode: "exact_external_id_match",
        sourceId: "RJ349517",
      }),
    ]);
  });

  it("records deterministic fuzzy candidates as review-pending rows without auto-merge metadata", async () => {
    const repository = fakeRepository();
    const service = new ItotoriCatalogFuzzyCandidateGeneratorService(repository, localActor);

    const result = await service.generateFuzzyCandidates(fixtureRequest("highConfidenceFuzzy"));

    expect(result.status).toBe(catalogFuzzyCandidateStatusValues.generated);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceCatalogSource: "egs",
      sourceId: "egs-moonlight-001",
      sourceTitle: "Moonlight Refrain",
      targetWorkId: "work-moonlight-hd",
      score: 860,
      status: "review_pending",
      diagnosticCode: catalogFuzzyCandidateDiagnosticCodeValues.candidateGenerated,
      metadata: expect.objectContaining({ autoMerge: false }),
    });
    expect(repository.workMutations).toBe(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        candidateId: result.candidates[0]?.candidateId,
        reasonCode: "review_required_no_auto_merge",
        score: 860,
      }),
    );
  });

  it("returns low-confidence diagnostics without recording a candidate", async () => {
    const repository = fakeRepository();
    const service = new ItotoriCatalogFuzzyCandidateGeneratorService(repository, localActor);

    const result = await service.generateFuzzyCandidates(
      fixtureRequest("lowConfidenceNoCandidate"),
    );

    expect(result.status).toBe(catalogFuzzyCandidateStatusValues.noCandidates);
    expect(result.candidates).toEqual([]);
    expect(repository.recordedCandidates).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: catalogFuzzyCandidateDiagnosticCodeValues.lowConfidence,
        field: "title",
        reasonCode: "low_confidence",
      }),
    ]);
  });

  it("refuses conflicting exact external IDs instead of generating fuzzy candidates", async () => {
    const repository = fakeRepository();
    repository.exactMatches.set(
      exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
      workSnapshot("work-dlsite", "DLsite-only fixture"),
    );
    repository.exactMatches.set(
      exactKey("steam", "333600", catalogExternalIdKindValues.storeProduct),
      workSnapshot("work-steam", "Steam-linked fixture"),
    );
    const service = new ItotoriCatalogFuzzyCandidateGeneratorService(repository, localActor);

    const result = await service.generateFuzzyCandidates(
      fixtureRequest("conflictingExactExternalIds"),
    );

    expect(result.status).toBe(catalogFuzzyCandidateStatusValues.conflict);
    expect(result.candidates).toEqual([]);
    expect(repository.recordedCandidates).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: catalogFuzzyCandidateDiagnosticCodeValues.exactExternalIdConflict,
        severity: "error",
        reasonCode: "exact_external_id_conflict",
      }),
    ]);
  });

  it("deduplicates repeated source facts and keeps one reviewable candidate", async () => {
    const repository = fakeRepository();
    const service = new ItotoriCatalogFuzzyCandidateGeneratorService(repository, localActor);

    const result = await service.generateFuzzyCandidates(fixtureRequest("duplicateSource"));

    expect(result.status).toBe(catalogFuzzyCandidateStatusValues.generated);
    expect(result.candidates).toHaveLength(1);
    expect(repository.recordedCandidates).toHaveLength(1);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: catalogFuzzyCandidateDiagnosticCodeValues.duplicateSource,
        reasonCode: "duplicate_source",
        sourceId: "egs-moonlight-001",
      }),
    );
  });
});

class FakeCatalogCandidateRepository implements Pick<
  ItotoriCatalogRepositoryPort,
  | "getWorkByExternalId"
  | "listCatalogCandidateTargetWorks"
  | "recordCatalogCandidateMatch"
  | "listCatalogCandidateMatches"
> {
  readonly exactMatches = new Map<string, CatalogWorkSnapshot>();
  readonly recordedCandidates: CatalogCandidateMatchRecord[] = [];
  readonly targets: CatalogCandidateTargetWorkRecord[] = [
    {
      workId: "work-moonlight-hd",
      canonicalTitle: "Moonlight Refrain HD",
      firstReleaseYear: 2021,
      originalLanguage: "ja-JP",
      workKind: "game",
    },
    {
      workId: "work-starry",
      canonicalTitle: "Starry Garden",
      firstReleaseYear: 2020,
      originalLanguage: "ja-JP",
      workKind: "game",
    },
  ];
  workMutations = 0;

  async getWorkByExternalId(
    _actor: AuthorizationActor,
    catalogSource: string,
    sourceId: string,
    externalIdKind: CatalogExternalIdKind = catalogExternalIdKindValues.sourceRecord,
  ): Promise<CatalogWorkSnapshot | null> {
    return this.exactMatches.get(exactKey(catalogSource, sourceId, externalIdKind)) ?? null;
  }

  async listCatalogCandidateTargetWorks(): Promise<CatalogCandidateTargetWorkRecord[]> {
    return this.targets;
  }

  async recordCatalogCandidateMatch(
    _actor: AuthorizationActor,
    input: CatalogCandidateMatchInput,
  ): Promise<CatalogCandidateMatchRecord> {
    const existing = this.recordedCandidates.find(
      (candidate) =>
        candidate.sourceCatalogSource === input.sourceCatalogSource &&
        candidate.sourceId === input.sourceId &&
        candidate.targetWorkId === input.targetWorkId &&
        candidate.generatorVersion === input.generatorVersion,
    );
    if (existing !== undefined) {
      return existing;
    }
    const now = new Date("2026-06-18T00:00:00.000Z");
    const record: CatalogCandidateMatchRecord = {
      candidateId: `candidate-${this.recordedCandidates.length + 1}`,
      sourceCatalogSource: input.sourceCatalogSource,
      sourceId: input.sourceId,
      sourceTitle: input.sourceTitle,
      sourceProvenanceId: input.sourceProvenanceId ?? null,
      targetWorkId: input.targetWorkId,
      score: input.score,
      matchedFields: input.matchedFields,
      status: input.status ?? "review_pending",
      diagnosticCode: input.diagnosticCode,
      generatorVersion: input.generatorVersion,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.recordedCandidates.push(record);
    return record;
  }

  async listCatalogCandidateMatches(): Promise<CatalogCandidateMatchRecord[]> {
    return this.recordedCandidates;
  }
}

function fakeRepository(): FakeCatalogCandidateRepository {
  return new FakeCatalogCandidateRepository();
}

function fixtureRequest(name: string): CatalogFuzzyCandidateRequest {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/catalog-fuzzy-candidate-generator/requests.json", import.meta.url),
      "utf8",
    ),
  ) as { requests: Record<string, CatalogFuzzyCandidateRequest> };
  const request = fixture.requests[name];
  if (request === undefined) {
    throw new Error(`missing fuzzy candidate fixture request ${name}`);
  }
  return request;
}

function workSnapshot(workId: string, canonicalTitle: string): CatalogWorkSnapshot {
  const now = new Date("2026-06-17T12:00:00.000Z");
  return {
    workId,
    canonicalTitle,
    originalLanguage: "ja-JP",
    firstReleaseYear: 2022,
    workKind: "game",
    engineName: null,
    engineSource: null,
    engineConfidence: null,
    engineProvenanceId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    externalIds: [],
    releases: [],
    languageStatuses: [],
    conflicts: [],
    localScanEntries: [],
    seedTargets: [],
  };
}

function exactKey(
  catalogSource: string,
  sourceId: string,
  externalIdKind: CatalogExternalIdKind,
): string {
  return `${catalogSource}:${sourceId}:${externalIdKind}`;
}
