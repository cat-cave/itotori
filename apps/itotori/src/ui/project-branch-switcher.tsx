// shell-project-branch-switcher (HI-FI STUDIO EPIC · Shell) — the work +
// edition + project + locale-branch switcher.
//
// A disclosure in the shell toolbar that lists the effective work + edition,
// every project the typed client can see, and the effective project's locale
// branches; picking a project/branch switches the shell chrome's context
// (status bar) through the client-side `ShellSelectionProvider`. There is no
// server-side select-project/branch mutation today, so the selection is a
// viewer-local overlay on the workspace's active project.
//
// DATA SOURCE — reachable, typed, no invented surface: the hierarchy comes
// from `projects.list` (`{ projects: ProjectDashboardStatus[] }`), where each
// project already carries its `localeBranches` + `selectedLocaleBranchId`. The
// server selection (which project/branch `projects.status` reports as active)
// is passed in by the shell frame and reconciled with the viewer's override by
// `resolveEffectiveSelection`. No ad-hoc fetch; no new route.
//
// SCOPE — game-agnostic and honestly tiered. The hi-fi hierarchy is
// org → work → edition → project → locale branch. `ProjectDashboardStatus`
// currently has no required catalog work/edition fields, so this switcher
// surfaces Work and Edition as read-only labels derived from the selected
// project's metadata. If a response carries optional catalog-like fields
// (`workTitle`, `workId`, `editionName`, `releaseTitle`, etc.) the adapter uses
// them; otherwise it falls back to existing project metadata. No invented route
// or backend mutation is needed.
//
// [[feedback_behavior_first_code_agnostic_testing]] — the pure builders +
// reconciliation rule are exported so the listing / switch behavior is
// asserted over the real typed read-model shapes without a DOM; the DOM suite
// asserts the rendered disclosure states + the switch driving the chrome.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { LocaleBranchStatus, ProjectDashboardStatus } from "@itotori/db";
import { useApiQuery } from "./use-api-resource.js";
import {
  NO_SHELL_SELECTION,
  useShellSelection,
  type ProjectBranchSelection,
} from "./shell-selection.js";

// ---------------------------------------------------------------------------
// Pure model — typed views over the reachable read-models. Exported so the
// listing + reconciliation behavior is testable without a DOM.
// ---------------------------------------------------------------------------

/** One project the switcher lists. Game-agnostic: only ids + the project name. */
export type SwitcherProject = {
  projectId: string;
  projectKey: string;
  name: string;
};

/** One read-only work / edition label derived from project metadata. */
export type SwitcherLineageItem = {
  lineageId: string;
  label: string;
};

export type SwitcherLineage = {
  work: readonly SwitcherLineageItem[];
  edition: readonly SwitcherLineageItem[];
};

/** One locale branch the switcher lists for the effective project. */
export type SwitcherBranch = {
  localeBranchId: string;
  targetLocale: string;
  status: string;
};

/**
 * Project the switcher lists, in stable input order, from `projects.list`.
 * De-duplicates by `projectId` (keeps the first occurrence) so a repeated row
 * in the read-model never yields a repeated option.
 */
export function buildSwitcherProjects(
  projects: ReadonlyArray<ProjectDashboardStatus>,
): readonly SwitcherProject[] {
  const seen = new Set<string>();
  const out: SwitcherProject[] = [];
  for (const project of projects) {
    if (seen.has(project.projectId)) {
      continue;
    }
    seen.add(project.projectId);
    out.push({
      projectId: project.projectId,
      projectKey: project.projectKey,
      name: project.name,
    });
  }
  return out;
}

/**
 * Read-only Work / Edition labels for the effective project. Optional
 * catalog-like properties are accepted because the wire schema permits
 * additional fields; the fallback uses the stable project metadata available
 * today.
 */
export function deriveSwitcherLineageForProject(
  projects: ReadonlyArray<ProjectDashboardStatus>,
  projectId: string | null,
): SwitcherLineage {
  if (projectId === null) {
    return { work: [], edition: [] };
  }
  const project = projects.find((candidate) => candidate.projectId === projectId);
  if (project === undefined) {
    return { work: [], edition: [] };
  }
  const workId =
    projectStringField(project, ["workId", "catalogWorkId", "catalogRecordId"]) ??
    nestedProjectStringField(project, ["importStatus", "futureReferences", "catalogWorkId"]) ??
    `project:${project.projectId}`;
  const workLabel =
    projectStringField(project, ["workTitle", "workName", "work", "title"]) ?? project.name;
  const editionId =
    projectStringField(project, ["editionId", "releaseId", "catalogReleaseId"]) ??
    project.sourceBundleRevisionId ??
    project.projectKey;
  const editionLabel =
    projectStringField(project, ["editionName", "editionTitle", "edition", "releaseTitle"]) ??
    project.sourceBundleRevisionId ??
    project.projectKey;
  return {
    work: [{ lineageId: workId, label: workLabel }],
    edition: [{ lineageId: editionId, label: editionLabel }],
  };
}

/**
 * Locale branches for one project, in stable input order. Strips nothing the
 * read-model carries — `targetLocale` is the human label, `status` lets the
 * switcher mark a branch that is not `active` if a future design calls for it.
 */
export function buildSwitcherBranches(
  branches: ReadonlyArray<LocaleBranchStatus>,
): readonly SwitcherBranch[] {
  return branches.map((branch) => ({
    localeBranchId: branch.localeBranchId,
    targetLocale: branch.targetLocale,
    status: branch.status,
  }));
}

/**
 * The locale branches offered for a project id, read straight from the
 * `projects.list` hierarchy. Returns `[]` when the project is unknown to the
 * client (e.g. a server selection for a project the viewer cannot read).
 */
export function selectBranchesForProject(
  projects: ReadonlyArray<ProjectDashboardStatus>,
  projectId: string | null,
): readonly SwitcherBranch[] {
  if (projectId === null) {
    return [];
  }
  const project = projects.find((candidate) => candidate.projectId === projectId);
  if (project === undefined) {
    return [];
  }
  return buildSwitcherBranches(project.localeBranches);
}

/**
 * The effective selection: the viewer's override reconciled with the server
 * selection. An override axis (`!== null`) wins; a project override ALSO
 * invalidates the server's selected branch (it belongs to the server's
 * project), so only an explicit branch override survives a project switch.
 * Both axes fall back to the server selection when no override is set.
 */
export function resolveEffectiveSelection(
  server: ProjectBranchSelection,
  override: ProjectBranchSelection,
): ProjectBranchSelection {
  const projectId = override.projectId ?? server.projectId;
  const localeBranchId =
    override.projectId !== null
      ? override.localeBranchId
      : (override.localeBranchId ?? server.localeBranchId);
  return { projectId, localeBranchId };
}

/** The server selection carried by a `projects.status` read-model. */
export function serverSelectionFromStatus(
  status: ProjectDashboardStatus | null,
): ProjectBranchSelection {
  if (status === null) {
    return NO_SHELL_SELECTION;
  }
  return { projectId: status.projectId, localeBranchId: status.selectedLocaleBranchId };
}

function projectStringField(
  project: ProjectDashboardStatus,
  fieldNames: readonly string[],
): string | null {
  const record = project as unknown as Record<string, unknown>;
  for (const fieldName of fieldNames) {
    const value = nonEmptyString(record[fieldName]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function nestedProjectStringField(
  project: ProjectDashboardStatus,
  fieldPath: readonly string[],
): string | null {
  let value: unknown = project;
  for (const fieldName of fieldPath) {
    if (typeof value !== "object" || value === null) {
      return null;
    }
    value = (value as Record<string, unknown>)[fieldName];
  }
  return nonEmptyString(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type ProjectBranchSwitcherProps = {
  /**
   * The server selection (active project + server-selected branch), sourced
   * from `projects.status` by the shell frame. Defaults to no selection so a
   * standalone mount renders without a server read.
   */
  serverSelection?: ProjectBranchSelection;
  /**
   * Override the projects source (tests / partial mounts). When omitted the
   * switcher reads `projects.list` through the typed client.
   */
  projects?: ReadonlyArray<ProjectDashboardStatus>;
  /**
   * Notified with the effective selection after the viewer picks a project or
   * branch. The host may navigate or track the switch; the chrome updates via
   * the `ShellSelectionProvider` regardless.
   */
  onSelect?: (selection: ProjectBranchSelection) => void;
};

export function ProjectBranchSwitcher({
  serverSelection = NO_SHELL_SELECTION,
  projects: projectsProp,
  onSelect,
}: ProjectBranchSwitcherProps): ReactNode {
  const selection = useShellSelection();
  // The connected read. Skipped when an explicit `projects` prop is supplied
  // (a test / partial mount that owns its data).
  const listRead = useApiQuery("projects.list", {}, "project-branch-switcher:projects");
  const projects: ReadonlyArray<ProjectDashboardStatus> =
    projectsProp ?? (listRead.state === "ready" ? listRead.data.projects : []);

  const override = selection?.override ?? NO_SHELL_SELECTION;
  const effective = resolveEffectiveSelection(serverSelection, override);

  const switcherProjects = useMemo(() => buildSwitcherProjects(projects), [projects]);
  const lineage = useMemo(
    () => deriveSwitcherLineageForProject(projects, effective.projectId),
    [projects, effective.projectId],
  );
  const branches = useMemo(
    () => selectBranchesForProject(projects, effective.projectId),
    [projects, effective.projectId],
  );

  const pickProject = useCallback(
    (projectId: string) => {
      selection?.selectProject(projectId);
      const next = resolveEffectiveSelection(serverSelection, {
        projectId,
        localeBranchId: null,
      });
      onSelect?.(next);
    },
    [onSelect, selection, serverSelection],
  );
  const pickBranch = useCallback(
    (localeBranchId: string) => {
      selection?.selectBranch(localeBranchId);
      const next = resolveEffectiveSelection(serverSelection, {
        projectId: override.projectId,
        localeBranchId,
      });
      onSelect?.(next);
    },
    [onSelect, override.projectId, selection, serverSelection],
  );

  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const readPhase =
    projectsProp !== undefined
      ? "ready"
      : listRead.state === "loading"
        ? "loading"
        : listRead.state === "error"
          ? "error"
          : "ready";

  return (
    <div
      className="itotori-switcher"
      data-switcher="project-branch"
      data-switcher-phase={readPhase}
      data-switcher-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className="itotori-switcher__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        data-switcher-trigger="true"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        Project &amp; branch
      </button>
      {open && (
        <div
          className="itotori-switcher__panel"
          role="menu"
          aria-label="Switch project and locale branch"
          data-switcher-panel="true"
        >
          <SwitcherSection
            label="Work"
            dataSection="work"
            isEmpty={lineage.work.length === 0}
            loading={readPhase === "loading"}
            error={readPhase === "error"}
          >
            {lineage.work.map((work) => (
              <SwitcherReadOnlyOption key={work.lineageId} dataId={work.lineageId}>
                {work.label}
              </SwitcherReadOnlyOption>
            ))}
          </SwitcherSection>
          <SwitcherSection
            label="Edition"
            dataSection="edition"
            isEmpty={lineage.edition.length === 0}
            loading={readPhase === "loading"}
            error={readPhase === "error"}
          >
            {lineage.edition.map((edition) => (
              <SwitcherReadOnlyOption key={edition.lineageId} dataId={edition.lineageId}>
                {edition.label}
              </SwitcherReadOnlyOption>
            ))}
          </SwitcherSection>
          <SwitcherSection
            label="Project"
            dataSection="project"
            isEmpty={switcherProjects.length === 0}
            loading={readPhase === "loading"}
            error={readPhase === "error"}
          >
            {switcherProjects.map((project) => {
              const active = project.projectId === effective.projectId;
              return (
                <SwitcherOption
                  key={project.projectId}
                  active={active}
                  dataId={project.projectId}
                  onSelect={() => {
                    pickProject(project.projectId);
                  }}
                >
                  {project.name}
                </SwitcherOption>
              );
            })}
          </SwitcherSection>
          <SwitcherSection
            label="Branch"
            dataSection="branch"
            isEmpty={branches.length === 0}
            loading={false}
            error={false}
          >
            {branches.map((branch) => {
              const active = branch.localeBranchId === effective.localeBranchId;
              return (
                <SwitcherOption
                  key={branch.localeBranchId}
                  active={active}
                  dataId={branch.localeBranchId}
                  onSelect={() => {
                    pickBranch(branch.localeBranchId);
                  }}
                >
                  {branch.targetLocale}
                </SwitcherOption>
              );
            })}
          </SwitcherSection>
          <div className="itotori-switcher__panel-footer">
            <button
              type="button"
              className="itotori-switcher__close"
              data-switcher-close="true"
              onClick={close}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SwitcherSection({
  label,
  dataSection,
  isEmpty,
  loading,
  error,
  children,
}: {
  label: string;
  dataSection: string;
  isEmpty: boolean;
  loading: boolean;
  error: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="itotori-switcher__section" data-switcher-section={dataSection}>
      <p className="itotori-switcher__section-label">{label}</p>
      {loading && <p className="itotori-switcher__pending">Loading…</p>}
      {error && <p className="itotori-switcher__unavailable">Unavailable</p>}
      {!loading && !error && isEmpty && <p className="itotori-switcher__empty">None</p>}
      {!loading && !error && !isEmpty && (
        <div className="itotori-switcher__options" role="group" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

function SwitcherOption({
  active,
  dataId,
  onSelect,
  children,
}: {
  active: boolean;
  dataId: string;
  onSelect: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      aria-current={active ? "true" : undefined}
      className="itotori-switcher__option"
      data-switcher-option-id={dataId}
      data-switcher-option-active={active ? "true" : "false"}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

function SwitcherReadOnlyOption({
  dataId,
  children,
}: {
  dataId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      role="menuitem"
      aria-disabled="true"
      className="itotori-switcher__option"
      data-switcher-option-id={dataId}
      data-switcher-option-readonly="true"
    >
      {children}
    </div>
  );
}
