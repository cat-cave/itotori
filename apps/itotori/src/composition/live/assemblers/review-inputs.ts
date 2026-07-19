// The review-lane input assemblers — the deterministic projections of a drafted
// unit (which `reviewLane` receives via the `DraftedScene`) into each lane's
// blinded review input.
//
// Each lane's model call happens INSIDE the role; these builders only project the
// exact input shape. Q1 (meaning) is fully self-contained from the drafted unit +
// its source fact. Q2 (voice), Q3 (terminology), and Q4 (continuity) additionally
// read run-scoped substrate the light review seam does not itself carry — the
// localized voice rules + accepted history (Q2), the exact-gate outcome + approved
// forms (Q3), and the accepted origin translations (Q4). Those are passed in
// explicitly (see the provider params); their SOURCING from the live accepted-
// output store / gate report is the live lane's concern, but each projection here
// is deterministic and proven against the role's own schema.

import type { UnitFact } from "../../../contracts/index.js";
import type { RouteScope } from "../../../contracts/index.js";
import type {
  Q1LocalizedBibleEntry,
  Q1NeighborWindow,
  Q1ReviewInput,
} from "../../../roles/q1/index.js";
import type {
  AcceptedTargetLine,
  Q2ReviewInput,
  Q2SampleKind,
  VoiceBibleRule,
} from "../../../roles/q2/index.js";
import type { Q3ApprovedTerm, Q3ReviewInput } from "../../../roles/q3/index.js";
import type { Q4OriginTranslation, Q4ReviewInput } from "../../../roles/q4/index.js";
import type { FactRouteScope, OrderedUnitFact } from "../../../prepass/index.js";
import type { DraftedUnit } from "../../../workflow/index.js";
import { AssemblerError, type Sha256Hash } from "./substrate.js";

/** Convert a decode route scope to the strict contract route scope (same shape,
 * cited verbatim — never re-derived). */
export function toRouteScope(scope: FactRouteScope): RouteScope {
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  if (scope.kind === "route-set") return { kind: "route-set", routeIds: [...scope.routeIds] };
  return { kind: "global" };
}

/** The known-speaker canonical id for a unit, or null when the line is
 * unattributed / reader-unknown (not a voice-review unit). */
export function knownSpeakerId(fact: UnitFact): string | null {
  const speaker = fact.value.speaker;
  return speaker !== null && speaker.status === "known" ? speaker.canonicalCharacterId : null;
}

/** The route a unit is in play under (route scope, or the first of a route set),
 * or null for a global-scope unit. */
export function primaryRouteId(scope: FactRouteScope): string | null {
  if (scope.kind === "route") return scope.routeId;
  if (scope.kind === "route-set") return scope.routeIds[0] ?? null;
  return null;
}

/** Q1 meaning: the candidate + its authoritative source fact + wiki-first basis.
 * Fully derivable from the drafted unit and its source fact. */
export function buildQ1ReviewInput(input: {
  readonly unit: DraftedUnit;
  readonly fact: UnitFact;
  readonly localizationSnapshotId: Sha256Hash;
  /** Exact rendered bible content, resolved before the reviewer runs. */
  readonly localizedBible: readonly Q1LocalizedBibleEntry[];
  readonly targetLanguage: string;
  readonly neighbors?: readonly Q1NeighborWindow[];
}): Q1ReviewInput {
  return {
    unitId: input.unit.unitId,
    contextSnapshotId: input.fact.snapshotId,
    localizationSnapshotId: input.localizationSnapshotId,
    targetLanguage: input.targetLanguage,
    reviewScope: input.fact.visibility.routeScope,
    sourceFacts: [
      {
        factId: input.fact.factId,
        field: "source",
        text: input.fact.value.sourceSurface,
        evidence: {
          evidenceHash: input.fact.hash,
          snapshotId: input.fact.snapshotId,
          subject: { kind: "unit", id: input.fact.value.unitId },
          playOrderIndex: input.fact.visibility.fromPlayOrder,
        },
      },
    ],
    candidateTarget: input.unit.draft.targetSkeleton,
    bibleRenderingIds: [...input.unit.bibleRenderingIds],
    localizedBible: [...input.localizedBible],
    neighbors: [...(input.neighbors ?? [])],
    // The back-translation is a live tripwire SIGNAL, not part of the deterministic
    // input — the reviewer receives it only when the live signal was produced.
    backTranslationSignal: null,
  };
}

/** Q2 voice: the candidate at its decode-derived position, judged against the
 * localized voice rules + accepted history (both passed in). Requires a known
 * speaker + a route in play — a global/unattributed unit is not a voice unit. */
export function buildQ2ReviewInput(input: {
  readonly unit: DraftedUnit;
  readonly fact: UnitFact;
  readonly ordered: OrderedUnitFact;
  readonly localizationSnapshotId: Sha256Hash;
  readonly sampleKind: Q2SampleKind;
  readonly counterpartId?: string | null;
  readonly bibleRules?: readonly VoiceBibleRule[];
  readonly acceptedHistory?: readonly AcceptedTargetLine[];
  readonly speakerId?: string;
  readonly routeId?: string;
}): Q2ReviewInput {
  const speakerId = input.speakerId ?? knownSpeakerId(input.fact);
  if (speakerId === null || speakerId === undefined) {
    throw new AssemblerError("no-speaker", `unit ${input.unit.unitId} has no known speaker for Q2`);
  }
  const routeId = input.routeId ?? primaryRouteId(input.ordered.routeScope);
  if (routeId === null || routeId === undefined) {
    throw new AssemblerError("no-route", `unit ${input.unit.unitId} has no route in play for Q2`);
  }
  return {
    unitId: input.unit.unitId,
    localizationSnapshotId: input.localizationSnapshotId,
    speakerId,
    candidateTarget: input.unit.draft.targetSkeleton,
    position: {
      derivation: "decode",
      counterpartId: input.counterpartId ?? null,
      routeId,
      playOrder: input.ordered.playReveal.playOrderIndex,
    },
    sampleKind: input.sampleKind,
    bibleRules: [...(input.bibleRules ?? [])],
    acceptedHistory: [...(input.acceptedHistory ?? [])],
  };
}

/** Q3 terminology: the candidate + the exact-gate outcome + the approved forms in
 * play. `exactGateStatus` is the deterministic gate's finding for this unit (the
 * gate report the driver holds); the approved forms + ruling refs are passed in. */
export function buildQ3ReviewInput(input: {
  readonly unit: DraftedUnit;
  readonly localizationSnapshotId: Sha256Hash;
  readonly exactGateStatus: "cleared" | "defect";
  readonly approvedTerms?: readonly Q3ApprovedTerm[];
  readonly termRulingIds?: readonly string[];
  readonly neighbors?: readonly {
    readonly surface: "source" | "accepted-target";
    readonly unitId: string;
    readonly text: string;
  }[];
}): Q3ReviewInput {
  return {
    unitId: input.unit.unitId,
    localizationSnapshotId: input.localizationSnapshotId,
    candidateTarget: input.unit.draft.targetSkeleton,
    exactGate: { gate: "glossary-exact", status: input.exactGateStatus },
    approvedTerms: [...(input.approvedTerms ?? [])],
    termRulingIds: [...(input.termRulingIds ?? [])],
    neighbors: [...(input.neighbors ?? [])],
  };
}

/** Q4 continuity: the route-bound candidate + the accepted origin translations it
 * judges continuity against (passed in from the accepted-output store). */
export function buildQ4ReviewInput(input: {
  readonly unit: DraftedUnit;
  readonly ordered: OrderedUnitFact;
  readonly localizationSnapshotId: Sha256Hash;
  readonly originTranslations?: readonly Q4OriginTranslation[];
}): Q4ReviewInput {
  return {
    unitId: input.unit.unitId,
    localizationSnapshotId: input.localizationSnapshotId,
    reviewScope: toRouteScope(input.ordered.routeScope),
    currentTarget: input.unit.draft.targetSkeleton,
    bibleRenderingIds: [...input.unit.bibleRenderingIds],
    originTranslations: [...(input.originTranslations ?? [])],
  };
}
