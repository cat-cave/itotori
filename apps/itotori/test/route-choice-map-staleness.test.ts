import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  ItotoriRouteChoiceMapRepositoryPort,
  RouteChoiceOptionRecord,
  RouteChoiceRecord,
  RouteInvalidatedReason,
  RouteMapRecord,
  SaveRouteChoiceInput,
  SaveRouteMapInput,
} from "@itotori/db";
import { markStaleRouteChoiceArtifactsForRevision } from "../src/agents/route-choice-map/index.js";

class InMemoryRouteChoiceMapRepository implements ItotoriRouteChoiceMapRepositoryPort {
  public routeMaps = new Map<string, RouteMapRecord>();
  public routeChoices = new Map<string, RouteChoiceRecord>();
  public sourceHashes = new Map<string, string>();

  async saveRouteMap(
    _actor: AuthorizationActor,
    input: SaveRouteMapInput,
  ): Promise<RouteMapRecord> {
    const record: RouteMapRecord = {
      routeMapId: input.routeMapId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      routeKey: input.routeKey,
      routeTitle: input.routeTitle,
      mapLocale: input.mapLocale,
      routeSummary: input.routeSummary,
      modelProviderFamily: input.modelProviderFamily,
      modelId: input.modelId,
      modelContextWindowTokens: input.modelContextWindowTokens,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
      promptTemplateVersion: input.promptTemplateVersion,
      promptHash: input.promptHash,
      inputTokenEstimate: input.inputTokenEstimate,
      completionTokens: input.completionTokens,
      status: "Fresh",
      invalidatedAt: null,
      invalidatedReason: null,
      generatedAt: input.generatedAt,
      createdAt: input.generatedAt,
      citations: input.citations.map((c) => ({
        bridgeUnitId: c.bridgeUnitId,
        citedSourceHash: c.citedSourceHash,
        citeOrdinal: c.citeOrdinal,
      })),
    };
    this.routeMaps.set(input.routeMapId, record);
    return record;
  }

  async saveRouteChoice(
    _actor: AuthorizationActor,
    input: SaveRouteChoiceInput,
  ): Promise<RouteChoiceRecord> {
    const record: RouteChoiceRecord = {
      routeChoiceId: input.routeChoiceId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      choiceKey: input.choiceKey,
      kind: input.kind,
      fromRouteKey: input.fromRouteKey,
      promptSummary: input.promptSummary,
      mapLocale: input.mapLocale,
      options: input.options.map(
        (opt): RouteChoiceOptionRecord => ({
          optionId: opt.optionId,
          optionIndex: opt.optionIndex,
          optionLabel: opt.optionLabel,
          targetRouteKey: opt.targetRouteKey,
          targetUnitIds: [...opt.targetUnitIds],
          targetUnitHashes: [...opt.targetUnitHashes],
        }),
      ),
      modelProviderFamily: input.modelProviderFamily,
      modelId: input.modelId,
      modelContextWindowTokens: input.modelContextWindowTokens,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
      promptTemplateVersion: input.promptTemplateVersion,
      promptHash: input.promptHash,
      status: "Fresh",
      invalidatedAt: null,
      invalidatedReason: null,
      generatedAt: input.generatedAt,
      createdAt: input.generatedAt,
      citations: input.citations.map((c) => ({
        bridgeUnitId: c.bridgeUnitId,
        citedSourceHash: c.citedSourceHash,
        citeOrdinal: c.citeOrdinal,
      })),
    };
    this.routeChoices.set(input.routeChoiceId, record);
    return record;
  }

  async loadRouteMapsByProject(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId?: string;
      sourceRevisionId?: string;
      status?: "Fresh" | "Stale";
    },
  ): Promise<RouteMapRecord[]> {
    return [...this.routeMaps.values()].filter((r) => {
      if (r.projectId !== query.projectId) return false;
      if (query.localeBranchId && r.localeBranchId !== query.localeBranchId) return false;
      if (query.sourceRevisionId && r.sourceRevisionId !== query.sourceRevisionId) return false;
      if (query.status && r.status !== query.status) return false;
      return true;
    });
  }

  async loadRouteChoicesByProject(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId?: string;
      sourceRevisionId?: string;
      status?: "Fresh" | "Stale";
    },
  ): Promise<RouteChoiceRecord[]> {
    return [...this.routeChoices.values()].filter((c) => {
      if (c.projectId !== query.projectId) return false;
      if (query.localeBranchId && c.localeBranchId !== query.localeBranchId) return false;
      if (query.sourceRevisionId && c.sourceRevisionId !== query.sourceRevisionId) return false;
      if (query.status && c.status !== query.status) return false;
      return true;
    });
  }

  async markRouteMapStale(
    _actor: AuthorizationActor,
    input: { routeMapId: string; reason: RouteInvalidatedReason; invalidatedAt?: Date },
  ): Promise<void> {
    const existing = this.routeMaps.get(input.routeMapId);
    if (!existing || existing.status !== "Fresh") return;
    this.routeMaps.set(input.routeMapId, {
      ...existing,
      status: "Stale",
      invalidatedAt: input.invalidatedAt ?? new Date(),
      invalidatedReason: input.reason,
    });
  }

  async markRouteChoiceStale(
    _actor: AuthorizationActor,
    input: { routeChoiceId: string; reason: RouteInvalidatedReason; invalidatedAt?: Date },
  ): Promise<void> {
    const existing = this.routeChoices.get(input.routeChoiceId);
    if (!existing || existing.status !== "Fresh") return;
    this.routeChoices.set(input.routeChoiceId, {
      ...existing,
      status: "Stale",
      invalidatedAt: input.invalidatedAt ?? new Date(),
      invalidatedReason: input.reason,
    });
  }

  async currentSourceHashesForBridgeUnits(
    _actor: AuthorizationActor,
    input: { bridgeUnitIds: string[] },
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of input.bridgeUnitIds) {
      const hash = this.sourceHashes.get(id);
      if (hash !== undefined) {
        result.set(id, hash);
      }
    }
    return result;
  }
}

const actor: AuthorizationActor = { userId: "test-user" };
const projectId = "019ed018-0000-7000-8000-000000000001";
const localeBranchId = "019ed018-0000-7000-8000-000000000002";
const sourceRevisionId = "019ed018-0000-7000-8000-000000000003";

function seedRoute(
  repo: InMemoryRouteChoiceMapRepository,
  routeKey: string,
  citations: Array<[string, string]>,
): RouteMapRecord {
  const record: RouteMapRecord = {
    routeMapId: `route-map-${routeKey}`,
    projectId,
    localeBranchId,
    sourceRevisionId,
    routeKey,
    routeTitle: routeKey,
    mapLocale: "ja-JP",
    routeSummary: "x",
    modelProviderFamily: "fake",
    modelId: "fake-v0",
    modelContextWindowTokens: 16000,
    modelMaxOutputTokens: 1024,
    promptTemplateVersion: "itotori-route-choice-map-v1",
    promptHash: "deadbeef".repeat(8),
    inputTokenEstimate: 10,
    completionTokens: 5,
    status: "Fresh",
    invalidatedAt: null,
    invalidatedReason: null,
    generatedAt: new Date("2026-06-23T00:00:00Z"),
    createdAt: new Date("2026-06-23T00:00:00Z"),
    citations: citations.map(([id, hash], index) => ({
      bridgeUnitId: id,
      citedSourceHash: hash,
      citeOrdinal: index + 1,
    })),
  };
  repo.routeMaps.set(record.routeMapId, record);
  for (const [id, hash] of citations) {
    repo.sourceHashes.set(id, hash);
  }
  return record;
}

function seedChoice(
  repo: InMemoryRouteChoiceMapRepository,
  choiceKey: string,
  citations: Array<[string, string]>,
  options: Array<{ targetRouteKey?: string; targets: Array<[string, string]> }>,
): RouteChoiceRecord {
  const record: RouteChoiceRecord = {
    routeChoiceId: `route-choice-${choiceKey}`,
    projectId,
    localeBranchId,
    sourceRevisionId,
    choiceKey,
    kind: "RouteBranch",
    fromRouteKey: "true-route",
    promptSummary: "x",
    mapLocale: "ja-JP",
    options: options.map((opt, index) => ({
      optionId: `opt-${choiceKey}-${index}`,
      optionIndex: index,
      optionLabel: `option-${index}`,
      targetRouteKey: opt.targetRouteKey ?? null,
      targetUnitIds: opt.targets.map(([id]) => id),
      targetUnitHashes: opt.targets.map(([, hash]) => hash),
    })),
    modelProviderFamily: "fake",
    modelId: "fake-v0",
    modelContextWindowTokens: 16000,
    modelMaxOutputTokens: 1024,
    promptTemplateVersion: "itotori-route-choice-map-v1",
    promptHash: "deadbeef".repeat(8),
    status: "Fresh",
    invalidatedAt: null,
    invalidatedReason: null,
    generatedAt: new Date("2026-06-23T00:00:00Z"),
    createdAt: new Date("2026-06-23T00:00:00Z"),
    citations: citations.map(([id, hash], index) => ({
      bridgeUnitId: id,
      citedSourceHash: hash,
      citeOrdinal: index + 1,
    })),
  };
  repo.routeChoices.set(record.routeChoiceId, record);
  for (const [id, hash] of citations) {
    repo.sourceHashes.set(id, hash);
  }
  for (const opt of options) {
    for (const [id, hash] of opt.targets) {
      repo.sourceHashes.set(id, hash);
    }
  }
  return record;
}

describe("markStaleRouteChoiceArtifactsForRevision", () => {
  it("returns clean scan when no source hashes have drifted", async () => {
    const repo = new InMemoryRouteChoiceMapRepository();
    seedRoute(repo, "true-route", [
      ["unit-1", "hash-1"],
      ["unit-2", "hash-2"],
    ]);
    const result = await markStaleRouteChoiceArtifactsForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: true,
    });
    expect(result.driftedRoutes).toHaveLength(0);
    expect(result.driftedChoices).toHaveLength(0);
    expect(result.markedStaleRouteCount).toBe(0);
    expect(result.scannedRouteCount).toBe(1);
  });

  it("flags routes whose cited unit hash drifted", async () => {
    const repo = new InMemoryRouteChoiceMapRepository();
    const route = seedRoute(repo, "true-route", [
      ["unit-1", "hash-1"],
      ["unit-2", "hash-2"],
    ]);
    // Mutate unit-1's hash to simulate ingest update.
    repo.sourceHashes.set("unit-1", "hash-1-new");

    const result = await markStaleRouteChoiceArtifactsForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: true,
    });
    expect(result.driftedRoutes).toHaveLength(1);
    expect(result.driftedRoutes[0]?.routeMapId).toBe(route.routeMapId);
    expect(result.markedStaleRouteCount).toBe(1);
    expect(repo.routeMaps.get(route.routeMapId)?.status).toBe("Stale");
    expect(repo.routeMaps.get(route.routeMapId)?.invalidatedReason).toBe("source_hash_drift");
  });

  it("flags choices whose cited unit hash drifted", async () => {
    const repo = new InMemoryRouteChoiceMapRepository();
    seedRoute(repo, "true-route", [["unit-1", "hash-1"]]);
    const choice = seedChoice(
      repo,
      "choice-fork-1",
      [["unit-3", "hash-3"]],
      [{ targetRouteKey: "true-route", targets: [["unit-1", "hash-1"]] }],
    );
    repo.sourceHashes.set("unit-3", "hash-3-new");

    const result = await markStaleRouteChoiceArtifactsForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: true,
    });
    expect(result.driftedChoices).toHaveLength(1);
    expect(result.driftedChoices[0]?.routeChoiceId).toBe(choice.routeChoiceId);
    expect(repo.routeChoices.get(choice.routeChoiceId)?.status).toBe("Stale");
  });

  it("flags choices pointing at a missing/stale targetRouteKey (dangling)", async () => {
    const repo = new InMemoryRouteChoiceMapRepository();
    const route = seedRoute(repo, "true-route", [["unit-1", "hash-1"]]);
    const choice = seedChoice(
      repo,
      "choice-fork-1",
      [["unit-3", "hash-3"]],
      [
        { targetRouteKey: "true-route", targets: [["unit-1", "hash-1"]] },
        { targetRouteKey: "missing-route", targets: [["unit-1", "hash-1"]] },
      ],
    );
    // No drift; mark route stale to simulate curator deletion.
    await repo.markRouteMapStale(actor, {
      routeMapId: route.routeMapId,
      reason: "manual",
    });

    const result = await markStaleRouteChoiceArtifactsForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: true,
    });
    // Because true-route is now Stale, and missing-route never existed,
    // the choice gets flagged dangling.
    expect(result.danglingChoices).toHaveLength(1);
    expect(result.danglingChoices[0]?.routeChoiceId).toBe(choice.routeChoiceId);
    expect(repo.routeChoices.get(choice.routeChoiceId)?.invalidatedReason).toBe(
      "unknown_route_target",
    );
  });

  it("respects markStale=false (dry run)", async () => {
    const repo = new InMemoryRouteChoiceMapRepository();
    const route = seedRoute(repo, "true-route", [["unit-1", "hash-1"]]);
    repo.sourceHashes.set("unit-1", "hash-1-new");

    const result = await markStaleRouteChoiceArtifactsForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: false,
    });
    expect(result.driftedRoutes).toHaveLength(1);
    expect(result.markedStaleRouteCount).toBe(0);
    expect(repo.routeMaps.get(route.routeMapId)?.status).toBe("Fresh");
  });
});
