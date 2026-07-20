# Surface-normalization semantics (SHARED-020)

Bridge text is not a flat stream of generic "dialogue". Each translatable unit
carries an **expanded surface kind** and a set of **protected spans**. Any code
path that _normalizes_ a bridge unit — reducing it to a canonical shape before
handing it to a provider prompt, a patch exporter, or a persisted draft record —
MUST preserve both. This document states the preservation contract and names the
one field that is legitimately transformed rather than preserved.

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

The legacy v0.1 `textSurface` two-value enum (`dialogue | system`) is
**deterministically widened** into the v0.2 vocabulary via
`LEGACY_TEXT_SURFACE_TO_SURFACE_KIND`:

| legacy `textSurface` | normalized `surfaceKind` |
| -------------------- | ------------------------ |
| `dialogue`           | `dialogue`               |
| `system`             | `metadata_text`          |

`system` maps to `metadata_text` — it is **never** collapsed to `dialogue`.
This widening is the single legitimately-_normalizing_ (not preserving) step,
and it is total and deterministic.

### 2. Protected-span semantics (offset + identity + meaning)

Each protected span (`control_markup`, `variable_placeholder`,
`ruby_annotation`, plus the legacy `placeholder`) must survive with:

- **Offset** — `startByte` / `endByte`, the exact range the span covers. Never
  shifted, widened, or narrowed by normalization.
- **Identity** — `spanId`. A v0.2 span's own `spanId` is preserved verbatim.
  Legacy v0.1 spans carry no id, so a **stable, deterministic** id is
  synthesized (`<bridgeUnitId>#span-<index>`) — repeated normalization of the
  same unit yields the same id.
- **Semantic meaning** — `spanKind` and `preserveMode`, i.e. _what_ the span is
  and _how_ it must be handled, plus the exact `raw` bytes it covers. The legacy
  `placeholder` kind is a superset of the v0.2 span kinds and is preserved as-is.

Normalization MUST NOT add, drop, reorder, or re-type spans.

## The canonical normalization + its enforcement

`normalizeBridgeSurface(unit)` (in
[`src/bridge-surface-normalization.ts`](./src/bridge-surface-normalization.ts))
is the **single** canonical normalization for both legacy `BridgeUnit` and
expanded `LocalizationUnitV02`. It returns a `NormalizedBridgeSurface`
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
validator's concern (`assertBridgeBundle` / `assertBridgeBundleV02`), while this
function only proves normalization did not lose or corrupt what the source
declared.

## Consumers

- The retired Itotori draft path formerly consumed this normalization. Current
  app consumers must call `normalizeBridgeSurface` directly at their
  deterministic boundary, preserve `surfaceKind`, use
  `normalizedProtectedSpanRaws` for protected-span literals, and validate with
  `assertNormalizedSurfacePreservesIdentity`.

## Legitimately normalized vs preserved — quick reference

| field                                    | treatment                                             |
| ---------------------------------------- | ----------------------------------------------------- |
| v0.2 `surfaceKind`                       | **preserved** verbatim                                |
| legacy `textSurface`                     | **normalized** (deterministic widening; not collapse) |
| span `startByte` / `endByte`             | **preserved**                                         |
| v0.2 span `spanId`                       | **preserved** verbatim                                |
| legacy span id                           | **synthesized** deterministically (none in source)    |
| span `spanKind` / `preserveMode` / `raw` | **preserved**                                         |
