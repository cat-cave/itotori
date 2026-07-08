// fnd-spa-shell — the localization reviewer workspace screen.
//
// Parity port of the deleted HTML-string `workspace/view.ts`. Consumes the
// `/api/workspace/*` reads THROUGH the typed client and renders the browse /
// scene / asset / comparison / search / corrections read-models with
// `@itotori/ds`. The parsed `WorkspaceRoute` (still owned by
// `workspace/route.ts`) selects which typed query to issue; each view leads
// with the translated, source-language-free affordances so a reviewer who
// does not read the source can navigate.

import type { ReactNode } from "react";
import { Badge, DataTable, Panel } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ItotoriApiRouteId } from "../../api-schema.js";
import type {
  WorkspaceAssetBrowseReadModel,
  WorkspaceComparisonReadModel,
  WorkspaceDiagnostic,
  WorkspacePermissionView,
  WorkspaceProjectBrowseReadModel,
  WorkspaceSceneBrowseReadModel,
  WorkspaceSearchReadModel,
} from "../../workspace/read-model.js";
import type { WorkspaceCorrectionPreviewReadModel } from "../../workspace/correction-model.js";
import type { WorkspaceRoute } from "../../workspace/route.js";
import type { ApiRequestOptionsFor, ApiRouteResponse } from "../../api-client.js";
import { useApiQuery } from "../use-api-resource.js";
import { ErrorState, LoadingState, ShellHeader } from "../states.js";

export function WorkspaceScreen({ route }: { route: WorkspaceRoute }): ReactNode {
  return (
    <main className="itotori-shell workspace" data-screen="workspace" data-view={route.kind}>
      <ShellHeader eyebrow="Localization workspace" title={workspaceTitle(route)} />
      <WorkspaceRouteBody route={route} />
    </main>
  );
}

function workspaceTitle(route: WorkspaceRoute): string {
  switch (route.kind) {
    case "projects":
      return "Browse projects and locale branches";
    case "scenes":
      return "Browse scenes";
    case "assets":
      return "Browse assets";
    case "comparison":
      return "Source / draft / final comparison";
    case "search":
      return "Search";
    case "corrections":
      return "Manual corrections";
  }
}

// A tiny generic query+render wrapper so each route kind issues its typed
// query and renders loading / error before handing the ready read-model to
// its view.
function QueryView<R extends ItotoriApiRouteId>({
  routeId,
  options,
  depsKey,
  render,
}: {
  routeId: R;
  options: ApiRequestOptionsFor<R>;
  depsKey: string;
  render: (data: ApiRouteResponse<R>) => ReactNode;
}): ReactNode {
  const state = useApiQuery(routeId, options, depsKey) as ApiCallState<ApiRouteResponse<R>>;
  if (state.state === "loading") {
    return <LoadingState label="Loading workspace…" />;
  }
  if (state.state === "error") {
    return <ErrorState title="Workspace" error={state.error} />;
  }
  // Workspace reads are structured read-models: the `empty` collection state
  // still carries permission + diagnostics, so treat it as ready-with-data.
  const data = state.state === "ready" ? state.data : null;
  if (data === null) {
    return <p className="itotori-empty-copy">No workspace data returned.</p>;
  }
  return <>{render(data)}</>;
}

function WorkspaceRouteBody({ route }: { route: WorkspaceRoute }): ReactNode {
  switch (route.kind) {
    case "projects":
      return (
        <QueryView
          routeId="workspace.projects"
          options={{}}
          depsKey="workspace.projects"
          render={(data) => <ProjectBrowseView model={data} />}
        />
      );
    case "scenes":
      return (
        <QueryView
          routeId="workspace.scenes"
          options={{ query: { projectId: route.projectId, localeBranchId: route.localeBranchId } }}
          depsKey={`workspace.scenes:${route.projectId}:${route.localeBranchId}`}
          render={(data) => <SceneBrowseView model={data} />}
        />
      );
    case "assets":
      return (
        <QueryView
          routeId="workspace.assets"
          options={{ query: { projectId: route.projectId, localeBranchId: route.localeBranchId } }}
          depsKey={`workspace.assets:${route.projectId}:${route.localeBranchId}`}
          render={(data) => <AssetBrowseView model={data} />}
        />
      );
    case "comparison":
      return (
        <QueryView
          routeId="workspace.comparison"
          options={{ query: { reviewItemId: route.reviewItemId } }}
          depsKey={`workspace.comparison:${route.reviewItemId}`}
          render={(data) => <ComparisonView model={data} />}
        />
      );
    case "search":
      return (
        <QueryView
          routeId="workspace.search"
          options={{
            query: {
              projectId: route.projectId,
              localeBranchId: route.localeBranchId,
              query: route.query,
              mode: route.mode,
            },
          }}
          depsKey={`workspace.search:${route.projectId}:${route.localeBranchId}:${route.query}:${route.mode ?? ""}`}
          render={(data) => <SearchView model={data} />}
        />
      );
    case "corrections":
      return (
        <QueryView
          routeId="workspace.correctionPreview"
          options={{
            query: {
              localeBranchId: route.localeBranchId,
              reviewItemIds: route.reviewItemIds.length > 0 ? route.reviewItemIds.join(",") : null,
            },
          }}
          depsKey={`workspace.corrections:${route.localeBranchId}:${route.reviewItemIds.join(",")}`}
          render={(data) => <CorrectionsView model={data} />}
        />
      );
  }
}

function DeniedShell({ permission }: { permission: WorkspacePermissionView }): ReactNode {
  const reason = permission.denialReasons[0] ?? `user ${permission.actorUserId} cannot read queue`;
  return (
    <Panel title="Localization workspace access denied" tone="sakura">
      <p role="alert">{reason}</p>
    </Panel>
  );
}

function DiagnosticBanner({ diagnostics }: { diagnostics: WorkspaceDiagnostic[] }): ReactNode {
  if (diagnostics.length === 0) {
    return null;
  }
  return (
    <section className="itotori-diagnostic-banner" role="alert" aria-label="Workspace diagnostics">
      <ul>
        {diagnostics.map((d) => (
          <li key={d.code} data-diagnostic-code={d.code}>
            <Badge status="warning">{d.code}</Badge> {d.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProjectBrowseView({ model }: { model: WorkspaceProjectBrowseReadModel }): ReactNode {
  if (!model.permission.canReadQueue) {
    return <DeniedShell permission={model.permission} />;
  }
  return (
    <>
      <DiagnosticBanner diagnostics={model.diagnostics} />
      {model.projects.map((project) => (
        <Panel
          key={project.projectId}
          title={project.name}
          eyebrow={project.projectKey}
          className="workspace-project"
        >
          <p className="itotori-subhead">
            source locale <code>{project.sourceLocale}</code> — {project.unitCount} units across{" "}
            {project.branchCount} locale branch(es)
          </p>
          <DataTable
            caption="Locale branches"
            columns={[
              { key: "branch", header: "Branch", render: (b) => b.branchName },
              {
                key: "locale",
                header: "Locale",
                render: (b) => (
                  <code>
                    {b.sourceLocale} → {b.targetLocale}
                  </code>
                ),
              },
              {
                key: "progress",
                header: "Progress",
                align: "end",
                render: (b) => `${b.translatedUnitCount}/${b.unitCount}`,
              },
              {
                key: "findings",
                header: "Open findings",
                align: "end",
                render: (b) => b.openFindingCount,
              },
              {
                key: "links",
                header: "Browse",
                render: (b) => (
                  <span>
                    <a href={b.sceneBrowsePath}>scenes</a> · <a href={b.assetBrowsePath}>assets</a>
                  </span>
                ),
              },
            ]}
            rows={project.localeBranches}
            getRowKey={(b) => b.localeBranchId}
          />
        </Panel>
      ))}
    </>
  );
}

function SceneBrowseView({ model }: { model: WorkspaceSceneBrowseReadModel }): ReactNode {
  if (!model.permission.canReadQueue) {
    return <DeniedShell permission={model.permission} />;
  }
  return (
    <>
      <DiagnosticBanner diagnostics={model.diagnostics} />
      {model.scenes.map((scene) => (
        <Panel
          key={scene.sceneId}
          title={scene.summaryText}
          eyebrow={`${scene.summaryLocale} · ${scene.citedUnitCount} cited unit(s)`}
        >
          {scene.stale && <Badge status="stale">stale summary</Badge>}
          <DataTable
            caption="Units"
            columns={[
              { key: "key", header: "Unit", render: (u) => <code>{u.sourceUnitKey}</code> },
              { key: "speaker", header: "Speaker", render: (u) => u.speaker ?? "—" },
              { key: "cited", header: "Cited", render: (u) => (u.cited ? "yes" : "no") },
            ]}
            rows={scene.units}
            getRowKey={(u) => u.occurrenceId}
          />
        </Panel>
      ))}
    </>
  );
}

function AssetBrowseView({ model }: { model: WorkspaceAssetBrowseReadModel }): ReactNode {
  if (!model.permission.canReadQueue) {
    return <DeniedShell permission={model.permission} />;
  }
  return (
    <>
      <DiagnosticBanner diagnostics={model.diagnostics} />
      <Panel title="Assets" eyebrow={model.localeBranchId}>
        <DataTable
          caption="Assets"
          columns={[
            { key: "label", header: "Asset", render: (a) => a.displayLabel ?? a.assetRef.ref },
            { key: "kind", header: "Kind", render: (a) => a.assetKind },
            { key: "decided", header: "Decided", render: (a) => (a.decided ? "yes" : "no") },
            { key: "policy", header: "Policy", render: (a) => a.decisionPolicy ?? "—" },
          ]}
          rows={model.assets}
          getRowKey={(a) => `${a.assetRef.kind}:${a.assetRef.ref}`}
        />
      </Panel>
    </>
  );
}

function ComparisonView({ model }: { model: WorkspaceComparisonReadModel }): ReactNode {
  if (!model.permission.canReadQueue) {
    return <DeniedShell permission={model.permission} />;
  }
  return (
    <>
      <DiagnosticBanner diagnostics={model.diagnostics} />
      <Panel title="Comparison" eyebrow={model.reviewItemId}>
        {model.contextNote !== null && <p className="itotori-context-note">{model.contextNote}</p>}
        {model.cells.map((cell, i) => (
          <div key={`${cell.side}:${i}`} className="itotori-comparison-cell" data-side={cell.side}>
            <p className="itotori-eyebrow">
              {cell.label} · {cell.locale}
            </p>
            <p>{cell.text}</p>
          </div>
        ))}
        {model.runtimeEvidenceLinks.length > 0 && (
          <DataTable
            caption="Runtime evidence"
            columns={[
              { key: "kind", header: "Kind", render: (l) => l.evidenceKind },
              { key: "tier", header: "Tier", render: (l) => l.evidenceTier },
              { key: "target", header: "Target", render: (l) => <code>{l.runtimeTargetId}</code> },
            ]}
            rows={model.runtimeEvidenceLinks}
            getRowKey={(l, i) => `${l.runtimeTargetId}:${i}`}
          />
        )}
      </Panel>
    </>
  );
}

function SearchView({ model }: { model: WorkspaceSearchReadModel }): ReactNode {
  if (!model.permission.canReadQueue) {
    return <DeniedShell permission={model.permission} />;
  }
  return (
    <>
      <DiagnosticBanner diagnostics={model.diagnostics} />
      <Panel
        title={`Search: ${model.query}`}
        eyebrow={`${model.mode} · ${model.results.length} hit(s)`}
      >
        {model.droppedOpaqueCount > 0 && (
          <p className="itotori-subhead">{model.droppedOpaqueCount} opaque result(s) dropped.</p>
        )}
        <DataTable
          caption="Search results"
          columns={[
            { key: "kind", header: "Kind", render: (r) => r.matchKind },
            { key: "snippet", header: "Match", render: (r) => r.snippet },
            { key: "unit", header: "Unit", render: (r) => <code>{r.bridgeUnitRef}</code> },
            { key: "score", header: "Score", align: "end", render: (r) => r.score.toFixed(3) },
          ]}
          rows={model.results}
          getRowKey={(r, i) => `${r.bridgeUnitRef}:${i}`}
          emptyLabel="No results."
        />
      </Panel>
    </>
  );
}

function CorrectionsView({ model }: { model: WorkspaceCorrectionPreviewReadModel }): ReactNode {
  return (
    <Panel title="Manual corrections" eyebrow={model.localeBranchId}>
      <p className="itotori-subhead">{model.units.length} unit(s) in this correction batch.</p>
      <DataTable
        caption="Correction units"
        columns={[
          { key: "item", header: "Review item", render: (u) => <code>{u.reviewItemId}</code> },
          { key: "source", header: "Source", render: (u) => u.sourceText ?? "—" },
          { key: "draft", header: "Draft", render: (u) => u.draftText ?? "—" },
          { key: "final", header: "Final", render: (u) => u.finalText ?? "—" },
        ]}
        rows={model.units}
        getRowKey={(u, i) => `${u.reviewItemId}:${i}`}
        emptyLabel="No correction units."
      />
    </Panel>
  );
}
