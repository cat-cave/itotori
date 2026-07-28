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
`user_mem[vars[lo]]` [operand.rs:27-43](/scratch/oracles/sena-rs/crates/pal-script/src/operand.rs#L27-L43).
It allocates the user bank as 65,536 zeroed `i32` cells, described as matching
the original engine [runtime.rs:32](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L32)
and instantiated at [runtime.rs:957](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L957).
Sena's read/write implementation returns zero or ignores a write for an
invalid index [runtime.rs:2827-2836](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L2827-L2836),
[runtime.rs:2902-2911](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L2902-L2911).

The compact runtime implements that fixed allocation and in-range read/write
contract, but deliberately diverges at an invalid index: a negative value or
value >= 65,536 stops with `user_mem_index_out_of_range`. This is the task's
stricter no-silent-fallback boundary; it does not treat unproven real-byte
control flow as zero.

The next reached call is `0x0012:0x000f` (`system_task_value`). It pops no
arguments and reports the task-data value only while the native system latch
is active [extsig.rs:5065-5070](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L5065-L5070).
The reference's portable handler consumes zero arguments and returns `1` for
that active-latch path [runtime.rs:11169-11176](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L11169-L11176),
which the compact VM uses rather than fabricating the launcher-owned task data.

The subsequent tag-`0x6` operands are direct `MEM.DAT` words, not another
unknown integer form. The decoder identifies their low 16 bits as `lo` and
the next 12 bits as `bank` [operand.rs:27-49](/scratch/oracles/sena-rs/crates/pal-script/src/operand.rs#L27-L49).
The reference reads them from a writable shadow initialized from raw
`MEM.DAT` bytes [runtime.rs:1119-1134](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L1119-L1134)
at word `bank + vars[lo] + 4`, with the four-word offset skipping the
16-byte file header [runtime.rs:3053-3066](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L3053-L3066).
The compact runtime requires this real archive asset, uses its bytes as the
initial shadow, visibly rejects a negative address, and applies the
reference's extension-on-write behavior [runtime.rs:2950-2957](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L2950-L2957).

The next reached native call, `0x0012:0x0006` (`string_alloc`), pops one
ignored value, clears a selected dynamic-string slot, advances modulo 16, and
returns `0x10000000 | slot` [extsig.rs:4200-4230](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L4200-L4230).
The compact VM preserves the same observable stack, slot-clear, cursor, and
handle behavior [runtime.rs:11218-11235](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L11218-L11235).

Tag `0x5` is temporary memory, addressed as
`temp_mem[(bank != 0 ? bank + argument_base : 0) + vars[lo]]`
[operand.rs:37-49](/scratch/oracles/sena-rs/crates/pal-script/src/operand.rs#L37-L49),
[runtime.rs:2847-2869](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L2847-L2869).
The reference initializes 65,536 cells [runtime.rs:957-959](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L957-L959)
and extends it on a non-negative write [runtime.rs:2921-2947](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L2921-L2947).
The compact VM preserves that allocation and write extension; a negative or
read-beyond-end access is a visible `temp_mem_index_out_of_range` stop, not a
silent zero.

`openfile` is now executed rather than deferred. The real byte path supplies
the native resource id `168`, which resolves through `FILE.DAT` to `BGM.CSV`.
That resource belongs to `csv.pac`, not `data.pac`, so the runtime accepts an
explicit PAC set, parses each with the existing `kaifuu-softpal::PacArchive`,
and keeps the exact extracted payload behind a non-zero reusable handle. The
following `read_file`, `set_file_pointer`, and `file_string` calls execute
against the parsed CSV table; a failed resource name, missing PAC entry, or
invalid handle is a named diagnostic and never a fake zero handle. This follows
the reference's open/handle model [extsig.rs:4407-4496](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L4407-L4496),
[runtime.rs:11499-11644](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L11499-L11644).

`0x000d:0x0015` (`set_bgv_volume`) pops one requested volume level, stores it,
and returns `1`; its paired query (`0x000d:0x0016`) pops nothing and returns the
stored level. This is established by the reference's named dispatch to text
stub 69 [runtime.rs:3308-3313](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L3308-L3313)
and its one-pop/store and zero-pop/query arms
[runtime.rs:4383-4391](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L4383-L4391),
[runtime.rs:4434-4436](/scratch/oracles/sena-rs/crates/pal-vm/src/runtime.rs#L4434-L4436).
`0x0012:0x0023` (`set_last_process`) then pops one point id, stores native
process bookkeeping, and returns `1`
[extsig.rs:4552-4573](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L4552-L4573).

**Measured result after those transitions:** corpus 1 completes its bootstrap
at 3,578 instructions, 134 moments, and 137 branches; corpus 2 completes at
13,919 instructions, 986 moments, and 1,403 branches. The next named gap is
`work_process_callback_unavailable` at the root-level return offset 576
(corpus 1) / 696 (corpus 2). Text, speaker, and text-bearing choice are still
zero in both executions.

This does **not** mean the source lacks text. The static byte decoder resolves
30,165 dialogue records plus 11 text-bearing choices for corpus 1, and 39,832
plus 16 for corpus 2; runtime output is checked as an ordered prefix of those
decoded command offsets. It means the completed `SCRIPT.SRC` bootstrap only
attaches the launcher-owned work-process pump. The reference establishes that
attach calls `PalAttachWorkProcess(sub_44A080, PalTaskGetTaskData(0)+824)` and
posts work to PAL
[extsig.rs:4350-4381](/scratch/oracles/sena-rs/crates/pal-script/src/extsig.rs#L4350-L4381).
That callback data and body are not operands in the archived script stream.
The specific next step is a focused reverse of that callback's registration and
initial task-data layout in the shipped game/PAL binaries, then a modeled
callback driver that proves decoded messages in static order. Cost: native
callback-route recovery, not another script-call signature.
