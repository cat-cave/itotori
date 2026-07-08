// ovw-cost-zdr-drilldown-ui — the Overview screen's cost / ZDR drilldown.
//
// A panel GROUP WITHIN the Workbench dashboard (not a new route) that renders
// the project's cost surface in two settled views, both consumed THROUGH the
// typed client (never an ad-hoc fetch):
//
//   1. the Model-cost SUMMARY (`projects.cost`) — the empirical $25 indie
//      target, the byKind breakdown, and the cache-reuse / zero-run totals;
//   2. the COST LEDGER drilldown (`projects.costDrilldown`) — the per-provider-
//      run rows carrying the DISTINCT cost display states (BILLED / ZERO /
//      UNKNOWN micros-USD) and the ACTUALLY-SERVED (model, provider) pair
//      recorded in the ledger, walked page-by-page via the fnd-api-client
//      `OffsetPager` (the route is server-paginated).
//
// The served pair is shown HONESTLY ([[feedback_model_provider_pair]]): the
// ledger records `actualModelId` + `upstreamProvider` (the pair that REALLY
// served the run), which may differ from the `requestedModelId` / routed
// provider — when they differ the requested pair is surfaced alongside so the
// mismatch is visible, never hidden. The three cost states are never collapsed
// (`zero` is a real $0.00 billed record; `unknown` is an UNRECORDED cost —
// structurally distinct, per ITOTORI-053).
//
// Each view settles into loading / empty / error / populated INDEPENDENTLY so
// one failed read degrades only its view. className-based, ds tokens, no
// literal styles, no game named. [[feedback_behavior_first_code_agnostic_testing]].

import type { ReactNode } from "react";
import type { CostDrilldownRow, ProjectCostReport } from "@itotori/db";
import { Badge, DataTable, Pagination, Panel, ProgressBar, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import { useApiQuery } from "../use-api-resource.js";
import { useOffsetPager } from "../use-offset-pager.js";
import {
  INDIE_LOCALIZATION_COST_TARGET_MICROS_USD,
  formatMicrosUsd,
  formatSignedMicrosUsd,
} from "../format.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

/** Server page size for the cost-ledger drilldown. */
const COST_DRILLDOWN_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Public panel — hosted by the Dashboard (takes the already-issued cost read
// so the dashboard does not re-issue `projects.cost`).
// ---------------------------------------------------------------------------

export function CostDrilldownPanel({ cost }: { cost: ApiCallState<ProjectCostReport> }): ReactNode {
  return (
    <section className="itotori-cost-panels" aria-label="Model cost">
      <CostSummaryPanel cost={cost} />
      <CostLedgerPanel />
    </section>
  );
}

/**
 * Self-contained wrapper that issues its OWN `projects.cost` read (for a
 * behavior-first test that mounts the full cost drilldown over msw) and renders
 * the {@link CostDrilldownPanel}. The dashboard hosts {@link CostDrilldownPanel}
 * directly with its shared cost read instead.
 */
export function CostDrilldown(): ReactNode {
  const cost = useApiQuery("projects.cost", {}, "cost");
  return <CostDrilldownPanel cost={cost} />;
}

// ---------------------------------------------------------------------------
// Model-cost summary — the empirical $25 indie target + byKind + cache reuse.
// (Verbatim parity port of the dashboard's historical CostReport, now hosted
// here so the cost surface is one cohesive panel group.)
// ---------------------------------------------------------------------------

function CostSummaryPanel({ cost }: { cost: ApiCallState<ProjectCostReport> }): ReactNode {
  return (
    <Panel
      title="Model cost"
      eyebrow="Spend"
      className="itotori-panel--cost"
      data-panel-state={cost.state}
    >
      {cost.state === "loading" && <LoadingState label="Loading cost report…" />}
      {cost.state === "empty" && (
        <EmptyState title="Model cost" message="No cost report was returned by the API." />
      )}
      {cost.state === "error" && <ErrorState title="Model cost" error={cost.error} />}
      {cost.state === "ready" && <CostSummary cost={cost.data} />}
    </Panel>
  );
}

function CostSummary({ cost }: { cost: ProjectCostReport }): ReactNode {
  const target = INDIE_LOCALIZATION_COST_TARGET_MICROS_USD;
  const spent = cost.billedMicrosUsd;
  const percentage = target <= 0 ? 0 : Math.round((spent / target) * 100);
  const remaining = target - spent;
  const overBudget = remaining < 0;
  return (
    <>
      <div className="itotori-cost-target" aria-label="Indie localization cost target">
        <StatReadout label="Spent (real)" value={formatMicrosUsd(spent)} mono />
        <StatReadout label="Target" value={formatMicrosUsd(target)} mono />
        <StatReadout
          label={overBudget ? "Over budget" : "Remaining"}
          value={formatSignedMicrosUsd(remaining)}
          deltaTone={overBudget ? "critical" : "ok"}
          mono
        />
        <StatReadout label="Used" value={`${percentage}%`} />
      </div>
      <ProgressBar
        value={Math.max(0, Math.min(100, percentage))}
        max={100}
        tone={overBudget ? "amber" : "mint"}
        label={`${percentage}% of $25 target used`}
        showValue
      />
      <div className="itotori-metric-row" aria-label="Cost totals">
        <StatReadout label="Billed" value={formatMicrosUsd(cost.billedMicrosUsd)} mono />
        <StatReadout label="Runs" value={cost.runCount} />
        <StatReadout label="Zero-cost runs" value={cost.zeroRunCount} />
        <StatReadout
          label="TM avoided"
          value={cost.translationMemoryReuse.providerCallAvoidedCount}
        />
        <StatReadout
          label="TM tokens saved"
          value={cost.translationMemoryReuse.estimatedTotalTokensSaved}
        />
      </div>
      <DataTable
        caption="Cost by kind"
        columns={[
          { key: "kind", header: "Kind", render: (e) => e.costKind },
          { key: "runs", header: "Runs", align: "end", render: (e) => e.runCount },
          {
            key: "amount",
            header: "Amount",
            align: "end",
            render: (e) => formatMicrosUsd(e.amountMicrosUsd),
          },
          { key: "tokens", header: "Tokens", align: "end", render: (e) => e.totalTokens },
        ]}
        rows={cost.totalsByCostKind}
        getRowKey={(e) => e.costKind}
        emptyLabel="No recorded cost by kind."
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Cost ledger drilldown — per-run rows with the cost STATE + served pair,
// walked page-by-page through the fnd-api-client OffsetPager.
// ---------------------------------------------------------------------------

function CostLedgerPanel(): ReactNode {
  const pager = useOffsetPager(
    "projects.costDrilldown",
    { limit: COST_DRILLDOWN_PAGE_SIZE },
    "costDrilldown",
  );
  return (
    <Panel
      title="Cost ledger"
      eyebrow="Drilldown"
      className="itotori-panel--cost-drilldown"
      data-panel-state={pager.phase}
    >
      <CostLedgerBody pager={pager} />
    </Panel>
  );
}

function CostLedgerBody({
  pager,
}: {
  pager: ReturnType<typeof useOffsetPager<"projects.costDrilldown">>;
}): ReactNode {
  const page = pager.page;
  // No cached page yet: the first fetch is in flight, or it failed outright.
  if (page === null) {
    if (pager.phase === "error" && pager.error !== null) {
      return <ErrorState title="Cost ledger" error={pager.error} />;
    }
    return <LoadingState label="Loading cost ledger…" />;
  }
  const data = page.data;
  if (data.rows.length === 0 && data.pagination.total === 0) {
    return <EmptyState title="Cost ledger" message="No provider-run cost rows were recorded." />;
  }
  return (
    <CostLedgerPage
      rows={data.rows}
      pagination={data.pagination}
      pager={pager}
      error={pager.error}
    />
  );
}

function CostLedgerPage({
  rows,
  pagination,
  pager,
  error,
}: {
  rows: readonly CostDrilldownRow[];
  pagination: {
    total: number;
    page: number;
    pageCount: number;
  };
  pager: ReturnType<typeof useOffsetPager<"projects.costDrilldown">>;
  error: ReturnType<typeof useOffsetPager<"projects.costDrilldown">>["error"];
}): ReactNode {
  const stateCounts = countCostStates(rows);
  return (
    <>
      {error !== null && (
        <p
          className="itotori-cost-error"
          role="alert"
          data-api-error-code={error.code ?? undefined}
        >
          <Badge status="failed">{error.code}</Badge> {error.message}
        </p>
      )}
      <div className="itotori-metric-row" aria-label="Cost states on this page">
        <StatReadout label="Billed (page)" value={stateCounts.billed} />
        <StatReadout label="Zero (page)" value={stateCounts.zero} />
        <StatReadout label="Unknown (page)" value={stateCounts.unknown} />
      </div>
      <DataTable
        caption="Provider-run cost ledger"
        columns={[
          {
            key: "run",
            header: "Run",
            render: (row) => (
              <span>
                {row.taskKind}
                <br />
                <code>{row.providerRunId}</code>
                <br />
                <span className="itotori-cost-started">{row.startedAt}</span>
              </span>
            ),
          },
          {
            key: "state",
            header: "Cost",
            render: (row) => <CostStateCell row={row} />,
          },
          {
            key: "served",
            header: "Served pair",
            render: (row) => <ServedPairCell row={row} />,
          },
          {
            key: "status",
            header: "Status",
            render: (row) => <Badge status={row.status} />,
          },
        ]}
        rows={rows}
        getRowKey={(row) => row.providerRunId}
        emptyLabel="No provider-run cost rows on this page."
      />
      <Pagination
        label="Cost ledger pagination"
        page={Math.max(0, pagination.page - 1)}
        pageCount={Math.max(1, pagination.pageCount)}
        totalItems={pagination.total}
        itemName="run"
        onPrevious={pager.previous}
        onNext={pager.next}
      />
    </>
  );
}

function CostStateCell({ row }: { row: CostDrilldownRow }): ReactNode {
  const { cost } = row;
  if (cost.state === "billed") {
    return (
      <span data-cost-state="billed">
        <Badge status="billed">Billed</Badge>
        <br />
        <span className="itotori-cost-amount">{formatMicrosUsd(cost.amountMicrosUsd)}</span>
      </span>
    );
  }
  if (cost.state === "zero") {
    return (
      <span data-cost-state="zero">
        <Badge status="zero">Zero</Badge>
        <br />
        <span className="itotori-cost-amount">{formatMicrosUsd(0)}</span>
      </span>
    );
  }
  return (
    <span data-cost-state="unknown">
      <Badge status="unknown">Unknown</Badge>
      <br />
      <span className="itotori-cost-amount">unrecorded</span>
    </span>
  );
}

/**
 * The ACTUALLY-SERVED (model, provider) pair from the ledger, shown honestly.
 * `actualModelId` + `upstreamProvider` (falling back to the curated provider
 * name) is the pair that REALLY served the run; when `requestedModelId` (or the
 * routed provider) differs, the requested pair is surfaced beneath so a
 * route-vs-serve mismatch is visible — never hidden.
 */
function ServedPairCell({ row }: { row: CostDrilldownRow }): ReactNode {
  const { provider } = row;
  const servedProvider = provider.upstreamProvider ?? provider.providerName;
  const requestedProviderDiffered =
    provider.upstreamProvider !== null && provider.upstreamProvider !== provider.providerName;
  const modelDiffered = provider.actualModelId !== provider.requestedModelId;
  return (
    <span className="itotori-served-pair" data-served-pair>
      <code className="itotori-served-model">{provider.actualModelId}</code>
      <br />
      <span className="itotori-served-provider">via {servedProvider}</span>
      {(modelDiffered || requestedProviderDiffered) && (
        <span className="itotori-served-requested">
          <br />
          requested {provider.requestedModelId}
          {requestedProviderDiffered ? ` (${provider.providerName})` : ""}
        </span>
      )}
    </span>
  );
}

function countCostStates(rows: readonly CostDrilldownRow[]): {
  billed: number;
  zero: number;
  unknown: number;
} {
  let billed = 0;
  let zero = 0;
  let unknown = 0;
  for (const row of rows) {
    if (row.cost.state === "billed") {
      billed += 1;
    } else if (row.cost.state === "zero") {
      zero += 1;
    } else {
      unknown += 1;
    }
  }
  return { billed, zero, unknown };
}
