import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertCatalogResolverFixtureArtifact,
  catalogResolverFixtureDiagnosticCodeValues,
  catalogResolverFixtureReviewReadModel,
  createCatalogResolverFixtureArtifact,
  type CatalogResolverFixtureInput,
} from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../fixtures/catalog-resolver/fixture.json", import.meta.url), "utf8"),
) as CatalogResolverFixtureInput;

describe("catalog resolver fixture artifact", () => {
  it("composes exact links, fuzzy candidates, conflicts, registry ids, and provenance hashes", () => {
    const artifact = createCatalogResolverFixtureArtifact(fixture);

    assertCatalogResolverFixtureArtifact(artifact);
    expect(artifact.exactLinks.map((entry) => entry.exactLinkId)).toEqual([
      "exact-link:dlsite:RJ349517",
      "exact-link:dlsite:rj-no-match",
      "exact-link:manual-conflict",
    ]);
    expect(artifact.exactLinks[0]).toMatchObject({
      status: "linked",
      workId: "work-dlsite-rj349517",
      matchIds: ["dlsite:RJ349517:store_product:work-dlsite-rj349517"],
    });
    expect(artifact.fuzzyCandidates.candidateIds).toEqual([
      "candidate:egs-moonlight-001:work-moonlight-hd",
    ]);
    expect(artifact.conflicts.conflictIds).toEqual([
      "catalog-conflict:manual-duplicate-external-id",
      "catalog-candidate:candidate:egs-moonlight-001:work-moonlight-hd",
    ]);
    expect(artifact.sourceRegistry.map((entry) => entry.sourceRegistryId)).toEqual([
      "source-registry:dlsite:RJ349517",
      "source-registry:egs:egs-moonlight-001",
      "source-registry:vndb:v-cat-010",
    ]);
    expect(artifact.provenanceHashes.map((entry) => entry.provenanceHash)).toEqual([
      "sha256:8ca1e815bb35c1b72281b9857262fbd97423a7e7634f4f7c8718b7f239c57ab1",
      "sha256:bb21ec7a93ae9a148ca0652b2940f3e2c35e127a30a6488f2672bdf7f8f47054",
      "sha256:c7a3d80d9f5c1d6f48bf04fd94a032b8a8c8235422db03f3ad47be482c68f7f9",
    ]);
  });

  it("returns semantic diagnostics for no-match and unsupported payload fixture paths", () => {
    const artifact = createCatalogResolverFixtureArtifact(fixture);

    expect(artifact.status).toBe("reviewable_with_diagnostics");
    expect(artifact.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogResolverFixtureDiagnosticCodeValues.unsupportedSourcePayload,
          severity: "error",
          sourceRegistryId: "source-registry:unsupported:legacy-payload",
        }),
        expect.objectContaining({
          code: catalogResolverFixtureDiagnosticCodeValues.noMatch,
          severity: "info",
          exactLinkId: "exact-link:dlsite:rj-no-match",
        }),
      ]),
    );
  });

  it("marks malformed source payload records invalid with semantic diagnostics", () => {
    const artifact = createCatalogResolverFixtureArtifact({
      ...fixture,
      sourceRegistry: [...fixture.sourceRegistry, { sourceRegistryId: "source-registry:broken" }],
    });

    expect(artifact.status).toBe("invalid");
    expect(artifact.diagnostics).toContainEqual(
      expect.objectContaining({
        code: catalogResolverFixtureDiagnosticCodeValues.invalidSourceRegistry,
        severity: "error",
        path: "$.sourceRegistry[4]",
      }),
    );
  });

  it("rejects malformed nested resolver payloads instead of producing reviewable null ids", () => {
    const artifact = createCatalogResolverFixtureArtifact({
      ...fixture,
      sourceRegistry: fixture.sourceRegistry.slice(0, 3),
      exactLinks: [
        {
          exactLinkId: "exact-link:malformed",
          result: {
            status: "linked",
            matches: [],
            diagnostics: [],
          },
        },
      ],
      fuzzyCandidates: {
        schemaVersion: "catalog.fuzzy_candidates.v0.1",
        generatorVersion: "deterministic-title-year.v0.1",
        status: "generated",
        candidates: [{}],
        diagnostics: [],
      },
      conflicts: { rows: [{}] },
    });

    expect(artifact.status).toBe("invalid");
    expect(artifact.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogResolverFixtureDiagnosticCodeValues.invalidExactLinkResult,
          severity: "error",
          path: "$.exactLinks[0].result",
        }),
        expect.objectContaining({
          code: catalogResolverFixtureDiagnosticCodeValues.invalidExactLinkResult,
          severity: "error",
          path: "$.exactLinks[0].result.workId",
        }),
        expect.objectContaining({
          code: catalogResolverFixtureDiagnosticCodeValues.invalidFuzzyCandidateResult,
          severity: "error",
          path: "$.fuzzyCandidates.candidates[0]",
        }),
        expect.objectContaining({
          code: catalogResolverFixtureDiagnosticCodeValues.invalidConflictReview,
          severity: "error",
          path: "$.conflicts.rows[0]",
        }),
      ]),
    );
    expect(artifact.exactLinks).toEqual([]);
    expect(artifact.fuzzyCandidates.candidateIds).toEqual([]);
    expect(artifact.conflicts.conflictIds).toEqual([]);
    expect(artifact.review).toMatchObject({
      status: "invalid",
      exactLinkedWorkIds: [],
      fuzzyCandidateIds: [],
      conflictIds: [],
      reviewable: {
        exactLinks: [],
        fuzzyCandidates: [],
        conflicts: [],
      },
    });
  });

  it("asserts nested artifact ids are present strings", () => {
    const artifact = createCatalogResolverFixtureArtifact(fixture);

    expect(() =>
      assertCatalogResolverFixtureArtifact({
        ...artifact,
        fuzzyCandidates: {
          ...artifact.fuzzyCandidates,
          candidateIds: [null],
        },
      }),
    ).toThrow("fuzzyCandidates");
  });

  it("derives a review read model from the recorded artifact without live catalog access", () => {
    const artifact = createCatalogResolverFixtureArtifact(fixture);
    const review = catalogResolverFixtureReviewReadModel(artifact);

    expect(review).toMatchObject({
      artifactId: "catalog-resolver-integration-001",
      exactLinkIds: [
        "exact-link:dlsite:RJ349517",
        "exact-link:dlsite:rj-no-match",
        "exact-link:manual-conflict",
      ],
      exactLinkedWorkIds: ["work-dlsite-rj349517"],
      fuzzyCandidateIds: ["candidate:egs-moonlight-001:work-moonlight-hd"],
      conflictIds: [
        "catalog-conflict:manual-duplicate-external-id",
        "catalog-candidate:candidate:egs-moonlight-001:work-moonlight-hd",
      ],
      sourceRegistryIds: [
        "source-registry:dlsite:RJ349517",
        "source-registry:egs:egs-moonlight-001",
        "source-registry:vndb:v-cat-010",
      ],
    });
    expect(review.noMatchDiagnostics).toHaveLength(1);
    expect(review.reviewable.fuzzyCandidates).toHaveLength(1);
    expect(review.reviewable.conflicts).toHaveLength(2);
  });
});
