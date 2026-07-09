// @vitest-environment jsdom
// xs-loop-spine-ui — behavior-first test for the iterative-loop spine panel.
//
// Mounts the real `LoopSpinePanel` over msw-intercepted `/api/projects/overview`
// (the first five stages) + the gated `/api/projects/{projectId}/bmk-cockpit`
// cockpit route (the confidence stage), and asserts the OBSERVABLE behavior:
// the whole loop (flag → decide → correct → launch → rescore → confidence)
// renders end-to-end as ONE legible spine, with each stage's signal SOURCED
// from the composed read models THROUGH the typed client (no ad-hoc fetch) +
// a deep-link into the stage's surface; loading / empty / error surface
// instead of a blank or fabricated panel.
//
// The cockpit route + its response asserter are wired through `apiJson`; these
// fixtures stay complete so client-side response validation runs before the
// spine consumes the read model.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered stages + their sourced signals + the deep-links are asserted,
// over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { BmkCockpitReadModel } from "../src/bmk-cockpit-read-model.js";
import type { ProjectOverviewReadModel } from "../src/project-overview-read-model.js";
import {
  deriveLoopSpine,
  formatLoopSpineScore,
  latestLoopSpinePassRow,
  LoopSpinePanel,
  resolveLoopSpineConfidence,
  type LoopSpineStage,
} from "../src/ui/screens/LoopSpinePanel.js";
import { dashboardStatusFixture, projectOverviewFixture } from "./api-fixtures.js";
import { apiJson } from "./msw-handlers.js";

// ---------------------------------------------------------------------------
// Fixture — a multi-pass overview so the correct / launch / rescore stages
// carry non-degenerate sourced signals (pass 2 folded 18 corrections, scored
// 3.9, so the next pass is 3). The fixture's progress.findingCount (3) +
// decisions.counts.pendingDecisionCount (3) drive the flag / decide stages.
// ---------------------------------------------------------------------------

function richOverview(overrides?: Partial<ProjectOverviewReadModel>): ProjectOverviewReadModel {
  return {
    ...projectOverviewFixture,
    passLedger: {
      filter: {
        projectId: dashboardStatusFixture.projectId,
        localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
      },
      pagination: {
        total: 2,
        limit: 10,
        offset: 0,
        page: 1,
        pageCount: 1,
        hasMore: false,
        nextOffset: null,
      },
      rows: [
        {
          passLedgerId: "localization-pass-1",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          passNumber: 1,
          priorPassNumber: null,
          totalUsageCostUsd: 0.051,
          zdrConfirmed: true,
          recordedAt: "2026-07-07T01:00:00.000Z",
          score: 3.4,
          feedback: 0,
          note: "First full draft.",
        },
        {
          passLedgerId: "localization-pass-2",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          passNumber: 2,
          priorPassNumber: 1,
          totalUsageCostUsd: 0.0612,
          zdrConfirmed: true,
          recordedAt: "2026-07-07T02:00:00.000Z",
          score: 3.9,
          feedback: 18,
          note: "Folded in 18 corrections.",
        },
      ],
    },
    ...overrides,
  };
}

// Self leads a calibrated field → the strong-caliber "proven" verdict drives
// the confidence stage. Built as a literal (see benchmark-headline-tile.test
// for the same constraint: the composer pulls a transitive dep vitest cannot
// resolve from the app context).
function strongCaliberCockpit(overrides?: Partial<BmkCockpitReadModel>): BmkCockpitReadModel {
  return {
    schemaVersion: "itotori.bmk-cockpit.v0.1",
    generatedAt: "2026-07-07T00:00:00.000Z",
    projectId: dashboardStatusFixture.projectId,
    localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
    runId: "bmk-run-spine-1",
    targetLocale: "ja-JP",
    kind: "real_run",
    status: "succeeded",
    unitsScored: 24,
    recordedAt: "2026-07-07T00:00:00.000Z",
    contestants: [
      {
        role: "self",
        contestantKind: "itotori_context_on",
        aggregateScore: 0.82,
        rank: 0,
        judgeMean: 3.6,
        metricMean: 0.82,
        coverage: null,
      },
      {
        role: "official",
        contestantKind: "official_localization",
        aggregateScore: 0.76,
        rank: 1,
        judgeMean: 3.4,
        metricMean: 0.76,
        coverage: null,
      },
      {
        role: "fan",
        contestantKind: "fan_edited_mtl",
        aggregateScore: 0.58,
        rank: 2,
        judgeMean: 2.7,
        metricMean: 0.58,
        coverage: null,
      },
      {
        role: "self_nocontext",
        contestantKind: "itotori_context_off",
        aggregateScore: 0.51,
        rank: 3,
        judgeMean: 2.4,
        metricMean: 0.51,
        coverage: null,
      },
      {
        role: "mtl",
        contestantKind: "raw_mtl_baseline",
        aggregateScore: 0.39,
        rank: 4,
        judgeMean: 2.0,
        metricMean: 0.39,
        coverage: null,
      },
    ],
    rankedRoles: ["self", "official", "fan", "self_nocontext", "mtl"],
    humanAnchor: {
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
    },
    confidence: {
      pearson: 0.82,
      normalizedAgreement: 0.85,
      value: 0.82,
      basis: "pearson",
    },
    actionableBacklog: {
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
    },
    actionableBacklogSize: 0,
    ...overrides,
  };
}

const projectId = projectOverviewFixture.projectId;

const server = setupServer(
  http.get("*/api/projects/overview", () => apiJson("projects.overview", richOverview())),
  http.get(`*/api/projects/${projectId}/bmk-cockpit`, () =>
    apiJson("projects.bmkCockpit", strongCaliberCockpit()),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Iterative-loop spine panel", () => {
  it("renders the whole loop end-to-end (flag → decide → correct → launch → rescore → confidence) with sourced signals + deep-links", async () => {
    render(<LoopSpinePanel />);

    // Wait for the READY surface (the confidence verdict only renders once the
    // cockpit settles) so the sourced assertions below do not race the loader.
    expect(await screen.findByText("Strong caliber")).toBeInTheDocument();

    // The panel title bar renders throughout (the stable shell heading).
    expect(screen.getByRole("heading", { name: /Iterative loop/i })).toBeInTheDocument();

    // The six stages render in handoff order as an ordered list.
    const spine = screen.getByLabelText("Iterative loop stages");
    const steps = within(spine).getAllByRole("listitem");
    expect(steps).toHaveLength(6);

    // flag — sourced from progress.findingCount (3) → links into the composer.
    const flag = spine.querySelector('[data-stage="flag"]') as HTMLElement;
    expect(flag).not.toBeNull();
    expect(flag).toHaveTextContent("Flag");
    expect(flag).toHaveTextContent("3 open");
    expect(flag.querySelector('[data-jump-to="flag"]')).toHaveAttribute("href", "/play/flag");

    // decide — sourced from decisions.counts.pendingDecisionCount (3).
    const decide = spine.querySelector('[data-stage="decide"]') as HTMLElement;
    expect(decide).not.toBeNull();
    expect(decide).toHaveTextContent("3 pending");
    expect(decide.querySelector('[data-jump-to="decide"]')).toHaveAttribute(
      "href",
      "/reviewer-queue",
    );

    // correct — sourced from the LATEST pass's feedback (pass 2 folded 18);
    // its handoff names the pass the corrections fold into (pass 3).
    const correct = spine.querySelector('[data-stage="correct"]') as HTMLElement;
    expect(correct).not.toBeNull();
    expect(correct).toHaveTextContent("18 folded");
    expect(correct).toHaveTextContent("Corrections fold into pass 3.");

    // launch — the next pass is N+1 (latest pass 2 → pass 3); the director
    // drives it (canSteer).
    const launch = spine.querySelector('[data-stage="launch"]') as HTMLElement;
    expect(launch).not.toBeNull();
    expect(launch).toHaveTextContent("pass 3");
    expect(launch).toHaveTextContent("Director drives the next localization pass");

    // rescore — the latest pass's quality score (3.9), sourced verbatim.
    const rescore = spine.querySelector('[data-stage="rescore"]') as HTMLElement;
    expect(rescore).not.toBeNull();
    expect(rescore).toHaveTextContent("3.9");
    expect(rescore.querySelector('[data-jump-to="rescore"]')).toHaveAttribute("href", "/benchmark");

    // confidence — the strong-caliber verdict from the cockpit (self leads a
    // calibrated field → "proven" → "Strong caliber").
    const confidence = spine.querySelector('[data-stage="confidence"]') as HTMLElement;
    expect(confidence).not.toBeNull();
    expect(confidence).toHaveTextContent("Confidence");
    expect(confidence).toHaveTextContent("Strong caliber");
    expect(confidence.getAttribute("data-stage-status")).toBe("proven");
    expect(confidence.querySelector('[data-jump-to="confidence"]')).toHaveAttribute(
      "href",
      "/benchmark",
    );
  });

  it("shows the loading surface before the read model settles", () => {
    render(<LoopSpinePanel />);
    expect(screen.getByText("Loading the iterative loop…")).toBeInTheDocument();
  });

  it("renders an honest '—' confidence while the cockpit is empty, with the first five stages still sourced from the overview", async () => {
    server.use(
      http.get(`*/api/projects/${projectId}/bmk-cockpit`, () =>
        apiJson(
          "projects.bmkCockpit",
          // A run recorded but scored zero items — no confidence signal.
          strongCaliberCockpit({
            contestants: [
              ["self", "itotori_context_on"],
              ["official", "official_localization"],
              ["fan", "fan_edited_mtl"],
              ["self_nocontext", "itotori_context_off"],
              ["mtl", "raw_mtl_baseline"],
            ].map(([role, kind]) => ({
              role,
              contestantKind: kind,
              aggregateScore: null,
              rank: null,
              judgeMean: null,
              metricMean: null,
              coverage: null,
            })),
            rankedRoles: ["official", "self", "self_nocontext", "fan", "mtl"],
            confidence: {
              pearson: null,
              normalizedAgreement: null,
              value: null,
              basis: "none",
            },
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
    render(<LoopSpinePanel />);

    // The first five stages render from the overview regardless of the cockpit.
    expect(await screen.findByText("18 folded")).toBeInTheDocument();

    // The confidence stage renders an honest "—" (no fabricated strong-caliber
    // claim) — it carries NO Badge (status is null) so its signal is bare text.
    const spine = screen.getByLabelText("Iterative loop stages");
    const confidence = spine.querySelector('[data-stage="confidence"]') as HTMLElement;
    expect(confidence).not.toBeNull();
    expect(confidence.getAttribute("data-stage-status")).toBe("neutral");
    expect(confidence).toHaveTextContent("—");
    // No verdict badge is rendered for an unresolved confidence.
    expect(within(confidence).queryByText("Strong caliber")).not.toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/overview", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read the project overview" },
          { status: 403 },
        ),
      ),
    );
    render(<LoopSpinePanel />);
    expect(
      await screen.findByText("not permitted to read the project overview"),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pure derivation — the loop spine is a pure function of the composed overview
// + the cockpit verdict; pin every sourced signal from a mock ledger so an
// audit can confirm no fabrication (PROJECT LAW).
// ---------------------------------------------------------------------------

describe("deriveLoopSpine (pure derivation)", () => {
  it("sources every stage from the read model (no fabrication)", () => {
    const overview = richOverview();
    const confidence = resolveLoopSpineConfidence(strongCaliberCockpit());
    const stages = deriveLoopSpine(overview, confidence);

    const byId = (id: string): LoopSpineStage => {
      const stage = stages.find((s) => s.id === id);
      if (stage === undefined) {
        throw new Error(`stage ${id} not found`);
      }
      return stage;
    };

    // flag — progress.findingCount (3).
    expect(byId("flag").signal).toBe("3 open");
    // decide — decisions.counts.pendingDecisionCount (3).
    expect(byId("decide").signal).toBe("3 pending");
    // correct — latest pass (pass 2) feedback (18).
    expect(byId("correct").signal).toBe("18 folded");
    // launch — latest pass (2) + 1 = 3.
    expect(byId("launch").signal).toBe("pass 3");
    // rescore — latest pass (pass 2) score (3.9).
    expect(byId("rescore").signal).toBe("3.9");
    // confidence — strong-caliber verdict label.
    expect(byId("confidence").signal).toBe("Strong caliber");
    expect(byId("confidence").status).toBe("proven");
  });

  it("renders honest '—' for the correction + rescore stages when no pass is recorded", () => {
    const overview = richOverview({
      passLedger: {
        ...richOverview().passLedger,
        rows: [],
        pagination: {
          total: 0,
          limit: 10,
          offset: 0,
          page: 1,
          pageCount: 0,
          hasMore: false,
          nextOffset: null,
        },
      },
    });
    const stages = deriveLoopSpine(overview, null);
    const byId = (id: string): LoopSpineStage => {
      const stage = stages.find((s) => s.id === id);
      if (stage === undefined) {
        throw new Error(`stage ${id} not found`);
      }
      return stage;
    };

    // No pass recorded → the first pass (1) is the launch target; corrections
    // have nothing to fold yet (honest "—"), and there is no score to rescore.
    expect(byId("correct").signal).toBe("—");
    expect(byId("launch").signal).toBe("pass 1");
    expect(byId("rescore").signal).toBe("—");
    // Confidence unresolved (null) → honest "—".
    expect(byId("confidence").signal).toBe("—");
    expect(byId("confidence").status).toBeNull();
  });

  it("treats a null latest-pass score as an honest '—' rescore (never a fabricated zero)", () => {
    const overview = richOverview({
      passLedger: {
        ...richOverview().passLedger,
        rows: [
          {
            ...richOverview().passLedger.rows[1]!,
            score: null,
          },
        ],
        pagination: {
          total: 1,
          limit: 10,
          offset: 0,
          page: 1,
          pageCount: 1,
          hasMore: false,
          nextOffset: null,
        },
      },
    });
    const stages = deriveLoopSpine(overview, null);
    const rescore = stages.find((s) => s.id === "rescore");
    expect(rescore?.signal).toBe("—");
  });

  it("uses the true latest pass when the visible ledger page is the first 10 of more than 10 passes", () => {
    const baseRow = richOverview().passLedger.rows[0]!;
    const rows = Array.from({ length: 12 }, (_, index) => {
      const passNumber = index + 1;
      return {
        ...baseRow,
        passLedgerId: `localization-pass-${passNumber}`,
        passNumber,
        priorPassNumber: passNumber === 1 ? null : passNumber - 1,
        recordedAt: `2026-07-07T${String(passNumber).padStart(2, "0")}:00:00.000Z`,
        score: 2 + passNumber / 10,
        feedback: passNumber * 3,
        note: `Pass ${passNumber}.`,
      };
    });
    const overview = richOverview({
      passLedger: {
        ...richOverview().passLedger,
        pagination: {
          total: 12,
          limit: 10,
          offset: 0,
          page: 1,
          pageCount: 2,
          hasMore: true,
          nextOffset: 10,
        },
        rows: rows.slice(0, 10),
        latestRow: rows[11]!,
      },
    });
    const stages = deriveLoopSpine(overview, null);

    expect(stages.find((s) => s.id === "correct")?.signal).toBe("36 folded");
    expect(stages.find((s) => s.id === "launch")?.signal).toBe("pass 13");
    expect(stages.find((s) => s.id === "rescore")?.signal).toBe("3.2");
  });

  it("latestLoopSpinePassRow picks the highest pass number + formatLoopSpineScore is honest", () => {
    const rows = richOverview().passLedger.rows;
    const latest = latestLoopSpinePassRow(rows);
    expect(latest?.passNumber).toBe(2);
    expect(latest?.feedback).toBe(18);
    expect(formatLoopSpineScore(3.9)).toBe("3.9");
    expect(formatLoopSpineScore(null)).toBe("—");
  });
});
