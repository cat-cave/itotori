// shell-project-branch-switcher (HI-FI STUDIO EPIC · Shell) — the CLIENT-SIDE
// project + locale-branch selection the shell switcher drives.
//
// The hi-fi studio store (`docs/design/hifi/studio/store.jsx`) models the
// switcher as CLIENT state: `setProjectId` / `setBranch` select which project +
// locale branch the shell chrome is scoped to. The real Studio has no
// server-side "select project/branch" mutation today (the server's
// `projects.status` returns the workspace's active project + a server-derived
// `selectedLocaleBranchId`); so — exactly as the mockup does — the SPA holds
// the viewer's selection here and overlays it on the server selection to drive
// the chrome (status bar) + the switcher's "current" marker.
//
// This is a pure React context: it holds the viewer's OVERRIDE selection and
// exposes typed mutators. The EFFECTIVE selection (server selection reconciled
// with this override) is computed by `resolveEffectiveSelection` in the
// switcher module so the reconciliation rule is one named, testable function.
//
// Game-agnostic: no title is baked in — only the opaque ids the typed
// read-models carry (`projectId` / `localeBranchId`) are selected here. The
// switcher renders Work / Edition as read-only labels derived from project
// metadata, so this selection seam stays project + branch scoped until a real
// catalog-selection API exists.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Selection shape — opaque ids the typed read-models carry. `null` on either
// axis means "no value" (the server read had none, or no override was set).
// ---------------------------------------------------------------------------

export type ProjectBranchSelection = {
  projectId: string | null;
  localeBranchId: string | null;
};

export type ShellSelectionContextValue = {
  /** The viewer's override selection (null axes mean "no override"). */
  override: ProjectBranchSelection;
  /** Select a project; resets any branch override (the new project's branches differ). */
  selectProject: (projectId: string) => void;
  /** Select a locale branch within the effective project. */
  selectBranch: (localeBranchId: string) => void;
  /** Clear the override so the chrome falls back to the server selection. */
  clear: () => void;
};

const ShellSelectionContext = createContext<ShellSelectionContextValue | null>(null);

export const NO_SHELL_SELECTION: ProjectBranchSelection = { projectId: null, localeBranchId: null };

export type ShellSelectionProviderProps = {
  /**
   * Initial override (tests / deep-links). Defaults to no override so the
   * chrome starts on the server selection.
   */
  initial?: ProjectBranchSelection;
  children: ReactNode;
};

export function ShellSelectionProvider({
  initial,
  children,
}: ShellSelectionProviderProps): ReactNode {
  const [override, setOverride] = useState<ProjectBranchSelection>(
    () => initial ?? NO_SHELL_SELECTION,
  );
  const selectProject = useCallback((projectId: string) => {
    // Switching project resets the branch override: a branch id from the prior
    // project is not valid under the new project, so drop it and let the
    // effective selection fall back to the new project's server-selected branch.
    setOverride({ projectId, localeBranchId: null });
  }, []);
  const selectBranch = useCallback((localeBranchId: string) => {
    setOverride((prev) => ({ projectId: prev.projectId, localeBranchId }));
  }, []);
  const clear = useCallback(() => {
    setOverride(NO_SHELL_SELECTION);
  }, []);
  const value = useMemo<ShellSelectionContextValue>(
    () => ({ override, selectProject, selectBranch, clear }),
    [override, selectProject, selectBranch, clear],
  );
  return <ShellSelectionContext.Provider value={value}>{children}</ShellSelectionContext.Provider>;
}

/**
 * Read the shell selection context. Returns `null` OUTSIDE a provider so a
 * consumer can fall back to the server selection without throwing (e.g. the
 * switcher mounted standalone in a test, or a status-bar cell rendered before
 * the provider is wired).
 */
export function useShellSelection(): ShellSelectionContextValue | null {
  return useContext(ShellSelectionContext);
}
