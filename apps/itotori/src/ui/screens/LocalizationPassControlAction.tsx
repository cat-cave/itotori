import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@itotori/ds";

import { apiClient } from "../client.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";

type ActivePassStatus = "running" | "paused";
type ControlOutcome =
  | { kind: "success"; status: ActivePassStatus }
  | { kind: "error"; message: string };

/** The dashboard's user-driven control surface for the durable active run. */
export function LocalizationPassControlAction({
  canSteer,
  steerDenial,
  projectId,
  journalRunId,
  status,
  onStatusChanged,
}: {
  canSteer: boolean;
  steerDenial: string | null;
  projectId: string;
  journalRunId: string;
  status: ProjectOverviewReadModel["journal"]["rows"][number]["status"];
  onStatusChanged?: (status: ActivePassStatus) => void;
}): ReactNode {
  if (status !== "running" && status !== "paused") return null;
  if (!canSteer) {
    const action = status === "running" ? "Pause" : "Resume";
    const reason = steerDenial ?? "draft.write permission required to control a pass";
    return (
      <div className="itotori-launch-pass" data-pass-control="denied" data-cap="steer">
        <button
          type="button"
          data-action={`${action.toLowerCase()}-pass`}
          disabled
          aria-disabled
          title={reason}
        >
          {action} pass
        </button>
        <span role="note" data-cap-denial="steer">
          {reason}
        </span>
      </div>
    );
  }
  return (
    <LocalizationPassControlActionBody
      projectId={projectId}
      journalRunId={journalRunId}
      status={status}
      {...(onStatusChanged === undefined ? {} : { onStatusChanged })}
    />
  );
}

function LocalizationPassControlActionBody({
  projectId,
  journalRunId,
  status,
  onStatusChanged,
}: {
  projectId: string;
  journalRunId: string;
  status: ActivePassStatus;
  onStatusChanged?: (status: ActivePassStatus) => void;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<ActivePassStatus>(status);
  const [outcome, setOutcome] = useState<ControlOutcome | null>(null);
  useEffect(() => {
    setCurrentStatus(status);
  }, [status]);
  const routeId = currentStatus === "running" ? "projects.pausePass" : "projects.resumePass";
  const verb = currentStatus === "running" ? "Pause" : "Resume";
  async function control(): Promise<void> {
    if (pending) return;
    setPending(true);
    setOutcome(null);
    const result = await apiClient.request(routeId, {
      pathParams: { projectId, runId: journalRunId },
      body: {},
    });
    if (result.state === "ready") {
      setCurrentStatus(result.data.status);
      setOutcome({ kind: "success", status: result.data.status });
      onStatusChanged?.(result.data.status);
    } else if (result.state === "error") {
      setOutcome({
        kind: "error",
        message: `${result.error.code ?? "unavailable"}: ${result.error.message ?? `status ${result.error.status}`}`,
      });
    } else {
      setOutcome({ kind: "error", message: "Unexpected empty response" });
    }
    setPending(false);
  }
  return (
    <div
      className="itotori-launch-pass-action"
      data-strip="pass-control"
      data-busy={String(pending)}
    >
      <button
        type="button"
        data-action={`${verb.toLowerCase()}-pass`}
        disabled={pending}
        aria-disabled={pending}
        onClick={() => void control()}
        title={`${verb} durable localization pass ${journalRunId}`}
      >
        {pending ? `${verb}ing…` : `${verb} pass`}
      </button>
      {outcome?.kind === "success" && (
        <p role="status" className="itotori-launch-pass-action__status">
          <Badge status={outcome.status} /> Pass {outcome.status}
        </p>
      )}
      {outcome?.kind === "error" && (
        <p role="alert" className="itotori-launch-pass-action__error">
          <Badge status="failed">control failed</Badge> {outcome.message}
        </p>
      )}
    </div>
  );
}
