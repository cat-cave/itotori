// Durable execution-journal review panel.
//
// The filename/component remains the dashboard slot's stable import while its
// data source is exclusively `projects.overview.journal`: normalized run,
// physical-call, outcome, candidate, QA, and context provenance.
//
// Also hosts the Studio patchback trigger: after a localization pass, the
// operator can run the REAL kaifuu-cli patch-apply seam and download a playable
// patched build without leaving the SPA.

import { useState, type ReactNode } from "react";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ApiProjectPatchbackResponse } from "../../api-schema.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";
import { useCapsOptional } from "../caps-context.js";
import { apiClient } from "../client.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";
import { useWorkflowHandoffToasts } from "../workflow-handoff-toasts.js";
import "./PassLedgerPanel.css";

export type JournalRunSummaryRow = {
  journalRunId: string;
  targetLocale: string;
  physicalCallCount: number;
  physicalCallLabel: string;
  writtenOutcomeCount: number;
  candidateCount: number;
  qaFindingCount: number;
  contextRefCount: number;
};

/** Pure, lossless display projection over the journal overview rows. */
export function journalRunSummaryRows(
  rows: ProjectOverviewReadModel["journal"]["rows"],
): JournalRunSummaryRow[] {
  return rows.map((row) => ({
    journalRunId: row.journalRunId,
    targetLocale: row.targetLocale,
    physicalCallCount: row.physicalCallCount,
    physicalCallLabel:
      row.failedPhysicalCallCount === 0
        ? String(row.physicalCallCount)
        : `${row.physicalCallCount} (${row.failedPhysicalCallCount} failed)`,
    writtenOutcomeCount: row.writtenOutcomeCount,
    candidateCount: row.candidateCount,
    qaFindingCount: row.qaFindingCount,
    contextRefCount: row.contextRefCount,
  }));
}

/**
 * The Overview journal panel. It retains the public component name used by
 * the dashboard shell, but the operator-facing title and every visible value
 * are sourced from the durable attempt/outcome journal.
 */
export function PassLedgerPanel(): ReactNode {
  const overview = useApiQuery("projects.overview", {}, "overview");
  return <PassLedgerPanelBody overview={overview} />;
}

export function PassLedgerPanelBody({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  const caps = useCapsOptional();
  const rowCount = overview.state === "ready" ? overview.data.journal.rows.length : null;
  const headline =
    rowCount === null
      ? "Execution journal"
      : rowCount === 0
        ? "Execution journal — no runs recorded"
        : `Execution journal — ${rowCount} run${rowCount === 1 ? "" : "s"} recorded`;
  const overviewCanSteer = overview.state === "ready" ? overview.data.canSteer : false;
  const canSteer = caps === null ? overviewCanSteer : overviewCanSteer && caps.canSteer;
  const steerDenial =
    caps?.denials.steer ?? (canSteer ? null : "draft.write permission required to launch a pass");
  return (
    <Panel
      title={headline}
      eyebrow="Execution journal"
      className="itotori-panel--pass-ledger"
      data-panel-state={overview.state}
    >
      {overview.state === "ready" && (
        <LaunchPassAction
          canSteer={canSteer}
          steerDenial={steerDenial}
          projectId={overview.data.projectId}
          localeBranchId={overview.data.journal.filter.localeBranchId}
        />
      )}
      {overview.state === "ready" && (
        <PatchbackAction canSteer={canSteer} steerDenial={steerDenial} />
      )}
      <PassLedgerPanelContent overview={overview} />
    </Panel>
  );
}

type LaunchPassOutcome =
  | { kind: "started"; journalRunId: string }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string };

export function LaunchPassAction({
  canSteer,
  projectId,
  localeBranchId,
  steerDenial,
}: {
  canSteer: boolean;
  projectId: string;
  localeBranchId: string | null;
  steerDenial?: string | null;
}): ReactNode {
  if (localeBranchId === null) return null;
  if (!canSteer) {
    const reason = steerDenial ?? "draft.write permission required to launch a pass";
    return (
      <div
        className="itotori-launch-pass"
        data-launch-pass="denied"
        data-cap="steer"
        data-cap-allowed="false"
      >
        <button
          type="button"
          data-action="launch-pass"
          disabled
          aria-disabled
          title={reason}
          aria-description={reason}
        >
          Launch next pass
        </button>
        <span role="note" data-cap-denial="steer">
          {reason}
        </span>
      </div>
    );
  }
  return <LaunchPassActionBody projectId={projectId} localeBranchId={localeBranchId} />;
}

function LaunchPassActionBody({
  projectId,
  localeBranchId,
}: {
  projectId: string;
  localeBranchId: string;
}): ReactNode {
  const { notifyHandoff } = useWorkflowHandoffToasts();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<LaunchPassOutcome | null>(null);
  async function launch(): Promise<void> {
    if (pending) return;
    setOutcome(null);
    setPending(true);
    const result = await apiClient.request("projects.launchPass", {
      pathParams: { projectId },
      body: { localeBranchId },
    });
    if (result.state === "ready") {
      if (result.data.outcome === "started") {
        const journalRunId = result.data.journalRunId;
        if (journalRunId === null) {
          setOutcome({ kind: "error", message: "started response omitted journal run id" });
        } else {
          setOutcome({ kind: "started", journalRunId });
          notifyHandoff({ kind: "pass-launched", journalRunId });
        }
      } else {
        setOutcome({ kind: "refused", message: result.data.refusalMessage ?? "refused" });
      }
    } else if (result.state === "error") {
      const code = result.error.code ?? "unavailable";
      const detail = result.error.message ?? `status ${result.error.status}`;
      setOutcome({ kind: "error", message: `${code}: ${detail}` });
    } else {
      setOutcome({ kind: "error", message: "Unexpected empty response" });
    }
    setPending(false);
  }
  return (
    <div
      className="itotori-launch-pass-action"
      data-strip="launch-pass"
      data-busy={pending ? "true" : "false"}
    >
      <button
        type="button"
        data-action="launch-pass"
        disabled={pending}
        aria-disabled={pending}
        onClick={() => {
          void launch();
        }}
        title="Drive the next localization run"
      >
        {pending ? "Launching…" : "Launch next pass"}
      </button>
      {outcome?.kind === "started" && (
        <p role="status" data-launch-pass="started" className="itotori-launch-pass-action__status">
          Journal {outcome.journalRunId} started
        </p>
      )}
      {(outcome?.kind === "refused" || outcome?.kind === "error") && (
        <p
          role="alert"
          data-launch-pass={outcome.kind}
          className="itotori-launch-pass-action__error"
        >
          <Badge status="failed">{outcome.kind}</Badge> {outcome.message}
        </p>
      )}
    </div>
  );
}

function PassLedgerPanelContent({
  overview,
}: {
  overview: ApiCallState<ProjectOverviewReadModel>;
}): ReactNode {
  if (overview.state === "loading") return <LoadingState label="Loading execution journal…" />;
  if (overview.state === "error")
    return <ErrorState title="Execution journal" error={overview.error} />;
  if (overview.state === "empty" || overview.data.journal.rows.length === 0) {
    return (
      <EmptyState
        title="Execution journal"
        message="No durable localization runs have been recorded for this project yet."
      />
    );
  }
  return <PassLedgerPanelReady overview={overview.data} />;
}

function PassLedgerPanelReady({ overview }: { overview: ProjectOverviewReadModel }): ReactNode {
  const rows = journalRunSummaryRows(overview.journal.rows);
  const totals = computeJournalTotals(rows);
  return (
    <>
      <div className="itotori-metric-row" aria-label="Execution journal aggregate">
        <StatReadout label="Runs" value={totals.runCount} />
        <StatReadout label="Physical calls" value={totals.physicalCallCount} />
        <StatReadout label="Candidates" value={totals.candidateCount} />
        <StatReadout label="QA findings" value={totals.qaFindingCount} />
      </div>
      <DataTable
        caption="Execution journal"
        columns={[
          {
            key: "run",
            header: "Run",
            render: (row) => <code>{row.journalRunId}</code>,
          },
          { key: "locale", header: "Locale", render: (row) => row.targetLocale },
          {
            key: "calls",
            header: "Physical calls",
            align: "end",
            render: (row) => row.physicalCallLabel,
          },
          {
            key: "written",
            header: "Written",
            align: "end",
            render: (row) => row.writtenOutcomeCount,
          },
          {
            key: "candidates",
            header: "Candidates",
            align: "end",
            render: (row) => row.candidateCount,
          },
          { key: "qa", header: "QA", align: "end", render: (row) => row.qaFindingCount },
          {
            key: "context",
            header: "Context refs",
            align: "end",
            render: (row) => row.contextRefCount,
          },
        ]}
        rows={rows}
        getRowKey={(row) => row.journalRunId}
        emptyLabel="No recorded runs."
      />
    </>
  );
}

function computeJournalTotals(rows: JournalRunSummaryRow[]): {
  runCount: number;
  physicalCallCount: number;
  candidateCount: number;
  qaFindingCount: number;
} {
  return {
    runCount: rows.length,
    physicalCallCount: rows.reduce((total, row) => total + row.physicalCallCount, 0),
    candidateCount: rows.reduce((total, row) => total + row.candidateCount, 0),
    qaFindingCount: rows.reduce((total, row) => total + row.qaFindingCount, 0),
  };
}

// ---------------------------------------------------------------------------
// Studio patchback — trigger real apply + download the patched build
// ---------------------------------------------------------------------------

type PatchbackOutcome =
  | { kind: "ready"; response: ApiProjectPatchbackResponse }
  | { kind: "error"; message: string };

type PatchbackScope = "dialogue-only" | "dialogue+choices";

/**
 * Hi-fi control that runs the REAL Studio patchback mutation and surfaces the
 * download URL for the retained patched game tree.
 */
export function PatchbackAction({
  canSteer,
  steerDenial,
}: {
  canSteer: boolean;
  steerDenial?: string | null;
}): ReactNode {
  if (!canSteer) {
    const reason = steerDenial ?? "draft.write permission required to build a patched game";
    return (
      <div
        className="itotori-patchback-action"
        data-patchback="denied"
        data-cap="steer"
        data-cap-allowed="false"
      >
        <div className="itotori-patchback-action__header">
          <h3 className="itotori-patchback-action__title">Patched build</h3>
          <p className="itotori-patchback-action__lede">
            Apply the translated bridge to a RealLive install and download a playable game tree.
          </p>
        </div>
        <button
          type="button"
          data-action="build-patched-game"
          disabled
          aria-disabled
          title={reason}
          aria-description={reason}
        >
          Build patched game
        </button>
        <span role="note" data-cap-denial="steer">
          {reason}
        </span>
      </div>
    );
  }
  return <PatchbackActionBody />;
}

function PatchbackActionBody(): ReactNode {
  const [gameRoot, setGameRoot] = useState("");
  const [bundlePath, setBundlePath] = useState("");
  const [scope, setScope] = useState<PatchbackScope>("dialogue+choices");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<PatchbackOutcome | null>(null);

  const disabledReason =
    gameRoot.trim().length === 0
      ? "Game root is required."
      : bundlePath.trim().length === 0
        ? "Translated bundle path is required."
        : null;

  async function build(): Promise<void> {
    if (pending) return;
    if (disabledReason !== null) {
      setOutcome({ kind: "error", message: disabledReason });
      return;
    }
    setOutcome(null);
    setPending(true);
    const result = await apiClient.request("projects.patchback", {
      body: {
        gameRoot: gameRoot.trim(),
        translatedBundlePath: bundlePath.trim(),
        scope,
        force: true,
      },
    });
    if (result.state === "ready") {
      setOutcome({ kind: "ready", response: result.data });
    } else if (result.state === "error") {
      const code = result.error.code ?? "unavailable";
      const detail = result.error.message ?? `status ${result.error.status}`;
      setOutcome({ kind: "error", message: `${code}: ${detail}` });
    } else {
      setOutcome({ kind: "error", message: "Unexpected empty response" });
    }
    setPending(false);
  }

  return (
    <div
      className="itotori-patchback-action"
      data-strip="patchback"
      data-busy={pending ? "true" : "false"}
      data-patchback={outcome?.kind ?? "idle"}
    >
      <div className="itotori-patchback-action__header">
        <h3 className="itotori-patchback-action__title">Patched build</h3>
        <p className="itotori-patchback-action__lede">
          Run the real kaifuu patch-apply seam against a RealLive install and download the playable
          game tree. Same path as <code>itotori patch</code> — no mock apply.
        </p>
      </div>
      <div className="itotori-patchback-action__fields">
        <label className="itotori-patchback-action__field">
          <span>Game root</span>
          <input
            type="text"
            data-field="game-root"
            value={gameRoot}
            onChange={(event) => setGameRoot(event.target.value)}
            placeholder="/path/to/game"
            autoComplete="off"
            disabled={pending}
          />
        </label>
        <label className="itotori-patchback-action__field">
          <span>Translated bundle path</span>
          <input
            type="text"
            data-field="bundle-path"
            value={bundlePath}
            onChange={(event) => setBundlePath(event.target.value)}
            placeholder="/path/to/translated-bridge.json"
            autoComplete="off"
            disabled={pending}
          />
        </label>
        <label className="itotori-patchback-action__field">
          <span>Scope</span>
          <select
            data-field="scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as PatchbackScope)}
            disabled={pending}
          >
            <option value="dialogue+choices">dialogue + choices</option>
            <option value="dialogue-only">dialogue only</option>
          </select>
        </label>
      </div>
      <div className="itotori-patchback-action__actions">
        <button
          type="button"
          data-action="build-patched-game"
          disabled={pending || disabledReason !== null}
          aria-disabled={pending || disabledReason !== null}
          onClick={() => {
            void build();
          }}
          title={
            disabledReason ?? "Apply translated bundle and retain a downloadable patched build"
          }
        >
          {pending ? "Building patched game…" : "Build patched game"}
        </button>
      </div>
      {outcome?.kind === "ready" && (
        <div role="status" data-patchback="ready" className="itotori-patchback-action__status">
          <p>
            <Badge status="ready">ready</Badge> Build{" "}
            <code data-patch-build-id={outcome.response.patchBuildId}>
              {outcome.response.patchBuildId}
            </code>{" "}
            ({outcome.response.scope})
          </p>
          <p className="itotori-patchback-action__command">
            <code>{outcome.response.command}</code>
          </p>
          <p>
            <a href={outcome.response.downloadUrl} data-action="download-patched-build" download>
              Download patched game (.tar)
            </a>
          </p>
        </div>
      )}
      {outcome?.kind === "error" && (
        <p role="alert" data-patchback="error" className="itotori-patchback-action__error">
          <Badge status="failed">error</Badge> {outcome.message}
        </p>
      )}
    </div>
  );
}
