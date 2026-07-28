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
