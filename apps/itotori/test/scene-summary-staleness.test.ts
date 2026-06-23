import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  BridgeUnitTextRecord,
  ItotoriSceneSummaryRepositoryPort,
  SaveSceneSummaryInput,
  SceneSummaryCitationRecord,
  SceneSummaryInvalidatedReason,
  SceneSummaryRecord,
  SceneSummaryStatus,
} from "@itotori/db";
import { markStaleSummariesForRevision } from "../src/agents/scene-summary/index.js";

class InMemorySceneSummaryRepository implements ItotoriSceneSummaryRepositoryPort {
  public records = new Map<string, SceneSummaryRecord>();
  public sourceHashes = new Map<string, string>();
  public bridgeUnitTextById = new Map<string, BridgeUnitTextRecord>();

  async saveSummary(
    _actor: AuthorizationActor,
    input: SaveSceneSummaryInput,
  ): Promise<SceneSummaryRecord> {
    const record: SceneSummaryRecord = {
      sceneSummaryId: input.sceneSummaryId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      sceneId: input.sceneId,
      summaryLocale: input.summaryLocale,
      summaryText: input.summaryText,
      modelProviderFamily: input.modelProviderFamily,
      modelId: input.modelId,
      modelContextWindowTokens: input.modelContextWindowTokens,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
      promptTemplateVersion: input.promptTemplateVersion,
      promptHash: input.promptHash,
      inputTokenEstimate: input.inputTokenEstimate,
      completionTokens: input.completionTokens,
      status: "Fresh" as SceneSummaryStatus,
      invalidatedAt: null,
      invalidatedReason: null,
      generatedAt: input.generatedAt,
      createdAt: input.generatedAt,
      citations: input.citations.map(
        (c): SceneSummaryCitationRecord => ({
          bridgeUnitId: c.bridgeUnitId,
          citedSourceHash: c.citedSourceHash,
          citeOrdinal: c.citeOrdinal,
        }),
      ),
    };
    this.records.set(record.sceneSummaryId, record);
    return record;
  }

  async loadSummaryByScene(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId: string;
      sourceRevisionId: string;
      sceneId: string;
      promptTemplateVersion?: string;
    },
  ): Promise<SceneSummaryRecord | null> {
    const matching = [...this.records.values()].filter(
      (r) =>
        r.projectId === query.projectId &&
        r.localeBranchId === query.localeBranchId &&
        r.sourceRevisionId === query.sourceRevisionId &&
        r.sceneId === query.sceneId &&
        (query.promptTemplateVersion === undefined ||
          r.promptTemplateVersion === query.promptTemplateVersion),
    );
    const fresh = matching.find((r) => r.status === "Fresh");
    if (fresh) {
      return fresh;
    }
    return matching[0] ?? null;
  }

  async loadSummaries(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId?: string;
      sourceRevisionId?: string;
      sceneId?: string;
      status?: SceneSummaryStatus;
      promptTemplateVersion?: string;
    },
  ): Promise<SceneSummaryRecord[]> {
    return [...this.records.values()].filter(
      (r) =>
        r.projectId === query.projectId &&
        (query.localeBranchId === undefined || r.localeBranchId === query.localeBranchId) &&
        (query.sourceRevisionId === undefined || r.sourceRevisionId === query.sourceRevisionId) &&
        (query.sceneId === undefined || r.sceneId === query.sceneId) &&
        (query.status === undefined || r.status === query.status) &&
        (query.promptTemplateVersion === undefined ||
          r.promptTemplateVersion === query.promptTemplateVersion),
    );
  }

  async markStale(
    _actor: AuthorizationActor,
    input: { sceneSummaryId: string; reason: SceneSummaryInvalidatedReason; invalidatedAt?: Date },
  ): Promise<void> {
    const record = this.records.get(input.sceneSummaryId);
    if (!record || record.status !== "Fresh") {
      return;
    }
    this.records.set(input.sceneSummaryId, {
      ...record,
      status: "Stale" as SceneSummaryStatus,
      invalidatedReason: input.reason,
      invalidatedAt: input.invalidatedAt ?? new Date(),
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

  async loadBridgeUnitsForSummary(
    _actor: AuthorizationActor,
    input: { bridgeUnitIds: string[] },
  ): Promise<Map<string, BridgeUnitTextRecord>> {
    const result = new Map<string, BridgeUnitTextRecord>();
    for (const id of input.bridgeUnitIds) {
      const record = this.bridgeUnitTextById.get(id);
      if (record) {
        result.set(id, record);
      }
    }
    return result;
  }
}

const actor: AuthorizationActor = { userId: "local-user" };

describe("markStaleSummariesForRevision", () => {
  it("flags summaries whose citation hashes drift from the current source units", async () => {
    const repository = new InMemorySceneSummaryRepository();
    const generatedAt = new Date("2026-06-23T12:00:00Z");

    await repository.saveSummary(actor, {
      sceneSummaryId: "sum-a",
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
      sceneId: "scene-a",
      summaryLocale: "ja-JP",
      summaryText: "a",
      modelProviderFamily: "fake",
      modelId: "fake-m",
      modelContextWindowTokens: 8000,
      modelMaxOutputTokens: 256,
      promptTemplateVersion: "itotori-scene-summary-v1",
      promptHash: "h",
      inputTokenEstimate: 10,
      completionTokens: 5,
      generatedAt,
      citations: [
        { bridgeUnitId: "u-1", citedSourceHash: "h-1", citeOrdinal: 1 },
        { bridgeUnitId: "u-2", citedSourceHash: "h-2", citeOrdinal: 2 },
      ],
    });
    await repository.saveSummary(actor, {
      sceneSummaryId: "sum-b",
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
      sceneId: "scene-b",
      summaryLocale: "ja-JP",
      summaryText: "b",
      modelProviderFamily: "fake",
      modelId: "fake-m",
      modelContextWindowTokens: 8000,
      modelMaxOutputTokens: 256,
      promptTemplateVersion: "itotori-scene-summary-v1",
      promptHash: "h",
      inputTokenEstimate: 10,
      completionTokens: 5,
      generatedAt,
      citations: [{ bridgeUnitId: "u-3", citedSourceHash: "h-3", citeOrdinal: 1 }],
    });

    repository.sourceHashes.set("u-1", "h-1-mutated"); // drift
    repository.sourceHashes.set("u-2", "h-2"); // fresh
    repository.sourceHashes.set("u-3", "h-3"); // fresh

    const result = await markStaleSummariesForRevision(repository, actor, {
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
    });

    expect(result.scannedSummaryCount).toBe(2);
    expect(result.driftedSummaries.map((d) => d.sceneSummaryId)).toEqual(["sum-a"]);
    expect(result.driftedSummaries[0]!.driftedBridgeUnitIds).toEqual(["u-1"]);
    expect(result.markedStaleCount).toBe(1);
    expect(repository.records.get("sum-a")?.status).toBe("Stale");
    expect(repository.records.get("sum-a")?.invalidatedReason).toBe("source_hash_drift");
    expect(repository.records.get("sum-b")?.status).toBe("Fresh");
  });

  it("treats a missing bridge unit (unit removed from current revision) as drift", async () => {
    const repository = new InMemorySceneSummaryRepository();
    await repository.saveSummary(actor, {
      sceneSummaryId: "sum-c",
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
      sceneId: "scene-c",
      summaryLocale: "ja-JP",
      summaryText: "c",
      modelProviderFamily: "fake",
      modelId: "fake-m",
      modelContextWindowTokens: 8000,
      modelMaxOutputTokens: 256,
      promptTemplateVersion: "itotori-scene-summary-v1",
      promptHash: "h",
      inputTokenEstimate: 10,
      completionTokens: 5,
      generatedAt: new Date("2026-06-23T12:00:00Z"),
      citations: [{ bridgeUnitId: "u-removed", citedSourceHash: "h-x", citeOrdinal: 1 }],
    });
    // No source hashes set -> bridge unit absent.

    const result = await markStaleSummariesForRevision(repository, actor, {
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
    });
    expect(result.driftedSummaries).toHaveLength(1);
    expect(result.markedStaleCount).toBe(1);
  });

  it("does not write when markStale=false (dry-run mode)", async () => {
    const repository = new InMemorySceneSummaryRepository();
    await repository.saveSummary(actor, {
      sceneSummaryId: "sum-d",
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
      sceneId: "scene-d",
      summaryLocale: "ja-JP",
      summaryText: "d",
      modelProviderFamily: "fake",
      modelId: "fake-m",
      modelContextWindowTokens: 8000,
      modelMaxOutputTokens: 256,
      promptTemplateVersion: "itotori-scene-summary-v1",
      promptHash: "h",
      inputTokenEstimate: 10,
      completionTokens: 5,
      generatedAt: new Date("2026-06-23T12:00:00Z"),
      citations: [{ bridgeUnitId: "u-1", citedSourceHash: "h-1", citeOrdinal: 1 }],
    });
    repository.sourceHashes.set("u-1", "h-1-mutated");

    const result = await markStaleSummariesForRevision(repository, actor, {
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
      markStale: false,
    });
    expect(result.driftedSummaries).toHaveLength(1);
    expect(result.markedStaleCount).toBe(0);
    expect(repository.records.get("sum-d")?.status).toBe("Fresh");
  });

  it("returns zero scans when no Fresh summaries exist", async () => {
    const repository = new InMemorySceneSummaryRepository();
    const result = await markStaleSummariesForRevision(repository, actor, {
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
    });
    expect(result.scannedSummaryCount).toBe(0);
    expect(result.driftedSummaries).toHaveLength(0);
    expect(result.markedStaleCount).toBe(0);
  });
});
