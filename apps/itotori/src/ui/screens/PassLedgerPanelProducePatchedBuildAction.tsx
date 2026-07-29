import { useState, type ReactNode } from "react";
import { Badge } from "@itotori/ds";

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
