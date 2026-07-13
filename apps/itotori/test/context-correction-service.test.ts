import { describe, expect, it, vi } from "vitest";
import type {
  ItotoriContextCorrectionPersistencePort,
  PersistContextCorrectionInput,
} from "@itotori/db";
import { ContextCorrectionService } from "../src/orchestrator/context-correction-service.js";

describe("ContextCorrectionService", () => {
  it("preserves a run-generated relationship category and semantic data in a wiki correction", async () => {
    const persisted: PersistContextCorrectionInput[] = [];
    const service = new ContextCorrectionService({
      actor: { userId: "wiki-editor" },
      contextArtifacts: persistenceFixture(persisted),
    });

    await service.apply({
      projectId: "project-wiki",
      localeBranchId: "branch-wiki",
      sourceRevisionId: "revision-wiki",
      contextArtifactId: "character-relationship-hero-guide",
      kind: "character_note",
      title: "Relationship: Hero -> Guide",
      body: "The Guide is the Hero's mentor.",
      reason: "The playtest established the relationship.",
      affectedUnitIds: ["unit-1"],
      data: {
        semanticKind: "character_relationship",
        kind: "Mentor",
        fromCharacterId: "Hero",
        toCharacterId: "Guide",
      },
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      category: "character_note",
      data: {
        semanticKind: "character_relationship",
        // `kind` remains relationship semantics, not a correction marker.
        kind: "Mentor",
        correctionKind: "character_note",
      },
    });
  });

  it("gives title or data changes a distinct canonical correction identity", async () => {
    const persisted: PersistContextCorrectionInput[] = [];
    const service = new ContextCorrectionService({
      actor: { userId: "wiki-editor" },
      contextArtifacts: persistenceFixture(persisted),
    });
    const base = {
      projectId: "project-wiki",
      localeBranchId: "branch-wiki",
      sourceRevisionId: "revision-wiki",
      contextArtifactId: "route-moon",
      kind: "route_map" as const,
      body: "The moon route opens after the archive choice.",
      reason: "The playtest route map corrected this fact.",
      affectedUnitIds: ["unit-1"],
    };

    await service.apply({ ...base, title: "Moon route", data: { routeKey: "moon" } });
    await service.apply({ ...base, title: "Moonlit route", data: { routeKey: "moonlit" } });

    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.correctionId).not.toBe(persisted[1]?.correctionId);
  });

  it("keeps the same correction identity when a wiki retry reloads node-8 markers", async () => {
    const persisted: PersistContextCorrectionInput[] = [];
    const service = new ContextCorrectionService({
      actor: { userId: "wiki-editor" },
      contextArtifacts: persistenceFixture(persisted),
    });
    const input = {
      projectId: "project-wiki",
      localeBranchId: "branch-wiki",
      sourceRevisionId: "revision-wiki",
      contextArtifactId: "speaker-label-unit-1",
      kind: "speaker_label" as const,
      title: "Speaker label: unit 1",
      body: "Captain Wato speaks this line.",
      reason: "The play test confirmed the line attribution.",
      affectedUnitIds: ["unit-1"],
      data: { speakerLabel: { speaker: "Captain Wato", confidence: "high" } },
    };

    await service.apply(input);
    const storedData = persisted[0]?.data;
    if (storedData === undefined) {
      throw new Error("first correction did not persist canonical data");
    }
    await service.apply({ ...input, data: storedData });

    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.correctionId).toBe(persisted[0]?.correctionId);
    expect(persisted[1]?.data).toMatchObject({
      speakerLabel: { speaker: "Captain Wato", confidence: "high" },
      correctionKind: "speaker_label",
      correctionId: persisted[0]?.correctionId,
    });
  });
});

function persistenceFixture(
  persisted: PersistContextCorrectionInput[],
): ItotoriContextCorrectionPersistencePort {
  return {
    persistContextCorrection: vi.fn(async (_actor, input) => {
      persisted.push(input);
      return {
        contextArtifact: { contextArtifactId: input.contextArtifactId, headVersionId: "version-1" },
        affectedUnitIds: [...input.requestedAffectedUnitIds],
        invalidatedArtifactIds: [],
        redraftJob: { jobId: "redraft-job-1" },
        duplicate: false,
      } as never;
    }),
  };
}
