// Safe same-app return destinations used by cross-surface loops. A `returnTo`
// value is navigation state, not an external redirect: accepting only an
// absolute path keeps a citation -> player -> correction round-trip in Studio.

/**
 * Extract a same-origin return path from a query string.
 *
 * `URLSearchParams.get` decodes exactly once, so callers must pass the raw
 * search and must not decode the result again.
 */
export function parseReturnTo(search: string): string | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(
    "returnTo",
  );
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  // Same-app absolute path only — never a scheme-relative or absolute URL.
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return null;
  }
  return raw;
}
