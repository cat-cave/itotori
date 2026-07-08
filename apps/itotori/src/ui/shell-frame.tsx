// shell-frame-ui (HI-FI STUDIO EPIC · Shell) — the persistent SPA shell frame.
//
// The app chrome: a NAV (the primary surface switcher) + a persistent STATUS
// BAR rendering Project+branch context, ZDR posture (zdr=true;
// data_collection=none), source->branch, and LIVE COST, all from the
// read-models via the typed client + @itotori/ds. The SPA screens render
// INSIDE the frame (the frame is the app shell every routed screen inherits).
//
// The ZDR posture is shown HONESTLY: derived from the REAL captured routing
// posture on the latest provider run (cost.recentRuns[0].routingPosture),
// never hardcoded. When zdr=true and data_collection="deny" the posture reads
// "zdr=true; data_collection=none"; a posture that opted out (zdr=false or
// data_collection="allow") is surfaced truthfully rather than masked.
//
// The frame consumes THROUGH the client (no ad-hoc fetch): projects.status for
// project+branch + source->branch, projects.cost for the live cost + the ZDR
// posture carried on its recent runs. className-based, ds tokens, no literals.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered nav + status bar states are asserted.

import type { ReactNode } from "react";
import type { ProjectCostReport, ProjectDashboardStatus } from "@itotori/db";
import { Badge, NavPills, type NavPillItem } from "@itotori/ds";
import type { ApiCallState } from "../api-client.js";
import { useApiQuery } from "./use-api-resource.js";
import { formatMicrosUsd } from "./format.js";
import { RedactionToggle } from "./redaction-governor.js";
import type { AppLocation } from "./App.js";

// ---------------------------------------------------------------------------
// Shell nav — the primary surface switcher. The active pill is derived from
// the current location; selecting a pill navigates (a full load, the same
// window.location the shell reads on mount — there is no client router). The
// ids are the SPA's primary surfaces; legacy routes match no pill.
// ---------------------------------------------------------------------------

export interface ShellNavItem {
  id: string;
  label: string;
  href: string;
}

export const SHELL_NAV_ITEMS: readonly ShellNavItem[] = [
  { id: "workbench", label: "Workbench", href: "/" },
  { id: "review", label: "Review", href: "/reviewer-queue" },
  { id: "workspace", label: "Workspace", href: "/workspace" },
];

/** The nav pill id active for a pathname, or "" when no pill matches. */
export function activeShellNavId(pathname: string): string {
  if (pathname === "/") {
    return "workbench";
  }
  if (pathname === "/reviewer-queue" || pathname.startsWith("/reviewer-queue/")) {
    return "review";
  }
  if (pathname === "/workspace" || pathname.startsWith("/workspace/")) {
    return "workspace";
  }
  return "";
}

export function defaultNavigate(path: string): void {
  if (typeof window !== "undefined" && typeof window.location?.assign === "function") {
    window.location.assign(path);
  }
}

function ShellNav({
  location,
  navigate,
}: {
  location: AppLocation;
  navigate: (path: string) => void;
}): ReactNode {
  const activeId = activeShellNavId(location.pathname);
  const items: ReadonlyArray<NavPillItem> = SHELL_NAV_ITEMS;
  return (
    <NavPills
      label="Surfaces"
      className="itotori-shell-frame__nav"
      items={items}
      activeId={activeId}
      onSelect={(id) => {
        const item = SHELL_NAV_ITEMS.find((entry) => entry.id === id);
        if (item !== undefined) {
          navigate(item.href);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// ZDR posture — derived HONESTLY from the latest provider run's captured
// routing posture (cost.recentRuns[0].routingPosture). The repository sorts
// recentRuns by started_at desc, so [0] is the latest. The wire values are
// zdr: boolean and data_collection: "deny" | "allow"; "deny" is the
// no-data-collection commitment, displayed as "none" (the brief's vocabulary).
// A posture that opted out is surfaced truthfully, never masked to "enforced".
// ---------------------------------------------------------------------------

export type ZdrPosture = {
  zdr: boolean;
  dataCollection: "deny" | "allow";
};

export type ZdrPostureRead =
  | { kind: "enforced"; posture: ZdrPosture }
  | { kind: "opted_out"; posture: ZdrPosture }
  | { kind: "unavailable" };

/**
 * Read the ZDR posture from a cost report's recent runs. Returns
 * `unavailable` when there are no runs or the captured posture is missing /
 * the pre-ITOTORI-230 sentinel (no zdr + data_collection scalars). Never
 * throws — a malformed posture reads as unavailable, not a crash.
 */
export function readZdrPosture(cost: ProjectCostReport): ZdrPostureRead {
  const latest = cost.recentRuns[0];
  if (latest === undefined) {
    return { kind: "unavailable" };
  }
  const posture = latest.routingPosture;
  const zdr = posture.zdr;
  const dataCollection = posture.data_collection;
  if (typeof zdr !== "boolean" || (dataCollection !== "deny" && dataCollection !== "allow")) {
    return { kind: "unavailable" };
  }
  const value: ZdrPosture = { zdr, dataCollection };
  // "enforced" only when BOTH axes hold: zdr=true AND data_collection=deny
  // (the canonical ZDR posture). Anything else is honestly "opted_out".
  return zdr && dataCollection === "deny"
    ? { kind: "enforced", posture: value }
    : { kind: "opted_out", posture: value };
}

function ZdrPostureCell({ cost }: { cost: ApiCallState<ProjectCostReport> }): ReactNode {
  const read = cost.state === "ready" ? readZdrPosture(cost.data) : null;
  const phase =
    cost.state === "loading"
      ? "loading"
      : cost.state === "error"
        ? "error"
        : read === null
          ? "unavailable"
          : read.kind;
  return (
    <div
      className="itotori-shell-frame__posture"
      aria-label="ZDR posture"
      data-shell-stat="zdr"
      data-zdr-phase={phase}
    >
      <span className="itotori-shell-frame__stat-label">ZDR posture</span>
      <span className="itotori-shell-frame__posture-value">
        {cost.state === "loading" && <span className="itotori-shell-frame__pending">loading…</span>}
        {cost.state === "error" && (
          <span className="itotori-shell-frame__unavailable">unavailable</span>
        )}
        {cost.state === "ready" && read !== null && <ZdrPostureValue read={read} />}
      </span>
    </div>
  );
}

function ZdrPostureValue({ read }: { read: ZdrPostureRead }): ReactNode {
  if (read.kind === "unavailable") {
    return <span className="itotori-shell-frame__unavailable">no recorded posture</span>;
  }
  const { zdr, dataCollection } = read.posture;
  const collectionLabel = dataCollection === "deny" ? "none" : "allow";
  return (
    <>
      <Badge status={zdr ? "ok" : "critical"}>{`zdr=${zdr ? "true" : "false"}`}</Badge>
      <span
        className="itotori-shell-frame__collection"
        data-data-collection={collectionLabel}
      >{`data_collection=${collectionLabel}`}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Status bar cells — each settles into loading / unavailable / ready on its
// OWN read, so one failed read degrades only its cell (never the whole bar).
// ---------------------------------------------------------------------------

function ProjectCell({ status }: { status: ApiCallState<ProjectDashboardStatus> }): ReactNode {
  return (
    <div className="itotori-shell-frame__stat" data-shell-stat="project">
      <span className="itotori-shell-frame__stat-label">Project</span>
      <span className="itotori-shell-frame__stat-value">
        {status.state === "loading" && (
          <span className="itotori-shell-frame__pending">loading…</span>
        )}
        {status.state === "error" && (
          <span className="itotori-shell-frame__unavailable">unavailable</span>
        )}
        {status.state === "ready" && <span data-project-name>{status.data.name}</span>}
      </span>
    </div>
  );
}

function BranchCell({ status }: { status: ApiCallState<ProjectDashboardStatus> }): ReactNode {
  const branch = status.state === "ready" ? selectedBranch(status.data) : null;
  return (
    <div className="itotori-shell-frame__stat" data-shell-stat="branch">
      <span className="itotori-shell-frame__stat-label">Branch</span>
      <span className="itotori-shell-frame__stat-value">
        {status.state === "loading" && (
          <span className="itotori-shell-frame__pending">loading…</span>
        )}
        {status.state === "error" && (
          <span className="itotori-shell-frame__unavailable">unavailable</span>
        )}
        {status.state === "ready" && (
          <span data-branch-locale={branch?.targetLocale ?? ""}>
            {branch?.targetLocale ?? "none selected"}
          </span>
        )}
      </span>
    </div>
  );
}

function SourceToBranchCell({
  status,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
}): ReactNode {
  const branch = status.state === "ready" ? selectedBranch(status.data) : null;
  const source = status.state === "ready" ? status.data.sourceLocale : null;
  return (
    <div className="itotori-shell-frame__stat" data-shell-stat="source-to-branch">
      <span className="itotori-shell-frame__stat-label">Source → Branch</span>
      <span className="itotori-shell-frame__stat-value">
        {status.state === "loading" && (
          <span className="itotori-shell-frame__pending">loading…</span>
        )}
        {status.state === "error" && (
          <span className="itotori-shell-frame__unavailable">unavailable</span>
        )}
        {status.state === "ready" && (
          <span data-source-to-branch>
            {source} → {branch?.targetLocale ?? "—"}
          </span>
        )}
      </span>
    </div>
  );
}

function LiveCostCell({ cost }: { cost: ApiCallState<ProjectCostReport> }): ReactNode {
  return (
    <div className="itotori-shell-frame__stat" data-shell-stat="cost">
      <span className="itotori-shell-frame__stat-label">Live cost</span>
      <span className="itotori-shell-frame__stat-value itotori-shell-frame__stat-value--mono">
        {cost.state === "loading" && <span className="itotori-shell-frame__pending">loading…</span>}
        {cost.state === "error" && (
          <span className="itotori-shell-frame__unavailable">unavailable</span>
        )}
        {cost.state === "ready" && (
          <span data-live-cost={cost.data.billedMicrosUsd}>
            {formatMicrosUsd(cost.data.billedMicrosUsd)}
          </span>
        )}
      </span>
    </div>
  );
}

function selectedBranch(
  status: ProjectDashboardStatus,
): { localeBranchId: string; targetLocale: string } | null {
  const id = status.selectedLocaleBranchId;
  if (id === null) {
    return null;
  }
  const match = status.localeBranches.find((branch) => branch.localeBranchId === id);
  if (match === undefined) {
    return null;
  }
  return { localeBranchId: match.localeBranchId, targetLocale: match.targetLocale };
}

// ---------------------------------------------------------------------------
// ShellStatusBar — the persistent status bar. Renders the four read-model
// facts (project+branch, source->branch, ZDR posture, live cost), each cell
// settling independently. The bar's overall phase is the worst of its reads
// so a test / observer can read the frame posture at a glance.
// ---------------------------------------------------------------------------

function ShellStatusBar({
  status,
  cost,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
  cost: ApiCallState<ProjectCostReport>;
}): ReactNode {
  const phase = statusBarPhase(status, cost);
  return (
    <div
      className="itotori-shell-frame__statusbar"
      role="status"
      aria-label="Shell status bar"
      data-shell-status={phase}
    >
      <ProjectCell status={status} />
      <BranchCell status={status} />
      <SourceToBranchCell status={status} />
      <ZdrPostureCell cost={cost} />
      <LiveCostCell cost={cost} />
    </div>
  );
}

function statusBarPhase(
  status: ApiCallState<ProjectDashboardStatus>,
  cost: ApiCallState<ProjectCostReport>,
): "loading" | "ready" | "error" {
  if (status.state === "loading" || cost.state === "loading") {
    return "loading";
  }
  if (status.state === "error" || cost.state === "error") {
    return "error";
  }
  return "ready";
}

// ---------------------------------------------------------------------------
// ShellFrame — the public frame. Issues the two status-bar reads THROUGH the
// typed client and renders nav + status bar + the routed screen inside.
// ---------------------------------------------------------------------------

export function ShellFrame({
  location,
  navigate = defaultNavigate,
  children,
}: {
  location: AppLocation;
  navigate?: (path: string) => void;
  children: ReactNode;
}): ReactNode {
  const status = useApiQuery("projects.status", {}, "shell-frame:status");
  const cost = useApiQuery("projects.cost", {}, "shell-frame:cost");
  return (
    <div className="itotori-shell-frame" data-shell-frame="true">
      <header className="itotori-shell-frame__chrome">
        <ShellNav location={location} navigate={navigate} />
        <div className="itotori-shell-toolbar" data-shell-toolbar="true">
          <RedactionToggle />
        </div>
      </header>
      <ShellStatusBar status={status} cost={cost} />
      <div className="itotori-shell-frame__content">{children}</div>
    </div>
  );
}
