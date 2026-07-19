# Softpal `Pal.dll` call-target evidence

`Sv20` has one engine-call opcode (`0x17`). Its first operand is the little
endian packed dispatch key `(category << 16) | function`. The production
decoder exposes that key as `CallTarget` and uses its evidence-backed semantic
catalog while classifying `TEXT-SHOW` and `SELECT`; the real fixture bridge
uses that same `OpcodeScan` through `ScriptScan`.

## Disassembly chain

Both research installers contain a protected launcher and an embedded inner
PE. In the Dimension Totsu Lovers image, the inner PE registers handler
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

The catalog intentionally returns no name for a handler that has not met this
bar. It is still represented losslessly by `(category, function)`, so later
RE cannot confuse a missing semantic proof with malformed bytecode.

## Real-byte validation

Run from this worktree (the research root is read-only):

```sh
direnv exec . env ITOTORI_SOFTPAL_RESEARCH_ROOT=/scratch/softpal-research \
  cargo test -p kaifuu-softpal --test opcode_real_corpus -- --ignored --nocapture
```

Expected result: one passing test. It parses `SCRIPT.SRC` from both v21465
and v60663 via the production PAC reader, achieves zero unknown instructions,
and requires both games to exercise named message, choice, sprite, sound,
button, video, effect, random, and input targets.
