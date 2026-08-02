# Surface-normalization semantics (SHARED-020)

Bridge text is not a flat stream of generic "dialogue". Each translatable unit
carries an **expanded surface kind** and a set of **protected spans**. Any code
path that _normalizes_ a bridge unit — reducing it to a canonical shape before
handing it to a provider prompt, a patch exporter, or a persisted draft record —
MUST preserve both. This document states the current v0.2 preservation
contract. A v0.1 bundle must be regenerated from its authoritative source and
profile before any unit reaches this normalization boundary.

## What must be preserved

### 1. Surface-kind identity (never collapsed to dialogue)

The expanded vocabulary is `SurfaceKindV02`:

```
dialogue | narration | speaker_name | choice_label | ui_label |
tutorial_text | database_entry | song_title | image_text | metadata_text
```

Normalization MUST carry a unit's surface kind through **verbatim**. A
`choice_label`, `speaker_name`, `ui_label`, `song_title`, etc. is NEVER reduced
to generic `dialogue`. Collapsing the surface kind would strip the downstream
translator, style policy, and patchback layout logic of the signal they need to
treat a menu label differently from a spoken line.

The current normalizer does not accept a legacy `textSurface`. A v0.1 artifact
must be regenerated from its authoritative source bytes into a native v0.2
bundle before normalization runs. No field conversion or compatibility reader
exists in this path.

### 2. Protected-span semantics (offset + identity + meaning)

Each protected span (`control_markup`, `variable_placeholder`, or
`ruby_annotation`) must survive with:

- **Offset** — `startByte` / `endByte`, the exact range the span covers. Never
  shifted, widened, or narrowed by normalization.
- **Identity** — `spanId`, preserved verbatim.
- **Semantic meaning** — `spanKind` and `preserveMode`, i.e. _what_ the span is
  and _how_ it must be handled, plus the exact `raw` bytes it covers.

Normalization MUST NOT add, drop, reorder, or re-type spans.

## The canonical normalization + its enforcement

`normalizeBridgeSurface(unit)` (in
[`src/bridge-surface-normalization.ts`](./src/bridge-surface-normalization.ts))
is the **single** canonical normalization for validated
`LocalizationUnitV02`. It returns a `NormalizedBridgeSurface`
`{ surfaceKind, sourceText, protectedSpans[] }` obeying the contract above.
`normalizedProtectedSpanRaws(surface)` is the only reduction a provider prompt
needs (the raw literals) and is derived _from_ the full normalization, so the
surface kind and span semantics are never lost upstream of that reduction.

`assertNormalizedSurfacePreservesIdentity(unit, normalized)` is the strict
contract validator. It re-derives the canonical form and throws
`SurfaceNormalizationIdentityError` if a consumer's normalized surface:

- collapsed / changed the surface kind (e.g. an expanded kind reduced to
  `dialogue`),
- changed the source text,
- added, dropped, reordered, or corrupted a protected span's offset, identity,
  semantic kind, preserve mode, or raw bytes.

It is a **preservation** check, not a schema re-validation: the offset
_semantics_ of the source span (byte- vs code-unit-based) are the ingest
validator's concern (`assertBridgeBundleV02`), while this function only proves
normalization did not lose or corrupt what the source declared.

## Consumers

- The retired Itotori draft path formerly consumed this normalization. Current
  app consumers must call `normalizeBridgeSurface` directly at their
  deterministic boundary, preserve `surfaceKind`, use
  `normalizedProtectedSpanRaws` for protected-span literals, and validate with
  `assertNormalizedSurfacePreservesIdentity`.

## Legitimately normalized vs preserved — quick reference

| field                                    | treatment              |
| ---------------------------------------- | ---------------------- |
| v0.2 `surfaceKind`                       | **preserved** verbatim |
| span `startByte` / `endByte`             | **preserved**          |
| v0.2 span `spanId`                       | **preserved** verbatim |
| span `spanKind` / `preserveMode` / `raw` | **preserved**          |
