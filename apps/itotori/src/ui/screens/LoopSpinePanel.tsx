// xs-loop-spine-ui — the iterative-loop SPINE, made visible end-to-end.
//
// The live human-in-the-loop workflow is a single legible handoff chain:
//
//   playtester FLAGS a unit →
//   a canonical context correction captures the finding →
//   iteration writes the next result revision →
//   director LAUNCHES the run →
//   benchmark RE-SCORES →
//   panel↔human CONFIDENCE moves.
//
// Each link already has its own surface (PlayFlagComposer, PatchIteration,
// ExecutionJournal, BenchmarkHeadline). This is the CROSS node that composes
// the whole loop into ONE legible spine so the handoff is visible at a glance — a READ-ONLY
// legibility view (it re-states the live signal each stage currently carries,
// sourced from the SAME read models the dedicated surfaces read; it is NOT a
// duplicate action surface). Every stage carries a deep-link into its surface
// + a short note describing the handoff into the next stage.
//
// HONESTY / no-fabrication (PROJECT LAW): every signal is a real read-model
// field or arithmetic over real fields. A dimension with no first-class source
// renders an honest "—" when no first-class source exists (the journal does
// not fabricate a folded-correction count or quality score). Painted with
// `@itotori/ds` (Panel / Badge);
// className-based, ds tokens, no literal styles, no game named.
// [[feedback_behavior_first_code_agnostic_testing]].

import type { ReactNode } from "react";
import { Badge, Panel } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { BmkCockpitReadModel } from "../../bmk-cockpit-read-model.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";
import {
  VERDICT_LABELS,
  deriveBenchmarkVerdict,
  isBenchmarkHeadlineEmpty,
  type BenchmarkVerdict,
  type BenchmarkVerdictStatus,
} from "./BenchmarkHeadlineTile.js";

// ---------------------------------------------------------------------------
// Pure derivation — the loop spine stages.
// ---------------------------------------------------------------------------

/** The six stages of the iterative loop, in handoff order. */
export type LoopSpineStageId = "flag" | "correct" | "iterate" | "launch" | "rescore" | "confidence";

/** One stage of the loop spine — a sourced signal + a deep-link + a handoff. */
export type LoopSpineStage = {
  id: LoopSpineStageId;
  /** Human stage label (game-agnostic). */
  label: string;
  /** Sourced signal label (e.g. "3 open", "82%", "run 4"). Honest "—" when no signal. */
  signal: string;
  /**
   * The product status the stage currently carries (drives the ds Badge tone),
   * or `null` when the stage has no status signal (a neutral readout).
   */
  status: BenchmarkVerdictStatus | null;
  /** Deep-link into the stage's dedicated surface. */
  href: string;
  /** Short note describing the handoff into the next stage. */
  handoff: string;
};

/**
 * The confidence stage input — the verdict the spine's final stage restates.
 * Sourced from the SAME `deriveBenchmarkVerdict` the BenchmarkHeadline tile
 * uses so the spine + the headline can never drift. `null` while the cockpit
 * read is unresolved / empty (the stage renders an honest "—").
 */
export type LoopSpineConfidence = {
  verdict: BenchmarkVerdict;
};

/**
 * The latest durable journal row, or `null` when none is recorded. Rows are
 * chronological, so the last one is authoritative.
 */
export function latestLoopSpineJournalRow(
  rows: readonly ProjectOverviewReadModel["journal"]["rows"][number][],
): ProjectOverviewReadModel["journal"]["rows"][number] | null {
  if (rows.length === 0) {
    return null;
  }
  return rows[rows.length - 1]!;
}

/**
 * Derive the six loop-spine stages from the composed overview read model + the
 * (optional) benchmark cockpit verdict. PURE + deterministic: every signal is
 * a real read-model value or arithmetic over real values — no fabricated
 * numbers (PROJECT LAW). The confidence stage renders "—" when the cockpit
 * verdict is unavailable, never a fabricated strong-caliber claim.
 *
 * The spine is a READ-ONLY legibility view: it re-states the live signal each
 * stage currently carries, sourced from the SAME read models the dedicated
 * surfaces read. Each stage carries a deep-link into its surface.
 */
export function deriveLoopSpine(
  overview: ProjectOverviewReadModel,
  confidence: LoopSpineConfidence | null,
): LoopSpineStage[] {
  const findings = overview.progress.findingCount;
  const openFindings = overview.decisions.counts.pendingDecisionCount;
  const latestRun = overview.journal.latestRow ?? latestLoopSpineJournalRow(overview.journal.rows);
  const nextRun = overview.journal.pagination.total + 1;

  const stages: LoopSpineStage[] = [
    {
      id: "flag",
      label: "Flag",
      signal: `${findings} open`,
      status: null,
      // A dashboard aggregate has no bridge-unit target. The Wiki resolves the
      // selected branch and is the canonical-context surface for an unscoped
      // finding; the flag composer intentionally requires an exact line.
      href: "/wiki",
      handoff: "Wiki records canonical context for the next run.",
    },
    {
      id: "correct",
      label: "Correct",
      signal: openFindings === 0 ? "none open" : `${openFindings} open`,
      status: openFindings > 0 ? "pending" : "proven",
      href: "/wiki",
      handoff: "Wiki corrections update canonical context for the next run.",
    },
    {
      id: "iterate",
      label: "Iterate",
      signal: "—",
      status: null,
      href: "/play/patches",
      handoff: `Patch feedback creates the result revision for run ${nextRun}.`,
    },
    {
      id: "launch",
      label: "Launch",
      signal: `run ${nextRun}`,
      status: null,
      href: "/",
      handoff: "Director drives the next localization run (canSteer).",
    },
    {
      id: "rescore",
      label: "Rescore",
      signal: "—",
      status: null,
      href: "/benchmark",
      handoff:
        latestRun === null
          ? "Benchmark re-scores the next durable run."
          : "Benchmark re-scores the latest durable run.",
    },
    {
      id: "confidence",
      label: "Confidence",
      signal: confidence === null ? "—" : VERDICT_LABELS[confidence.verdict.status],
      status: confidence === null ? null : confidence.verdict.status,
      href: "/benchmark",
      handoff: "Panel↔human confidence moves with each durable run.",
    },
  ];
  return stages;
}

/**
 * Resolve the confidence stage input from the cockpit read model. Returns
 * `null` while the cockpit is unresolved, empty, or carries no scored signal
 * (the spine's confidence stage then renders an honest "—"). Reuses the SAME
 * `deriveBenchmarkVerdict` the BenchmarkHeadline tile uses so the two surfaces
 * agree.
 */
export function resolveLoopSpineConfidence(cockpit: BmkCockpitReadModel): LoopSpineConfidence {
  return { verdict: deriveBenchmarkVerdict(cockpit) };
}

// ---------------------------------------------------------------------------
// Panel — owns its reads through the typed client. The overview read supplies
// the first five stages; the project-scoped cockpit read (waited on the
// overview's projectId, the same dance {@link BenchmarkHeadlineTile} dances)
// supplies the confidence verdict. Each read settles independently.
// ---------------------------------------------------------------------------

/**
 * The Overview iterative-loop spine panel. Composes the whole loop
 * (flag → correct → iterate → launch → rescore → confidence) into one legible
 * band, sourced from the composed `projects.overview` read model + the
 * project-scoped `projects.bmkCockpit` read model through the typed client.
 * Renders loading / empty / error surfaces independently of the other panels.
 */
export function LoopSpinePanel(): ReactNode {
  const overview = useApiQuery("projects.overview", {}, "loop-spine-overview");
  return <LoopSpineShell overview={overview} />;
}

/**
 * The ONE stable panel surface — the title bar (and its heading) stays mounted
 * across every state transition so a behavior-first test can resolve the
 * heading without it detaching on the loading → ready transition (mirrors
 * {@link BenchmarkHeadlineTile}'s stable shell).
 */
function LoopSpineShell({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  const projectId = overview.state === "ready" ? overview.data.projectId : null;
  return (
    <Panel
      title="Iterative loop"
      eyebrow="Loop spine"
      className="itotori-panel--loop-spine"
      data-pane-id="loop-spine"
      data-pane-state={overview.state}
    >
      {projectId === null ? (
        <LoopSpineOverviewSurface overview={overview} />
      ) : (
        <LoopSpineCockpit overview={overview} projectId={projectId} />
      )}
    </Panel>
  );
}

function LoopSpineOverviewSurface({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  if (overview.state === "loading") {
    return <LoadingState label="Loading the iterative loop…" />;
  }
  if (overview.state === "error") {
    return <ErrorState title="Iterative loop" error={overview.error} />;
  }
  return (
    <EmptyState
      title="Iterative loop"
      message="No project context is available to scope the iterative loop."
    />
  );
}

function LoopSpineCockpit({
  overview,
  projectId,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
  projectId: string;
}): ReactNode {
  // The cockpit read is project-scoped; the spine waits on the overview's
  // projectId (the same read the sibling Overview panels issue). The cockpit
  // is OPTIONAL for the spine — the first five stages render from the overview
  // regardless, and the confidence stage renders an honest "—" while the
  // cockpit loads / errors / is empty.
  const cockpit = useApiQuery(
    "projects.bmkCockpit",
    { pathParams: { projectId } },
    `loop-spine-bmk-cockpit:${projectId}`,
  );
  return <LoopSpinePanelBody overview={overview} cockpit={cockpit} />;
}

/**
 * The state-bound panel body. Exported (and the props are the resolved
 * `ApiCallState`s) so a behavior-first test can mount the spine over msw via
 * the self-contained {@link LoopSpinePanel}, or directly over pre-settled
 * states.
 */
export function LoopSpinePanelBody({
  overview,
  cockpit,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
  cockpit: ApiCallState<BmkCockpitReadModel>;
}): ReactNode {
  if (overview.state === "loading") {
    return <LoadingState label="Loading the iterative loop…" />;
  }
  if (overview.state === "error") {
    return <ErrorState title="Iterative loop" error={overview.error} />;
  }
  // `empty` (no body) surfaces the empty state — never a fabricated zeroed spine.
  if (overview.state === "empty") {
    return (
      <EmptyState
        title="Iterative loop"
        message="No project context is available to scope the iterative loop."
      />
    );
  }
  const confidence = resolveConfidence(cockpit);
  const stages = deriveLoopSpine(overview.data, confidence);
  return <LoopSpineReadout stages={stages} cockpit={cockpit} />;
}

function resolveConfidence(cockpit: ApiCallState<BmkCockpitReadModel>): LoopSpineConfidence | null {
  if (cockpit.state !== "ready") {
    return null;
  }
  if (isBenchmarkHeadlineEmpty(cockpit.data)) {
    return null;
  }
  return resolveLoopSpineConfidence(cockpit.data);
}

function LoopSpineReadout({
  stages,
  cockpit,
}: {
  stages: readonly LoopSpineStage[];
  cockpit: ApiCallState<BmkCockpitReadModel>;
}): ReactNode {
  return (
    <div className="itotori-loop-spine" data-loop-spine="ready" data-cockpit-state={cockpit.state}>
      <ol className="itotori-loop-spine__stages" aria-label="Iterative loop stages">
        {stages.map((stage, index) => (
          <LoopSpineStageStep key={stage.id} stage={stage} isLast={index === stages.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function LoopSpineStageStep({
  stage,
  isLast,
}: {
  stage: LoopSpineStage;
  isLast: boolean;
}): ReactNode {
  return (
    <li
      className="itotori-loop-spine__stage"
      data-stage={stage.id}
      data-stage-status={stage.status ?? "neutral"}
    >
      <a className="itotori-loop-spine__link" href={stage.href} data-jump-to={stage.id}>
        <span className="itotori-loop-spine__label">{stage.label}</span>
        <span className="itotori-loop-spine__signal">
          {stage.status === null ? (
            stage.signal
          ) : (
            <Badge status={stage.status}>{stage.signal}</Badge>
          )}
        </span>
      </a>
      <p className="itotori-loop-spine__handoff">
        {isLast ? "Loop complete — confidence feeds the next flag." : stage.handoff}
      </p>
    </li>
  );
}
