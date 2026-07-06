// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type {
  CatalogBenchmarkSeedRow,
  CatalogReleaseRecord,
  LocaleBranchStatus,
} from "@itotori/db";
import {
  catalogContextPanelViewFromReadModel,
  collapseCatalogReadiness,
  renderCatalogContextPanel,
  type CatalogContextPanelInput,
} from "../src/catalog-context-panel.js";

// A raw source-language DIALOGUE line. It is NEVER part of any panel input —
// the panel is sourced strictly from typed catalog facts + project state. The
// tests assert it can never leak into the rendered panel.
const RAW_SOURCE_PROSE = "「またお前か……この街で何をしている？」";

// Catalog identity strings ARE source-language, and the panel is EXPECTED to
// surface them (that is the identity a non-source-reader asked for). These are
// structured catalog fields, not scene prose.
const CANONICAL_TITLE = "おしおきスイーティー";
const ALIAS_TITLE = "Oshioki Sweetie — Deluxe";

const seedRow: CatalogBenchmarkSeedRow = {
  workId: "019ed065-0000-7000-8000-0000000000aa",
  canonicalTitle: CANONICAL_TITLE,
  originalLanguage: "ja",
  sourceIds: [
    { catalogSource: "vndb", sourceId: "v60663", externalIdKind: "source_record" },
    { catalogSource: "dlsite", sourceId: "RJ123456", externalIdKind: "store_product" },
  ],
  completenessPool: "no_english",
  translationStatuses: [
    {
      language: "en-US",
      status: "none",
      confidence: "high",
      statusScope: "work",
      platform: null,
    },
    {
      language: "zh-Hans",
      status: "mtl",
      confidence: "medium",
      statusScope: "release",
      platform: "windows",
    },
  ],
  localOwnership: "owned",
  localEvidenceCount: 3,
  demandBucket: "high",
  readiness: {
    adapterId: "softpal-adv",
    identify: "supported",
    inventory: "supported",
    extract: "supported",
    patch: "partial",
    helper: "unknown",
    runtime: "unsupported",
  },
  provenance: [],
  decision: "seed",
  rank: 1,
  seedRank: 1,
  explanationCodes: [],
};

function releaseFixture(overrides: Partial<CatalogReleaseRecord>): CatalogReleaseRecord {
  return {
    releaseId: "019ed065-0000-7000-8000-0000000000b0",
    workId: seedRow.workId,
    catalogSource: "vndb",
    sourceReleaseId: null,
    releaseTitle: CANONICAL_TITLE,
    releaseKind: "original",
    editionName: null,
    milestone: null,
    packageKind: "loose_files",
    engineName: "softpal",
    engineSource: "vndb",
    engineConfidence: "high",
    engineProvenanceId: null,
    platform: "windows",
    language: "ja",
    releaseDate: "2018-05-25",
    releaseYear: 2018,
    isOfficial: true,
    sourceProvenanceId: null,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const releases: CatalogReleaseRecord[] = [
  releaseFixture({}),
  releaseFixture({
    releaseId: "019ed065-0000-7000-8000-0000000000b1",
    releaseTitle: ALIAS_TITLE,
    editionName: "Deluxe",
    releaseKind: "edition",
    isOfficial: true,
  }),
];

const localeBranch: LocaleBranchStatus = {
  localeBranchId: "019ed065-0000-7000-8000-0000000000c0",
  targetLocale: "en-US",
  status: "in_progress",
  currentStyleGuidePolicyVersionId: null,
  unitCount: 20,
  translatedUnitCount: 5,
  openFindingCount: 2,
  artifactCount: 1,
};

const input: CatalogContextPanelInput = {
  row: seedRow,
  releases,
  projectState: { targetLanguage: "en-US", localeBranch },
};

function renderInto(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("catalogContextPanelViewFromReadModel", () => {
  it("projects every reviewer-facing fact from the typed read-models", () => {
    const view = catalogContextPanelViewFromReadModel(input);

    expect(view.identity.workId).toBe(seedRow.workId);
    expect(view.identity.canonicalTitle).toBe(CANONICAL_TITLE);
    expect(view.identity.sourceIds).toEqual(seedRow.sourceIds);
    // Aliases = distinct release titles that differ from the canonical title.
    expect(view.identity.aliases).toEqual([ALIAS_TITLE]);
    expect(view.editions).toHaveLength(2);
    expect(view.editions[1]?.editionName).toBe("Deluxe");
    expect(view.completeness.completenessPool).toBe("no_english");
    expect(view.completeness.targetLanguageStatus?.status).toBe("none");
    expect(view.demandBucket).toBe("high");
    expect(view.localCorpus).toEqual({ ownership: "owned", evidenceCount: 3 });
    // patch=partial collapses to extract-ready (a patch can't be produced yet).
    expect(view.readiness.level).toBe("extract_ready");
    expect(view.readiness.rungs).toHaveLength(6);
    expect(view.projectState).toMatchObject({
      targetLanguage: "en-US",
      localizing: true,
      localeBranchStatus: "in_progress",
      translatedUnitCount: 5,
      unitCount: 20,
      progressPercentage: 25,
    });
  });

  it("reports no tracking branch as not-localizing with zero progress", () => {
    const view = catalogContextPanelViewFromReadModel({
      ...input,
      projectState: { targetLanguage: "de-DE", localeBranch: null },
    });
    expect(view.projectState.localizing).toBe(false);
    expect(view.projectState.localeBranchStatus).toBeNull();
    expect(view.projectState.progressPercentage).toBe(0);
    expect(view.completeness.targetLanguageStatus).toBeNull();
  });
});

describe("collapseCatalogReadiness", () => {
  it("orders the adapter-readiness ladder patch > extract > inventory > identify", () => {
    const base = seedRow.readiness;
    expect(collapseCatalogReadiness({ ...base, patch: "supported" })).toBe("patch_ready");
    expect(collapseCatalogReadiness({ ...base, patch: "partial" })).toBe("extract_ready");
    expect(
      collapseCatalogReadiness({
        ...base,
        extract: "unsupported",
        patch: "unsupported",
      }),
    ).toBe("inventory_ready");
    expect(
      collapseCatalogReadiness({
        adapterId: null,
        identify: "supported",
        inventory: "unsupported",
        extract: "unsupported",
        patch: "unsupported",
        helper: "unsupported",
        runtime: "unsupported",
      }),
    ).toBe("identify_ready");
    expect(
      collapseCatalogReadiness({
        adapterId: null,
        identify: "unsupported",
        inventory: "unsupported",
        extract: "unsupported",
        patch: "unsupported",
        helper: "unsupported",
        runtime: "unsupported",
      }),
    ).toBe("unsupported");
  });
});

describe("renderCatalogContextPanel", () => {
  it("renders identity, aliases, edition, completeness, demand, local corpus, and readiness", () => {
    const view = catalogContextPanelViewFromReadModel(input);
    const root = renderInto(renderCatalogContextPanel(view));

    const panel = root.querySelector('[data-state="catalog-context-ready"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("data-work-id")).toBe(seedRow.workId);

    // Identity + source IDs.
    expect(root.textContent).toContain(CANONICAL_TITLE);
    expect(root.textContent).toContain(seedRow.workId);
    expect(root.textContent).toContain("v60663");
    expect(root.textContent).toContain("RJ123456");
    expect(root.textContent).toContain("source_record");

    // Aliases + edition.
    const aliasCard = root.querySelector('[data-context-section="Aliases"]');
    expect(aliasCard?.textContent).toContain(ALIAS_TITLE);
    const editionCard = root.querySelector('[data-context-section="Editions"]');
    expect(editionCard?.textContent).toContain("Deluxe");
    expect(editionCard?.textContent).toContain("official");

    // Completeness (with target-language highlight) + demand + local corpus.
    const completeness = root.querySelector('[data-context-section="Translation completeness"]');
    expect(completeness?.textContent).toContain("no_english");
    expect(completeness?.querySelector(".target-language-row")).not.toBeNull();
    expect(root.querySelector('[data-context-section="Demand"]')?.textContent).toContain("high");
    const localCorpus = root.querySelector('[data-context-section="Local corpus"]');
    expect(localCorpus?.textContent).toContain("owned");
    expect(localCorpus?.textContent).toContain("3");

    // Readiness (overall + every capability rung) + project state.
    const readiness = root.querySelector('[data-context-section="Readiness"]');
    expect(readiness?.textContent).toContain("extract_ready");
    expect(readiness?.textContent).toContain("softpal-adv");
    for (const capability of ["identify", "inventory", "extract", "patch", "helper", "runtime"]) {
      expect(readiness?.textContent).toContain(capability);
    }
    const projectState = root.querySelector('[data-context-section="Project state"]');
    expect(projectState?.textContent).toContain("en-US");
    expect(projectState?.textContent).toContain("in_progress");
    expect(projectState?.textContent).toContain("5/20");
  });

  it("never leaks raw source-language prose the reviewer cannot read", () => {
    const view = catalogContextPanelViewFromReadModel(input);
    const html = renderCatalogContextPanel(view);

    // The panel is sourced only from typed catalog facts + project state; raw
    // scene dialogue is structurally absent from every input, so it can never
    // appear in the rendered panel.
    expect(html).not.toContain(RAW_SOURCE_PROSE);
    // Identity fields (title/alias) are the only source-language strings and
    // are intentionally present.
    expect(html).toContain(CANONICAL_TITLE);
    expect(html).toContain(ALIAS_TITLE);
  });

  it("renders empty-state copy when catalog facts are sparse", () => {
    const sparseView = catalogContextPanelViewFromReadModel({
      row: {
        ...seedRow,
        sourceIds: [],
        translationStatuses: [],
      },
      releases: [],
      projectState: { targetLanguage: "en-US", localeBranch: null },
    });
    const root = renderInto(renderCatalogContextPanel(sparseView));
    expect(root.textContent).toContain("No catalog source IDs recorded");
    expect(root.textContent).toContain("No alternate release titles recorded");
    expect(root.textContent).toContain("No catalog releases recorded");
  });
});
