# Softpal `Pal.dll` syscall-target evidence

`Sv20` has a script-function `call` opcode (`0x0b`) and a native `syscall`
opcode (`0x17`). The latter's first operand is the little
endian packed dispatch key `(category << 16) | function`. The production
decoder exposes that key as `CallTarget` and uses its evidence-backed semantic
catalog while classifying `TEXT-SHOW` and `SELECT`; the real fixture bridge
uses that same `OpcodeScan` through `ScriptScan`.

## Reference-table reconciliation

The staged `VNTranslationTools` reference names the same two control opcodes:
`0x000b` as `call` and `0x0017` as `syscall`. Its `SoftpalDisassembler` treats
the `0x0002:0x0002/0x000f/0x0010/0x0011/0x0012/0x0013` syscall targets as
message instructions, matching this decoder's table for those cases. This
decoder also retains its byte-proven `0x0002:0x0014` text target; the reference
does not list it, so it is not used as the source of truth for that case.
The reference also lists direct `create_message` (`0x0023`) and `text`
(`0x0088` and variants) opcodes. The exhaustive scans of both staged scripts
contain only `0x0001..=0x0021`, with zero unknown operator tokens, so none of
those direct entries occurs in these byte streams. This is a table entry for a
different script surface/revision, not a reachable text path here.

Consequently the earlier halted instruction is precisely a native `0x17`
syscall (`0x000f:0x0005`), not a script `0x0b` call and not direct `0x0088`
text. The archive-visible text path remains the `0x17` message syscall, which
the VM already emits when execution reaches it; its failure to do so on the
two real entry paths is caused by the proved launcher-state blocker before it.

## Disassembly chain

Both research installers contain a protected launcher and an embedded inner
PE. In the second corpus launcher, the inner PE registers handler
addresses by dispatch key at `0x00472480`: for example it registers
`0x00020002` with handler `0x0046FB90`. Its import thunk table begins at
`0x004EB9B0`; thunk `0x004EB9BC` resolves to `PalDebugPrintf`, and the table
contains the named `Pal.dll` exports used by the registered handlers. Direct
handler calls establish the catalog entries rather than category guesses, for
example:

- `(0x0003, 0x0009)` calls `PalSpriteSetCenterOffset`;
- `(0x0003, 0x000C)` calls `PalSpriteSetOption`;
- `(0x0004, 0x0006)` calls `PalSoundSetVolume`;
- `(0x0008, 0x0000)` calls `PalButtonCreateEx`;
- `(0x000B, 0x0000)` calls `PalVideoPlay`;
- `(0x0013, 0x0001)` calls `PalSetFxEffect`;
- `(0x0014, 0x0000)` calls `PalRandomEx`;
- `(0x0016, 0x0000)` calls `PalEffectEx`; and
- `(0x0017, 0x0000)` calls `PalInputGetKeyEx`.

`(0x000f, 0x0005)` is also now named precisely, but it cannot run from
archived script bytes alone. The second corpus launcher registers it at
`0x00427e96`/`0x00427e9b` with handler `0x00427860`. That handler pops the
launcher VM value stack at `context + 0x45e90`, calls the lazy imports
`PalDebugWindowGetState` and `PalDebugWindowSetState` (slots `0x004ebb1c` and
`0x004ebb24`; the resolver's name table identifies them at `0x004e66fa` and
`0x004e6728`), then pushes the old state to `context + 0x45e94`. The process-
local debug-window state has no archive representation, so the VM records
`debug_window_state_unavailable` rather than assuming an initial value.
The exports confirm that this is real mutable host state: `PalDebugWindowGetState`
at `0x100a5a50` reads the live debug-window object and its state field, while
`PalDebugWindowSetState` at `0x100a5a70` writes that field. Both return zero
only when no debug window exists. Nothing in the archived script or data
establishes whether that object has been created on this launch path.

The catalog intentionally returns no name for a handler that has not met this
bar. It is still represented losslessly by `(category, function)`, so later
RE cannot confuse a missing semantic proof with malformed bytecode.

## Real-byte validation

Run from this worktree (the research root is read-only):

```sh
direnv exec . env private inventory row=/scratch/softpal-research \
  cargo test -p kaifuu-softpal --features real-bytes --test opcode_real_corpus --nocapture
```

Expected result: one passing test. It parses `SCRIPT.SRC` from both v21465
and v60663 via the production PAC reader, achieves zero unknown instructions,
and requires both games to exercise named message, choice, sprite, sound,
button, video, effect, random, and input targets.
