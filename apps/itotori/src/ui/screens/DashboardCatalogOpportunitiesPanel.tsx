import type { ReactNode } from "react";
import type {
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogCompletenessPool,
  CatalogOpportunityFactor,
  CatalogOpportunityRankingReadModel,
  CatalogOpportunityRow,
} from "@itotori/db";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

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

const opportunityNumberFormatter = new Intl.NumberFormat("en-US");

export function CatalogOpportunitiesPanel({
  opportunities,
}: {
  opportunities: ApiCallState<CatalogOpportunityRankingReadModel>;
}): ReactNode {
  return (
    <Panel
      title="Catalog opportunities"
      eyebrow="Project selection"
      className="itotori-panel--catalog-opportunities"
    >
      {opportunities.state === "loading" && (
        <LoadingState label="Loading catalog opportunities..." />
      )}
      {opportunities.state === "empty" && (
        <EmptyState
          title="Catalog opportunities"
          message="No catalog opportunity rows were returned by the API."
        />
      )}
      {opportunities.state === "error" && (
        <ErrorState title="Catalog opportunities" error={opportunities.error} />
      )}
      {opportunities.state === "ready" && (
        <CatalogOpportunitiesContent opportunities={opportunities.data} />
      )}
    </Panel>
  );
}

function CatalogOpportunitiesContent({
  opportunities,
}: {
  opportunities: CatalogOpportunityRankingReadModel;
}): ReactNode {
  const rows = opportunities.rows.slice(0, 5);
  const candidateCount = opportunities.rows.filter((row) => row.decision === "candidate").length;
  const demotedCount = opportunities.rows.filter((row) => row.decision === "demoted").length;
  return (
    <>
      <div className="itotori-metric-row" aria-label="Catalog opportunities aggregate">
        <StatReadout label="Rows" value={opportunities.rows.length} />
        <StatReadout label="Candidates" value={candidateCount} />
        <StatReadout label="Demoted" value={demotedCount} />
        <StatReadout label="Target" value={opportunities.targetLanguage} />
      </div>
      <DataTable
        caption="Catalog opportunity rows"
        columns={[
          {
            key: "work",
            header: "Work",
            render: (row) => (
              <span>
                #{row.rank} {row.canonicalTitle}
                <br />
                <code>{row.workId}</code>
              </span>
            ),
          },
          {
            key: "decision",
            header: "Decision",
            render: (row) => (
              <span>
                <Badge status={row.decision} tone={decisionTone(row.decision)}>
                  {decisionLabel(row.decision)}
                </Badge>
                <br />
                {formatScore(row)}
              </span>
            ),
          },
          {
            key: "engine",
            header: "Engine / readiness",
            render: (row) => (
              <span>
                {row.engineName ?? "Unknown engine"}
                <br />
                {formatReadiness(row)}
              </span>
            ),
          },
          {
            key: "demand",
            header: "Demand / owned",
            render: (row) => (
              <span>
                <Badge status={row.demandFacts.demandBucket}>
                  {DEMAND_BUCKET_LABELS[row.demandFacts.demandBucket]}
                </Badge>{" "}
                <Badge
                  status={row.localOwnership}
                  tone={row.localOwnership === "owned" ? "ok" : "neutral"}
                >
                  {OWNERSHIP_LABELS[row.localOwnership]}
                </Badge>
                <br />
                {formatDemand(row)} / {formatLocalEvidence(row)}
              </span>
            ),
          },
          {
            key: "signals",
            header: "Signals",
            render: (row) => (
              <span>
                <Badge status={COMPLETENESS_STATUS[row.completenessPool]}>
                  {COMPLETENESS_LABELS[row.completenessPool]}
                </Badge>
                <br />
                {formatTopFactors(row)}
                <br />
                {formatDemotion(row)}
              </span>
            ),
          },
        ]}
        rows={rows}
        getRowKey={(row) => row.workId}
        emptyLabel="No catalog opportunities are currently ranked."
      />
      <p>
        <a href="/catalog">Open catalog candidates</a>
      </p>
    </>
  );
}

function decisionTone(decision: CatalogOpportunityRow["decision"]): "neutral" | "ok" | "critical" {
  if (decision === "candidate") {
    return "ok";
  }
  if (decision === "demoted") {
    return "critical";
  }
  return "neutral";
}

function decisionLabel(decision: CatalogOpportunityRow["decision"]): string {
  return decision.charAt(0).toUpperCase() + decision.slice(1);
}

function formatScore(row: CatalogOpportunityRow): string {
  return `Score ${row.score}`;
}

function formatReadiness(row: CatalogOpportunityRow): string {
  return `patch ${row.readiness.patch} / runtime ${row.readiness.runtime}`;
}

function formatDemand(row: CatalogOpportunityRow): string {
  const counts: string[] = [];
  if (row.demandFacts.dlCount !== null) {
    counts.push(`${opportunityNumberFormatter.format(row.demandFacts.dlCount)} DL`);
  }
  if (row.demandFacts.wishlistCount !== null) {
    counts.push(`${opportunityNumberFormatter.format(row.demandFacts.wishlistCount)} wishlists`);
  }
  return counts.length === 0 ? "no public demand counts" : counts.join(", ");
}

function formatLocalEvidence(row: CatalogOpportunityRow): string {
  const unit = row.localEvidenceCount === 1 ? "signal" : "signals";
  return `${row.localEvidenceCount} local ${unit}`;
}

function formatTopFactors(row: CatalogOpportunityRow): string {
  const factors = topContributingFactors(row.factorBreakdown);
  if (factors.length === 0) {
    return "factors: none";
  }
  return `factors: ${factors.map(formatFactorContribution).join(", ")}`;
}

function topContributingFactors(
  factors: readonly CatalogOpportunityFactor[],
): CatalogOpportunityFactor[] {
  return [...factors]
    .filter((factor) => factor.weightedScore !== 0)
    .sort((left, right) => Math.abs(right.weightedScore) - Math.abs(left.weightedScore))
    .slice(0, 2);
}

function formatFactorContribution(factor: CatalogOpportunityFactor): string {
  const signedScore =
    factor.weightedScore > 0 ? `+${factor.weightedScore}` : `${factor.weightedScore}`;
  return `${factor.factor.replaceAll("_", " ")} ${signedScore}`;
}

function formatDemotion(row: CatalogOpportunityRow): string {
  const demotion = row.demotions[0];
  if (demotion === undefined) {
    return "demotion: none";
  }
  return `demotion: ${demotion.reasonCode}`;
}
