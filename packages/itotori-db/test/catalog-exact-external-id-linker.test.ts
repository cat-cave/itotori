import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type {
  CatalogWorkSnapshot,
  ItotoriCatalogRepositoryPort,
} from "../src/repositories/catalog-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  catalogExactExternalIdLinkDiagnosticCodeValues,
  catalogExactExternalIdLinkSchemaVersion,
  catalogExactExternalIdLinkStatusValues,
  ItotoriCatalogExactExternalIdLinkerService,
  type CatalogExactExternalIdLinkRequest,
} from "../src/services/catalog-exact-external-id-linker.js";
import {
  catalogExternalIdKindValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

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

  it.each([
    ["malformed object", { schemaVersion: catalogExactExternalIdLinkSchemaVersion }],
    ["null", null],
    ["array", []],
    ["scalar", "not-a-request"],
  ])("returns semantic invalid-request diagnostics for %s payloads", async (_name, payload) => {
    const repository = new FakeCatalogLookupRepository([
      [
        exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
        workSnapshot("work-dlsite", "DLsite-only fixture"),
      ],
    ]);
    const service = new ItotoriCatalogExactExternalIdLinkerService(repository, localActor);

    const result = await service.linkExactExternalIds(payload);

    expect(result).toMatchObject({
      status: catalogExactExternalIdLinkStatusValues.unsupported,
      subject: null,
      workId: null,
      matches: [],
      diagnostics: [
        expect.objectContaining({
          code: catalogExactExternalIdLinkDiagnosticCodeValues.invalidRequest,
          severity: "error",
        }),
      ],
    });
    expect(repository.calls).toEqual([]);
  });

  it("returns the same exact-match diagnostics against the real catalog repository", async () => {
    const context = await isolatedMigratedContext();
    try {
      const realRepository = new ItotoriCatalogRepository(context.db);
      const sourceProvenance = await realRepository.recordSourceProvenance(localActor, {
        sourceProvenanceId: uuid(1),
        catalogSource: catalogSourceValues.dlsite,
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        sourceId: "RJ349517",
        sourceVersion: "fixture-2026-06-19",
        requestId: "fixture:dlsite:RJ349517",
        httpStatus: 200,
        ok: true,
        payloadHash: `sha256:${"1".repeat(64)}`,
        payload: { catalogSource: "dlsite", sourceId: "RJ349517" },
        fetchedAt: "2026-06-19T12:00:00.000Z",
        metadata: { fixture: true },
      });
      await realRepository.upsertWork(localActor, {
        workId: "work-dlsite",
        canonicalTitle: "DLsite-only fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2022,
        externalIds: [
          {
            externalIdId: uuid(2),
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJ349517",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            sourceProvenanceId: sourceProvenance.sourceProvenanceId,
          },
        ],
      });
      const request = fixtureRequest("exactMatch");
      const fakeService = new ItotoriCatalogExactExternalIdLinkerService(
        new FakeCatalogLookupRepository([
          [
            exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
            workSnapshot("work-dlsite", "DLsite-only fixture"),
          ],
        ]),
        localActor,
      );
      const realService = new ItotoriCatalogExactExternalIdLinkerService(
        realRepository,
        localActor,
      );

      await expect(realService.linkExactExternalIds(request)).resolves.toEqual(
        await fakeService.linkExactExternalIds(request),
      );
    } finally {
      await context.close();
    }
  });

  it.each([
    ["malformed object", { schemaVersion: catalogExactExternalIdLinkSchemaVersion }],
    ["null", null],
    ["array", []],
    ["scalar", "not-a-request"],
  ])(
    "returns the same invalid-request diagnostics for %s payloads through the real catalog repository",
    async (_name, payload) => {
      const context = await isolatedMigratedContext();
      try {
        const realRepository = new ItotoriCatalogRepository(context.db);
        const fakeRepository = new FakeCatalogLookupRepository([
          [
            exactKey("dlsite", "RJ349517", catalogExternalIdKindValues.storeProduct),
            workSnapshot("work-dlsite", "DLsite-only fixture"),
          ],
        ]);
        const realService = new ItotoriCatalogExactExternalIdLinkerService(
          realRepository,
          localActor,
        );
        const fakeService = new ItotoriCatalogExactExternalIdLinkerService(
          fakeRepository,
          localActor,
        );

        const realResult = await realService.linkExactExternalIds(payload);
        const fakeResult = await fakeService.linkExactExternalIds(payload);

        expect(realResult).toEqual(fakeResult);
        expect(realResult).toMatchObject({
          status: catalogExactExternalIdLinkStatusValues.unsupported,
          subject: null,
          workId: null,
          matches: [],
          diagnostics: [
            expect.objectContaining({
              code: catalogExactExternalIdLinkDiagnosticCodeValues.invalidRequest,
              severity: "error",
            }),
          ],
        });
        expect(fakeRepository.calls).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
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

function uuid(id: number): string {
  return `019ed064-0000-7000-8000-${String(id).padStart(12, "0")}`;
}
