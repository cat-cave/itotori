// The shell's addressable surfaces — ONE list, consumed by the nav pills, the
// command palette, and the HTTP server's SPA fallback.
//
// Why this module exists. The nav pills navigate with a real
// `window.location.assign(href)`, so every href is a FULL PAGE LOAD the server
// has to answer with the SPA document. The server kept its own hand-written
// list of SPA paths, and it had drifted: seven of the eleven nav pills
// (`/onboarding`, `/catalog`, `/members`, and the four `/settings/*` screens)
// were absent from it, so clicking them returned a plain-text `not found`.
// Nothing failed in the SPA — the screen existed, was routed, and was tested;
// it was simply unreachable by its own nav.
//
// Keeping the list here means the cost of adding surface number twelve is one
// entry: the pill, the palette command, and the server fallback all follow.
// React lives in `shell-frame.tsx`; this module stays dependency-free so the
// node server can import it.

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

/**
 * Deep-link roots the SPA owns beyond the nav pills: entity addresses
 * (`/bible/…`, `/runs/…`, `/findings/…`) and the per-surface sub-routes the nav
 * pill only points at the root of. `/runtime/*` is deliberately absent — that
 * path belongs to the runtime-web dashboard document, not this SPA.
 */
export const SHELL_DEEP_LINK_ROOTS: readonly string[] = ["/bible", "/runs", "/findings"];

/**
 * True when the SPA document must answer this path. Every nav href and every
 * deep-link root matches, exactly or as a `/`-delimited prefix, so a sub-route
 * (`/settings/privacy`, `/play/units/unit-1`) resolves without its own entry.
 */
export function isShellNavPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  for (const root of [...SHELL_NAV_ITEMS.map((item) => item.href), ...SHELL_DEEP_LINK_ROOTS]) {
    if (root === "/") {
      continue;
    }
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return true;
    }
  }
  return normalized === "/";
}
