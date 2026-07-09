// set-privacy-zdr-ui — Settings > Privacy posture.
//
// The privacy/ZDR surface is intentionally READ-ONLY. ZDR is an account-wide
// operator posture asserted at process startup by `assertOpenRouterZdrAccount`;
// the UI surfaces the latest captured provider-run posture as evidence and
// never presents a per-project writable ZDR toggle.

import { type ReactNode } from "react";
import type { ProjectCostReport } from "@itotori/db";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import { useApiQuery } from "../use-api-resource.js";
import { ShellHeader } from "../states.js";
import { readZdrPosture, type ZdrPostureRead } from "../shell-frame.js";

export function parseSettingsRoute(pathname: string): { tab: "privacy" } | null {
  return pathname === "/settings" || pathname === "/settings/privacy" ? { tab: "privacy" } : null;
}

type PrivacyDefaultRow = {
  key: "retention" | "redactShared";
  label: string;
  value: ReactNode;
  evidence: string;
};

const PRIVACY_DEFAULT_ROWS: readonly PrivacyDefaultRow[] = [
  {
    key: "retention",
    label: "retention",
    value: "none",
    evidence:
      "Provider requests use zero data retention routing; local audit records stay in the app ledger.",
  },
  {
    key: "redactShared",
    label: "redactShared",
    value: "true",
    evidence:
      "Shared/exported sensitive frames are redacted even when private reveal is available.",
  },
];

export function SettingsScreen(): ReactNode {
  const cost = useApiQuery("projects.cost", {}, "settings:privacy:zdr-posture");
  return <PrivacyPosturePanel cost={cost} />;
}

export function PrivacyPosturePanel({
  cost,
}: {
  cost: ApiCallState<ProjectCostReport>;
}): ReactNode {
  return (
    <section className="itotori-settings" aria-label="Settings">
      <ShellHeader eyebrow="Settings" title="Privacy posture" />
      <Panel
        title="Privacy / ZDR"
        eyebrow="Account-wide evidence"
        lamps={<PrivacyPostureLamp cost={cost} />}
        data-panel-id="privacy-zdr"
        data-panel-state={cost.state}
        aria-label="Privacy / ZDR"
      >
        <PrivacyPostureBody cost={cost} />
      </Panel>
    </section>
  );
}

function PrivacyPostureLamp({ cost }: { cost: ApiCallState<ProjectCostReport> }): ReactNode {
  if (cost.state !== "ready") {
    return <Badge status={cost.state === "error" ? "failed" : "pending"}>{cost.state}</Badge>;
  }
  const read = readZdrPosture(cost.data);
  if (read.kind === "enforced") {
    return <Badge status="ready">read-only</Badge>;
  }
  return <Badge status={read.kind === "opted_out" ? "failed" : "pending"}>{read.kind}</Badge>;
}

function PrivacyPostureBody({ cost }: { cost: ApiCallState<ProjectCostReport> }): ReactNode {
  if (cost.state === "loading") {
    return <p role="status">Loading privacy posture evidence...</p>;
  }
  if (cost.state === "error") {
    return (
      <p role="alert" data-api-error-code={cost.error.code ?? "unavailable"}>
        Privacy posture unavailable.
      </p>
    );
  }
  if (cost.state === "empty") {
    return <p>No privacy posture evidence has been recorded yet.</p>;
  }
  const read = readZdrPosture(cost.data);
  return (
    <div
      className="itotori-settings-privacy"
      data-zdr-readonly="true"
      data-zdr-phase={read.kind}
      data-project-zdr-toggle="absent"
    >
      <section aria-label="ZDR evidence" className="itotori-settings-privacy__evidence">
        <StatReadout
          label="Account posture"
          value={<ZdrEvidenceValue read={read} />}
          unit="read-only"
          mono
        />
        <p>
          ZDR is enforced account-wide by assertOpenRouterZdrAccount and verified here from the
          latest provider-run routing posture. This is evidence, not a writable project setting.
        </p>
      </section>
      <DataTable
        caption="Privacy defaults"
        rows={PRIVACY_DEFAULT_ROWS}
        getRowKey={(row) => row.key}
        columns={[
          { key: "label", header: "Setting", render: (row) => row.label },
          { key: "value", header: "Default", render: (row) => row.value },
          { key: "evidence", header: "Evidence", render: (row) => row.evidence },
        ]}
      />
    </div>
  );
}

function ZdrEvidenceValue({ read }: { read: ZdrPostureRead }): ReactNode {
  if (read.kind === "unavailable") {
    return <span>no recorded posture</span>;
  }
  const collectionLabel = read.posture.dataCollection === "deny" ? "none" : "allow";
  return (
    <>
      <span>{`zdr=${read.posture.zdr ? "true" : "false"}`}</span>
      <span>{`; data_collection=${collectionLabel}`}</span>
    </>
  );
}
