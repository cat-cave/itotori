// @vitest-environment jsdom
// bmk-cockpit-ui — behavior-first test for the benchmark cockpit screen.
//
// Mounts the real `BenchmarkCockpitScreen` over msw-intercepted
// `/api/projects/overview` (for the project identity) + the gated
// `/api/projects/{projectId}/bmk-cockpit` cockpit route + history route, and asserts the
// OBSERVABLE behavior: the comparative CONTESTANT PALETTE (official / self /
// self_nocontext / fan / mtl, each swatch keyed off the `--ito-contestant-*`
// token) + the §8 human anchor + headline CONFIDENCE + the ACTIONABLE BACKLOG
// (the cockpit's PRIMARY diagnostic output) render from the read model, sourced
// THROUGH the typed client (no ad-hoc fetch); loading / empty / error surface
// instead of a blank or fabricated panel.
//
// The cockpit route + its response asserter are wired through the typed client;
// these fixtures stay complete so client-side response validation runs before
// the cockpit screen consumes the read model.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only the
// rendered contestants + backlog + confidence + the loading/empty/error states
// are asserted, over msw.

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
  BmkCockpitRunHistoryPage,
} from "../src/bmk-cockpit-read-model.js";
import {
  BACKLOG_RANK_LABELS,
  BenchmarkCockpitScreen,
  benchmarkCockpitBacklogRows,
  formatCockpitConfidence,
} from "../src/ui/screens/BenchmarkCockpitScreen.js";
import { projectOverviewFixture } from "./api-fixtures.js";

// ---------------------------------------------------------------------------
// Fixture — a valid cockpit read model with a RANKED ACTIONABLE BACKLOG. The
// real composer cannot be imported here (its graph pulls
// @itotori/localization-bridge-schema, a transitive dep vitest cannot resolve
// from the app context); the fields the screen renders are typed via the
// read-model + actionable-backlog types, and the backlog body is cast to the
// closed `actionableBacklog` shape.
// ---------------------------------------------------------------------------

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
  byDimensionCount: 4,
  divergentDimensionCount: 1,
  overall: {
    itemsCompared: 24,
    normalizedAgreement: 0.85,
    signedMeanDiff: -0.3,
    pearson: 0.82,
  },
};

// A ranked actionable backlog — two failure modes, one top-priority blind spot
// (trailing even fan-MTL) + one improvement-backlog item (trailing pro). The
// §10 cockpit's PRIMARY output; this is what the screen exists to surface.
type BacklogFixture = BmkCockpitReadModel["actionableBacklog"];

function emptyBacklogFixture(): BacklogFixture {
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
  } as BacklogFixture;
}

function backlogFixture(): BacklogFixture {
  const items = [
    {
      backlogItemId: "bmk-backlog-item-glossary",
      failureMode: "Glossary drift on protagonist name",
      dimension: "terminology",
      signalSource: "deterministic_metric",
      scope: {
        scopeKind: "corpus_wide",
        scopeId: "corpus",
        unitCount: 12,
        unitIds: ["unit-1", "unit-2"],
        description: "Corpus-wide — 12 source units.",
      },
      evidence: [],
      cause: "glossary_policy_gap",
      causeAdjudicated: true,
      fixCandidate: "glossary enforcement (declare/enforce the canon target form)",
      rank: "top_priority",
      ladder: {
        scale: "judge_mean_0_4",
        systemUnderTestScore: 2.1,
        fanMtlScore: 2.2,
        professionalScore: 3.4,
        beatsFanMtl: false,
        beatsProfessional: false,
      },
      regressionRef: null,
      findingIds: ["finding-1"],
      worstSeverity: "major",
      priorityOrder: 0,
    },
    {
      backlogItemId: "bmk-backlog-item-voice",
      failureMode: "Character-voice style drift in scene 03",
      dimension: "character_voice_consistency",
      signalSource: "blind_judge_panel",
      scope: {
        scopeKind: "scene",
        scopeId: "scene-03",
        unitCount: 5,
        unitIds: ["unit-3"],
        description: "Scene 03 — 5 units.",
      },
      evidence: [],
      cause: "style_guide_gap",
      causeAdjudicated: true,
      fixCandidate: "style-guide + context tuning (register/voice/locale guidance)",
      rank: "improvement_backlog",
      ladder: {
        scale: "judge_mean_0_4",
        systemUnderTestScore: 2.9,
        fanMtlScore: 2.4,
        professionalScore: 3.5,
        beatsFanMtl: true,
        beatsProfessional: false,
      },
      regressionRef: null,
      findingIds: ["finding-2"],
      worstSeverity: "minor",
      priorityOrder: 1,
    },
  ];
  return {
    systemUnderTestId: "itotori_context_on",
    fanMtlSystemId: "fan_edited_mtl",
    professionalSystemId: "official_localization",
    items,
    countsByRank: {
      top_priority: 1,
      improvement_backlog: 1,
      regression_protection: 0,
    },
    perDimensionRegression: [],
    perSignalScores: [],
    dag: { nodes: [], findings: [] },
    adjudicatedFindings: [],
  } as BacklogFixture;
}

type CockpitFixtureOverrides = Partial<{
  contestants: BmkCockpitContestant[];
  rankedRoles: BmkCockpitContestantRole[];
  confidence: BmkCockpitConfidence;
  humanAnchor: BmkCockpitHumanAnchor;
  unitsScored: number;
  actionableBacklog: BacklogFixture;
  actionableBacklogSize: number;
}>;

function bmkCockpitFixture(overrides?: CockpitFixtureOverrides): BmkCockpitReadModel {
  const backlog = overrides?.actionableBacklog ?? backlogFixture();
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
    actionableBacklog: backlog,
    actionableBacklogSize: backlog.items.length,
    ...overrides,
  };
}

function bmkCockpitHistoryFixture(
  overrides?: Partial<BmkCockpitRunHistoryPage>,
): BmkCockpitRunHistoryPage {
  return {
    filter: {
      projectId: "project-1",
      localeBranchId: null,
    },
    pagination: {
      limit: 25,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    },
    rows: [
      {
        runId: "bmk-run-1",
        projectId: "project-1",
        localeBranchId: "019ed065-0000-7000-8000-000000000110",
        targetLocale: "ja-JP",
        kind: "real_run",
        status: "succeeded",
        unitsScored: 24,
        recordedAt: "2026-07-07T00:00:00.000Z",
        bestRole: "self",
        actionableBacklogSize: 2,
        confidence: 0.82,
      },
      {
        runId: "bmk-run-0",
        projectId: "project-1",
        localeBranchId: "019ed065-0000-7000-8000-000000000110",
        targetLocale: "ja-JP",
        kind: "real_run",
        status: "partial",
        unitsScored: 18,
        recordedAt: "2026-07-01T00:00:00.000Z",
        bestRole: "official",
        actionableBacklogSize: 5,
        confidence: 0.71,
      },
    ],
    ...overrides,
  };
}

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
  http.get(`*/api/projects/${projectId}/bmk-cockpit/history`, () =>
    HttpResponse.json(bmkCockpitHistoryFixture()),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Benchmark cockpit screen — pure derivation", () => {
  it("projects the ranked backlog rows in priority order with display labels", () => {
    const rows = benchmarkCockpitBacklogRows(bmkCockpitFixture());
    expect(rows).toHaveLength(2);
    expect(rows[0].backlogItemId).toBe("bmk-backlog-item-glossary");
    expect(rows[0].rankLabel).toBe(BACKLOG_RANK_LABELS.top_priority);
    expect(rows[0].severityLabel).toBe("Major");
    expect(rows[1].backlogItemId).toBe("bmk-backlog-item-voice");
    expect(rows[1].rankLabel).toBe(BACKLOG_RANK_LABELS.improvement_backlog);
  });

  it("formats the headline confidence with the sourced basis, or an honest dash", () => {
    expect(formatCockpitConfidence(RICH_CONFIDENCE)).toBe("82% · Pearson panel↔human");
    expect(formatCockpitConfidence(EMPTY_CONFIDENCE)).toBe("—");
  });
});

describe("Benchmark cockpit screen — rendered behavior", () => {
  it("renders contestants (palette) + confidence + history + the actionable backlog from the read models", async () => {
    render(<BenchmarkCockpitScreen />);

    // Wait for the READY surface (the strong-caliber verdict renders once the
    // cockpit settles) so the sourced assertions do not race the loading state.
    expect(await screen.findByText("Contestants")).toBeInTheDocument();

    // CONFIDENCE: the sourced value (82%, pearson) + units + anchor items render.
    const confidence = screen.getByLabelText("Benchmark confidence");
    expect(confidence).toHaveTextContent("82% · Pearson panel↔human");
    expect(confidence).toHaveTextContent("24");
    expect(confidence).toHaveTextContent("1");

    // CONTESTANTS: the comparative palette renders one ranked row per
    // contestant, each with a palette swatch keyed off its role token. Self is
    // flagged + leads the field (rank #1).
    const list = screen.getByLabelText("Benchmark contestants");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    const selfEl = list.querySelector('[data-contestant="self"]') as HTMLElement;
    expect(selfEl.getAttribute("data-self")).toBe("true");
    expect(selfEl).toHaveTextContent("Self");
    expect(selfEl).toHaveTextContent("82%");
    expect(selfEl).toHaveTextContent("#1");
    const selfSwatch = selfEl.querySelector(".itotori-contestant-swatch");
    expect(selfSwatch?.getAttribute("data-contestant")).toBe("self");
    expect(within(list).getByText("Official")).toBeInTheDocument();
    expect(within(list).getByText("Fan")).toBeInTheDocument();
    expect(within(list).getByText("MTL")).toBeInTheDocument();
    expect(within(list).getByText("Self (no context)")).toBeInTheDocument();

    // HISTORY: the cockpit consumes projects.bmkCockpitHistory and renders the
    // prior-run trend + run table from the history read model.
    expect(await screen.findByRole("heading", { name: "Benchmark history" })).toBeInTheDocument();
    const trend = screen.getByLabelText("Benchmark history trend");
    expect(trend).toHaveTextContent("Latest confidence");
    expect(trend).toHaveTextContent("82%");
    expect(trend).toHaveTextContent("Latest backlog");
    expect(trend).toHaveTextContent("2");
    expect(screen.getByText("bmk-run-0")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();

    // ACTIONABLE BACKLOG — the cockpit's PRIMARY output: the ranked failure
    // modes render as a ds DataTable, sourced verbatim (cause + fix candidate).
    expect(await screen.findByRole("heading", { name: "Actionable backlog" })).toBeInTheDocument();
    const backlogCounts = screen.getByLabelText("Backlog counts by rank");
    expect(backlogCounts).toHaveTextContent(BACKLOG_RANK_LABELS.top_priority);
    expect(backlogCounts).toHaveTextContent("1");
    expect(backlogCounts).toHaveTextContent(BACKLOG_RANK_LABELS.improvement_backlog);
    expect(screen.getByText("Glossary drift on protagonist name")).toBeInTheDocument();
    expect(
      screen.getByText("glossary enforcement (declare/enforce the canon target form)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Character-voice style drift in scene 03")).toBeInTheDocument();
    // The source run id is surfaced so a reviewer can audit the cockpit read.
    expect(screen.getAllByText("bmk-run-1").length).toBeGreaterThan(0);
  });

  it("shows the loading surface before the read model settles", () => {
    render(<BenchmarkCockpitScreen />);
    expect(screen.getByText("Loading benchmark cockpit…")).toBeInTheDocument();
  });

  it("surfaces the empty state when the cockpit has no scored signal and no backlog", async () => {
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
            actionableBacklog: emptyBacklogFixture(),
            actionableBacklogSize: 0,
          }),
        ),
      ),
    );
    render(<BenchmarkCockpitScreen />);
    expect(
      await screen.findByText("No benchmark runs have been scored for this project yet."),
    ).toBeInTheDocument();
  });

  it("surfaces a history empty state without hiding the ready cockpit", async () => {
    server.use(
      http.get(`*/api/projects/${projectId}/bmk-cockpit/history`, () =>
        HttpResponse.json(bmkCockpitHistoryFixture({ rows: [] })),
      ),
    );
    render(<BenchmarkCockpitScreen />);
    expect(await screen.findByText("Contestants")).toBeInTheDocument();
    expect(
      await screen.findByText("No prior benchmark runs are available for this project yet."),
    ).toBeInTheDocument();
    expect(screen.getByText("Actionable backlog")).toBeInTheDocument();
  });

  it("surfaces a history error state without hiding the ready cockpit", async () => {
    server.use(
      http.get(`*/api/projects/${projectId}/bmk-cockpit/history`, () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read benchmark history" },
          { status: 403 },
        ),
      ),
    );
    render(<BenchmarkCockpitScreen />);
    expect(await screen.findByText("Contestants")).toBeInTheDocument();
    expect(await screen.findByText("not permitted to read benchmark history")).toBeInTheDocument();
    expect(screen.getByText("Actionable backlog")).toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank screen", async () => {
    server.use(
      http.get(`*/api/projects/${projectId}/bmk-cockpit`, () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read the benchmark cockpit" },
          { status: 403 },
        ),
      ),
    );
    render(<BenchmarkCockpitScreen />);
    expect(
      await screen.findByText("not permitted to read the benchmark cockpit"),
    ).toBeInTheDocument();
  });
});
