// Durable execution-journal review panel.
//
// The filename/component remains the dashboard slot's stable import while its
// data source is exclusively `projects.overview.journal`: normalized run,
// physical-call, outcome, candidate, QA, and context provenance.

import { useState, type ReactNode } from "react";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";
import { useCapsOptional } from "../caps-context.js";
import { apiClient } from "../client.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";
import { useWorkflowHandoffToasts } from "../workflow-handoff-toasts.js";

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
        <ProducePatchedBuildAction
          canSteer={canSteer}
          steerDenial={steerDenial}
          projectId={overview.data.projectId}
          localeBranchId={overview.data.journal.filter.localeBranchId}
        />
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

type ProduceBuildOutcome =
  | { kind: "produced"; fileName: string }
  | { kind: "error"; message: string };

/**
 * Produce-and-download a playable patched build. This POSTs to the real
 * `/api/patchback/produce` mutation, which drives the byte-surgical native
 * `kaifuu patch` apply over the run's accepted outputs and streams back the
 * produced game archive — the reviewer gets a playable patched game out of the
 * app in one action. The bytes are exactly what the apply wrote (no fabrication).
 */
export function ProducePatchedBuildAction({
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
    const reason = steerDenial ?? "draft.write permission required to produce a patched build";
    return (
      <div
        className="itotori-produce-build"
        data-produce-build="denied"
        data-cap="steer"
        data-cap-allowed="false"
      >
        <button
          type="button"
          data-action="produce-patched-build"
          disabled
          aria-disabled
          title={reason}
          aria-description={reason}
        >
          Produce patched build
        </button>
        <span role="note" data-cap-denial="steer">
          {reason}
        </span>
      </div>
    );
  }
  return <ProducePatchedBuildActionBody projectId={projectId} localeBranchId={localeBranchId} />;
}

function ProducePatchedBuildActionBody({
  projectId,
  localeBranchId,
}: {
  projectId: string;
  localeBranchId: string;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ProduceBuildOutcome | null>(null);
  async function produce(): Promise<void> {
    if (pending) return;
    setOutcome(null);
    setPending(true);
    try {
      const response = await fetch("/api/patchback/produce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ projectId, localeBranchId }),
      });
      if (!response.ok) {
        const message = await produceErrorMessage(response);
        setOutcome({ kind: "error", message });
        return;
      }
      const blob = await response.blob();
      const fileName = downloadFileName(response.headers.get("content-disposition"));
      triggerBlobDownload(blob, fileName);
      setOutcome({ kind: "produced", fileName });
    } catch (error) {
      setOutcome({
        kind: "error",
        message: error instanceof Error ? error.message : "produce request failed",
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      className="itotori-produce-build-action"
      data-strip="produce-patched-build"
      data-busy={pending ? "true" : "false"}
    >
      <button
        type="button"
        data-action="produce-patched-build"
        disabled={pending}
        aria-disabled={pending}
        onClick={() => {
          void produce();
        }}
        title="Splice accepted translations into a playable patched game and download it"
      >
        {pending ? "Producing…" : "Produce patched build"}
      </button>
      {outcome?.kind === "produced" && (
        <p
          role="status"
          data-produce-build="produced"
          className="itotori-produce-build-action__status"
        >
          Downloaded {outcome.fileName}
        </p>
      )}
      {outcome?.kind === "error" && (
        <p role="alert" data-produce-build="error" className="itotori-produce-build-action__error">
          <Badge status="failed">error</Badge> {outcome.message}
        </p>
      )}
    </div>
  );
}

async function produceErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; code?: unknown };
    const code = typeof payload.code === "string" ? payload.code : String(response.status);
    const detail = typeof payload.error === "string" ? payload.error : response.statusText;
    return `${code}: ${detail}`;
  } catch {
    return `status ${response.status}`;
  }
}

function downloadFileName(contentDisposition: string | null): string {
  const match = contentDisposition ? /filename="?([^"]+)"?/u.exec(contentDisposition) : null;
  return match?.[1] ?? "patched-build.tar";
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
