import type { ReactNode } from "react";
import { Panel } from "@itotori/ds";
import { useApiQuery, useApiQueryWhen } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

export type AssetDecisionsRoute = {
  readonly projectId: string;
  readonly localeBranchId: string;
  readonly view: "policy" | "batch";
};

export type CatalogContextRoute = {
  readonly projectId: string;
  readonly localeBranchId: string;
  readonly workId: string;
};

const assetDecisionsPath =
  /^\/projects\/([^/]+)\/locale-branches\/([^/]+)\/asset-decisions(\/batch)?$/u;
const catalogContextPath =
  /^\/projects\/([^/]+)\/locale-branches\/([^/]+)\/catalog-context\/([^/]+)$/u;

export function parseAssetDecisionsRoute(pathname: string): AssetDecisionsRoute | null {
  const match = assetDecisionsPath.exec(pathname);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeURIComponent(match[1]),
    localeBranchId: decodeURIComponent(match[2]),
    view: match[3] === "/batch" ? "batch" : "policy",
  };
}

export function parseCatalogContextRoute(pathname: string): CatalogContextRoute | null {
  const match = catalogContextPath.exec(pathname);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  return {
    projectId: decodeURIComponent(match[1]),
    localeBranchId: decodeURIComponent(match[2]),
    workId: decodeURIComponent(match[3]),
  };
}

export function AssetDecisionsScreen({ route }: { route: AssetDecisionsRoute }): ReactNode {
  const pathParams = { projectId: route.projectId, localeBranchId: route.localeBranchId };
  const decisions = useApiQuery(
    "assetDecisions.active",
    { pathParams },
    `asset-decisions:${route.projectId}:${route.localeBranchId}`,
  );
  const candidates = useApiQueryWhen(
    "assetDecisions.candidates",
    { pathParams },
    `asset-decision-candidates:${route.projectId}:${route.localeBranchId}`,
    route.view === "batch",
  );
  const loading =
    decisions.state === "loading" || (route.view === "batch" && candidates.state === "loading");
  const error =
    decisions.state === "error"
      ? decisions.error
      : candidates.state === "error"
        ? candidates.error
        : null;

  return (
    <main
      className="itotori-shell"
      data-screen="asset-decisions"
      data-state={loading ? "loading" : decisions.state}
    >
      <ShellHeader eyebrow="Project" title="Asset decisions">
        <p className="itotori-shell__lede">{route.localeBranchId}</p>
      </ShellHeader>
      {loading && <LoadingState label="Loading asset decisions..." />}
      {error !== null && <ErrorState title="Asset decisions" error={error} />}
      {!loading && error === null && decisions.state === "empty" && (
        <EmptyState
          title="Asset decisions"
          message="No active asset decisions were returned by the API."
        />
      )}
      {!loading && error === null && decisions.state === "ready" && (
        <>
          <Panel
            title="Active decisions"
            eyebrow={route.view === "batch" ? "Batch view" : "Policy view"}
          >
            {decisions.data.decisions.length === 0 ? (
              <p>No active asset decisions were returned by the API.</p>
            ) : (
              <ul>
                {decisions.data.decisions.map((decision) => (
                  <li key={decision.decisionId}>
                    <strong>{decision.assetRef.ref}</strong> ({decision.assetKind}):{" "}
                    {decision.decisionPolicy}
                    {decision.decisionRationale === null ? "" : ` — ${decision.decisionRationale}`}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {route.view === "batch" && candidates.state === "ready" && (
            <Panel title="Candidate assets" eyebrow="No active decision">
              {candidates.data.candidateAssets.length === 0 ? (
                <p>No candidate assets were returned by the API.</p>
              ) : (
                <ul>
                  {candidates.data.candidateAssets.map((asset) => (
                    <li key={`${asset.assetRef.kind}:${asset.assetRef.ref}`}>
                      {asset.displayLabel ?? asset.assetRef.ref} ({asset.assetKind})
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </>
      )}
    </main>
  );
}

export function CatalogContextScreen({ route }: { route: CatalogContextRoute }): ReactNode {
  const context = useApiQuery(
    "catalog.contextPanel",
    {
      pathParams: {
        projectId: route.projectId,
        localeBranchId: route.localeBranchId,
        workId: route.workId,
      },
    },
    `catalog-context:${route.projectId}:${route.localeBranchId}:${route.workId}`,
  );
  return (
    <main className="itotori-shell" data-screen="catalog-context" data-state={context.state}>
      <ShellHeader eyebrow="Catalog" title="Context">
        <p className="itotori-shell__lede">{route.workId}</p>
      </ShellHeader>
      {context.state === "loading" && <LoadingState label="Loading catalog context..." />}
      {context.state === "error" && <ErrorState title="Catalog context" error={context.error} />}
      {context.state === "ready" && (
        <>
          <Panel title={context.data.row.canonicalTitle} eyebrow={context.data.row.workId}>
            <p>{context.data.row.originalLanguage ?? "Original language unavailable"}</p>
            <p>{context.data.row.explanationCodes.join(", ") || "No catalog explanations."}</p>
          </Panel>
          <Panel title="Releases" eyebrow={`${context.data.releases.length} recorded`}>
            {context.data.releases.length === 0 ? (
              <p>No releases were returned by the API.</p>
            ) : (
              <ul>
                {context.data.releases.map((release) => (
                  <li key={release.releaseId}>
                    {release.releaseKind} — {release.platform}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </main>
  );
}
