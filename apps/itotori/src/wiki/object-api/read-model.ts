// The typed read models the wiki object API exposes. Every field is derived
// from the trusted substrate: a persisted wiki-version record and the strict
// contract object decrypted from it. Route scope, citations, media, and the
// provisional/context/run badges are surfaced exactly as they were persisted —
// nothing here trusts a caller-declared value.

import {
  LocalizedRenderingSchema,
  WikiObjectSchema,
  type EntityRef,
  type LocalizedRendering,
  type MediaRef,
  type WikiObject,
} from "../../contracts/index.js";
import type { LlmWikiKind, LlmWikiObjectRecord } from "@itotori/db";

/** The parsed contract object a record projects to: a source/translation
 * WikiObject, or a per-target localized (bible) rendering. */
export type ParsedWikiRecord =
  | { readonly form: "object"; readonly object: WikiObject }
  | { readonly form: "rendering"; readonly rendering: LocalizedRendering };

/** The route scope a wiki object or rendering is visible under. */
export type WikiRouteScope = WikiObject["scope"];

/** The provisional / context / run badges a viewer reads off an object. */
export interface WikiBadges {
  readonly provisional: boolean;
  readonly contextScope: string | null;
  readonly runMode: string;
  readonly editedBy: "human" | "enhancement" | "agent" | null;
}

/** One flattened citation: the claim it supports plus the same-snapshot evidence
 * it resolves against. Surfaced verbatim from the object's claims. */
export interface WikiCitationView {
  readonly claimId: string;
  readonly evidenceId: string;
  readonly evidenceHash: string;
  readonly snapshotId: string;
  readonly subject: EntityRef;
  readonly role: "establishes" | "supports" | "contradicts" | "first-mention" | "reveal";
  readonly playOrderIndex: number;
  /** The exact source span a citation quotes, when the claim recorded one. */
  readonly quotedSpan: string | null;
}

/** One claim view: its statement, the route scope it holds under (canonical vs
 * route-specific), and the citations that witness it. The scope is surfaced
 * VERBATIM so a route toggle can hide a claim whose route is not active — the
 * scope is the enforcement key, never a cosmetic label. */
export interface WikiClaimView {
  readonly claimId: string;
  readonly statement: string;
  readonly scope: WikiRouteScope;
  readonly kind: WikiObject["claims"][number]["kind"];
  readonly confidence: "low" | "medium" | "high";
  readonly supersedesClaimId: string | null;
  readonly citations: readonly WikiCitationView[];
}

/** One immutable history entry: a persisted version never mutates, so this chain
 * is the append-only lineage of the object. */
export interface WikiHistoryEntry {
  readonly version: number;
  readonly supersedesVersion: number | null;
  readonly contentHash: string;
  readonly editedBy: string | null;
  readonly provisional: boolean;
  readonly createdAt: string;
}

/** A source WikiObject view: its category, subject, route scope, citations,
 * media, and badges. */
export interface WikiSourceObjectView {
  readonly kind: "source";
  readonly objectId: string;
  readonly wikiKind: LlmWikiKind;
  readonly category: string;
  readonly version: number;
  readonly lang: string;
  readonly subject: EntityRef;
  readonly routeScope: WikiRouteScope;
  readonly badges: WikiBadges;
  readonly claims: readonly WikiClaimView[];
  readonly citations: readonly WikiCitationView[];
  readonly media: readonly MediaRef[];
}

/** A per-target bible rendering view: the source it localizes, its target
 * language, route scope, claim renderings, and badges. */
export interface WikiRenderingView {
  readonly kind: "rendering";
  readonly renderingId: string;
  readonly sourceObjectId: string;
  readonly category: string;
  readonly version: number;
  readonly targetLanguage: string;
  readonly routeScope: WikiRouteScope;
  readonly badges: WikiBadges;
  readonly claimRenderings: readonly { readonly claimId: string; readonly text: string }[];
}

export type WikiObjectView = WikiSourceObjectView | WikiRenderingView;

/** Parse a record's decrypted body through the strict contract that matches its
 * kind. A source/translation object parses as a WikiObject; a rendering parses
 * as a LocalizedRendering. A tampered body fails loud here. */
export function parseRecord(record: LlmWikiObjectRecord): ParsedWikiRecord {
  const candidate: unknown = JSON.parse(record.objectJson);
  if (record.wikiKind === "localized-rendering") {
    return { form: "rendering", rendering: LocalizedRenderingSchema.parse(candidate) };
  }
  return { form: "object", object: WikiObjectSchema.parse(candidate) };
}

/** Build the typed view of one record. */
export function toView(record: LlmWikiObjectRecord): WikiObjectView {
  const parsed = parseRecord(record);
  if (parsed.form === "rendering") return renderingView(record, parsed.rendering);
  return sourceView(record, parsed.object);
}

function sourceView(record: LlmWikiObjectRecord, object: WikiObject): WikiSourceObjectView {
  return {
    kind: "source",
    objectId: object.objectId,
    wikiKind: record.wikiKind,
    category: object.kind,
    version: object.version,
    lang: object.lang,
    subject: object.subject,
    routeScope: object.scope,
    badges: {
      provisional: object.provisional,
      contextScope: object.provenance.contextScope,
      runMode: object.provenance.runMode,
      editedBy: object.provenance.editedBy ?? null,
    },
    claims: object.claims.map(claimView),
    citations: flattenCitations(object),
    media: object.media,
  };
}

function claimView(claim: WikiObject["claims"][number]): WikiClaimView {
  return {
    claimId: claim.claimId,
    statement: claim.statement,
    scope: claim.scope,
    kind: claim.kind,
    confidence: claim.confidence,
    supersedesClaimId: claim.supersedesClaimId ?? null,
    citations: claim.citations.map((citation) => ({
      claimId: claim.claimId,
      evidenceId: citation.evidenceId,
      evidenceHash: citation.evidenceHash,
      snapshotId: citation.snapshotId,
      subject: citation.subject,
      role: citation.role,
      playOrderIndex: citation.playOrderIndex,
      quotedSpan: citation.quotedSpan ?? null,
    })),
  };
}

function renderingView(
  record: LlmWikiObjectRecord,
  rendering: LocalizedRendering,
): WikiRenderingView {
  return {
    kind: "rendering",
    renderingId: rendering.renderingId,
    sourceObjectId: rendering.sourceObjectId,
    category: rendering.sourceObjectKind,
    version: rendering.version,
    targetLanguage: rendering.targetLanguage,
    routeScope: rendering.scope,
    badges: {
      provisional: rendering.provisional,
      contextScope: null,
      runMode: rendering.provenance.runMode,
      editedBy: rendering.provenance.editedBy ?? null,
    },
    claimRenderings: rendering.claimRenderings.map((claim) => ({
      claimId: claim.claimId,
      text: claim.text,
    })),
  };
}

function flattenCitations(object: WikiObject): WikiCitationView[] {
  const citations: WikiCitationView[] = [];
  for (const claim of object.claims) {
    for (const citation of claim.citations) {
      citations.push({
        claimId: claim.claimId,
        evidenceId: citation.evidenceId,
        evidenceHash: citation.evidenceHash,
        snapshotId: citation.snapshotId,
        subject: citation.subject,
        role: citation.role,
        playOrderIndex: citation.playOrderIndex,
        quotedSpan: citation.quotedSpan ?? null,
      });
    }
  }
  return citations;
}

/** Build the immutable history from a version chain (oldest first). */
export function toHistory(records: readonly LlmWikiObjectRecord[]): WikiHistoryEntry[] {
  return records.map((record) => ({
    version: record.version,
    supersedesVersion: record.supersedesVersion,
    contentHash: record.contentHash,
    editedBy: record.editedBy,
    provisional: record.provisional,
    createdAt: record.createdAt,
  }));
}
