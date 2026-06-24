import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  ExistsTerminologyTermBySurfaceFormInput,
  ItotoriTerminologyCandidateRepositoryPort,
  SaveTerminologyCandidateInput,
  TerminologyCandidateInvalidatedReason,
  TerminologyCandidateRecord,
  TerminologyCandidateStatus,
} from "@itotori/db";
import { markStaleTerminologyCandidatesForRevision } from "../src/agents/terminology-candidate/index.js";

class InMemoryTerminologyCandidateRepository implements ItotoriTerminologyCandidateRepositoryPort {
  public candidates = new Map<string, TerminologyCandidateRecord>();
  public sourceHashes = new Map<string, string>();
  public glossary = new Map<string, string>(); // surfaceForm -> termId

  async saveCandidate(
    _actor: AuthorizationActor,
    input: SaveTerminologyCandidateInput,
  ): Promise<TerminologyCandidateRecord> {
    const conflictId =
      input.conflictingTerminologyTermId ?? this.glossary.get(input.surfaceForm) ?? null;
    const record: TerminologyCandidateRecord = {
      terminologyCandidateId: input.terminologyCandidateId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      kind: input.kind,
      surfaceForm: input.surfaceForm,
      surfaceLocale: input.surfaceLocale,
      rationale: input.rationale,
      readingHint: input.readingHint,
      conflictingTerminologyTermId: conflictId,
      modelProviderFamily: input.modelProviderFamily,
      modelId: input.modelId,
      modelContextWindowTokens: input.modelContextWindowTokens,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
      promptTemplateVersion: input.promptTemplateVersion,
      promptHash: input.promptHash,
      inputTokenEstimate: input.inputTokenEstimate,
      completionTokens: input.completionTokens,
      status: conflictId !== null ? "RejectedByReviewer" : "Fresh",
      invalidatedAt: conflictId !== null ? new Date() : null,
      invalidatedReason: conflictId !== null ? "glossary_conflict_post_persist" : null,
      generatedAt: input.generatedAt,
      createdAt: input.generatedAt,
      citations: input.citations.map((c) => ({
        bridgeUnitId: c.bridgeUnitId,
        citedSourceHash: c.citedSourceHash,
        citeOrdinal: c.citeOrdinal,
      })),
    };
    this.candidates.set(input.terminologyCandidateId, record);
    return record;
  }

  async loadCandidatesByProject(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId?: string;
      sourceRevisionId?: string;
      status?: TerminologyCandidateStatus;
    },
  ): Promise<TerminologyCandidateRecord[]> {
    return [...this.candidates.values()].filter((c) => {
      if (c.projectId !== query.projectId) return false;
      if (query.localeBranchId && c.localeBranchId !== query.localeBranchId) return false;
      if (query.sourceRevisionId && c.sourceRevisionId !== query.sourceRevisionId) return false;
      if (query.status && c.status !== query.status) return false;
      return true;
    });
  }

  async markCandidateStale(
    _actor: AuthorizationActor,
    input: {
      terminologyCandidateId: string;
      reason: TerminologyCandidateInvalidatedReason;
      invalidatedAt?: Date;
    },
  ): Promise<void> {
    const existing = this.candidates.get(input.terminologyCandidateId);
    if (!existing || existing.status !== "Fresh") return;
    this.candidates.set(input.terminologyCandidateId, {
      ...existing,
      status: "Stale",
      invalidatedAt: input.invalidatedAt ?? new Date(),
      invalidatedReason: input.reason,
    });
  }

  async markCandidateRejected(
    _actor: AuthorizationActor,
    input: {
      terminologyCandidateId: string;
      reason: TerminologyCandidateInvalidatedReason;
      invalidatedAt?: Date;
    },
  ): Promise<void> {
    const existing = this.candidates.get(input.terminologyCandidateId);
    if (!existing) return;
    this.candidates.set(input.terminologyCandidateId, {
      ...existing,
      status: "RejectedByReviewer",
      invalidatedAt: input.invalidatedAt ?? new Date(),
      invalidatedReason: input.reason,
    });
  }

  async markCandidatePromoted(
    _actor: AuthorizationActor,
    input: { terminologyCandidateId: string; terminologyTermId: string },
  ): Promise<void> {
    const existing = this.candidates.get(input.terminologyCandidateId);
    if (!existing) return;
    this.candidates.set(input.terminologyCandidateId, {
      ...existing,
      status: "Promoted",
      conflictingTerminologyTermId: input.terminologyTermId,
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

  async existsTerminologyTermBySurfaceForm(
    _actor: AuthorizationActor,
    input: ExistsTerminologyTermBySurfaceFormInput,
  ): Promise<string | null> {
    return this.glossary.get(input.surfaceForm) ?? null;
  }
}

const actor: AuthorizationActor = { userId: "test-user" };
const projectId = "019ed018-0000-7000-8000-000000000001";
const localeBranchId = "019ed018-0000-7000-8000-000000000002";
const sourceRevisionId = "019ed018-0000-7000-8000-000000000003";

function seedCandidate(
  repo: InMemoryTerminologyCandidateRepository,
  surfaceForm: string,
  citations: Array<[string, string]>,
): TerminologyCandidateRecord {
  const record: TerminologyCandidateRecord = {
    terminologyCandidateId: `cand-${surfaceForm}`,
    projectId,
    localeBranchId,
    sourceRevisionId,
    kind: "ProperNoun",
    surfaceForm,
    surfaceLocale: "ja-JP",
    rationale: "x",
    readingHint: null,
    conflictingTerminologyTermId: null,
    modelProviderFamily: "fake",
    modelId: "fake-v0",
    modelContextWindowTokens: 16000,
    modelMaxOutputTokens: 1024,
    promptTemplateVersion: "itotori-terminology-candidate-v1",
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
  repo.candidates.set(record.terminologyCandidateId, record);
  for (const [id, hash] of citations) {
    repo.sourceHashes.set(id, hash);
  }
  return record;
}

describe("markStaleTerminologyCandidatesForRevision", () => {
  it("returns clean scan when no source hashes have drifted and no conflicts exist", async () => {
    const repo = new InMemoryTerminologyCandidateRepository();
    seedCandidate(repo, "ハル", [["unit-1", "hash-1"]]);
    const result = await markStaleTerminologyCandidatesForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: true,
    });
    expect(result.driftedCandidates).toHaveLength(0);
    expect(result.conflictingCandidates).toHaveLength(0);
    expect(result.markedStaleCandidateCount).toBe(0);
    expect(result.markedRejectedCandidateCount).toBe(0);
    expect(result.scannedCandidateCount).toBe(1);
  });

  it("flags candidates whose cited unit hash drifted", async () => {
    const repo = new InMemoryTerminologyCandidateRepository();
    const candidate = seedCandidate(repo, "ハル", [["unit-1", "hash-1"]]);
    repo.sourceHashes.set("unit-1", "hash-1-new");
    const result = await markStaleTerminologyCandidatesForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: true,
    });
    expect(result.driftedCandidates).toHaveLength(1);
    expect(result.driftedCandidates[0]?.terminologyCandidateId).toBe(
      candidate.terminologyCandidateId,
    );
    expect(result.markedStaleCandidateCount).toBe(1);
    expect(repo.candidates.get(candidate.terminologyCandidateId)?.status).toBe("Stale");
    expect(repo.candidates.get(candidate.terminologyCandidateId)?.invalidatedReason).toBe(
      "source_hash_drift",
    );
  });

  it("flags candidates whose surface form is now in the glossary (post-persist conflict)", async () => {
    const repo = new InMemoryTerminologyCandidateRepository();
    const candidate = seedCandidate(repo, "ハル", [["unit-1", "hash-1"]]);
    // Curator added the term after persistence.
    repo.glossary.set("ハル", "term-haru");
    const result = await markStaleTerminologyCandidatesForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: true,
    });
    expect(result.conflictingCandidates).toHaveLength(1);
    expect(result.conflictingCandidates[0]?.terminologyTermId).toBe("term-haru");
    expect(result.markedRejectedCandidateCount).toBe(1);
    expect(repo.candidates.get(candidate.terminologyCandidateId)?.status).toBe(
      "RejectedByReviewer",
    );
    expect(repo.candidates.get(candidate.terminologyCandidateId)?.invalidatedReason).toBe(
      "glossary_conflict_post_persist",
    );
  });

  it("respects markStale=false (dry run)", async () => {
    const repo = new InMemoryTerminologyCandidateRepository();
    const candidate = seedCandidate(repo, "ハル", [["unit-1", "hash-1"]]);
    repo.sourceHashes.set("unit-1", "hash-1-new");
    const result = await markStaleTerminologyCandidatesForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: false,
    });
    expect(result.driftedCandidates).toHaveLength(1);
    expect(result.markedStaleCandidateCount).toBe(0);
    expect(repo.candidates.get(candidate.terminologyCandidateId)?.status).toBe("Fresh");
  });

  it("does not transition drifted candidates to RejectedByReviewer even when glossary conflicts exist", async () => {
    // When a candidate is BOTH drifted AND conflicting, the drift wins
    // (RejectedByReviewer is reserved for the post-persist conflict
    // scenario where the citation has NOT drifted).
    const repo = new InMemoryTerminologyCandidateRepository();
    seedCandidate(repo, "ハル", [["unit-1", "hash-1"]]);
    repo.sourceHashes.set("unit-1", "hash-1-new");
    repo.glossary.set("ハル", "term-haru");
    const result = await markStaleTerminologyCandidatesForRevision(repo, actor, {
      projectId,
      localeBranchId,
      sourceRevisionId,
      markStale: true,
    });
    expect(result.driftedCandidates).toHaveLength(1);
    expect(result.conflictingCandidates).toHaveLength(0);
    expect(result.markedStaleCandidateCount).toBe(1);
    expect(result.markedRejectedCandidateCount).toBe(0);
  });
});
