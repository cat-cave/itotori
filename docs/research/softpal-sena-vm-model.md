# Softpal VM state slice from Sena

This note records the model used for the small Softpal runtime advance in
`utsushi-softpal`. It is a reference-guided model, not a claim that every
native engine subsystem is implemented.

## Observed model

`SCRIPT.SRC` is a primary-opcode stream. Sena treats opcode 23 (`0x17`) as an
extended call with a packed `(category, index)` first word and a return
destination second word [opcodes.rs:127-135](/scratch/oracles/sena-rs/crates/pal-script/src/opcodes.rs#L127-L135).
It stores an extcall's destination before dispatch and writes a handler result
back afterwards [runtime.rs:2509-2548](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L2509-L2548).

The staged byte streams first require these two native state transitions:

- `0x0011:0x001c` is `attach_work_process`, takes zero arguments, sets the
  attach flag, and returns success. Sena initializes that flag false
  [runtime.rs:208-216](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L208-L216),
  implements the zero-pop/true transition [runtime.rs:11193-11207](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L11193-L11207),
  and documents the native side effect as posting a PAL worker message rather
  than exposing callback data to the script [extsig.rs:4350-4381](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L4350-L4381).
- `0x000f:0x0005` pops a new debug-window state, returns the old one, and
  starts from state zero [runtime.rs:395-398](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L395-L398),
  [runtime.rs:1017-1022](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L1017-L1022),
  [runtime.rs:5357-5388](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L5357-L5388).
- `0x0009:0x0034` is category-9 handler 52: it consumes zero VM arguments,
  cancels the scene-skip latch, and writes success (`1`) to the extcall
  destination [runtime.rs:4009-4024](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L4009-L4024).
  The native save-point mutation is conditional on a scene-skip latch; the
  compact VM retains the cancellation transition but does not fabricate that
  launcher-owned save state.
- `0x0009:0x0002` (`auto_set`) pops one truthy/falsey flag, stores the ADV
  auto-advance latch, and returns success [extsig.rs:2883-2893](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L2883-L2893),
  [runtime.rs:3692-3697](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L3692-L3697).
- `0x000c:0x0001` (`system_btn_release`) pops one system-button slot and
  removes that entry (with `0xffff` as the all-slot wildcard), returning
  success [extsig.rs:3374-3396](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L3374-L3396),
  [runtime.rs:4946-4982](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L4946-L4982).
- `0x000c:0x0000` (`system_btn_set`) pops `(slot, image, state)` and registers
  the native window/menu button state, returning success
  [extsig.rs:3355-3372](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L3355-L3372).
- `0x0009:0x0000` (`skip_set`) pops one truthy/falsey flag, stores the ADV
  skip latch, and returns success [extsig.rs:2863-2873](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L2863-L2873),
  [runtime.rs:3680-3687](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L3680-L3687).
- `0x0009:0x000e` consumes no arguments, clears the native temporary work
  bank, and returns success [runtime.rs:3888-3893](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L3888-L3893).
- `0x0011:0x0003` (`action_clear_count_over`) pops one action id, clearing the
  current counter for `-1` or the named counter otherwise, then returns
  success [extsig.rs:3645-3671](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L3645-L3671),
  [runtime.rs:5440-5445](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L5440-L5445).
- `0x0003:0x0005` (`sp_cls`) pops one sprite slot and releases it; `-1` is the
  all-slots wildcard [extsig.rs:731-740](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L731-L740).

Sena also identifies primary opcode `0x16` as `nop`, and `0x19` as
`reset_adv` [opcodes.rs:117-140](/scratch/oracles/sena-rs/crates/pal-script/src/opcodes.rs#L117-L140).
The reference calls `0x20`/`0x21` `pack_args`/`drop_args`
[opcodes.rs:172-180](/scratch/oracles/sena-rs/crates/pal-script/src/opcodes.rs#L172-L180);
the compact VM verifies their count against its already-transferred callee
frame. Only `nop` advances without a state update. `reset_adv` and every
unknown call halt the compact runtime with a name and byte offset.

## Boundary

The staged bytes provide scripts and archives, not launcher-owned native work
tables or callback bodies. Therefore the runtime records work-process
attachment but does not invent callback population. The next work item is to
model the first post-setup call reached per title, including its argument and
return contract; this is bounded by one call signature plus a real-bytes proof.

After the startup native calls, both staged titles reach operand tag `0x1` at
different byte offsets. Sena decodes it as indirect user memory:
`user_mem[vars[lo]]` [operand.rs:27-43](/scratch/oracles/sena-rs/crates/pal-script/src/operand.rs#L27-L43),
with reads returning zero for an invalid index [runtime.rs:2827-2836](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L2827-L2836)
and writes updating that same indexed bank [runtime.rs:2902-2911](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L2902-L2911).
The compact VM deliberately stops there: it has no `user_mem` bank or a
proven allocation/range contract, so treating the operand as zero would be a
silent invented state transition.
