// @vitest-environment jsdom
// ovw-benchmark-headline-ui — behavior-first test for the Overview benchmark
// headline tile.
//
// Mounts the real `BenchmarkHeadlineTile` over msw-intercepted
// `/api/projects/overview` (for the project identity) + the gated
// `/api/projects/{projectId}/bmk-cockpit` cockpit route, and asserts the
// OBSERVABLE behavior: Self vs official / fan / MTL contestants + the §8
// panel↔human confidence + a strong-caliber VERDICT render from the cockpit
// read model, sourced THROUGH the typed client (no ad-hoc fetch); loading /
// empty / error surface instead of a blank or fabricated panel.
//
// The cockpit route + its response asserter are wired through the typed client;
// these fixtures stay complete so client-side response validation runs before
// the headline tile consumes the read model.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered contestants + their sourced standings + the verdict are
// asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  BmkCockpitConfidence,
  BmkCockpitContestant,
  BmkCockpitContestantRole,
  BmkCockpitHumanAnchor,
  BmkCockpitReadModel,
} from "../src/bmk-cockpit-read-model.js";
import { BenchmarkHeadlineTile } from "../src/ui/screens/BenchmarkHeadlineTile.js";
import { projectOverviewFixture } from "./api-fixtures.js";

// ---------------------------------------------------------------------------
// Fixture — a valid cockpit read model, built as a literal. The real composer
// (`projectBmkCockpitReadModel`) cannot be imported here: it pulls the
// benchmark-stages graph whose report-renderer imports
// `@itotori/localization-bridge-schema`, a transitive dep vitest cannot
// resolve from the app context. The fields the tile renders (contestants,
// rankedRoles, humanAnchor, confidence, unitsScored) are typed via the
// read-model types; `actionableBacklog` is a closed empty backlog (the tile
// never reads its internals, only the defensive `actionableBacklogSize`).
// ---------------------------------------------------------------------------

// The §9 ranking projected onto the cockpit vocabulary. Self
// (itotori_context_on) leads a calibrated field — the strong-caliber "proven"
// verdict. Scores/ranks are sourced verbatim; coverage stays null (the §9
// primitive surfaces no coverage today — an honest null, never a fabricated 0).
function contestant(
  role: BmkCockpitContestantRole,
  kind: BmkCockpitContestant["contestantKind"],
  aggregateScore: number,
  rank: number,
  judgeMean: number,
  metricMean: number,
): BmkCockpitContestant {
  return {
    role,
    contestantKind: kind,
    aggregateScore,
    rank,
    judgeMean,
    metricMean,
    coverage: null,
  };
}

const RICH_CONTESTANTS: BmkCockpitContestant[] = [
  contestant("self", "itotori_context_on", 0.82, 0, 3.6, 0.82),
  contestant("official", "official_localization", 0.76, 1, 3.4, 0.76),
  contestant("fan", "fan_edited_mtl", 0.58, 2, 2.7, 0.58),
  contestant("self_nocontext", "itotori_context_off", 0.51, 3, 2.4, 0.51),
  contestant("mtl", "raw_mtl_baseline", 0.39, 4, 2.0, 0.39),
];

const RICH_CONFIDENCE: BmkCockpitConfidence = {
  pearson: 0.82,
  normalizedAgreement: 0.85,
  value: 0.82,
  basis: "pearson",
};

const RICH_HUMAN_ANCHOR: BmkCockpitHumanAnchor = {
  raters: ["rater-1"],
  judgeIds: ["judge-1"],
  byDimensionCount: 0,
  divergentDimensionCount: 0,
  overall: {
    itemsCompared: 24,
    normalizedAgreement: 0.85,
    signedMeanDiff: -0.3,
    pearson: 0.82,
  },
};

type CockpitFixtureOverrides = Partial<{
  contestants: BmkCockpitContestant[];
  rankedRoles: BmkCockpitContestantRole[];
  confidence: BmkCockpitConfidence;
  humanAnchor: BmkCockpitHumanAnchor;
  unitsScored: number;
}>;

function emptyBacklogFixture(): BmkCockpitReadModel["actionableBacklog"] {
  return {
    systemUnderTestId: "itotori_context_on",
    fanMtlSystemId: "fan_edited_mtl",
    professionalSystemId: "official_localization",
    items: [],
    countsByRank: {
      top_priority: 0,
      improvement_backlog: 0,
      regression_protection: 0,
    },
    perDimensionRegression: [],
    perSignalScores: [],
    dag: { nodes: [], findings: [] },
    adjudicatedFindings: [],
  };
}

function bmkCockpitFixture(overrides?: CockpitFixtureOverrides): BmkCockpitReadModel {
  return {
    schemaVersion: "itotori.bmk-cockpit.v0.1",
    generatedAt: "2026-07-07T00:00:00.000Z",
    projectId: "project-1",
    localeBranchId: "019ed065-0000-7000-8000-000000000110",
    runId: "bmk-run-1",
    targetLocale: "ja-JP",
    kind: "real_run",
    status: "succeeded",
    unitsScored: 24,
    recordedAt: "2026-07-07T00:00:00.000Z",
    contestants: RICH_CONTESTANTS,
    rankedRoles: ["self", "official", "fan", "self_nocontext", "mtl"],
    humanAnchor: RICH_HUMAN_ANCHOR,
    confidence: RICH_CONFIDENCE,
    // The tile only reads `actionableBacklogSize`; the backlog body is an
    // honest empty (no ranked failure modes for this run).
    actionableBacklog: emptyBacklogFixture(),
    actionableBacklogSize: 0,
    ...overrides,
  };
}

// A run recorded but scored zero items — neither a contestant standing nor a
// confidence exists. The honest empty case the tile surfaces as an empty state.
const EMPTY_CONFIDENCE: BmkCockpitConfidence = {
  pearson: null,
  normalizedAgreement: null,
  value: null,
  basis: "none",
};

function emptyContestants(): BmkCockpitContestant[] {
  return (
    [
      ["self", "itotori_context_on"],
      ["official", "official_localization"],
      ["fan", "fan_edited_mtl"],
      ["self_nocontext", "itotori_context_off"],
      ["mtl", "raw_mtl_baseline"],
    ] as Array<[BmkCockpitContestantRole, BmkCockpitContestant["contestantKind"]]>
  ).map(([role, kind]) => ({
    role,
    contestantKind: kind,
    aggregateScore: null,
    rank: null,
    judgeMean: null,
    metricMean: null,
    coverage: null,
  }));
}

const projectId = projectOverviewFixture.projectId;

const server = setupServer(
  http.get("*/api/projects/overview", () => HttpResponse.json(projectOverviewFixture)),
  http.get(`*/api/projects/${projectId}/bmk-cockpit`, () => HttpResponse.json(bmkCockpitFixture())),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Overview benchmark headline tile", () => {
  it("renders self vs contestants + confidence + verdict from the cockpit read model", async () => {
    const { container } = render(<BenchmarkHeadlineTile />);

    // Wait for the READY surface specifically (the strong-caliber verdict badge
    // only renders once the cockpit settles) so the sourced assertions below
    // do not race the loading surface.
    expect(await screen.findByText("Strong caliber")).toBeInTheDocument();

    // Panel title bar renders throughout (the stable shell heading).
    expect(screen.getByRole("heading", { name: /Benchmark headline/i })).toBeInTheDocument();

    // AGGREGATE: Self standing + Confidence + Units scored render as ds StatReadouts,
    // sourced verbatim from the cockpit (0.82 -> "82%", 24 units).
    const aggregate = screen.getByLabelText("Benchmark headline aggregate");
    expect(aggregate).toHaveTextContent("Self standing");
    expect(aggregate).toHaveTextContent("82%");
    expect(aggregate).toHaveTextContent("Confidence");
    expect(aggregate).toHaveTextContent("82%");
    expect(aggregate).toHaveTextContent("Units scored");
    expect(aggregate).toHaveTextContent("24");

    // VERDICT: self leads a calibrated field -> the strong-caliber "proven" verdict.
    const verdictNode = container.querySelector("[data-verdict]");
    expect(verdictNode).not.toBeNull();
    expect(verdictNode?.getAttribute("data-verdict")).toBe("proven");
    expect(verdictNode).toHaveTextContent("Strong caliber");
    expect(verdictNode).toHaveTextContent(/Self leads the field/i);

    // CONTESTANTS: the ranked field renders one row per contestant with sourced
    // standings (aggregate % + rank). Self is flagged + leads (rank #1).
    const list = screen.getByLabelText("Benchmark contestants");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(5);

    // Ranked order: self, official, fan, self_nocontext, mtl.
    const selfEl = list.querySelector('[data-contestant="self"]') as HTMLElement;
    expect(selfEl).not.toBeNull();
    expect(selfEl.getAttribute("data-self")).toBe("true");
    expect(selfEl).toHaveTextContent("Self");
    expect(selfEl).toHaveTextContent("82%");
    expect(selfEl).toHaveTextContent("#1");

    // Every contestant label renders (no game named); the field's sourced
    // standings render verbatim (no fabrication — an unscored contestant would
    // render "—"; here all are scored).
    expect(within(list).getByText("Official")).toBeInTheDocument();
    expect(within(list).getByText("Fan")).toBeInTheDocument();
    expect(within(list).getByText("MTL")).toBeInTheDocument();
    expect(within(list).getByText("Self (no context)")).toBeInTheDocument();
    expect(list).toHaveTextContent("76%");
    expect(list).toHaveTextContent("58%");
    expect(list).toHaveTextContent("51%");
    expect(list).toHaveTextContent("39%");
  });

  it("shows the loading surface before the read model settles", () => {
    render(<BenchmarkHeadlineTile />);
    expect(screen.getByText("Loading benchmark headline…")).toBeInTheDocument();
  });

  it("surfaces the empty state when the cockpit has no scored signal", async () => {
    server.use(
      http.get(`*/api/projects/${projectId}/bmk-cockpit`, () =>
        HttpResponse.json(
          bmkCockpitFixture({
            contestants: emptyContestants(),
            rankedRoles: ["official", "self", "self_nocontext", "fan", "mtl"],
            confidence: EMPTY_CONFIDENCE,
            humanAnchor: {
              raters: [],
              judgeIds: [],
              byDimensionCount: 0,
              divergentDimensionCount: 0,
              overall: {
                itemsCompared: 0,
                normalizedAgreement: null,
                signedMeanDiff: null,
                pearson: null,
              },
            },
            unitsScored: 0,
          }),
        ),
      ),
    );
    render(<BenchmarkHeadlineTile />);
    expect(
      await screen.findByText("No benchmark runs have been scored for this project yet."),
    ).toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get(`*/api/projects/${projectId}/bmk-cockpit`, () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read the benchmark cockpit" },
          { status: 403 },
        ),
      ),
    );
    render(<BenchmarkHeadlineTile />);
    expect(
      await screen.findByText("not permitted to read the benchmark cockpit"),
    ).toBeInTheDocument();
  });
});
