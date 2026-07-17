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

import { useCallback, useState, type ReactNode } from "react";
import type { ProjectCostReport, ProjectDashboardStatus } from "@itotori/db";
import { Badge, NavPills, type NavPillItem } from "@itotori/ds";
import type { ApiCallState } from "../api-client.js";
import { useApiQuery } from "./use-api-resource.js";
import { formatMicrosUsd } from "./format.js";
import { RedactionToggle } from "./redaction-governor.js";
import { ShellCommandPalette } from "./command-palette.js";
import {
  ProjectBranchSwitcher,
  resolveEffectiveSelection,
  serverSelectionFromStatus,
} from "./project-branch-switcher.js";
import {
  NO_SHELL_SELECTION,
  ShellSelectionProvider,
  useShellSelection,
} from "./shell-selection.js";
import { IdentityOrgSwitcher } from "./identity-org-switcher.js";
import { loadSelectedAccountId, saveSelectedAccountId } from "./shell-account-scope.js";
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
  { id: "onboarding", label: "First run", href: "/onboarding" },
  { id: "play", label: "Play", href: "/play" },
  { id: "wiki", label: "Wiki", href: "/wiki" },
  { id: "benchmark", label: "Benchmark", href: "/benchmark" },
  { id: "catalog", label: "Catalog", href: "/catalog" },
  { id: "members", label: "Members", href: "/members" },
  { id: "settings-privacy", label: "Privacy", href: "/settings/privacy" },
  { id: "settings-model-routing", label: "Model routing", href: "/settings/model-routing" },
  { id: "settings-branch-policy", label: "Branch policy", href: "/settings/branch-policy" },
  {
    id: "settings-translation-scope",
    label: "Translation scope",
    href: "/settings/translation-scope",
  },
];

/** The nav pill id active for a pathname, or "" when no pill matches. */
export function activeShellNavId(pathname: string): string {
  if (pathname === "/") {
    return "workbench";
  }
  if (pathname === "/onboarding") {
    return "onboarding";
  }
  if (pathname === "/play" || pathname.startsWith("/play/")) {
    return "play";
  }
  // wiki-entry-ui — the Wiki entry surface (bare /wiki + character/term
  // deep-links) owns its nav pill.
  if (pathname === "/wiki" || pathname.startsWith("/wiki/")) {
    return "wiki";
  }
  if (pathname === "/benchmark" || pathname.startsWith("/benchmark/")) {
    return "benchmark";
  }
  if (pathname === "/catalog" || pathname.startsWith("/catalog/")) {
    return "catalog";
  }
  if (pathname === "/members" || pathname.startsWith("/members/")) {
    return "members";
  }
  if (pathname === "/settings" || pathname === "/settings/privacy") {
    return "settings-privacy";
  }
  if (pathname === "/settings/model-routing") {
    return "settings-model-routing";
  }
  if (pathname === "/settings/branch-policy") {
    return "settings-branch-policy";
  }
  if (pathname === "/settings/translation-scope") {
    return "settings-translation-scope";
  }
  // fnd-addressable-routing — run / finding deep-links have no nav pill yet
  // (the runtime surface node owns those); leave the chrome unselected rather
  // than mis-highlight workbench.
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

function ProjectCell({
  status,
  name,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
  name: string | null;
}): ReactNode {
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
        {status.state === "ready" && <span data-project-name>{name ?? "unavailable"}</span>}
      </span>
    </div>
  );
}

function BranchCell({
  status,
  targetLocale,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
  targetLocale: string | null;
}): ReactNode {
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
          <span data-branch-locale={targetLocale ?? ""}>{targetLocale ?? "none selected"}</span>
        )}
      </span>
    </div>
  );
}

function SourceToBranchCell({
  status,
  sourceLocale,
  branchTargetLocale,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
  sourceLocale: string | null;
  branchTargetLocale: string | null;
}): ReactNode {
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
            {sourceLocale ?? "—"} → {branchTargetLocale ?? "—"}
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

// ---------------------------------------------------------------------------
// ShellStatusBar — the persistent status bar. Renders the four read-model
// facts (project+branch, source->branch, ZDR posture, live cost), each cell
// settling independently. The bar's overall phase is the worst of its reads
// so a test / observer can read the frame posture at a glance.
//
// The Project / Branch / Source cells render the EFFECTIVE selection (server
// selection reconciled with the shell switcher's client override) so picking
// a project / locale branch in the switcher updates the chrome. The loading /
// error phase of those cells is still driven by the `projects.status` read
// (the project context read), so a failed read degrades only those cells.
// ---------------------------------------------------------------------------

type EffectiveContext = {
  projectName: string | null;
  sourceLocale: string | null;
  branchTargetLocale: string | null;
};

function ShellStatusBar({
  status,
  cost,
  effective,
}: {
  status: ApiCallState<ProjectDashboardStatus>;
  cost: ApiCallState<ProjectCostReport>;
  effective: EffectiveContext;
}): ReactNode {
  const phase = statusBarPhase(status, cost);
  return (
    <div
      className="itotori-shell-frame__statusbar"
      role="status"
      aria-label="Shell status bar"
      data-shell-status={phase}
    >
      <ProjectCell status={status} name={effective.projectName} />
      <BranchCell status={status} targetLocale={effective.branchTargetLocale} />
      <SourceToBranchCell
        status={status}
        sourceLocale={effective.sourceLocale}
        branchTargetLocale={effective.branchTargetLocale}
      />
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
// ShellFrame — the public frame. Issues the status-bar reads THROUGH the
// typed client (`projects.status` + `projects.cost`) and, for the switcher +
// the effective-selection resolution, `projects.list` (each project carries
// its locale branches, so the switcher + the status bar resolve the effective
// project / branch from the one reachable hierarchy). Renders nav + status
// bar + the routed screen inside, wrapped in the shell selection provider the
// switcher drives.
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
  return (
    <ShellSelectionProvider>
      <ShellFrameInner location={location} navigate={navigate}>
        {children}
      </ShellFrameInner>
    </ShellSelectionProvider>
  );
}

function ShellFrameInner({
  location,
  navigate,
  children,
}: {
  location: AppLocation;
  navigate: (path: string) => void;
  children: ReactNode;
}): ReactNode {
  const [selectedAccountId, setSelectedAccountId] = useState(() => loadSelectedAccountId());
  const accountScopeKey = selectedAccountId ?? "default";
  const status = useApiQuery("projects.status", {}, `shell-frame:status:${accountScopeKey}`);
  const cost = useApiQuery("projects.cost", {}, `shell-frame:cost:${accountScopeKey}`);
  const list = useApiQuery("projects.list", {}, `shell-frame:projects:${accountScopeKey}`);
  const shellSel = useShellSelection();
  const selectIdentityOrg = useCallback(
    (selection: { accountId: string | null }) => {
      saveSelectedAccountId(selection.accountId);
      setSelectedAccountId(selection.accountId);
      navigate("/");
    },
    [navigate],
  );

  const serverSelection = serverSelectionFromStatus(status.state === "ready" ? status.data : null);
  const effectiveSelection = resolveEffectiveSelection(
    serverSelection,
    shellSel?.override ?? NO_SHELL_SELECTION,
  );

  // Resolve the effective project (name + source locale + branches) from the
  // `projects.list` hierarchy; fall back to the active `projects.status` row
  // when the list has not settled yet AND the effective project IS the active
  // project (the no-override default — so the bar renders the server values
  // immediately, before the list read resolves).
  const listProjects = list.state === "ready" ? list.data.projects : [];
  const statusProject = status.state === "ready" ? status.data : null;
  const effectiveProject: ProjectDashboardStatus | null =
    effectiveSelection.projectId === null
      ? null
      : (listProjects.find((project) => project.projectId === effectiveSelection.projectId) ??
        (statusProject !== null && statusProject.projectId === effectiveSelection.projectId
          ? statusProject
          : null));
  const effectiveBranch =
    effectiveSelection.localeBranchId === null
      ? null
      : (effectiveProject?.localeBranches.find(
          (branch) => branch.localeBranchId === effectiveSelection.localeBranchId,
        ) ?? null);
  const effective: EffectiveContext = {
    projectName: effectiveProject?.name ?? null,
    sourceLocale: effectiveProject?.sourceLocale ?? null,
    branchTargetLocale: effectiveBranch?.targetLocale ?? null,
  };

  return (
    <div className="itotori-shell-frame" data-shell-frame="true">
      <header className="itotori-shell-frame__chrome">
        <ShellNav location={location} navigate={navigate} />
        <div className="itotori-shell-toolbar" data-shell-toolbar="true">
          <IdentityOrgSwitcher onSelect={selectIdentityOrg} />
          <ProjectBranchSwitcher serverSelection={serverSelection} />
          <ShellCommandPalette navigate={navigate} />
          <RedactionToggle />
        </div>
      </header>
      <ShellStatusBar status={status} cost={cost} effective={effective} />
      <div className="itotori-shell-frame__content">{children}</div>
    </div>
  );
}
