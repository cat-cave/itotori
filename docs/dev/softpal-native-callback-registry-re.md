# Softpal native callback registry evidence

This note records only properties established by offline disassembly of the
embedded PE in the read-only v60663 launcher. It is not a runtime dependency.

## Registration and shape

- At `0x0041cf6c`, the launcher registers dispatch key `0x0011001c` with
  handler `0x0041bae0` through `0x004046f0`.
- `0x0041bae0` begins at `context + 0x59678`, iterates 16 groups with stride
  `0x85e4c`, and its inner loop runs 60 times with stride `0x23a8`.
- A work table stores its count at offset `0`, begins its work records at
  offset `8`, and advances each record by `0x4c`. It loads the selector from
  record offset `0x40`.
- The selector indexes native function tables at `0x004d23c0` and
  `0x004d24c0`; these contain callback pointers. A registry entry is therefore
  a launcher work item with a selector and state, not a function pointer or
  four values supplied by the script VM.

## Population and remaining boundary

`0x00418e10` chooses a group from launcher context state, clears one
`0x85e4c`-byte group, and transfers to `0x004194c0`; the scheduler tick at
`0x00419050` consumes the same group/slot/work-record layout. Neither handler
reads a script operand to populate the registry. The script archive contains
no snapshot of this process-local memory.

The available artifacts establish the dispatcher and layout, but not the
per-scene writes that create the populated records, nor which native selector
reaches message presentation. Therefore the Rust model keeps an empty registry
unless a future evidence-backed launcher-state decoder supplies records, and it
does not assign any selector text behavior.
