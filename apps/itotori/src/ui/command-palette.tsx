// shell-cmdk-palette (HI-FI STUDIO EPIC · Shell) — the ⌘K command palette host.
//
// The connective tissue across every surface: ⌘K / Ctrl+K (or the toolbar
// trigger) opens a palette that jumps to any indexed entity / action. The
// palette itself is the ds `<CommandPalette>` (query-filtered, arrow-key
// navigable, Enter to select, Esc to close); this module is the SHELL host
// that owns open state, sources the index, and routes a selection to a URL
// through the same `navigate` the shell nav uses (a full load, the same
// window.location the shell reads on mount — there is no client router).
//
// INDEX SEAM — the palette is sourced from `PaletteEntry[]`. Today the only
// addressable, always-available targets are the shell SURFACES (the same
// `SHELL_NAV_ITEMS` the nav renders), surfaced as the "surfaces" group. The
// unified palette search index (`shell-cmdk-index-api`) + the addressable-id
// routing scheme (`fnd-addressable-routing`) are not yet implemented; when
// they land, their entries (scenes / characters / terms / runs / findings /
// actions) drop in via the `entries` prop — no host change required. This
// keeps the palette pure UI against a clear seam rather than half-wiring an
// API. See `docs/dev/` + the spec DAG entries for the two dep nodes.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the open / filter / select / navigate behavior is asserted.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { CommandPalette, useCommandPaletteShortcut, type CommandItem } from "@itotori/ds";
import { SHELL_NAV_ITEMS } from "./shell-frame.js";

/**
 * A palette entry is a ds `CommandItem` plus the addressable URL the shell
 * navigates to when the entry is chosen. `href` is the bridge to
 * `fnd-addressable-routing`: today every href is a real surface path; once
 * the routing scheme lands, entity entries carry their stable deep-link href.
 */
export interface PaletteEntry extends CommandItem {
  href: string;
}

/**
 * The always-available palette index: the shell surfaces, as jump actions.
 * Mirrors `SHELL_NAV_ITEMS` (the nav pills) so the palette and the nav never
 * disagree on what surfaces exist. Pure + exported so the index shape is
 * testable without a DOM.
 */
export function shellNavCommandEntries(): readonly PaletteEntry[] {
  return SHELL_NAV_ITEMS.map((item) => ({
    id: `surface:${item.id}`,
    label: item.label,
    group: "surfaces",
    href: item.href,
    keywords: [item.id],
  }));
}

/**
 * Merge multiple palette index sources into one stable list. The order is
 * preserved (callers control precedence); this is the seam the future
 * unified index (`shell-cmdk-index-api`) plugs into — e.g.
 * `mergeCommandEntries(shellNavCommandEntries(), useGlobalIndex())`.
 */
export function mergeCommandEntries(
  ...sources: ReadonlyArray<readonly PaletteEntry[]>
): readonly PaletteEntry[] {
  return sources.flat();
}

/**
 * ShellCommandPalette — mounts the ⌘K palette in the shell frame. Owns the
 * open state, wires the global ⌘K / Ctrl+K shortcut (via the ds hook), and
 * routes a selection through `navigate`. Renders BOTH the toolbar trigger
 * (discoverable + clickable) and the overlay dialog (fixed-position, so its
 * tree location is irrelevant).
 */
export function ShellCommandPalette({
  navigate,
  entries = shellNavCommandEntries(),
}: {
  navigate: (path: string) => void;
  /** Palette index; defaults to the shell-nav surfaces. */
  entries?: readonly PaletteEntry[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);

  // The global ⌘K / Ctrl+K shortcut (the ds hook) — the primary affordance.
  useCommandPaletteShortcut(openPalette);

  // Strip `href` before handing to the ds component (it only renders label /
  // group / hint / keywords). Memoized so the ds filter input is stable.
  const items = useMemo<readonly CommandItem[]>(
    () => entries.map(({ href: _href, ...item }) => item),
    [entries],
  );

  const onSelect = useCallback(
    (item: CommandItem) => {
      const entry = entries.find((candidate) => candidate.id === item.id);
      if (entry !== undefined) {
        navigate(entry.href);
      }
    },
    [entries, navigate],
  );

  return (
    <>
      <button
        type="button"
        className="itotori-command-trigger"
        data-command-trigger="true"
        aria-label="Open command palette"
        aria-keyshortcuts="Control+k Meta+k"
        aria-expanded={open}
        onClick={openPalette}
      >
        <span className="itotori-command-trigger__copy">Jump to…</span>
        <code className="itotori-command-trigger__kbd" aria-hidden="true">
          ⌘K
        </code>
      </button>
      <CommandPalette open={open} onClose={closePalette} items={items} onSelect={onSelect} />
    </>
  );
}
