// np-candidate-browse-ui (HI-FI STUDIO EPIC - NewProject) - catalog candidate browser.
//
// A routed Studio surface backed by the existing aggregate-safe
// `catalog.opportunities` read model. The browser lists candidate works with
// the acceptance-critical signals from each row: demand, local ownership, and
// translation completeness. Reads go through the typed client, so API shape
// validation and loading / empty / error states stay shared with the rest of
// the React Studio shell.

import type { ReactNode } from "react";
import type {
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogBenchmarkSeedReadinessLevel,
  CatalogCompletenessPool,
  CatalogOpportunityRankingReadModel,
  CatalogOpportunityRow,
  CatalogOpportunityRuntimeEvidenceReadiness,
} from "@itotori/db";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

export const catalogCandidateBrowserRoutePathRegex = /^\/catalog\/?$/u;

export function isCatalogCandidateBrowserRoute(pathname: string): boolean {
  return catalogCandidateBrowserRoutePathRegex.test(pathname);
}

const DEMAND_BUCKET_LABELS: Readonly<Record<CatalogBenchmarkDemandBucket, string>> = {
  very_high: "Very high",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

const OWNERSHIP_LABELS: Readonly<Record<CatalogBenchmarkLocalOwnership, string>> = {
  owned: "Owned",
  not_owned: "Not owned",
  unknown: "Unknown",
};

const COMPLETENESS_LABELS: Readonly<Record<CatalogCompletenessPool, string>> = {
  no_english: "No English",
  mtl_only: "MTL only",
  fan_partial: "Fan partial",
  unknown: "Unknown",
  conflict: "Conflict",
};

const COMPLETENESS_STATUS: Readonly<Record<CatalogCompletenessPool, string>> = {
  no_english: "blocker",
  mtl_only: "warning",
  fan_partial: "warning",
  unknown: "stale",
  conflict: "failed",
};

const READINESS_LEVEL_LABELS: Readonly<Record<CatalogBenchmarkSeedReadinessLevel, string>> = {
  supported: "Supported",
  partial: "Partial",
  unsupported: "Unsupported",
  unknown: "Unknown",
};

const READINESS_LEVEL_TONES: Readonly<Record<CatalogBenchmarkSeedReadinessLevel, string>> = {
  supported: "accepted",
  partial: "warning",
  unsupported: "failed",
  unknown: "stale",
};

const RUNTIME_EVIDENCE_LABELS: Readonly<
  Record<CatalogOpportunityRuntimeEvidenceReadiness["status"], string>
> = {
  public_and_aggregate: "Public + aggregate",
  public_fixture: "Public fixture",
  private_local_aggregate: "Private aggregate",
  partial_public_and_aggregate: "Partial public + aggregate",
  partial_public_fixture: "Partial public fixture",
  partial_private_local_aggregate: "Partial private aggregate",
  unknown: "Unknown",
};

const numberFormatter = new Intl.NumberFormat("en-US");

export function CatalogCandidateBrowserScreen(): ReactNode {
  const opportunities = useApiQuery(
    "catalog.opportunities",
    {},
    "catalog.opportunities:candidate-browser",
  );

  return (
    <main
      className="itotori-shell catalog-candidate-browser"
      data-screen="catalog-candidate-browser"
      data-state={opportunities.state}
    >
      <ShellHeader eyebrow="Catalog" title="Candidate browser">
        <p className="itotori-shell__lede">
          Ranked localization candidates from catalog opportunities.
        </p>
      </ShellHeader>
      {opportunities.state === "loading" && <LoadingState label="Loading catalog candidates..." />}
      {opportunities.state === "empty" && (
        <EmptyState
          title="Candidate browser"
          message="No catalog candidates were returned by the API."
        />
      )}
      {opportunities.state === "error" && (
        <ErrorState title="Candidate browser" error={opportunities.error} />
      )}
      {opportunities.state === "ready" && (
        <CatalogCandidateBrowserReady opportunities={opportunities.data} />
      )}
    </main>
  );
}

export function CatalogCandidateBrowserReady({
  opportunities,
}: {
  opportunities: CatalogOpportunityRankingReadModel;
}): ReactNode {
  const rows = opportunities.rows.filter((row) => row.decision === "candidate");
  return (
    <section
      className="catalog-candidate-browser__body"
      aria-label="Catalog candidate browser"
      data-target-language={opportunities.targetLanguage}
      data-row-count={rows.length}
    >
      <CatalogCandidateAggregate opportunities={opportunities} rows={rows} />
      <CatalogReadinessMatrix rows={rows} />
      <Panel
        title="Catalog candidates"
        eyebrow={opportunities.targetLanguage}
        lamps={<Badge status="captured">{opportunities.weightsVersion}</Badge>}
        className="catalog-candidate-browser__panel"
      >
        <DataTable
          caption="Catalog candidates with demand, ownership, and completeness"
          columns={[
            {
              key: "rank",
              header: "Rank",
              align: "end",
              render: (row) => `#${row.rank}`,
            },
            {
              key: "candidate",
              header: "Candidate",
              render: (row) => (
                <span>
                  {row.canonicalTitle}
                  <br />
                  <code>{row.workId}</code>
                </span>
              ),
            },
            {
              key: "demand",
              header: "Demand",
              render: (row) => (
                <span>
                  <Badge status={row.demandFacts.demandBucket}>
                    {DEMAND_BUCKET_LABELS[row.demandFacts.demandBucket]}
                  </Badge>
                  <br />
                  {formatDemandFacts(row)}
                </span>
              ),
            },
            {
              key: "ownership",
              header: "Owned",
              render: (row) => (
                <span>
                  <Badge
                    status={row.localOwnership === "owned" ? "accepted" : "stale"}
                    tone={row.localOwnership === "owned" ? "ok" : "neutral"}
                  >
                    {OWNERSHIP_LABELS[row.localOwnership]}
                  </Badge>
                  <br />
                  {formatLocalEvidence(row)}
                </span>
              ),
            },
            {
              key: "completeness",
              header: "Completeness",
              render: (row) => (
                <Badge status={COMPLETENESS_STATUS[row.completenessPool]}>
                  {COMPLETENESS_LABELS[row.completenessPool]}
                </Badge>
              ),
            },
            {
              key: "score",
              header: "Score",
              align: "end",
              render: (row) => row.score,
            },
          ]}
          rows={rows}
          getRowKey={(row) => row.workId}
          emptyLabel="No rows are currently ranked as catalog candidates."
        />
      </Panel>
    </section>
  );
}

function CatalogReadinessMatrix({ rows }: { rows: readonly CatalogOpportunityRow[] }): ReactNode {
  return (
    <Panel
      title="Readiness matrix"
      eyebrow="Capability evidence"
      lamps={<Badge status="captured">{rows.length} candidates</Badge>}
      className="catalog-candidate-browser__panel"
    >
      <DataTable
        caption="Per-candidate readiness matrix"
        columns={[
          {
            key: "candidate",
            header: "Candidate",
            render: (row) => (
              <span>
                {row.canonicalTitle}
                <br />
                <code>{formatEngineName(row)}</code>
              </span>
            ),
          },
          {
            key: "adapter",
            header: "Adapter evidence",
            render: (row) => (
              <span>
                <Badge status={row.adapterId === null ? "stale" : "captured"}>
                  {row.adapterId ?? "No adapter"}
                </Badge>
                <br />
                {formatAdapterEvidence(row)}
              </span>
            ),
          },
          {
            key: "identify",
            header: "Identify",
            render: (row) => <ReadinessBadge level={row.readiness.identify} />,
          },
          {
            key: "inventory",
            header: "Inventory",
            render: (row) => <ReadinessBadge level={row.readiness.inventory} />,
          },
          {
            key: "extract",
            header: "Extract",
            render: (row) => <ReadinessBadge level={row.readiness.extract} />,
          },
          {
            key: "patch",
            header: "Patch",
            render: (row) => <ReadinessBadge level={row.readiness.patch} />,
          },
          {
            key: "runtime",
            header: "Runtime",
            render: (row) => (
              <span>
                <ReadinessBadge level={row.readiness.runtime} />
                <br />
                {formatRuntimeEvidence(row.runtimeEvidenceReadiness)}
              </span>
            ),
          },
        ]}
        rows={rows}
        getRowKey={(row) => row.workId}
        emptyLabel="No candidate readiness evidence is available."
      />
    </Panel>
  );
}

function ReadinessBadge({ level }: { level: CatalogBenchmarkSeedReadinessLevel }): ReactNode {
  return <Badge status={READINESS_LEVEL_TONES[level]}>{READINESS_LEVEL_LABELS[level]}</Badge>;
}

function CatalogCandidateAggregate({
  opportunities,
  rows,
}: {
  opportunities: CatalogOpportunityRankingReadModel;
  rows: readonly CatalogOpportunityRow[];
}): ReactNode {
  const owned = rows.filter((row) => row.localOwnership === "owned").length;
  const highDemand = rows.filter(
    (row) =>
      row.demandFacts.demandBucket === "very_high" || row.demandFacts.demandBucket === "high",
  ).length;
  const noEnglish = rows.filter((row) => row.completenessPool === "no_english").length;
  return (
    <div className="itotori-metric-row" aria-label="Catalog candidate aggregate">
      <StatReadout label="Candidates" value={rows.length} />
      <StatReadout label="Owned" value={owned} />
      <StatReadout label="High demand" value={highDemand} />
      <StatReadout label="No English" value={noEnglish} />
      <StatReadout label="Generated" value={formatGeneratedAt(opportunities.generatedAt)} />
    </div>
  );
}

function formatDemandFacts(row: CatalogOpportunityRow): string {
  const parts: string[] = [];
  if (row.demandFacts.dlCount !== null) {
    parts.push(`${numberFormatter.format(row.demandFacts.dlCount)} DL`);
  }
  if (row.demandFacts.ratingAverage !== null) {
    parts.push(`${row.demandFacts.ratingAverage.toFixed(2)} rating`);
  }
  if (row.demandFacts.wishlistCount !== null) {
    parts.push(`${numberFormatter.format(row.demandFacts.wishlistCount)} wishlists`);
  }
  return parts.length > 0 ? parts.join(" / ") : "No demand counts";
}

function formatLocalEvidence(row: CatalogOpportunityRow): string {
  const unit = row.localEvidenceCount === 1 ? "signal" : "signals";
  return `${row.localEvidenceCount} local ${unit}`;
}

function formatEngineName(row: CatalogOpportunityRow): string {
  return row.engineName ?? "Unknown engine";
}

function formatAdapterEvidence(row: CatalogOpportunityRow): string {
  return row.adapterId === null
    ? "No engineCapabilityReports adapter match"
    : `engineCapabilityReports/${row.adapterId}`;
}

function formatRuntimeEvidence(readiness: CatalogOpportunityRuntimeEvidenceReadiness): string {
  const publicUnit =
    readiness.publicFixtureEvidenceCount === 1 ? "public fixture" : "public fixtures";
  const privateUnit =
    readiness.privateLocalAggregateEvidenceCount === 1 ? "private aggregate" : "private aggregates";
  const runtimeLabel = RUNTIME_EVIDENCE_LABELS[readiness.status];
  const publicEvidence = `${readiness.publicFixtureEvidenceCount} ${publicUnit}`;
  const privateEvidence = `${readiness.privateLocalAggregateEvidenceCount} ${privateUnit}`;
  return `${runtimeLabel} - ${publicEvidence}; ${privateEvidence}`;
}

function formatGeneratedAt(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}
