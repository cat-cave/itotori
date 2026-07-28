# Stage-object execution model

This is an implementation note for the first executable scene-state slice. It
records observed byte shapes and the reference model without copying code.

## Reference model

- A stage owns object lists keyed by stage index; each list is a slot-indexed
  vector. The reference keeps the three lifecycle stages distinct and has
  separate slot-enable flags: `siglus_scene_vm/src/runtime/globals.rs:4544-4578`.
- An object has a lifecycle flag, type/file identity, a base property block,
  and runtime children. Its base block contains ordering (`order`, `layer`),
  position (`x`, `y`, `z`), center, scale, rotation, clipping, and visibility:
  `siglus_scene_vm/src/runtime/globals.rs:2260-2376` and
  `siglus_scene_vm/src/runtime/globals.rs:2878-2942`.
- The object element path is decoded as stage, object-list child, array marker,
  slot, operation, and optional tail. The reference recognizes both the
  canonical stage-list path and aliases: `siglus_scene_vm/src/runtime/forms/stage.rs:220-375`.
- Object operations have explicit lifecycle and geometry forms: initialize,
  free, create picture, create rectangle, set position/center/scale/rotation,
  and set clipping. The operation catalog is at
  `siglus_scene_vm/src/runtime/globals.rs:1759-1797`; numeric element values
  are at `siglus_scene_vm/src/runtime/forms/codes.rs:4708-4735`.
- Lifecycle means reset type-specific state, create a typed object, mutate its
  properties, and eventually free/reset it. The reference dispatches each of
  those operations separately rather than treating an unrecognized call as a
  successful no-op: `siglus_scene_vm/src/runtime/forms/stage.rs:8714-9250`.
- Picture creation is also a position write for the four-argument overload:
  `(file, disp, x, y[, patno])`. The reference selects the overload from the
  argument-list id or real positional count and stores `x`/`y` in the base
  properties: `siglus_scene_vm/src/runtime/forms/stage.rs:8900-8923` (shared
  overload predicate: `:3414-3421`).
- `OBJECT_WIPE_COPY` (56) and `OBJECT_WIPE_ERASE` (92) are persisted object
  properties, not no-op commands; the later stage-wipe transition reads them
  to decide whether the old front object stays and whether the back object is
  promoted: `siglus_scene_vm/src/runtime/forms/stage.rs:1699-1713`,
  `:1957-1980`, and `:6381-6400`.

## Current port gap

Before this change, `VmState` only retained globals, indexed values, system
properties, and an opaque structured-system map
(`crates/utsushi-siglus/src/scene_vm/model.rs:25-32`). Element paths outside a
small system subset stopped as `element-path` / `assignment-target`
(`state.rs:15-62`, `state.rs:65-118`). The command dispatcher also returned
zero for many system calls (`dispatch.rs:37-75`), so no stage, slot, object
identity, geometry, ordering, creation, or free transition existed.

## Slice boundary

This slice implements only root-stage object arrays reached by the observed
element paths: stage index, object slot, picture identity, visibility, x/y/z,
order, layer, scale, center, rotation, clipping, initialize, and free. Unknown
paths and operations stay terminal diagnostics. Embedded children, rendering,
events, and non-picture object backends remain outside this slice.

## Byte decision

The real inputs use the reference's stage aliases, specifically the back-stage
form path `[37, 2, -1, slot, operation]`, rather than the canonical
stage-list spelling. The port follows those bytes; it does not preallocate
reference-only configuration slots or model reference renderer resources
because the scene payload supplies neither in this path.
