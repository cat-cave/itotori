// SHARED-020 — Bridge surface-identity + protected-span preserving normalization.
//
// Bridge text does NOT carry a single generic "dialogue" surface. It carries
// EXPANDED surface kinds (`SurfaceKindV02`: dialogue, narration, speaker_name,
// choice_label, ui_label, tutorial_text, database_entry, song_title,
// image_text, metadata_text) and PROTECTED SPANS (control markup, variable
// placeholders, ruby annotations) that must survive translation byte-for-byte.
//
// Several downstream paths (draft-request building, patch-export mapping) must
// reduce a bridge unit to a canonical shape before handing it to a provider or
// exporter. The hazard this module closes is that such NORMALIZATION silently
// COLLAPSES the expanded surface kind into generic dialogue, or drops a
// protected span's offset / identity / semantic meaning (its kind + the exact
// source bytes it covers).
//
// This module owns the SINGLE canonical normalization + a strict validator that
// ENFORCES preservation. `normalizeBridgeSurface` produces a
// `NormalizedBridgeSurface` that keeps the surface kind AND every protected
// span's offset (startByte/endByte), stable identity (spanId), and semantic
// meaning (spanKind + preserveMode + the raw bytes). `assertNormalizedSurface\
// PreservesIdentity` re-derives the canonical form and fails loudly if a
// consumer's normalized surface collapsed the kind or corrupted a span.
//
// Legitimately-normalized fields (flagged so consumers do not mistake them for
// corruption): the legacy v0.1 `textSurface` two-value enum is DETERMINISTICALLY
// widened to the v0.2 surface-kind vocabulary via
// `LEGACY_TEXT_SURFACE_TO_SURFACE_KIND` — `system` maps to `metadata_text`, it
// is NEVER collapsed to `dialogue`. Legacy spans carry no id, so a stable
// per-occurrence identity is synthesized; a v0.2 span's own `spanId` is always
// preserved verbatim.

import type {
  BridgeUnit,
  LocalizationUnitV02,
  PreserveModeV02,
  ProtectedSpanKind,
  SurfaceKindV02,
  TextSurface,
  Uuid7,
} from "./index.js";

/**
 * Deterministic widening from the legacy v0.1 two-value `textSurface` enum to
 * the expanded v0.2 surface-kind vocabulary. `system` maps to `metadata_text`
 * — it is NEVER collapsed to `dialogue`. This mapping is the one legitimately
 * "normalizing" (not preserving) step for legacy units and is stated in the
 * surface-normalization semantics doc.
 */
export const LEGACY_TEXT_SURFACE_TO_SURFACE_KIND: Record<TextSurface, SurfaceKindV02> = {
  dialogue: "dialogue",
  system: "metadata_text",
};

/**
 * A protected span after normalization. Carries everything a downstream
 * consumer needs to keep the span byte-exact and semantically identified:
 *  - `startByte` / `endByte` — the OFFSET into the source's UTF-8 bytes.
 *  - `spanId` — the stable IDENTITY (v0.2 spanId verbatim; synthesized for
 *    legacy spans which carry none).
 *  - `spanKind` / `preserveMode` — the SEMANTIC MEANING (what the span is and
 *    how it must be handled), preserving the legacy `placeholder` kind which is
 *    a superset of the v0.2 span kinds.
 *  - `raw` — the exact source bytes the span covers.
 */
export type NormalizedProtectedSpan = {
  spanId: Uuid7;
  spanKind: ProtectedSpanKind;
  raw: string;
  startByte: number;
  endByte: number;
  preserveMode: PreserveModeV02;
};

/**
 * The canonical, surface-identity-preserving normalization of a bridge unit's
 * translatable surface. `surfaceKind` is an EXPANDED kind and is never
 * collapsed to generic dialogue.
 */
export type NormalizedBridgeSurface = {
  surfaceKind: SurfaceKindV02;
  sourceText: string;
  protectedSpans: NormalizedProtectedSpan[];
};

export class SurfaceNormalizationIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceNormalizationIdentityError";
  }
}

/**
 * Synthesize a stable identity for a legacy protected span, which carries no
 * id of its own. Deterministic in the unit id + occurrence index so repeated
 * normalization of the same unit is byte-identical.
 */
function legacySpanId(bridgeUnitId: Uuid7, index: number): Uuid7 {
  return `${bridgeUnitId}#span-${index}`;
}

function isLocalizationUnitV02(
  unit: BridgeUnit | LocalizationUnitV02,
): unit is LocalizationUnitV02 {
  return "spans" in unit && "surfaceKind" in unit;
}

/**
 * Produce the canonical surface-identity + protected-span preserving
 * normalization of a bridge unit (legacy v0.1 `BridgeUnit` or expanded v0.2
 * `LocalizationUnitV02`).
 *
 * PRESERVES:
 *  - surface kind (v0.2 `surfaceKind` verbatim; legacy `textSurface`
 *    deterministically widened, never collapsed to dialogue).
 *  - every protected span's offset, identity, semantic meaning, and raw bytes.
 */
export function normalizeBridgeSurface(
  unit: BridgeUnit | LocalizationUnitV02,
): NormalizedBridgeSurface {
  if (isLocalizationUnitV02(unit)) {
    return {
      surfaceKind: unit.surfaceKind,
      sourceText: unit.sourceText,
      protectedSpans: unit.spans.map((span) => ({
        spanId: span.spanId,
        spanKind: span.spanKind,
        raw: span.raw,
        startByte: span.startByte,
        endByte: span.endByte,
        preserveMode: span.preserveMode,
      })),
    };
  }
  return {
    surfaceKind: LEGACY_TEXT_SURFACE_TO_SURFACE_KIND[unit.textSurface],
    sourceText: unit.sourceText,
    protectedSpans: unit.protectedSpans.map((span, index) => ({
      spanId: legacySpanId(unit.bridgeUnitId, index),
      spanKind: span.kind,
      raw: span.raw,
      startByte: span.start,
      endByte: span.end,
      preserveMode: span.preserveMode,
    })),
  };
}

/**
 * The raw protected-span literals of a normalized surface, in span order. This
 * is the ONLY view a provider prompt needs of the spans — but it is derived
 * from the full normalization so surface identity + span semantics are never
 * lost upstream of this reduction.
 */
export function normalizedProtectedSpanRaws(surface: NormalizedBridgeSurface): string[] {
  return surface.protectedSpans.map((span) => span.raw);
}

/**
 * Strict contract enforcement: a consumer's `normalized` surface MUST equal the
 * canonical normalization of `unit`. This is a PRESERVATION check, not a
 * schema re-validation — the offset SEMANTICS of the source span (byte- vs
 * code-unit-based) are the ingest validator's concern; this function only
 * proves the normalization did not lose or corrupt what the source declared.
 * Throws `SurfaceNormalizationIdentityError` if:
 *  - the surface kind was collapsed / changed (e.g. an expanded kind reduced to
 *    generic dialogue).
 *  - the source text changed.
 *  - a protected span was added, dropped, reordered, or had its offset,
 *    identity, semantic kind, preserve mode, or raw bytes altered.
 */
export function assertNormalizedSurfacePreservesIdentity(
  unit: BridgeUnit | LocalizationUnitV02,
  normalized: NormalizedBridgeSurface,
  label = "normalizedSurface",
): void {
  const canonical = normalizeBridgeSurface(unit);

  if (normalized.surfaceKind !== canonical.surfaceKind) {
    throw new SurfaceNormalizationIdentityError(
      `${label}.surfaceKind collapsed: expected '${canonical.surfaceKind}', got '${normalized.surfaceKind}'`,
    );
  }
  if (normalized.sourceText !== canonical.sourceText) {
    throw new SurfaceNormalizationIdentityError(`${label}.sourceText changed during normalization`);
  }
  if (normalized.protectedSpans.length !== canonical.protectedSpans.length) {
    throw new SurfaceNormalizationIdentityError(
      `${label}.protectedSpans count changed: expected ${canonical.protectedSpans.length}, got ${normalized.protectedSpans.length}`,
    );
  }

  normalized.protectedSpans.forEach((span, index) => {
    const want = canonical.protectedSpans[index];
    const spanLabel = `${label}.protectedSpans[${index}]`;
    if (want === undefined) {
      throw new SurfaceNormalizationIdentityError(`${spanLabel} has no canonical counterpart`);
    }
    if (span.spanId !== want.spanId) {
      throw new SurfaceNormalizationIdentityError(
        `${spanLabel}.spanId identity changed: expected '${want.spanId}', got '${span.spanId}'`,
      );
    }
    if (span.spanKind !== want.spanKind) {
      throw new SurfaceNormalizationIdentityError(
        `${spanLabel}.spanKind semantics changed: expected '${want.spanKind}', got '${span.spanKind}'`,
      );
    }
    if (span.preserveMode !== want.preserveMode) {
      throw new SurfaceNormalizationIdentityError(
        `${spanLabel}.preserveMode semantics changed: expected '${want.preserveMode}', got '${span.preserveMode}'`,
      );
    }
    if (span.startByte !== want.startByte || span.endByte !== want.endByte) {
      throw new SurfaceNormalizationIdentityError(
        `${spanLabel} offset shifted: expected [${want.startByte}, ${want.endByte}), got [${span.startByte}, ${span.endByte})`,
      );
    }
    if (span.raw !== want.raw) {
      throw new SurfaceNormalizationIdentityError(
        `${spanLabel}.raw bytes changed during normalization`,
      );
    }
  });
}
