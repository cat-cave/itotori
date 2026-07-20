// fnd-addressable-routing — stable URL scheme for Studio addressable entities.
//
// Every entity the loop spine / cmdk / cross-surface jumps touch
// (unit / scene / route / character / term / run / finding) has ONE stable
// URL. A deep-link parses to a typed target (kind + id + surface + focus),
// and the SPA resolves + focuses it. Surfaces that do not yet own a full
// screen still resolve (AddressableFocusScreen) so the backbone is usable
// before wiki/runtime full UIs land.
//
// Path shapes (game-agnostic; ids are opaque, URL-encoded):
//   unit      → /play/units/:unitId
//   scene     → /play/scenes/:sceneId
//   route     → /play/routes/:routeId
//   character → /wiki/characters/:characterId
//   term      → /wiki/terms/:termId
//   run       → /runs/:runId
//   finding   → /findings/:findingId
//
// Optional scope query: projectId, localeBranchId.
// Optional nested focus on a scene: ?unit=:unitId.
//
// Ref form (cmdk / index): "unit:<id>", "scene:<id>", … and the mockup's
// "bridge-unit:<id>" alias for units. [[feedback_behavior_first_code_agnostic_testing]].

// ---------------------------------------------------------------------------
// Kinds + surfaces
// ---------------------------------------------------------------------------

/** Closed set of addressable entity kinds. */
export const ADDRESSABLE_KINDS = [
  "unit",
  "scene",
  "route",
  "character",
  "term",
  "run",
  "finding",
] as const;

export type AddressableKind = (typeof ADDRESSABLE_KINDS)[number];

/** Studio surface a deep-link lands on. */
export type AddressableSurface = "play" | "runtime" | "wiki" | "workbench";

/** Default surface each kind resolves to. */
export const ADDRESSABLE_DEFAULT_SURFACE: Readonly<Record<AddressableKind, AddressableSurface>> = {
  unit: "play",
  scene: "play",
  route: "play",
  character: "wiki",
  term: "wiki",
  run: "runtime",
  finding: "runtime",
};

// ---------------------------------------------------------------------------
// Target + resolved deep-link
// ---------------------------------------------------------------------------

/** Input for building a stable URL (cmdk / jump links). */
export type AddressableTarget = {
  kind: AddressableKind;
  id: string;
  /** Optional project scope (forwarded as query). */
  projectId?: string | null;
  /** Optional locale-branch scope (forwarded as query). */
  localeBranchId?: string | null;
  /**
   * Nested unit focus when targeting a scene (scene URL + `?unit=`).
   * Ignored for non-scene kinds.
   */
  unitId?: string | null;
};

/**
 * A parsed deep-link: the entity, the surface it lands on, the path/search
 * to re-emit, and the focus token screens stamp onto the DOM.
 */
export type AddressableLocation = {
  kind: AddressableKind;
  id: string;
  surface: AddressableSurface;
  /** Canonical pathname (no query). */
  pathname: string;
  /** Canonical search string including leading `?`, or empty. */
  search: string;
  projectId: string | null;
  localeBranchId: string | null;
  /** Nested unit focus for scene deep-links; null otherwise. */
  unitId: string | null;
  /** Focus token screens put on `data-addressable-focus`. */
  focus: { kind: AddressableKind; id: string };
};

// ---------------------------------------------------------------------------
// Path builders — one stable shape per kind
// ---------------------------------------------------------------------------

/**
 * Pathname for an addressable target (no query). IDs are encodeURIComponent'd
 * so opaque tokens (including `bridge-unit:…` forms) survive the URL.
 */
export function addressablePathname(target: Pick<AddressableTarget, "kind" | "id">): string {
  const id = requireNonEmptyId(target.id, target.kind);
  const encoded = encodeURIComponent(id);
  switch (target.kind) {
    case "unit":
      return `/play/units/${encoded}`;
    case "scene":
      return `/play/scenes/${encoded}`;
    case "route":
      return `/play/routes/${encoded}`;
    case "character":
      return `/wiki/characters/${encoded}`;
    case "term":
      return `/wiki/terms/${encoded}`;
    case "run":
      return `/runs/${encoded}`;
    case "finding":
      return `/findings/${encoded}`;
  }
}

/**
 * Build the stable URL (pathname + optional scope / nested-unit query) for
 * an addressable entity. Round-trips with `parseAddressableLocation`.
 */
export function hrefForAddressable(target: AddressableTarget): string {
  const pathname = addressablePathname(target);
  const params = new URLSearchParams();
  const projectId = nonEmpty(target.projectId ?? null);
  const localeBranchId = nonEmpty(target.localeBranchId ?? null);
  if (projectId !== null) {
    params.set("projectId", projectId);
  }
  if (localeBranchId !== null) {
    params.set("localeBranchId", localeBranchId);
  }
  if (target.kind === "scene") {
    const unitId = nonEmpty(target.unitId ?? null);
    if (unitId !== null) {
      params.set("unit", unitId);
    }
  }
  const query = params.toString();
  return query.length === 0 ? pathname : `${pathname}?${query}`;
}

// ---------------------------------------------------------------------------
// Parse — pathname + search → AddressableLocation | null
// ---------------------------------------------------------------------------

const PLAY_UNIT_RE = /^\/play\/units\/([^/]+)\/?$/u;
const PLAY_SCENE_RE = /^\/play\/scenes\/([^/]+)\/?$/u;
const PLAY_ROUTE_RE = /^\/play\/routes\/([^/]+)\/?$/u;
const WIKI_CHARACTER_RE = /^\/wiki\/characters\/([^/]+)\/?$/u;
const WIKI_TERM_RE = /^\/wiki\/terms\/([^/]+)\/?$/u;
const RUN_RE = /^\/runs\/([^/]+)\/?$/u;
const FINDING_RE = /^\/findings\/([^/]+)\/?$/u;

/**
 * Parse a client location into an addressable deep-link. Returns `null` when
 * the path is not an addressable entity URL (bare `/play`, `/wiki`, etc. are
 * surface roots, not entity deep-links — they stay with their screen parsers).
 */
export function parseAddressableLocation(
  pathname: string,
  search = "",
): AddressableLocation | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const projectId = nonEmpty(params.get("projectId"));
  const localeBranchId = nonEmpty(params.get("localeBranchId"));
  const unitQuery = nonEmpty(params.get("unit"));
  // Citation → player deep-links may carry a return path to the addressed wiki
  // object; preserve it so play flags / edit / feedback can close the loop.
  const returnTo = nonEmpty(params.get("returnTo"));

  const matchers: ReadonlyArray<{
    re: RegExp;
    kind: AddressableKind;
  }> = [
    { re: PLAY_UNIT_RE, kind: "unit" },
    { re: PLAY_SCENE_RE, kind: "scene" },
    { re: PLAY_ROUTE_RE, kind: "route" },
    { re: WIKI_CHARACTER_RE, kind: "character" },
    { re: WIKI_TERM_RE, kind: "term" },
    { re: RUN_RE, kind: "run" },
    { re: FINDING_RE, kind: "finding" },
  ];

  for (const { re, kind } of matchers) {
    const match = re.exec(pathname);
    if (match === null) {
      continue;
    }
    const raw = match[1];
    if (raw === undefined) {
      return null;
    }
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (id.trim().length === 0) {
      return null;
    }
    const unitId = kind === "scene" ? unitQuery : kind === "unit" ? id : null;
    const surface = ADDRESSABLE_DEFAULT_SURFACE[kind];
    const focusKind: AddressableKind = kind === "scene" && unitId !== null ? "unit" : kind;
    const focusId = kind === "scene" && unitId !== null ? unitId : id;
    const target: AddressableTarget = {
      kind,
      id,
      projectId,
      localeBranchId,
      unitId: kind === "scene" ? unitId : null,
    };
    const href = hrefForAddressable(target);
    const qIndex = href.indexOf("?");
    const pathnameOut = qIndex === -1 ? href : href.slice(0, qIndex);
    const baseSearch = qIndex === -1 ? "" : href.slice(qIndex + 1);
    const searchOut = withReturnTo(baseSearch, returnTo);
    return {
      kind,
      id,
      surface,
      pathname: pathnameOut,
      search: searchOut,
      projectId,
      localeBranchId,
      unitId: kind === "scene" ? unitId : kind === "unit" ? id : null,
      focus: { kind: focusKind, id: focusId },
    };
  }
  return null;
}

/**
 * Whether a pathname is an addressable deep-link (or a known addressable
 * surface root that the Studio SPA must serve). Used by the HTTP server SPA
 * fallback so deep-links resolve without a prior client navigation.
 */
export function isAddressableSpaPath(pathname: string): boolean {
  if (pathname === "/play" || pathname.startsWith("/play/")) {
    return true;
  }
  if (pathname === "/wiki" || pathname.startsWith("/wiki/")) {
    return true;
  }
  if (pathname === "/benchmark" || pathname.startsWith("/benchmark/")) {
    return true;
  }
  if (pathname === "/findings" || pathname.startsWith("/findings/")) {
    return true;
  }
  if (pathname === "/runs" || pathname.startsWith("/runs/")) {
    return true;
  }
  return parseAddressableLocation(pathname) !== null;
}

// ---------------------------------------------------------------------------
// Opaque ref form — "kind:id" / "bridge-unit:…" for cmdk + indexes
// ---------------------------------------------------------------------------

/**
 * Encode an addressable target as a compact ref string (`unit:<id>`).
 * Units may also be written as `bridge-unit:<id>` (mockup vocabulary); both
 * parse back to kind `unit`.
 */
export function formatAddressableRef(target: Pick<AddressableTarget, "kind" | "id">): string {
  const id = requireNonEmptyId(target.id, target.kind);
  return `${target.kind}:${id}`;
}

/**
 * Parse a compact ref (`unit:<id>`, `bridge-unit:<id>`, …) into a target.
 * Returns `null` when the prefix is not a known kind (or the bridge-unit
 * alias) or the id is empty.
 */
export function parseAddressableRef(ref: string): { kind: AddressableKind; id: string } | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // bridge-unit:<rest> — mockup / bridge vocabulary aliases kind "unit".
  if (trimmed.startsWith("bridge-unit:")) {
    const id = trimmed.slice("bridge-unit:".length).trim();
    return id.length === 0 ? null : { kind: "unit", id: trimmed };
  }
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }
  const kindRaw = trimmed.slice(0, separator);
  const id = trimmed.slice(separator + 1).trim();
  if (id.length === 0 || !isAddressableKind(kindRaw)) {
    return null;
  }
  return { kind: kindRaw, id };
}

/**
 * Resolve a compact ref to a stable href (optional scope). Returns `null`
 * when the ref is not addressable.
 */
export function hrefForAddressableRef(
  ref: string,
  scope: { projectId?: string | null; localeBranchId?: string | null } = {},
): string | null {
  const parsed = parseAddressableRef(ref);
  if (parsed === null) {
    return null;
  }
  return hrefForAddressable({
    kind: parsed.kind,
    id: parsed.id,
    projectId: scope.projectId ?? null,
    localeBranchId: scope.localeBranchId ?? null,
  });
}

export function isAddressableKind(value: string): value is AddressableKind {
  return (ADDRESSABLE_KINDS as readonly string[]).includes(value);
}

/** DOM focus token: `${kind}:${id}` — stamped as `data-addressable-focus`. */
export function addressableFocusToken(focus: { kind: AddressableKind; id: string }): string {
  return `${focus.kind}:${focus.id}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireNonEmptyId(id: string, kind: AddressableKind): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new Error(`addressable ${kind} id must be non-empty`);
  }
  return trimmed;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Merge a preserved `returnTo` query into a canonical addressable search. */
function withReturnTo(baseSearch: string, returnTo: string | null): string {
  if (returnTo === null) {
    return baseSearch.length === 0 ? "" : `?${baseSearch}`;
  }
  const params = new URLSearchParams(baseSearch);
  params.set("returnTo", returnTo);
  return `?${params.toString()}`;
}
