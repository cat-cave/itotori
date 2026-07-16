import { createHash } from "node:crypto";

import { MediaRefSchema, type MediaRef, type WikiObject } from "../contracts/index.js";

// The content-addressed Wiki media index.
//
// A `MediaRef` (defined by the strict WikiObject contract) binds a STABLE
// character / scene / unit / asset subject to a sanitized artifact URI, a
// content hash, a media type, dimensions, and a redaction/permission policy —
// and to NOTHING ELSE. There is no byte field anywhere in this module: the
// index and every resolved handle are reference-only by construction, so a
// copyrighted pixel can never be inlined into the wiki, the index, or a commit.
//
// This module owns three reference-only concerns:
//   1. BUILD — assemble + strictly validate a `MediaRef` from real producer
//      facts (a sanitized artifact URI, a `sha256:` content hash, the media
//      type + dimensions, and the access policy). It never fabricates a hash,
//      URI, or dimension; every field is supplied by the caller from a real
//      Utsushi render/patch report and re-validated through `MediaRefSchema`.
//   2. INDEX — collect refs off wiki objects and key them by subject AND by
//      content hash. Content-addressing is the integrity spine: the same
//      `mediaId` may not bind two divergent hashes, and a subject's media is
//      looked up without ever touching bytes.
//   3. RESOLVE — resolve a ref through the EXISTING sanitized artifact server
//      and the DEFAULT-REDACTED frame surface. A missing artifact, a hash
//      mismatch, or an unauthorized reveal is an EXPLICIT typed error
//      (`MediaResolutionError`) — never a silent pass and never a leaked byte.
//      Redaction is a TOGGLE, default-on: the ref carries the policy and this
//      resolver + the frame rule enforce it.

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/** The stable subject a media ref binds to, derived from the ref kind. */
export type MediaSubject =
  | { kind: "character"; id: string }
  | { kind: "scene"; id: string; unitId?: string }
  | { kind: "asset"; id: string };

/** The subject a media ref binds to (stable across versions of the object). */
export function mediaSubject(ref: MediaRef): MediaSubject {
  switch (ref.kind) {
    case "portrait":
      return { kind: "character", id: ref.characterId };
    case "screenshot":
      return ref.unitId === undefined
        ? { kind: "scene", id: ref.sceneId }
        : { kind: "scene", id: ref.sceneId, unitId: ref.unitId };
    case "cg":
      return { kind: "asset", id: ref.assetId };
  }
}

/** The stable index key for a subject (the finer unit detail is not part of
 * the subject identity — a scene's units all share the scene subject). */
export function mediaSubjectKey(subject: MediaSubject): string {
  return `${subject.kind}:${subject.id}`;
}

// ---------------------------------------------------------------------------
// Sanitized artifact URI
// ---------------------------------------------------------------------------

const ARTIFACT_STORE_PATH = "/artifact-store/";

/**
 * Build the sanitized-artifact-server URL for a portable-relative managed
 * artifact URI (e.g. `artifacts/utsushi/runtime/<run>/screenshots/<id>.png`).
 * The managed URI is portable-relative and scheme-less by construction; the
 * server serves it under `/artifact-store/<encoded-uri>`. This reconciles the
 * portable-relative producer convention with the resolvable-URL the `MediaRef`
 * contract requires, WITHOUT embedding any bytes.
 */
export function sanitizedArtifactUrl(serverBaseUrl: string, managedArtifactUri: string): string {
  const base = serverBaseUrl.endsWith("/") ? serverBaseUrl.slice(0, -1) : serverBaseUrl;
  return `${base}${ARTIFACT_STORE_PATH}${encodeURIComponent(managedArtifactUri)}`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** The access policy a media ref carries (permission is DATA, never a role). */
export type MediaAccessPolicy = {
  redaction: "default-redacted" | "clear";
  permission: "public" | "project-member" | "restricted";
};

/** The real producer facts a media ref is content-addressed from. Every field
 * is supplied from a real Utsushi render/patch report — this module never
 * invents a hash, URI, or dimension. */
export type MediaArtifactFacts = {
  /** A resolvable sanitized-artifact-server URL (see {@link sanitizedArtifactUrl}). */
  artifactUri: string;
  /** The `sha256:<hex>` content hash of the referenced artifact bytes. */
  contentHash: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  dimensions: { width: number; height: number };
  access: MediaAccessPolicy;
};

/** The subject binding for a new media ref, discriminated by media kind. */
export type MediaRefBinding =
  | { kind: "portrait"; mediaId: string; characterId: string }
  | { kind: "screenshot"; mediaId: string; sceneId: string; unitId?: string }
  | { kind: "cg"; mediaId: string; assetId: string };

/**
 * Build a strictly-validated, reference-only `MediaRef` binding a stable
 * subject to a sanitized artifact URI + content hash + type + dimensions +
 * access policy. The result carries no bytes and is re-validated through
 * `MediaRefSchema`, so a malformed hash/URI/dimension fails loud here.
 */
export function buildMediaRef(binding: MediaRefBinding, facts: MediaArtifactFacts): MediaRef {
  const availability = {
    status: "available" as const,
    artifactUri: facts.artifactUri,
    contentHash: facts.contentHash,
    mediaType: facts.mediaType,
    dimensions: facts.dimensions,
    access: facts.access,
  };
  const candidate =
    binding.kind === "portrait"
      ? {
          kind: "portrait" as const,
          mediaId: binding.mediaId,
          characterId: binding.characterId,
          availability,
        }
      : binding.kind === "screenshot"
        ? {
            kind: "screenshot" as const,
            mediaId: binding.mediaId,
            sceneId: binding.sceneId,
            ...(binding.unitId === undefined ? {} : { unitId: binding.unitId }),
            availability,
          }
        : {
            kind: "cg" as const,
            mediaId: binding.mediaId,
            assetId: binding.assetId,
            availability,
          };
  return MediaRefSchema.parse(candidate);
}

/**
 * Fold a resolution failure into an explicit `unavailable` media ref so the
 * unavailable state is recorded on the wiki object rather than dropped. The
 * expected content hash is preserved so a later re-resolution can detect the
 * artifact returning; the bytes are, as everywhere, never present.
 */
export function toUnavailableMediaRef(ref: MediaRef, code: MediaResolutionCode): MediaRef {
  if (ref.availability.status !== "available") {
    return ref;
  }
  const availability = {
    status: "unavailable" as const,
    expectedContentHash: ref.availability.contentHash,
    reason: code,
  };
  const base =
    ref.kind === "portrait"
      ? { kind: "portrait" as const, mediaId: ref.mediaId, characterId: ref.characterId }
      : ref.kind === "screenshot"
        ? {
            kind: "screenshot" as const,
            mediaId: ref.mediaId,
            sceneId: ref.sceneId,
            ...(ref.unitId === undefined ? {} : { unitId: ref.unitId }),
          }
        : { kind: "cg" as const, mediaId: ref.mediaId, assetId: ref.assetId };
  return MediaRefSchema.parse({ ...base, availability });
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/** Every way a media index fails to reconcile into a content-addressed set.
 * Each is fatal — the index never silently keeps a divergent binding. */
export type MediaIndexCode =
  /** One `mediaId` bound two divergent available refs (subject or hash drift). */
  "media-id-conflict";

/** Raised when refs do not reconcile into one content-addressed binding per id. */
export class MediaIndexError extends Error {
  constructor(
    public readonly code: MediaIndexCode,
    public readonly mediaId: string,
    detail: string,
  ) {
    super(`media index refused (${code}) for ${mediaId}: ${detail}`);
    this.name = "MediaIndexError";
  }
}

/** A content-addressed index over media refs: lookup by subject, by media id,
 * and by content hash. Reference-only — it holds refs, never bytes. */
export type MediaIndex = {
  readonly bySubject: ReadonlyMap<string, readonly MediaRef[]>;
  readonly byMediaId: ReadonlyMap<string, MediaRef>;
  readonly byContentHash: ReadonlyMap<string, readonly MediaRef[]>;
};

/** Pull the media refs off a set of wiki objects. */
export function collectMediaRefs(objects: readonly WikiObject[]): MediaRef[] {
  return objects.flatMap((object) => object.media);
}

function bindingSignature(ref: MediaRef): string {
  const subject = mediaSubjectKey(mediaSubject(ref));
  const hash =
    ref.availability.status === "available"
      ? ref.availability.contentHash
      : `unavailable:${ref.availability.reason}:${ref.availability.expectedContentHash}`;
  const unit = ref.kind === "screenshot" && ref.unitId !== undefined ? ref.unitId : "";
  return `${ref.kind}|${subject}|${unit}|${hash}`;
}

/**
 * Build the content-addressed media index. A repeated `mediaId` is allowed only
 * when it binds byte-for-byte the same subject + content hash (idempotent
 * collection across objects); any divergence is a `media-id-conflict`.
 */
export function buildMediaIndex(refs: readonly MediaRef[]): MediaIndex {
  const byMediaId = new Map<string, MediaRef>();
  const signatures = new Map<string, string>();
  const bySubject = new Map<string, MediaRef[]>();
  const byContentHash = new Map<string, MediaRef[]>();

  for (const ref of refs) {
    const signature = bindingSignature(ref);
    const priorSignature = signatures.get(ref.mediaId);
    if (priorSignature !== undefined) {
      if (priorSignature !== signature) {
        throw new MediaIndexError(
          "media-id-conflict",
          ref.mediaId,
          `${priorSignature} vs ${signature}`,
        );
      }
      continue;
    }
    signatures.set(ref.mediaId, signature);
    byMediaId.set(ref.mediaId, ref);

    const subjectKey = mediaSubjectKey(mediaSubject(ref));
    const subjectBucket = bySubject.get(subjectKey);
    if (subjectBucket === undefined) {
      bySubject.set(subjectKey, [ref]);
    } else {
      subjectBucket.push(ref);
    }

    if (ref.availability.status === "available") {
      const hash = ref.availability.contentHash;
      const hashBucket = byContentHash.get(hash);
      if (hashBucket === undefined) {
        byContentHash.set(hash, [ref]);
      } else {
        hashBucket.push(ref);
      }
    }
  }

  return { bySubject, byMediaId, byContentHash };
}

/** The media bound to a subject (empty when the subject has no media). */
export function mediaForSubject(index: MediaIndex, subject: MediaSubject): readonly MediaRef[] {
  return index.bySubject.get(mediaSubjectKey(subject)) ?? [];
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/** The explicit failure reasons a resolution can raise — identical to the
 * `unavailable` reasons the media contract already types. */
export type MediaResolutionCode = "missing" | "hash-mismatch" | "unauthorized-reveal";

/** Raised when a media ref cannot be resolved to a served, hash-matched,
 * authorized frame. Never a silent pass, never a leaked byte. */
export class MediaResolutionError extends Error {
  constructor(
    public readonly code: MediaResolutionCode,
    public readonly mediaId: string,
    detail: string,
  ) {
    super(`media resolution refused (${code}) for ${mediaId}: ${detail}`);
    this.name = "MediaResolutionError";
  }
}

/** Fetches the bytes for a sanitized artifact URI from the artifact server.
 * Returns `null` when the artifact is absent (a 404 / missing file). */
export type MediaArtifactFetcher = (artifactUri: string) => Promise<Uint8Array | null>;

/** The viewer's reveal grant — DATA, permission-not-role. `heldPermission` is
 * the media-local tier the viewer holds; `revealSensitive` is the cap that
 * unblurs a default-redacted frame; `revealIntent` is the viewer asking for a
 * CLEAR (unblurred) frame; `shareRedaction` (share/export mode) forces
 * redaction regardless of the cap. */
export type MediaRevealGrant = {
  heldPermission: "public" | "project-member" | "restricted" | null;
  revealSensitive: boolean;
  revealIntent: boolean;
  shareRedaction: boolean;
};

/** A resolved, reference-only frame handle. It carries the redaction verdict
 * and the served URI for the frame surface to render — never any bytes. */
export type ResolvedMediaFrame = {
  mediaId: string;
  subject: MediaSubject;
  artifactUri: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  dimensions: { width: number; height: number };
  /** Whether the frame surface must render this frame redacted (blurred). */
  redacted: boolean;
};

const PERMISSION_RANK: Record<"public" | "project-member" | "restricted", number> = {
  public: 0,
  "project-member": 1,
  restricted: 2,
};

function permissionSatisfied(
  required: "public" | "project-member" | "restricted",
  held: MediaRevealGrant["heldPermission"],
): boolean {
  if (held === null) {
    return required === "public";
  }
  return PERMISSION_RANK[held] >= PERMISSION_RANK[required];
}

async function sha256Ref(bytes: Uint8Array): Promise<string> {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The pure redaction predicate. Mirrors `shouldRedactFrame`
 * (`packages/itotori-ds/.../RedactionFrame.tsx`) exactly: a sensitive frame is
 * redacted unless the viewer can reveal AND we are not in share/export mode,
 * and share mode always wins. Backend media resolution must not depend on the
 * UI component library, so the rule is mirrored here — the same way the shell
 * redaction governor and the Rust render emit boundary mirror it.
 */
function frameRedacted(input: {
  sensitive: boolean;
  canReveal: boolean;
  shareRedaction: boolean;
}): boolean {
  if (!input.sensitive) return false;
  return !input.canReveal || input.shareRedaction;
}

/**
 * Resolve a media ref through the sanitized artifact server + the
 * default-redacted frame surface. Order enforces "fail loud, never leak":
 *   1. an already-`unavailable` ref surfaces its recorded reason;
 *   2. an insufficient permission tier is `unauthorized-reveal` (before any
 *      fetch — a restricted artifact is never even retrieved unauthorized);
 *   3. a missing artifact is `missing`;
 *   4. a served-byte hash that differs from the ref is `hash-mismatch`;
 *   5. a CLEAR reveal of a default-redacted frame without the cap (or in
 *      share/export mode) is `unauthorized-reveal` — the clear frame is never
 *      returned;
 *   6. otherwise a reference-only handle carrying the redaction verdict from
 *      the shared `shouldRedactFrame` rule.
 */
export async function resolveMediaRef(
  ref: MediaRef,
  context: { fetchArtifactBytes: MediaArtifactFetcher; grant: MediaRevealGrant },
): Promise<ResolvedMediaFrame> {
  const subject = mediaSubject(ref);
  if (ref.availability.status === "unavailable") {
    throw new MediaResolutionError(
      ref.availability.reason,
      ref.mediaId,
      `ref is recorded unavailable (${ref.availability.reason})`,
    );
  }

  const { artifactUri, contentHash, mediaType, dimensions, access } = ref.availability;
  const { grant } = context;

  if (!permissionSatisfied(access.permission, grant.heldPermission)) {
    throw new MediaResolutionError(
      "unauthorized-reveal",
      ref.mediaId,
      `viewer permission ${grant.heldPermission ?? "none"} < required ${access.permission}`,
    );
  }

  const bytes = await context.fetchArtifactBytes(artifactUri);
  if (bytes === null) {
    throw new MediaResolutionError("missing", ref.mediaId, `no artifact at ${artifactUri}`);
  }

  const servedHash = await sha256Ref(bytes);
  if (servedHash !== contentHash) {
    throw new MediaResolutionError(
      "hash-mismatch",
      ref.mediaId,
      `served ${servedHash} != expected ${contentHash}`,
    );
  }

  const sensitive = access.redaction === "default-redacted";
  const entitledToReveal = grant.revealSensitive && !grant.shareRedaction;
  if (grant.revealIntent && sensitive && !entitledToReveal) {
    throw new MediaResolutionError(
      "unauthorized-reveal",
      ref.mediaId,
      grant.shareRedaction
        ? "clear reveal refused in share/export mode"
        : "clear reveal refused without revealSensitive capability",
    );
  }

  const canReveal = sensitive && grant.revealIntent && entitledToReveal;
  const redacted = frameRedacted({
    sensitive,
    canReveal,
    shareRedaction: grant.shareRedaction,
  });

  return { mediaId: ref.mediaId, subject, artifactUri, mediaType, dimensions, redacted };
}

/**
 * The default sanitized-artifact-server fetcher: an HTTP GET against the
 * running artifact server. A 404 is `null` (missing); any other non-2xx is a
 * hard failure. Returns bytes only — the caller content-addresses them.
 */
export async function httpArtifactFetcher(artifactUri: string): Promise<Uint8Array | null> {
  const response = await fetch(artifactUri);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`artifact server returned ${response.status} for ${artifactUri}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
