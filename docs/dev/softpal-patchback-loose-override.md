# SoftPal patch-back: the loose-file override, validated

`kaifuu-softpal` patch-back writes translated dialogue/choices back by rebuilding
`TEXT.DAT`, repointing `SCRIPT.SRC`, and dropping the two rebuilt files into the
game's `data\` override directory — **no PAC repack, no archive re-encryption**.

That strategy rests on one load-bearing assumption: **the SoftPal / Amuse-Craft
("PAL") engine resolves a script asset from a loose file under `data\` in
preference to the entry inside the `data.pac` archive.** This document records
how that assumption was _validated against real evidence_ rather than asserted.

## Verdict

**HOLDS — with a location correction.** The engine does prefer a loose file over
the PAC entry, so a translation can run against the **original, unmodified**
`data.pac`. The correction: the loose files must live in the game's **`data\`
override subdirectory** (the same virtual namespace `data.pac` maps to), **not**
the game root beside the archive — files in the game root are not preferred.

## Evidence 1 — a working third-party toolchain (oracle)

The `bluquark/VNTranslationTools_SoftPal` fork is a real, working SoftPal
translation toolchain (its README reports Flyable Heart fully working). Read
read-only as a clean-room oracle; not vendored.

- Its `README.md` states the behaviour as native to the engine: the SoftPal
  engine looks for script files in the `data\` directory first, and only falls
  back to `data.pac` when they are absent. Its insertion step writes the rebuilt
  script to `data\script.src` (and `data\TEXT.DAT`) against an **unmodified**
  archive.
- The override is **not** provided by the toolchain's runtime shim. That shim's
  only file-related hook (`VNTextProxy/Win32AToWAdapter.cpp`, `CreateFileAHook`,
  ~lines 297-299) merely decodes Shift-JIS filenames and forwards to
  `CreateFileW`; every other proxy hook (`PALHooks.cpp`) is font / DirectX /
  video. There is no load-path redirect, so the `data\`-first resolution is
  native engine behaviour, not proxy-injected.
- Its _release_ step (`create_translation_patch_release.ps1`, ~lines 90-93)
  optionally repacks the loose files back into `data.pac` via `unipack.exe`.
  This is purely a **distribution convenience** (players overwrite a single
  `.pac` instead of managing a `data\` subdirectory); the translation itself
  runs from the loose `data\` files, confirming no repack is required to load
  them.

## Evidence 2 — the real `Pal.dll`

The genuine PAL engine binary (real game v21465; its embedded PDB path is
`D:\TamoSys\PAL\DownLoad\PAL.pdb`) carries both path-construction templates a
loose-then-archive resolver needs:

| Marker            | Bytes     | Offset     | Role                              |
| ----------------- | --------- | ---------- | --------------------------------- |
| Engine identity   | `TamoSys` | `0x10e7e7` | PDB marker — genuine PAL engine   |
| Archive extension | `.pac`    | `0x10a310` | `<name>.pac` archive-path builder |
| Name builder      | `%s%s`    | `0x0f12e0` | archive filename format string    |
| Path join         | `%s\%s`   | `0x10a1e0` | loose `<dir>\<file>` path join    |

The presence of both an `<name>.pac` archive-path builder and a `<dir>\<file>`
path-join template is consistent with a loose-then-archive resolver.

## Honest limitation — runtime order not traced

The runtime resolution **order** (loose _before_ archive) rests on the oracle's
documented, shipped-working engine behaviour plus the path templates above. It
was **not** observed directly by disassembling the file-open routine or by
running the engine under Windows/Wine — either of which would be needed to trace
the order at runtime. The evidence is strong and convergent, but it is not a
runtime trace.

## Where this is exercised

- Production patch path: `kaifuu-engine-fixture` softpal `run_patch` writes the
  rebuilt files into an output directory deployed as the engine's `data\`
  override directory.
- Real-bytes grounding test: `kaifuu-softpal/tests/pal_dll_loose_override_real.rs`
  inspects the shipped `Pal.dll` for the archive (`.pac`) + loose (`%s\%s`) path
  machinery under the `TamoSys` engine marker. Env-gated on
  `ITOTORI_SOFTPAL_RESEARCH_ROOT`; skips cleanly when the corpus is absent.
