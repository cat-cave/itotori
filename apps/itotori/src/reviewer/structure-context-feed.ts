// wiki-structure-context-feed — structure-informed context surfacing.
//
// The owned-structure advantage ([[project_full_stack_structure_informed_context]]):
// character arcs, scene summaries, route/branch maps, and glossary terms FEED
// the draft. This module turns the decision-record context (artifact refs +
// the structured-context injection that actually entered the translate-stage
// prompt) into a typed feed the reviewer detail UI can render so a human sees
// WHY a draft chose its wording — not just an opaque list of ref ids.
//
// Backed by the agentic-loop bridge decision record
// (`payload.decisionRecord.context`) and, when present, the
// `StructuredContextInjection` texts that the translate stage consumed.
// Pure: no I/O. The evidence loader hydrates from the queue item payload.

import type { StructuredContextInjection } from "../agents/structure-informed-context/shapes.js";

/** Closed taxonomy of structure-context kinds the feed surfaces. */
export const structureContextFeedItemKindValues = {
  sceneSummary: "scene_summary",
  characterArc: "character_arc",
  characterBio: "character_bio",
  characterRelationship: "character_relationship",
  routeMap: "route_map",
  glossaryTerm: "glossary_term",
  terminologyCandidate: "terminology_candidate",
  other: "other",
} as const;

export type StructureContextFeedItemKind =
  (typeof structureContextFeedItemKindValues)[keyof typeof structureContextFeedItemKindValues];

/**
 * One cited structure-context artifact that fed (or is associated with) the
 * draft under review. `body` is the human-readable text the translator saw
 * when present; otherwise a short label derived from the artifact ref.
 */
export type ReviewerDetailStructureContextFeedItem = {
  kind: StructureContextFeedItemKind;
  artifactRef: string;
  title: string;
  body: string;
  /** How this item relates to the draft wording (feed role). */
  feedRole: string;
};

/**
 * The structure-informed context feed for one reviewer-detail view.
 *
 * `fedTheDraft` is true when the feed was reconstructed from the same
 * structure-informed injection the translate stage consumed (the ownership
 * proof that character arcs / scene summaries / route maps FEED the draft).
 * When only bare artifact refs are known, `fedTheDraft` is false and the
 * items still list the cited refs so the gap is visible rather than silent.
 */
export type ReviewerDetailStructureContextFeed = {
  /** Human-facing panel heading — answers "why this wording?". */
  whyHeading: string;
  sceneId: number | null;
  items: ReviewerDetailStructureContextFeedItem[];
  /** All citable context artifact IDs recorded on the decision record. */
  contextArtifactIds: string[];
  /** Draft-selected citation refs that fed the exact draft under review. */
  citationRefs: string[];
  fedTheDraft: boolean;
};

/**
 * The shape stored on `decisionRecord.context` by the agentic-loop bridge
 * (wiki-structure-context-feed). `citationRefs` and `sceneId` remain
 * optional because an outcome may have no draft-selected citations or scene.
 */
export type DecisionRecordStructureContext = {
  contextArtifactIds: string[];
  citationRefs?: string[] | undefined;
  sceneId?: number | undefined;
  /**
   * The exact structured-context injection texts the translate stage rendered
   * into the prompt. When present, the reviewer sees the same structure that
   * fed the draft wording.
   */
  structuredContext?:
    | {
        sceneId: number;
        sceneSummaryText: string;
        routePositionText: string;
        characterArcsText: string;
        artifactRefs: string[];
      }
    | undefined;
};

/** Classify a citable artifact ref into a feed kind. */
export function classifyStructureContextArtifactRef(ref: string): StructureContextFeedItemKind {
  if (ref.startsWith("scene-summary:")) {
    return structureContextFeedItemKindValues.sceneSummary;
  }
  if (ref.startsWith("character-arc:")) {
    return structureContextFeedItemKindValues.characterArc;
  }
  if (ref.startsWith("character-bio:")) {
    return structureContextFeedItemKindValues.characterBio;
  }
  if (ref.startsWith("character-rel:")) {
    return structureContextFeedItemKindValues.characterRelationship;
  }
  if (ref.startsWith("route-branch-map") || ref.startsWith("route:") || ref.startsWith("choice:")) {
    return structureContextFeedItemKindValues.routeMap;
  }
  if (ref.startsWith("terminology-candidate:") || ref.startsWith("term:")) {
    return structureContextFeedItemKindValues.terminologyCandidate;
  }
  if (ref.startsWith("glossary:") || ref.startsWith("glossary-term:")) {
    return structureContextFeedItemKindValues.glossaryTerm;
  }
  return structureContextFeedItemKindValues.other;
}

function classifyDecisionContextFeedRef(
  ref: string,
  input: { contextArtifactIds: ReadonlySet<string>; citationRefs: ReadonlySet<string> },
): StructureContextFeedItemKind {
  const artifactKind = classifyStructureContextArtifactRef(ref);
  if (artifactKind !== structureContextFeedItemKindValues.other) {
    return artifactKind;
  }
  if (input.citationRefs.has(ref) && !input.contextArtifactIds.has(ref)) {
    return structureContextFeedItemKindValues.glossaryTerm;
  }
  return artifactKind;
}

function titleForKind(kind: StructureContextFeedItemKind, ref: string): string {
  switch (kind) {
    case structureContextFeedItemKindValues.sceneSummary:
      return "Scene summary";
    case structureContextFeedItemKindValues.characterArc:
      return "Character arc";
    case structureContextFeedItemKindValues.characterBio:
      return "Character bio";
    case structureContextFeedItemKindValues.characterRelationship:
      return "Character relationship";
    case structureContextFeedItemKindValues.routeMap:
      return "Route / branch map";
    case structureContextFeedItemKindValues.glossaryTerm:
      return "Glossary term";
    case structureContextFeedItemKindValues.terminologyCandidate:
      return "Terminology candidate";
    case structureContextFeedItemKindValues.other:
      return ref.length > 0 ? ref : "Context artifact";
  }
}

function defaultBodyForRef(kind: StructureContextFeedItemKind, ref: string): string {
  const suffix = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
  switch (kind) {
    case structureContextFeedItemKindValues.sceneSummary:
      return `Cited scene summary ${suffix} fed the draft's scene-aware wording.`;
    case structureContextFeedItemKindValues.characterArc:
      return `Cited character arc for ${suffix} fed the draft's speaker voice.`;
    case structureContextFeedItemKindValues.characterBio:
      return `Cited character bio for ${suffix} informed naming and voice.`;
    case structureContextFeedItemKindValues.characterRelationship:
      return `Cited relationship ${suffix} informed interpersonal register.`;
    case structureContextFeedItemKindValues.routeMap:
      return `Cited route/branch context ${suffix} kept the draft branch-aware.`;
    case structureContextFeedItemKindValues.glossaryTerm:
      return `Cited glossary term ${suffix} constrained the preferred translation.`;
    case structureContextFeedItemKindValues.terminologyCandidate:
      return `Cited terminology candidate ${suffix} informed term choice.`;
    case structureContextFeedItemKindValues.other:
      return `Cited context artifact ${ref}.`;
  }
}

function feedRoleForRef(
  ref: string,
  input: { contextArtifactIds: ReadonlySet<string>; citationRefs: ReadonlySet<string> },
): string {
  if (input.citationRefs.has(ref) && !input.contextArtifactIds.has(ref)) {
    return "Selected by the draft citationRefs; this citation fed the draft under review.";
  }
  return "Cited context artifact available to the translate stage.";
}

/**
 * Serialize a live `StructuredContextInjection` into the decision-record
 * shape (JSON-safe, no class instances).
 */
export function structuredContextForDecisionRecord(
  injection: StructuredContextInjection,
): NonNullable<DecisionRecordStructureContext["structuredContext"]> {
  return {
    sceneId: injection.sceneId,
    sceneSummaryText: injection.sceneSummaryText,
    routePositionText: injection.routePositionText,
    characterArcsText: injection.characterArcsText,
    artifactRefs: [...injection.artifactRefs],
  };
}

/**
 * Build the reviewer-facing structure context feed from the decision-record
 * context block. Pure. Prefer the stored structured-context injection texts
 * (exact feed that entered the prompt) over bare ref labels.
 */
export function buildStructureContextFeedFromDecisionContext(
  context: DecisionRecordStructureContext | null | undefined,
): ReviewerDetailStructureContextFeed | null {
  if (context === null || context === undefined) {
    return null;
  }
  const refs = Array.isArray(context.contextArtifactIds)
    ? context.contextArtifactIds.filter((r): r is string => typeof r === "string" && r.length > 0)
    : [];
  const citationRefs = Array.isArray(context.citationRefs)
    ? context.citationRefs.filter((r): r is string => typeof r === "string" && r.length > 0)
    : [];
  const citedRefs = uniqueRefs([...refs, ...citationRefs]);
  const structured = context.structuredContext;
  const hasStructured =
    structured !== undefined &&
    typeof structured.sceneSummaryText === "string" &&
    structured.sceneSummaryText.length > 0;

  if (citedRefs.length === 0 && !hasStructured) {
    return null;
  }

  const items: ReviewerDetailStructureContextFeedItem[] = [];
  const coveredRefs = new Set<string>();
  const contextArtifactIdSet = new Set(refs);
  const citationRefSet = new Set(citationRefs);

  if (hasStructured && structured !== undefined) {
    items.push({
      kind: structureContextFeedItemKindValues.sceneSummary,
      artifactRef:
        structured.artifactRefs.find((r) => r.startsWith("scene-summary:")) ??
        `scene-summary:${structured.sceneId}`,
      title: "Scene summary",
      body: structured.sceneSummaryText,
      feedRole: "Fed the draft's scene-aware wording (structure-informed injection).",
    });
    coveredRefs.add(items[items.length - 1]!.artifactRef);

    items.push({
      kind: structureContextFeedItemKindValues.routeMap,
      artifactRef:
        structured.artifactRefs.find(
          (r) => r.startsWith("route-branch-map") || r.startsWith("route:"),
        ) ?? "route-branch-map",
      title: "Route / branch position",
      body: structured.routePositionText,
      feedRole: "Fed the draft's branch-aware wording (structure-informed injection).",
    });
    coveredRefs.add(items[items.length - 1]!.artifactRef);

    // Character arcs arrive as a multi-line block; keep them as one feed item
    // so the reviewer reads the same block the translator saw.
    if (structured.characterArcsText.trim().length > 0) {
      const arcRef =
        structured.artifactRefs.find((r) => r.startsWith("character-arc:")) ?? "character-arc:*";
      items.push({
        kind: structureContextFeedItemKindValues.characterArc,
        artifactRef: arcRef,
        title: "Character arcs",
        body: structured.characterArcsText,
        feedRole: "Fed the draft's speaker voice consistency (structure-informed injection).",
      });
      for (const ref of structured.artifactRefs) {
        if (ref.startsWith("character-arc:")) {
          coveredRefs.add(ref);
        }
      }
      coveredRefs.add(arcRef);
    }

    for (const ref of structured.artifactRefs) {
      coveredRefs.add(ref);
    }
  }

  // Surface any remaining cited refs (semantic enrichment: bios, terms, …)
  // that are not already covered by the structured injection items.
  for (const ref of citedRefs) {
    if (coveredRefs.has(ref)) {
      continue;
    }
    // Skip refs already represented by the structured injection's scene/route
    // items (prefix match for scene-summary / route-branch-map).
    if (
      hasStructured &&
      (ref.startsWith("scene-summary:") ||
        ref.startsWith("route-branch-map") ||
        ref.startsWith("character-arc:"))
    ) {
      continue;
    }
    const kind = classifyDecisionContextFeedRef(ref, {
      contextArtifactIds: contextArtifactIdSet,
      citationRefs: citationRefSet,
    });
    items.push({
      kind,
      artifactRef: ref,
      title: titleForKind(kind, ref),
      body: defaultBodyForRef(kind, ref),
      feedRole: feedRoleForRef(ref, {
        contextArtifactIds: contextArtifactIdSet,
        citationRefs: citationRefSet,
      }),
    });
  }

  if (items.length === 0) {
    return null;
  }

  const sceneId =
    typeof context.sceneId === "number"
      ? context.sceneId
      : hasStructured && structured !== undefined
        ? structured.sceneId
        : null;

  return {
    whyHeading: hasStructured
      ? "Structure-informed context that fed this draft's wording"
      : "Cited structure context for this draft",
    sceneId,
    items,
    contextArtifactIds: [...refs].sort(),
    citationRefs: [...citationRefs].sort(),
    fedTheDraft: hasStructured,
  };
}

function uniqueRefs(refs: ReadonlyArray<string>): string[] {
  return [...new Set(refs)];
}

/**
 * Extract `decisionRecord.context` from a reviewer-queue item payload.
 * Tolerates missing / malformed payloads — returns null rather than throwing
 * so the detail loader can emit a diagnostic instead of failing the page.
 */
export function extractDecisionRecordStructureContext(
  payload: unknown,
): DecisionRecordStructureContext | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const record = (payload as { decisionRecord?: unknown }).decisionRecord;
  if (record === null || typeof record !== "object") {
    return null;
  }
  const context = (record as { context?: unknown }).context;
  if (context === null || typeof context !== "object") {
    return null;
  }
  const ctx = context as {
    contextArtifactIds?: unknown;
    citationRefs?: unknown;
    sceneId?: unknown;
    structuredContext?: unknown;
  };
  const refs = Array.isArray(ctx.contextArtifactIds)
    ? ctx.contextArtifactIds.filter((r): r is string => typeof r === "string")
    : [];
  const citationRefs = Array.isArray(ctx.citationRefs)
    ? ctx.citationRefs.filter((r): r is string => typeof r === "string")
    : [];
  const sceneId = typeof ctx.sceneId === "number" ? ctx.sceneId : undefined;
  let structuredContext: DecisionRecordStructureContext["structuredContext"];
  if (ctx.structuredContext !== null && typeof ctx.structuredContext === "object") {
    const s = ctx.structuredContext as Record<string, unknown>;
    if (
      typeof s.sceneId === "number" &&
      typeof s.sceneSummaryText === "string" &&
      typeof s.routePositionText === "string" &&
      typeof s.characterArcsText === "string" &&
      Array.isArray(s.artifactRefs)
    ) {
      structuredContext = {
        sceneId: s.sceneId,
        sceneSummaryText: s.sceneSummaryText,
        routePositionText: s.routePositionText,
        characterArcsText: s.characterArcsText,
        artifactRefs: s.artifactRefs.filter((r): r is string => typeof r === "string"),
      };
    }
  }
  if (refs.length === 0 && citationRefs.length === 0 && structuredContext === undefined) {
    return null;
  }
  return {
    contextArtifactIds: refs,
    ...(citationRefs.length > 0 ? { citationRefs } : {}),
    ...(sceneId !== undefined ? { sceneId } : {}),
    ...(structuredContext !== undefined ? { structuredContext } : {}),
  };
}

/**
 * Build the feed directly from a live structured-context injection + the
 * full set of citable refs (used by tests and by the bridge when assembling
 * the decision record).
 */
export function buildStructureContextFeedFromInjection(input: {
  structuredContext?: StructuredContextInjection | undefined;
  contextArtifactIds: ReadonlyArray<string>;
  citationRefs?: ReadonlyArray<string> | undefined;
  sceneId?: number | undefined;
}): ReviewerDetailStructureContextFeed | null {
  return buildStructureContextFeedFromDecisionContext({
    contextArtifactIds: [...input.contextArtifactIds],
    ...(input.citationRefs !== undefined ? { citationRefs: [...input.citationRefs] } : {}),
    ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    ...(input.structuredContext !== undefined
      ? { structuredContext: structuredContextForDecisionRecord(input.structuredContext) }
      : {}),
  });
}
