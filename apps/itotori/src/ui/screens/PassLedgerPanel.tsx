// ovw-pass-ledger-ui — the Overview screen's pass ledger panel.
//
// A panel WITHIN the Workbench dashboard (not a new route): the per-pass
// SCORE / FEEDBACK / NOTE iteration table, backed by the composed
// `projects.overview` read model (the `passLedger.rows` piece). It CONSUMES
// the read model THROUGH the typed client (`useApiQuery`, never an ad-hoc
// fetch) and paints each pass as a row whose PASS / SCORE / FEEDBACK / NOTE
// columns are sourced verbatim from the row — no fabricated numbers (a pass
// with no score renders `null`, never zero). Independent loading / empty /
// error surfaces, the same way {@link ProgressInstrumentPanel} and
// {@link DecisionsBand} paint their panels. ClassName-based, ds tokens, no
// literal styles, no game named. [[feedback_behavior_first_code_agnostic_testing]].
//
// Mirrors `pass-ledger iteration tokens` from the `@itotori/ds` Gallery
// (pass / score / feedback / note / status) — the same per-pass columns the
// ds gallery paints against its neutral fixtures. This panel paints them
// against the REAL `localizationPassLedger` data via the composed overview.

import type { ReactNode } from "react";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

// ---------------------------------------------------------------------------
// Pure derivation — per-row view-model + the headline count.
// ---------------------------------------------------------------------------

/**
 * Per-pass view-model for the Overview pass ledger. Derived from the composed
 * `passLedger.rows` piece of the overview read model; the row's `score`,
 * `feedback`, and `note` are SOURCED (never fabricated — null / 0 / "" are
 * real values when the row carries no signal). `iteration` collapses the
 * lineage into a human label: "—" for the first pass, "pass N" when built on
 * a prior.
 */
export type PassLedgerIterationRow = {
  passLedgerId: string;
  passNumber: number;
  iteration: string;
  scoreLabel: string;
  feedbackCount: number;
  note: string;
};

/**
 * Derive the per-row view-model for the Overview pass-ledger panel. Pure +
 * deterministic; null fields render honestly (PROJECT LAW / no fabrication).
 */
export function passLedgerIterationRows(
  rows: ProjectOverviewReadModel["passLedger"]["rows"],
): PassLedgerIterationRow[] {
  return rows.map((row) => ({
    passLedgerId: row.passLedgerId,
    passNumber: row.passNumber,
    iteration: row.priorPassNumber === null ? "—" : `pass ${row.priorPassNumber}`,
    scoreLabel: row.score === null ? "—" : row.score.toFixed(1),
    feedbackCount: row.feedback,
    note: row.note.length === 0 ? "—" : row.note,
  }));
}

// ---------------------------------------------------------------------------
// Panel — owns its `projects.overview` read through the typed client. The
// overview is shared with `ProgressInstrumentPanel`, but each panel issues
// its own typed query (the api-client's per-depsKey cache keeps both reads
// independent; a re-render does not double-fetch).
// ---------------------------------------------------------------------------

/**
 * The Overview pass-ledger panel — per-pass SCORE / FEEDBACK / NOTE rows
 * sourced from the composed `projects.overview` read model. Self-contained
 * (issues its own `useApiQuery("projects.overview")`); renders loading /
 * empty / error surfaces independently of the other dashboard panels.
 */
export function PassLedgerPanel(): ReactNode {
  const overview = useApiQuery("projects.overview", {}, "overview");
  return <PassLedgerPanelBody overview={overview} />;
}

/**
 * The state-bound panel body. Exported (and the prop is the resolved
 * `ApiCallState`) so a behavior-first test can mount the panel over msw.
 */
export function PassLedgerPanelBody({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  const rowCount = overview.state === "ready" ? overview.data.passLedger.rows.length : null;
  const headline =
    rowCount === null
      ? "Pass ledger"
      : rowCount === 0
        ? "Pass ledger — no passes recorded"
        : `Pass ledger — ${rowCount} pass${rowCount === 1 ? "" : "es"} recorded`;
  return (
    <Panel
      title={headline}
      eyebrow="Pass ledger"
      className="itotori-panel--pass-ledger"
      data-panel-state={overview.state}
    >
      <PassLedgerPanelContent overview={overview} />
    </Panel>
  );
}

function PassLedgerPanelContent({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  if (overview.state === "loading") {
    return <LoadingState label="Loading pass ledger…" />;
  }
  if (overview.state === "error") {
    return <ErrorState title="Pass ledger" error={overview.error} />;
  }
  if (overview.state === "empty" || overview.data.passLedger.rows.length === 0) {
    return (
      <EmptyState
        title="Pass ledger"
        message="No localization passes have been recorded for this project yet."
      />
    );
  }
  return <PassLedgerPanelReady overview={overview.data} />;
}

function PassLedgerPanelReady({ overview }: { overview: ProjectOverviewReadModel }): ReactNode {
  const rows = passLedgerIterationRows(overview.passLedger.rows);
  const totals = computePassLedgerTotals(rows);
  return (
    <>
      <div className="itotori-metric-row" aria-label="Pass ledger aggregate">
        <StatReadout label="Passes" value={totals.passCount} />
        <StatReadout label="Feedback notes" value={totals.feedbackTotal} />
        <StatReadout label="Avg score" value={totals.averageScoreLabel} />
        <StatReadout label="Latest pass" value={totals.latestPass} />
      </div>
      <DataTable
        caption="Pass ledger"
        columns={[
          {
            key: "pass",
            header: "Pass",
            render: (row) => <code>pass {row.passNumber}</code>,
          },
          {
            key: "iteration",
            header: "Iteration",
            render: (row) => row.iteration,
          },
          {
            key: "score",
            header: "Score",
            align: "end",
            render: (row) => row.scoreLabel,
          },
          {
            key: "feedback",
            header: "Feedback",
            align: "end",
            render: (row) => row.feedbackCount,
          },
          {
            key: "note",
            header: "Note",
            render: (row) => row.note,
          },
          {
            key: "status",
            header: "Status",
            render: () => <Badge status="succeeded" />,
          },
        ]}
        rows={rows}
        getRowKey={(row) => row.passLedgerId}
        emptyLabel="No recorded passes."
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Totals — pure derivation for the headline metric row.
// ---------------------------------------------------------------------------

type PassLedgerTotals = {
  passCount: number;
  feedbackTotal: number;
  averageScoreLabel: string;
  latestPass: string;
};

function computePassLedgerTotals(rows: PassLedgerIterationRow[]): PassLedgerTotals {
  const passCount = rows.length;
  const feedbackTotal = rows.reduce((sum, row) => sum + row.feedbackCount, 0);
  const scoredRows = rows.filter((row) => row.scoreLabel !== "—");
  const averageScoreLabel =
    scoredRows.length === 0
      ? "—"
      : (
          scoredRows.reduce((sum, row) => sum + Number.parseFloat(row.scoreLabel), 0) /
          scoredRows.length
        ).toFixed(1);
  const latestRow = rows.reduce<PassLedgerIterationRow | null>(
    (latest, row) => (latest === null || row.passNumber > latest.passNumber ? row : latest),
    null,
  );
  const latestPass = latestRow === null ? "—" : `pass ${latestRow.passNumber}`;
  return { passCount, feedbackTotal, averageScoreLabel, latestPass };
}
