# RealLive detector live-corpus calibration

## Method and boundary

The detector was called through `RealLiveProfileDetectorAdapter`'s Rust
`EngineAdapter::detect` API against the locally staged RealLive corpus roots.
No external helper, emulator, reference implementation, or subprocess
participated in detection. The calibration output intentionally retains only a
title label and structural signal booleans. It contains no corpus path, file
hash, filename beyond the detector's public signal classes, or copyrighted
byte/text content.

## Baseline aggregate evidence

| Title label | Detected | SEEN envelope | Gameexe keys | `.g00` assets | Voice archives | `.PDT` assets | Siglus markers |
| ----------- | -------- | ------------- | ------------ | ------------- | -------------- | ------------- | -------------- |
| sweetie-hd  | true     | true          | true         | true          | true           | false         | false          |
| kanon       | false    | true          | true         | true          | false          | true          | false          |

## Observed false-negative class

The `kanon` label is an observed false negative for this structural class:

> A valid RealLive SEEN envelope and RealLive-specific Gameexe key are present,
> with `.g00` corroboration and no Siglus marker, while `.PDT` assets also
> coexist.

The original FSM accepts the first label but requires the `.PDT` signal to be
absent for its live positive branch. Its AVG32 branch already requires that no
RealLive Gameexe key be present, so the conflicting case falls through to the
unknown variant rather than an AVG32 diagnostic.

## Narrow extension justified by this evidence

The live positive branch may accept the observed class when the valid envelope
and a RealLive Gameexe key are both present, regardless of `.PDT` asset
co-presence. The extension must preserve the existing precedence rules:

- Siglus marker co-presence remains ambiguous and rejects detection.
- A valid envelope with `.PDT` assets but without a RealLive Gameexe key
  remains the AVG32 unsupported variant.
- Missing or invalid envelope/key signals remain non-positive.

This is a detector-only magic/structure decision; it neither reads scene text
nor invokes, links, or vendors an external RealLive implementation.
