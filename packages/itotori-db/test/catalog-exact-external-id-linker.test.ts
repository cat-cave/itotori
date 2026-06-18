import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type {
  CatalogWorkSnapshot,
  ItotoriCatalogRepositoryPort,
} from "../src/repositories/catalog-repository.js";
import {
  catalogExactExternalIdLinkDiagnosticCodeValues,
  catalogExactExternalIdLinkStatusValues,
  ItotoriCatalogExactExternalIdLinkerService,
  type CatalogExactExternalIdLinkRequest,
} from "../src/services/catalog-exact-external-id-linker.js";
import { catalogExternalIdKindValues, type CatalogExternalIdKind } from "../src/schema.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriCatalogExactExternalIdLinkerService", () => {
  it("links a catalog work only when a fixture external ID exactly matches", async () => {
    const repository = new FakeCatalogLookupRepository([
      [
        exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
        workSnapshot("work-dlsite", "DLsite-only fixture"),
      ],
    ]);
    const service = new ItotoriCatalogExactExternalIdLinkerService(repository, localActor);

    const result = await service.linkExactExternalIds(fixtureRequest("exactMatch"));

    expect(result).toMatchObject({
      status: catalogExactExternalIdLinkStatusValues.linked,
      workId: "work-dlsite",
      diagnostics: [],
      matches: [
        {
          catalogSource: "dlsite",
          sourceId: "RJ349517",
          externalIdKind: catalogExternalIdKindValues.storeProduct,
          workId: "work-dlsite",
        },
      ],
    });
  });

  it("returns a semantic no-match diagnostic without fuzzy case folding", async () => {
    const repository = new FakeCatalogLookupRepository([
      [
        exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
        workSnapshot("work-dlsite", "DLsite-only fixture"),
      ],
    ]);
    const service = new ItotoriCatalogExactExternalIdLinkerService(repository, localActor);

    const result = await service.linkExactExternalIds(fixtureRequest("caseSensitiveNoMatch"));

    expect(result.status).toBe(catalogExactExternalIdLinkStatusValues.noMatch);
    expect(result.workId).toBeNull();
    expect(result.matches).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: catalogExactExternalIdLinkDiagnosticCodeValues.noMatch,
        severity: "info",
      }),
    ]);
    expect(repository.calls).toEqual([
      exactKey("dlsite", "rj349517", catalogExternalIdKindValues.storeProduct),
    ]);
  });

  it("refuses ambiguous exact matches instead of choosing or merging works", async () => {
    const repository = new FakeCatalogLookupRepository([
      [
        exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
        workSnapshot("work-dlsite", "DLsite-only fixture"),
      ],
      [
        exactKey("steam", "333600", catalogExternalIdKindValues.storeProduct),
        workSnapshot("work-steam", "Steam-linked fixture"),
      ],
    ]);
    const service = new ItotoriCatalogExactExternalIdLinkerService(repository, localActor);

    const result = await service.linkExactExternalIds(fixtureRequest("conflictingMatches"));

    expect(result.status).toBe(catalogExactExternalIdLinkStatusValues.conflict);
    expect(result.workId).toBeNull();
    expect(result.matches.map((match) => match.workId).sort()).toEqual([
      "work-dlsite",
      "work-steam",
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: catalogExactExternalIdLinkDiagnosticCodeValues.ambiguousConflict,
        severity: "error",
      }),
    ]);
  });

  it("rejects unsupported detector-only IDs with semantic diagnostics before lookup", async () => {
    const repository = new FakeCatalogLookupRepository([
      [
        exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
        workSnapshot("work-dlsite", "DLsite-only fixture"),
      ],
    ]);
    const service = new ItotoriCatalogExactExternalIdLinkerService(repository, localActor);

    const result = await service.linkExactExternalIds(fixtureRequest("unsupportedLocalDetection"));

    expect(result.status).toBe(catalogExactExternalIdLinkStatusValues.unsupported);
    expect(result.workId).toBeNull();
    expect(result.matches).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: catalogExactExternalIdLinkDiagnosticCodeValues.unsupportedExternalIdKind,
        inputIndex: 0,
        severity: "error",
      }),
    ]);
    expect(repository.calls).toEqual([]);
  });
});

class FakeCatalogLookupRepository implements Pick<
  ItotoriCatalogRepositoryPort,
  "getWorkByExternalId"
> {
  readonly calls: string[] = [];
  private readonly snapshots: Map<string, CatalogWorkSnapshot>;

  constructor(entries: [string, CatalogWorkSnapshot][]) {
    this.snapshots = new Map(entries);
  }

  async getWorkByExternalId(
    _actor: AuthorizationActor,
    catalogSource: string,
    sourceId: string,
    externalIdKind: CatalogExternalIdKind,
  ): Promise<CatalogWorkSnapshot | null> {
    const key = exactKey(catalogSource, sourceId, externalIdKind);
    this.calls.push(key);
    return this.snapshots.get(key) ?? null;
  }
}

function fixtureRequest(name: string): CatalogExactExternalIdLinkRequest {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/catalog-exact-external-id-linker/requests.json", import.meta.url),
      "utf8",
    ),
  ) as { requests: Record<string, CatalogExactExternalIdLinkRequest> };
  const request = fixture.requests[name];
  if (request === undefined) {
    throw new Error(`missing exact external-id linker fixture request ${name}`);
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
