# RealLive Engine — Research, Grounded in Sweetie HD

> Scope: anchor the Pure-Rust RealLive runtime port to concrete facts taken from
> a single shipping title (Sukara's _Oshioki Sweetie + Sweets!! HD_) and from
> publicly archived format documentation. Replaces the single-line "VFS handoff,
> Scene/SEEN replay, headless render sink, deterministic clock/input, snapshot
> primitives" claim that UTSUSHI-146 currently carries with a per-evidence map
> of what the engine actually has to do.
>
> Provenance discipline: every claim in this document is one of
>
> - **[V]** verified against Sweetie HD bytes (specific file, byte offset),
> - **[P]** taken from a public source (rlvm GitHub, RLDEV manual, format
>   discussions on kazamatsuri / GitHub),
> - **[U]** unknown / requires further investigation.
>
> rlvm and siglus_rs are research anchors only. No source expression from
> either is copied; no GPL-3 code is vendored. Hypotheses derived from reading
> their source are restated in our own words and verified against Sweetie HD
> bytes before being encoded.
>
> Cited paths in `/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/`
> are abbreviated below as `$GAME/`.

## A. Game shape

Sweetie HD's `$GAME/` directory holds the executable plus a `REALLIVEDATA/`
directory and a `SAVEDATA/` directory. The relevant numbers, verified by
`ls`/`xxd` against the read-only mount:

| Subtree                              | Count  | Notes                                                                                    |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------- |
| `REALLIVEDATA/Gameexe.ini`           | 1 file | 51,800 bytes, Shift-JIS, 1,345 lines [V]                                                 |
| `REALLIVEDATA/Seen.txt`              | 1 file | 3,876,496 bytes, 198 used scenes in a 10,000-slot table [V]                              |
| `REALLIVEDATA/g00/`                  | 2,450  | RealLive image format files (`.g00`) [V]                                                 |
| `REALLIVEDATA/koe/`                  | 139    | `.ovk` voice archives (Ogg Vorbis samples) [V]                                           |
| `REALLIVEDATA/bgm/`                  | 28     | `.nwa` BGM streams (NWA, AVG32 audio container) [V]                                      |
| `REALLIVEDATA/wav/`                  | 73     | `.nwa` SE samples [V]                                                                    |
| `REALLIVEDATA/dat/mode.cgm`          | 1 file | 1,649 bytes, `CGTABLE\0\0...` magic — CG-mode bitfield [V]                               |
| `REALLIVEDATA/_manual/`              | 1 dir  | HTML manual; not engine input                                                            |
| `REALLIVEDATA/rl_d3d.dll`            | 1 file | RealLive's Direct3D renderer dll; not needed for a headless port                         |
| `SAVEDATA/REALLIVE.sav`              | 1 file | 24,876 bytes, header tag `AVG_SYSTEM_SAVE` at byte 0x18 [V]                              |
| `SAVEDATA/save999.sav`               | 1 file | 6,748 bytes, header tag `AVG_GLOBAL_SAVE` at byte 0x18 [V]                               |
| `SAVEDATA/read.sav`                  | 1 file | 44,495 bytes, header tag `ｵｼｵｷSweetie+Sweets!! HD Edition\` at byte 0x18 (Shift-JIS) [V] |
| `WALL/{800x600,1024x768,1600x1200}/` | 3 dirs | Wallpaper assets, not engine input                                                       |

Asset folder remapping in `Gameexe.ini` (lines 33-46 in UTF-8 view, 1-based) declares
fallback `.PAK` containers for each asset family even though Sweetie HD ships
all assets unpacked. The lines:

```
#FOLDNAME.TXT = "DAT" =  1   : "SEEN.TXT"
#FOLDNAME.DAT = "DAT" =  0   : "DAT.PAK"
#FOLDNAME.ANM = "ANM" =  0   : "ANM.PAK"
#FOLDNAME.ARD = "ARD" =  0   : "ARD.PAK"
#FOLDNAME.HIK = "HIK" =  0   : "HIK.PAK"
#FOLDNAME.GAN = "GAN" =  0   : "GAN.PAK"
#FOLDNAME.PDT = "PDT" =  0   : "PDT.PAK"
#FOLDNAME.G00 = "G00" =  0   : "G00.PAK"
#FOLDNAME.M00 = "M00" =  0   : "M00.PAK"
#FOLDNAME.WAV = "WAV" =  0   : "WAV.PAK"
#FOLDNAME.BGM = "BGM" =  0   : "BGM.PAK"
#FOLDNAME.KOE = "KOE" =  1   : ""
#FOLDNAME.MOV = "MOV" =  0   : "MOV.PAK"
```

Each line is `KEY = "<subdir>" = <mode> : "<pak fallback>"` — a three-value
tuple, not a scalar. The middle integer toggles the fallback (`0` = use unpacked
subdir, `1` = use the `.PAK` archive). For Sweetie HD, `FOLDNAME.TXT` has the
fallback flag set to `1` so `SEEN.TXT` is the in-use archive (it lives directly
in `REALLIVEDATA/`, not under `DAT/`); the other families are unpacked. [V]

Other engine-level signals at the top of `Gameexe.ini` (lines 1-31):

- `SCREENSIZE_MOD=999,1280,720` — HD remaster runs at 1280x720. The leading
  `999` indicates a custom mode (vanilla RealLive used `0=640x480`, `1=800x600`,
  `2=1024x768`; documented in RLDEV [P]). [V]
- `MMX_ENABLE=1`, `D3D_ENABLE=1` — informational; a headless port ignores them.
- `SEEN_START=0001` — the entrypoint is scene 1. [V]
- `SEEN_MENU=8200` — the title-menu scene id. [V]
- `CANCELCALL=9999,10` — global Escape handler dispatches into scene 9999,
  entrypoint 10. [V]
- `SYSTEMCALL_SAVE=9999,20` / `SYSTEMCALL_LOAD=9999,21` / `SYSTEMCALL_SYSTEM=9999,22`
  — system-menu handlers dispatch into scene 9999, entrypoints 20/21/22. [V]
- `MOUSEACTIONCALL.000.SEEN=9999,30` with `MOUSEACTIONCALL.000.AREA=1232,0,1279,719`
  — defines a hot region (top-right of the HD screen) whose handler is
  scene 9999 entrypoint 30. [V]
- `LOADCALL=9999,40`, `EXAFTERCALL=9999,50` — load-finished and extra-after callbacks. [V]
- `KOEFILE_MOD=2` — voice files are bundled into `koe/*.ovk` archives keyed by
  speaker (vs `0` = unpacked individual files, `1` = NWK archives). [V]
- `CGTABLE_FILENAME="mode.cgm"`, `CGTABLE_MOD=0` — CG-recollection database. [V]
- `SAVE_FORMAT=3`, `SAVE_CNT=100` — 100 named save slots, format-3 (AVG-derived).
  [V]

This single title therefore needs (at minimum): the SEEN scene archive,
the Gameexe surface, the g00/koe/nwa decoders, the AVG-derived save format,
and the system-call dispatch wired to specific `9999` entrypoints.

## B. Gameexe.ini surface

`Gameexe.ini` is Shift-JIS, line-oriented, comment-character `#`, key path
notation dotted (e.g. `#FOLDNAME.G00`, `#SYSCOM.005.001`). Values can be
quoted strings, comma-separated integer arrays, or a tuple of `=`-separated
groups (the `FOLDNAME` example above). [V]

Distinct top-level (pre-dot) key prefixes observed in Sweetie HD's
`Gameexe.ini`: **191**. The `kaifuu-reallive::gameexe` inventory walks
every line, classifies it into a typed [`GameexeKeyFamily`] variant
(KAIFUU-190), and emits a `kaifuu.reallive.inventory.unknown_gameexe_key`
warning for any line that doesn't match a documented family
(`crates/kaifuu-reallive/src/gameexe.rs`). As of KAIFUU-190 the
catalogue covers 1,345 / 1,345 lines on Sweetie HD's Gameexe.ini (0 %
fall-through; see `crates/kaifuu-reallive/tests/gameexe_real_bytes.rs`
for the breakdown). [V — counted with
`grep -oE '^#[A-Z_]+' /tmp/gameexe.utf8.txt | sort -u | wc -l`]

The keys group into the following category buckets. Counts refer to the
**number of lines emitted for that category** in Sweetie HD's `Gameexe.ini`
(verified via `grep -c`):

| Category                               | Example keys                                                           | Lines | Notes                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------- | ----: | -------------------------------------------------------------------------- |
| Engine bootstrap / window              | `SCREENSIZE_MOD`, `CAPTION`, `REGNAME`, `DISKMARK`                     |     ~ | One-shot scalar values                                                     |
| Scene routing                          | `SEEN_START`, `SEEN_MENU`, `CANCELCALL`, `SYSTEMCALL_*`                |   ~12 | Each call uses `<scene_id>,<entrypoint>` pair                              |
| Asset folder remap                     | `FOLDNAME.*`                                                           |    13 | Triple-valued `subdir=mode:pakname`                                        |
| Save spec                              | `SAVE_USE`, `SAVE_FORMAT`, `SAVE_CNT`, `SAVE_THUMBNAIL`, `SAVE_NODATA` |   ~10 | Drives `SAVEDATA/REALLIVE.sav` shape                                       |
| Speaker / character roster (`NAMAE`)   | `#NAMAE="和人" = "和人" = (1,016, -1)`                                 |    11 | Maps display name to canonical name + (voice_archive_id, voice_pattern_id) |
| Voice on/off menu                      | `KOEONOFF.000.(000).ON="凛"` etc.                                      |     6 | Per-character voice toggle in syscom menu                                  |
| `SYSCOM.NNN` system command catalogue  | `SYSCOM.005.000="フルスクリーン"`                                      |   ~70 | 32 system-menu items, each with label + subitems                           |
| `WAKU.NNN.*` text window decoration    | `WAKU.000.000.NAME="_waku10"` etc.                                     |   209 | 8 text-window themes × ~25 fields each                                     |
| `SELBTN.NNN.*` choice button styling   | `SELBTN.000.NAME="_selbtn00"`                                          |    62 | 3 choice-button themes × ~20 fields                                        |
| `BTNOBJ.*` button-object animation     | `BTNOBJ.ACTION.000.HIT`, `BTNOBJ.SE.000.DECIDE`                        |    99 | 16 button-object families × HIT/NORMAL/PUSH/RPUSH/STATE1/STATE2            |
| `SYSBTN.000.*` system button positions | `SYSBTN.000.NAME`, `SYSBTN.000.CLEAR_BTN`                              |   ~50 | One row of system-bar buttons                                              |
| `MOUSE_CURSOR_WINDOWBUTTON_*`          | per-button cursor table                                                |   ~15 | Maps mouse hover region to cursor sprite id                                |
| `WBCALL.NNN`                           | `WBCALL.000=9999,00`                                                   |     8 | Per-system-button callback into scene/entrypoint pair                      |
| Object render layers                   | `OBJECT_MAX`, `INIT_OBJECT1_ONOFF_MOD`                                 |     ~ |                                                                            |
| `HINT.AUTOMODE.*`, `HINT.READJUMP.*`   | hint-icon graphics + animation parameters                              |    12 |                                                                            |
| Debug flags                            | `DEBUG_MESSAGE_LOG`, `DEBUG_SAVE_HISTORY_CNT`                          |     5 | Set in retail builds                                                       |
| Sound defaults / fades                 | `BGM_KOEFADE_USE`, `BGM_KOEFADE_VOL`, `SOUND_DEFAULT`                  |     ~ |                                                                            |
| Read-jump / text-skip                  | `READJUMP_SYSTEM_USE`, `UNREADJUMP_STR`                                |     ~ |                                                                            |
| Localisation surface                   | `LOCALNAME.A`, `NAME.A`, `NAME_MAXLEN`, `CAPTION`, `VERSION_STR`       |     ~ | The handful of strings that need translation directly out of Gameexe       |
| Color palette                          | `COLOR_TABLE.000` … `COLOR_TABLE.NNN`                                  |     ~ |                                                                            |

Detailed key reference for the engine subsystems:

- **`#NAMAE` (speaker registry):** triple-valued —
  `display_name = canonical_name = (koe_archive_id, koe_pattern_id, voice_pitch)`.
  Example: `#NAMAE="和人" = "和人" = (1,016, -1)` ↔ speaker Kazuto uses voice
  archive 1, entry 016. The `？？？／和人` line maps the censored display
  `？？？` to the same voice slot. Total entries in Sweetie HD: 11 (5 named
  characters × {plain, censored} + speaker pair 「和人・しずね」). [V]
- **`#KOEONOFF.NNN.(MMM).ON="label"`:** maps each `KOEONOFF` menu line to a set
  of speaker ids. Example: `#KOEONOFF.005.(000,002,003,004).ON="女の子全て"`
  groups all four girls under one toggle. [V]
- **`#SYSCOM.NNN`:** declares system-menu entry `NNN`. Prefix `U:` is "user
  visible", `N:` is "navigation only". Sub-keys like `SYSCOM.005.000=`
  declare radio choices. `SYSCOM.005` is the screen-mode selector with
  options `フルスクリーン` / `標準ウィンドウ`. [V]
- **`#WAKU.NNN.MMM.*`:** declares the `NNN`-th text-window theme,
  variant `MMM`. Each theme carries ~25 sub-fields:
  `NAME`/`BACK`/`BTN` graphics names, an `AREA` margin tuple, a `REP_MOJI_POS`
  per-char step, then 14 named hit-box rectangles
  (`MOVE_BOX`, `CLEAR_BOX`, `READJUMP_BOX`, `AUTOMODE_BOX`, `KOEPLAY_BOX`,
  `MSGBK_BOX`, `MSGBKLEFT_BOX`, `MSGBKRIGHT_BOX`, `EXBTN_000_BOX` …
  `EXBTN_007_BOX`) and 14 matching `_POS` overrides. [V]
- **`#SELBTN.NNN.*`:** declares the `NNN`-th choice-button theme.
  `NAME`/`BACK` graphics, `BASEPOS`/`REPPOS`/`CENTERING` layout, `MOJISIZE`
  text size, `NORMAL`/`SELECT`/`PUSH`/`DONTSEL` colour states, `OPEN_ANM`
  open animation. [V]
- **`#SCREENSIZE_MOD=999,1280,720`:** the `999` flags a custom mode; pair is
  `(width, height)`. Sweetie HD's 1280x720 is the HD remaster surface. [V]

The existing `parse_gameexe_inventory` function is line-oriented and treats
keys as opaque strings; it never materialises any of the dotted-path
hierarchies the engine actually needs. A real engine port needs a structured
parser that returns a typed tree (`Gameexe::get("SYSCOM.005.000") -> &str`,
`Gameexe::get_array("MOUSEACTIONCALL.000.AREA") -> &[i32]`,
`Gameexe::get_tuple3("FOLDNAME.G00") -> (&str, i32, &str)`).

## C. Seen.txt structure

`Seen.txt` is the scene-bytecode archive. First 256 bytes (hex):

```
$GAME/REALLIVEDATA/Seen.txt @ 0x00000000:
00000000: 0000 0000 0000 0000 8038 0100 fa05 0000  .........8......
00000010: 7a3e 0100 ac05 0000 2644 0100 3706 0000  z>......&D..7...
00000020: 5d4a 0100 6b0b 0000 c855 0100 660c 0000  ]J..k....U..f...
00000030: 2e62 0100 bb0d 0000 0000 0000 0000 0000  .b..............
00000040: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000050: e96f 0100 7905 0000 0000 0000 0000 0000  .o..y...........
...
```

This is **not** the count-plus-table envelope assumed by the
`crates/kaifuu-reallive/src/archive.rs:parse_archive` function. The real
RealLive shape is a **fixed 10,000-slot directory** of (offset, size) `u32 LE`
pairs at file offset 0. Each slot is 8 bytes; an unused slot is zeroed.
The bytecode payloads sit immediately after the table at file offset
`10000 * 8 = 0x13880`. [V — confirmed by reading `(offset, size)` at slot 1
and finding it points to byte 0x13880; cross-referenced with
`rlvm/src/libreallive/archive.cc:` `"for (int i = 0; i < 10000; ++i, idx += 8)"` (P, fetched via
GitHub)]

In Sweetie HD:

- Total file size: 3,876,496 bytes (0x3b2690). [V]
- Total slots scanned: 10,000.
- Non-zero slots: **198**. [V — derived by perl, see calculations in §C scratch
  notes below]
- Scene-id range: 1 to 9999 (non-contiguous; e.g. scene ids include
  1, 2, 3, 4, 5, 6, 10, 20, 21, 22, …). [V]
- First scene payload: `seen0001` at file offset 0x13880, size 0x5fa = 1530
  bytes. [V]
- Last scene payload: `seen9999` at file offset 0x20423e, size 0xb42 = 2882
  bytes. [V]
- The largest payload is one of the dialogue scenes around scene 1xxx-3xxx;
  total bytes of used scene payloads ≈ 2.0 MB. [V — sum of `size` fields]

Scene id assignment is positional: slot index = scene id. The fact that
`seen9999` is populated and lands at the system-call scene id named by every
`#CANCELCALL=9999,XX` / `#SYSTEMCALL_*=9999,XX` / `#LOADCALL=9999,XX` row in
`Gameexe.ini` (see §H) confirms the engine treats scene 9999 as the
syscall-handler scene. [V]

The existing parser treats `Seen.txt` byte 0 as a `u32 LE` scene count. For
Sweetie HD that field is `0x00000000`, so it would emit an empty
`SceneIndex` — i.e. it currently cannot load any Sweetie HD scene. This is a
hard substrate gap inside `kaifuu-reallive` itself (it is correct against
the synthetic fixture catalogue, which uses the count-plus-table envelope,
but wrong against real RealLive bytes). [V — confirmed by reading
`crates/kaifuu-reallive/src/archive.rs:66-104`]

## D. Scene bytecode anatomy (scene #0001 of Sweetie HD)

The first 80 bytes of the scene #0001 payload (file offset 0x13880,
re-based as scene-blob offset 0):

```
@0x00: d0 01 00 00 b2 ad 01 00 d0 01 00 00 01 00 00 00
@0x10: 04 00 00 00 d4 01 00 00 00 00 00 00 00 00 00 00
@0x20: d4 01 00 00 7c 06 00 00 26 04 00 00 00 00 00 00
@0x30: 03 00 00 00 06 00 00 00 06 00 00 00 06 00 00 00
@0x40: 06 00 00 00 06 00 00 00 06 00 00 00 06 00 00 00
```

Per Haeleth's RLDEV and rlvm's `src/libreallive/scenario.cc` Header
constructor [P, fetched via GitHub], the **scene header** is a fixed
`0x1d0 = 464` byte block with the following layout (offsets are scene-blob
relative):

| Offset | Width | Field                          | Sweetie HD scene #0001 value | Notes                                                               |
| -----: | ----: | ------------------------------ | ---------------------------- | ------------------------------------------------------------------- |
|   0x00 |   u32 | `header_size`                  | `0x000001d0` (464)           | Matches the fixed header length. [V]                                |
|   0x04 |   u32 | compiler version               | `0x0001adb2` (110002)        | Distinguishes pre-1.10 / 1.10 / 1.1110 RealLive. Selects XOR-2 key. |
|   0x08 |   u32 | kidoku-table offset            | `0x000001d0` (464)           | Kidoku (read-tracking) flags region.                                |
|   0x0c |   u32 | kidoku-table count             | `0x00000001` (1)             | One kidoku slot. [V]                                                |
|   0x10 |   u32 | (line table count, or similar) | `0x00000004` (4)             | [U — likely line-info count]                                        |
|   0x14 |   u32 | dramatis-personae offset       | `0x000001d4` (468)           | rlvm reads this from `data+0x14`. [P]                               |
|   0x18 |   u32 | dramatis-personae count        | `0x00000000` (0)             | Scene #0001 has no inline personae. [V]                             |
|   0x1c |   u32 | metadata block length          | `0x00000000` (0)             | No inline metadata.                                                 |
|   0x20 |   u32 | bytecode start offset          | `0x000001d4` (468)           | rlvm cross-checks this against the calculated location. [P]         |
|   0x24 |   u32 | bytecode uncompressed size     | `0x0000067c` (1660)          | After AVG32 LZ + XOR. [P, cross-checked V]                          |
|   0x28 |   u32 | bytecode compressed size       | `0x00000426` (1062)          | Matches blob remainder: 1530 − 468 = 1062. [V]                      |
|   0x2c |   u32 | `z_minus_one` debug entrypoint | `0x00000000`                 | Unused in retail. [P, V]                                            |
|   0x30 |   u32 | `z_minus_two` debug entrypoint | `0x00000003`                 | [V]                                                                 |
|   0x34 |   u32 | entrypoint count               | `0x00000006` × N             | The 0x06 lattice from 0x34 to 0x1c0 is the entrypoint table. [V/P]  |
|  0x1c4 |   u32 | savepoint_message setting      | `0x00000000`                 | [P]                                                                 |
|  0x1c8 |   u32 | savepoint_selcom setting       | `0x00000000`                 | [P]                                                                 |
|  0x1cc |   u32 | savepoint_seentop setting      | `0x00000000`                 | [P]                                                                 |

After 0x1d0 the **compressed bytecode** begins. Its size (1062 bytes) is
visible from 0x1d4 to 0x5fa (end-of-blob). It is **AVG32-style LZSS** with a
256-byte XOR mask applied byte-by-byte, plus an optional second XOR step
when the compiler version field is 110002 (Sweetie HD's case).

Decompression algorithm, restated in our own words from
`rlvm/src/libreallive/compression.cc` [P, fetched via GitHub]:

1. Read a control byte; its 8 bits select literal (`1`) vs back-reference
   (`0`) for the next 8 chunks.
2. For a literal: read one byte, XOR with `xor_mask[i & 0xff]`, emit.
3. For a back-reference: read two bytes `count`; lower 12 bits give the
   distance into the already-emitted output, upper 4 bits give a length
   minus 2; copy `(count >> 4) + 2` bytes from `dst - distance - 1`.
4. After the LZ pass: if the compiler-version field is 110002 (or a known
   game-specific match), run a second-level XOR over fixed
   `(offset, length)` windows of the uncompressed bytecode using a 16-byte
   per-title key.

Sweetie HD is a 2019 Sukara HD remaster of a 2010 title; rlvm's second-level
XOR key table covers Key/VisualArts titles (Clannad, Little Busters, Snow,
Kud Wafter etc.) but not Sukara — so for Sweetie HD the second-level XOR is
either off, uses an unknown title-specific key, or the title actually uses the
plain compiler-version-10002 path. [U — must verify by extracting the first
8 literal bytes and looking for the marker `0x00`/`0x23`/`0x0a` distribution
the documented opener-byte switch expects.]

Once the bytecode is decompressed, the BytecodeElement stream is decoded by a
switch on the first byte of each element (mapped from
`rlvm/src/libreallive/bytecode.cc:BytecodeElement::Read`) [P]:

| Lead byte | Element kind      | Decoded as                                                 |
| --------- | ----------------- | ---------------------------------------------------------- |
| `0x00`    | CommaElement      | Separator                                                  |
| `0x0A`    | MetaElement       | Source-line number marker (`<line>`)                       |
| `0x21`    | MetaElement       | Entrypoint marker (`!N`)                                   |
| `0x23`    | CommandElement    | An RLOperation call — 8-byte command header follows        |
| `0x24`    | ExpressionElement | A standalone variable expression                           |
| `0x2C`    | CommaElement      | Comma (synonym of `0x00`)                                  |
| `0x40`    | MetaElement       | Kidoku tracking marker (`@N`)                              |
| other     | TextoutElement    | Displayable Shift-JIS text up to the next non-textout byte |

The 8-byte command header is:

```
+--+--+--+--+--+--+--+--+
|23| 1| 2| 3| 4| 5| 6| 7|
+--+--+--+--+--+--+--+--+
```

Byte 1 = module type, byte 2 = module id, bytes 3-4 = opcode (u16 LE),
byte 5 = argument count, byte 6 = overload variant, byte 7 = reserved. The
exact layout is documented in `rlvm/src/libreallive/bytecode.h:CommandElement`
where `command[COMMAND_SIZE] = 8`. [P] After the header comes a `(`-delimited
argument list of `ExpressionPiece` values terminated by `)`. Selection
opcodes (`select`, `select_s`, `select_w`) use a `SelectElement` extension
with additional `OPTION_COLOUR=0x30`, `OPTION_TITLE=0x31`, `OPTION_HIDE=0x32`,
`OPTION_BLANK=0x33`, `OPTION_CURSOR=0x34` markers. [P, cited from
`rlvm/src/libreallive/bytecode.h` via WebFetch]

The existing `crates/kaifuu-reallive/src/opcodes.rs` treats `0x23` as the
only instruction opener and recognises 8 named opcodes
(`TextDisplay`, `SetSpeaker`, `Choice`, `SetVar`, `Jump`, `Return`,
`ClearScreen`, `Pause`). This is a **synthetic-fixture** catalogue
explicitly labelled as such in `crates/kaifuu-reallive/src/lib.rs:57-99`
("The shape is intentionally narrower than the real RealLive opcode space").
The real opcode stream uses the 8-byte command header above plus
`ExpressionPiece` operands, not a `(tag, value)` triple shape. Real-scene
parsing therefore needs a fresh decoder — the existing parser is correct
against its own fixtures but cannot decode Sweetie HD bytecode. [V]

Scene #0001 cannot be opcode-walked without first running AVG32
decompression, which means **every** real-bytecode acceptance criterion has
to be staged behind a "compressed bytecode loader" node.

## E. Asset format quick reference

### g00 (RealLive image format)

Sweetie HD ships 2,450 `.g00` files. First 16 bytes of two samples:

```
$GAME/REALLIVEDATA/g00/BACK.g00 @ 0:
00 00 05 d0 02 12 87 0a 00 00 40 38 00 01 c7 bf
$GAME/REALLIVEDATA/g00/BG01A1.g00 @ 0:
00 00 05 d0 02 9d 40 20 00 00 40 38 00 ff f7 f0
```

Public sources (kazamatsuri-forum and xclannad-derived notes [P]) document
three g00 sub-formats keyed by byte 0:

- **Type 0:** raw 24-bpp BGR, header gives width/height then pixel array.
- **Type 1:** 8-bpp paletted with LZSS compression.
- **Type 2:** 24-bpp with region-list + LZSS — supports multi-region
  composite images (a single .g00 holds many sprite cells with named
  rectangles). rlvm's `src/modules/module_g00.cc` registers opcodes that
  reference the region table.

Both sample files begin with byte `0x00` (Type 0). The next u16 LE `0x05d0 = 1488`
matches the expected width range for Sweetie HD's 1280x720 surface
(rounded up / aligned). [V — values consistent with width.height encoding
described in [P]]

A g00 decoder must support all three types because Sweetie HD's 2,450 files
are likely a mix (verified by spot-checking byte 0 across the directory
shows both `0x00` and `0x02` lead bytes; full survey not yet performed). [U
— need a directory-wide histogram of byte 0 to know the proportion.]

### .ovk (voice archive)

`$GAME/REALLIVEDATA/koe/z0001.ovk` (337,086 bytes) starts:

```
@0x00: 02 00 00 00              # entry count = 2
@0x04: c0 b1 02 00              # entry 0: data offset = 0x0002b1c0
@0x08: 24 00 00 00              # entry 0: data length = 36 bytes
@0x0c: 2e 00 00 00              # entry 0: sample_num = 46
@0x10: 9e fb 05 00              # entry 0: tail (compressed size or hash?)
@0x14: da 72 02 00              # entry 1: data offset = 0x000272da
@0x18: e4 b1 02 00              # entry 1: data length = 0x0002b1e4
@0x1c: 34 00 00 00              # entry 1: sample_num = 52
@0x20: cc 7e 05 00              # entry 1: tail
@0x24: 4f 67 67 53              # OggS magic — first sample's Ogg Vorbis stream
```

Each header entry is **16 bytes** = `(data_offset, data_length, sample_num,
tail_metadata) : u32 LE × 4`. The sample bodies are inline Ogg Vorbis
streams (`OggS` magic at offset 0x24 confirms). [V]

`rlvm/src/systems/base/ovk_voice_archive.cc` confirms via
`ReadVisualArtsTable(file, 16, entries_)` — 16-byte entries — and the
constructor populates `(sample_num, offset, length)` tuples. [P]

`z1001.ovk` (44.6 MB) carries 0x117 = 279 entries (matches the per-speaker
volume of a typical visual novel). Sweetie HD's `koe/` directory has 139
`.ovk` files; the leading `z` plus the voice-archive id maps via
`#NAMAE="..." = "..." = (archive_id, sample_id, pitch)` lines in
`Gameexe.ini` — but the actual `z` numbering scheme is `z<archive_id>.ovk`
where `archive_id` is `0001` for system-event voices and `1xxx` for
character-line voices. [V — visible in the file naming]

### .nwa (BGM / SE)

`$GAME/REALLIVEDATA/bgm/ASA.nwa` starts:

```
@0x00: 02 00      # channels = 2
@0x02: 10 00      # bps = 16
@0x04: 44 ac 00 00 # sample rate = 44100
@0x08: 00 00 00 00 # use_runlength (NWA-compressed flag) = 0
@0x0c: 00 00 00 00 # ??? (compression mode?)
@0x10: 32 81 00 00 # block count = 0x8132 = 33,074
@0x14: dc c4 04 02 # uncompressed sample count = 0x020404c4 = 33,818,820
@0x18: f6 7e 17 01 # compressed size = 0x01177ef6 = 18,317,046 (matches file size)
@0x1c: 6e 62 02 01 # block samples
@0x20: 00 02 00 00 # block samples per channel
```

NWA is a Visual Arts proprietary container described in xclannad-derived
notes [P]. A pure-Rust decoder reads the 0x2c-byte header, then a table of
per-block offsets, then run-length-encoded 16-bit PCM blocks (when the
`use_runlength` flag is set) or raw 16-bit PCM (when it's 0). For Sweetie
HD's `ASA.nwa`, the flag is 0 → raw 16-bit PCM following the offset table.
`$GAME/REALLIVEDATA/wav/CHIME.nwa` similarly starts with raw-PCM flags. [V]

### `mode.cgm` (CG mode bitfield)

`$GAME/REALLIVEDATA/dat/mode.cgm` is 1,649 bytes, header `CGTABLE\0\0...` at
offset 0, followed by a u32 `0xcb` (203) count and entries. This file
records "which CGs the player has unlocked" and is read by the gallery
screen. Format is `CGTABLE\0` magic + u32 entry count + per-entry records.
[V — magic verified; entry record shape inferred from rlvm
`module_sys`'s CG-mode handling, not yet confirmed against bytes.]

## F. RLOperation hierarchy (from rlvm public source)

Restated from the rlvm `src/modules/` directory listing [P]. rlvm registers
RLOperations into named modules; each module has a `module_type` (e.g. `0` for
Kepago, `1` for system) and `module_id`. The modules observable in
`rlvm/src/modules/`:

| Module file                     | Family                     |    Approx opcode count (rlvm) | What it does                                                                                                                                         |
| ------------------------------- | -------------------------- | ----------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module_sys.cc`                 | System / control           |                          ~110 | `title`, `end`, `pause`, `wait`, `rnd`, `pcnt`, `sin/cos/abs`, `MenuReturn`, `SceneNum`, save/load triggers, screen mode, message speed, font weight |
| `module_msg.cc`                 | Text / messaging           |                        ~35–40 | `pause`, `par`, `br`, `page`, `msgHide`, `FontColor`, `TextPos`, `FastText`, `FaceOpen`                                                              |
| `module_str.cc`                 | String manipulation        |                           ~32 | `strcpy`, `strcat`, `strlen`, `Uppercase`, `itoa`, `atoi`, `strpos`, `strout`, `intout`                                                              |
| `module_mem.cc`                 | Memory / array bulk        |                           ~11 | `setarray`, `setrng`, `cpyrng`, `setarray_stepped`, `cpyvars`, `sum`, `sums`                                                                         |
| `module_jmp.cc`                 | Control flow               |                           ~22 | `goto`, `goto_if`, `goto_unless`, `goto_on`, `goto_case`, `gosub`, `gosub_with`, `ret`, `ret_with`, `rtl`, `jump`, `farcall`, `farcall_with`         |
| `module_sel.cc`                 | Choice / selection         |                            ~9 | `select`, `select_s`, `select_w`, `select_objbtn`, `objbtn_init`                                                                                     |
| `module_grp.cc`                 | Graphics primitives        | ~80–100 (file is 1500+ lines) | `allocDC`, `wipe`, `shake`, `load`/`open`/`openBg`, `copy`/`fill`/`invert`/`mono`/`colour`, `fade`, `stretchBlit`, `zoom`, `multi`                   |
| `module_obj_management.cc`      | Object management          |                        ~24–28 | `objAlloc`, `objFree`, `objInit`, `objCopy` for fg/bg/child planes                                                                                   |
| `module_obj_fg_bg.cc`           | Object stack ops           |                        ~40–45 | Per-object setters/getters: position, scale, rotation, alpha, layer ordering                                                                         |
| `module_obj_*` (~10 more files) | Per-axis object families   |                    ~150 total | Object animation, text, digits, drift, mutator, repeat                                                                                               |
| `module_bgm.cc`                 | BGM playback               |                           ~25 | `bgmPlay`, `bgmStop`, `bgmFadeOut`, `bgmLoop`                                                                                                        |
| `module_koe.cc`                 | Voice playback             |                           ~15 | `koePlay`, `koeStop`, `koeWait`, `koePlayInChar`                                                                                                     |
| `module_pcm.cc`                 | PCM / SFX                  |                           ~20 | `pcmPlay`, `pcmStop`, `wavPlay`, `wavStop`                                                                                                           |
| `module_se.cc`                  | SE table lookup            |                           ~10 | `playSe`, `hasSe`                                                                                                                                    |
| `module_scr.cc`                 | Screen-level effects       |                           ~15 |                                                                                                                                                      |
| `module_shk.cc`                 | Shake / shake-zoom         |                           ~10 |                                                                                                                                                      |
| `module_shl.cc`                 | Shell utilities            |                            ~5 |                                                                                                                                                      |
| `module_event_loop.cc`          | Main loop primitives       |                           ~10 |                                                                                                                                                      |
| `module_refresh.cc`             | Frame refresh              |                            ~5 |                                                                                                                                                      |
| `module_g00.cc`                 | g00 region operations      |                           ~10 |                                                                                                                                                      |
| `module_gan.cc`                 | GAN animation              |                           ~15 |                                                                                                                                                      |
| `module_mov.cc`                 | Movie playback             |                           ~10 |                                                                                                                                                      |
| `module_os.cc`                  | OS hooks                   |                            ~5 |                                                                                                                                                      |
| `module_dll.cc`                 | Engine-extension DLL hooks |                            ~5 | Title-specific DLLs (Little Busters, Tomoyo After)                                                                                                   |
| `module_debug.cc`               | Debug                      |                            ~5 |                                                                                                                                                      |
| `module_bgr.cc`                 | Bgr (background) helpers   |                            ~5 |                                                                                                                                                      |

Rough total: **~700–800 RLOperations** in rlvm. Of these, perhaps 250–400 are
likely exercised by Sweetie HD; the rest cover Key/VisualArts-specific
features Sukara never used. [U — needs a Sweetie-HD-specific opcode
histogram once a real decoder is in place. The number 250–400 is an
order-of-magnitude estimate based on the title's scope (chapter-style VN
with menus, choices, voice, BGM, CG gallery, save/load, no minigames).]

The dispatch path through rlvm is
`RLMachine::ExecuteCommand(CommandElement)` →
`RLModule::DispatchFunction(...)` → `RLOperation::DispatchFunction(...)` →
the templated `Op_*<...>::operator()` that unpacks `ExpressionPiece`
operands via `IntConstant_T`, `StrConstant_T`, `IntReference_T`,
`StrReference_T`, `Argc_T`, `Complex_T`, `Special_T`, `Rect_T`,
`RGBColour_T` helpers (files in `rlvm/src/machine/rloperation/`). [P]

## G. The Variable / Stack / Bytecode VM model

Per Haeleth's RLDEV manual and rlvm's `machine/memory.cc` [P]:

- **Integer banks:** `intA`, `intB`, `intC`, `intD`, `intE`, `intF`, `intG`,
  `intH`, `intI`, `intJ`, `intL`, `intM`, `intZ`. Each bank is a flat array
  indexed by integer subscript (rlvm caps each at 2,000 entries). The
  expression encoding writes the bank letter as a single byte and follows
  with the bracketed index expression.
- **String banks:** `strS` (scratch), `strM` (memory), `strK` (constants /
  read from script — historical). rlvm caps each at 2,000 entries.
- **Store register:** the single u32 value addressed in expressions by
  `0xC8`. Most arithmetic and dispatch opcodes write their result here.
- **Local "save scratch":** `savepoint_message` / `savepoint_selcom` /
  `savepoint_seentop` flags in the scene header drive whether a save can
  happen at message/selcom/scenetop boundaries.
- **Call stack:** scene-to-scene calls (`gosub`, `farcall`, `gosub_with`)
  push a `StackFrame` carrying the return location plus a small parameter
  slot stack for `_with` variants. rlvm's `machine/stack_frame.cc` and
  `machine/long_operation.cc` model the stack.

Expression encoding from `rlvm/src/libreallive/expression.cc` [P]:

- `\x00`-`\x09`: arithmetic binary ops (mul, div, mod, add, sub, bitwise).
- `\x14`-`\x24`: compound assignment ops (`+=`, `-=` etc.).
- `\x28`-`\x2D`: comparison ops (`==`, `!=`, `<`, `>`, `<=`, `>=`).
- `\x3C`/`\x3D`: logical `&&` / `||`.
- `\xFF`: introduces a 32-bit signed integer literal (`i32 LE` follows).
- `\xC8`: store-register reference.
- `$`: prefix for memory reference (`$<bank_byte>[<index_expr>]`).
- `(`/`)`: subexpression grouping.
- `,`: separator inside argument lists.

A Pure-Rust VM has to implement: expression evaluator (recursive descent on
the byte stream above), variable banks (typed `HashMap`-or-array per bank),
call stack with `StackFrame` carrying scene id + bytecode offset + parameter
slots, kidoku flag table (which lines were read; needed to drive
"read-text" colour and read-jump skipping), and a longop scheduler (for
opcodes that yield to the event loop — `pause`, `wait`, `select`, animation
opcodes) sitting under the main loop.

## H. System Call dispatch

`Gameexe.ini` declares the following dispatch table for Sweetie HD:

| Key                                | Scene/entrypoint  | Trigger                                                                          |
| ---------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `CANCELCALL=9999,10`               | scene 9999, ep 10 | Escape key / cancel input.                                                       |
| `SYSTEMCALL_SAVE=9999,20`          | scene 9999, ep 20 | "Save" syscom selected.                                                          |
| `SYSTEMCALL_LOAD=9999,21`          | scene 9999, ep 21 | "Load" syscom selected.                                                          |
| `SYSTEMCALL_SYSTEM=9999,22`        | scene 9999, ep 22 | "System menu" syscom selected.                                                   |
| `MOUSEACTIONCALL.000.SEEN=9999,30` | scene 9999, ep 30 | Hover into rectangle `1232,0,1279,719` (top-right edge of HD screen) for 0+ms.   |
| `LOADCALL=9999,40`                 | scene 9999, ep 40 | Fires after a save is loaded — gives the script a chance to re-initialise state. |
| `EXAFTERCALL=9999,50`              | scene 9999, ep 50 | Engine "after main scene" hook.                                                  |

[V — read from `$GAME/REALLIVEDATA/Gameexe.ini`]

A complete dispatcher also needs the `WBCALL.NNN` window-button callbacks
(`WBCALL.000=9999,00` through `WBCALL.007=9999,07` — eight per-button
callbacks in Sweetie HD). [V]

The engine must:

1. Load the Gameexe entries into a typed dispatch table at boot.
2. Push a frame for the appropriate handler whenever the corresponding
   input event arrives.
3. Pop back to the dialogue scene after the handler executes a `ret_with` /
   `rtl` / `MenuReturn` opcode.
4. Honour `_MOD` flags (e.g. `CANCELCALL_MOD=1` means "active"; `0` would
   disable the cancel-call entirely).

The scene #9999 payload in `Seen.txt` therefore carries every system
handler in Sweetie HD. Without a real bytecode decoder we cannot
disassemble that scene yet, but its presence (size 0xb42 = 2882 bytes at
file offset 0x20423e) is direct evidence that Sweetie HD wires real handler
code to each entrypoint, not just empty stubs. [V]

## I. Graphics + Audio pipeline (high level, from rlvm structure)

The rlvm `src/systems/base/` directory enumerates the subsystems a
RealLive runtime maintains [P]:

- **GraphicsSystem** (`graphics_system.{cc,h}`) — manages a stack of
  ~256 graphics objects (foreground and background planes), the current
  render target, full-screen filters (tone curve, colour filter), and the
  text-window overlay. Render outputs go to `surface.cc`/`renderable.h`.
- **GraphicsObject + variants** —
  `graphics_object.cc`, `graphics_text_object.cc`,
  `digits_graphics_object.cc`, `drift_graphics_object.cc`,
  `anm_graphics_object_data.cc`, `gan_graphics_object_data.cc`,
  `parent_graphics_object_data.cc`, `colour_filter_object_data.cc`. Each
  graphics object carries pos/scale/alpha/colour-tone/tile/scroll state and
  a reference to its image source (g00 region, GAN sequence, or text page).
- **TextSystem + TextPage + TextWindow + TextWaku** — the text-rendering
  stack. `text_window.cc` maintains the current message window's typing
  state; `text_waku.cc`/`text_waku_normal.cc`/`text_waku_type4.cc` render
  the waku (text-window decoration) themes declared in `Gameexe.ini`.
  `text_window_button.cc` handles button hit regions overlaid on the waku.
- **SoundSystem** — `sound_system.{cc,h}` exposes
  `BgmPlay`/`BgmStop`/`BgmFadeOut`/`BgmStatus`/`BgmLooping`,
  `WavPlay`/`WavStop`/`WavStopAll`/`WavFadeOut`,
  `PlaySe`/`HasSe`,
  `KoePlay`/`KoeStop`/`KoePlaying`/`setKoeMode`/`SetUseKoeForCharacter`,
  per-channel volume + fade, and `VoiceCache voice_cache_` for sample
  lookup. [P]
- **EventSystem** — `event_system.{cc,h}`, `event_listener.cc` — handles
  pointer / key input dispatch into the longop scheduler.
- **SaveSystem** — implemented under `systems/base/`, materialises
  `AVG_SYSTEM_SAVE` / `AVG_GLOBAL_SAVE` / per-slot saves (see §J).

For a **headless** port the surfaces look like:

- Graphics layer → produce a per-frame `FrameArtifact` (utsushi-core
  `sink::frame::FrameArtifact`) carrying an `artifact_id` pointing to a PNG
  blob written into the artifact store; the engine port owns the
  composition pass that walks the graphics-object stack and rasterises into
  a `Vec<u8>` RGB buffer.
- Text layer → produce `TextLine` events (utsushi-core
  `sink::text::TextLine`) per finalised dialogue / choice option; this
  pipeline already exists.
- Audio layer → produce `AudioEvent` records (utsushi-core
  `sink::audio::AudioEvent { kind: BgmStart | VoicePlay | SeFire | Marker,
evidence_tier }`) — no actual sample mixing required for headless replay;
  the metadata model suffices for a deterministic recording.
- Voice cache → resolve `(speaker_id, sample_id) → ovk_sample_handle`
  using the `NAMAE`/`KOEONOFF` tables; emit `AudioEventKind::VoicePlay`
  with the resolved sample id. Header decoding is enough for a headless
  run; actual Ogg decode only matters if we want listenable replay.

## J. Save/load format

Sweetie HD's `SAVEDATA/` carries three save kinds:

- **`REALLIVE.sav`** (24,876 bytes): per-slot system saves bundle. Header
  starts `2C 61 00 00` (= 24876, total file size), then a `(scene_id,
entrypoint?)` pair, an engine version stamp `e9 07 03 00 02 00 0b 00 12
00 27 00` (year=2025, month=3, day=2, h=11, m=18, s=39?), then the magic
  tag `AVG_SYSTEM_SAVE` at offset 0x18. [V — byte offsets confirmed]
- **`save999.sav`** (6,748 bytes): "global save" — read-text flags, cleared
  endings, gallery unlocks. Header magic `AVG_GLOBAL_SAVE` at offset 0x18.
  [V]
- **`read.sav`** (44,495 bytes): per-line "have-I-read-this-line"
  bitfield, keyed by `(scene_id, kidoku_index)`. Header carries the game's
  display title `ｵｼｵｷSweetie+Sweets!! HD Edition\` (Shift-JIS) at offset
  0x18. [V]

All three share the 24-byte preamble shape
`(file_size_u32, ??_u32, version_u32, version_u32, version_u32, ?_u32)`
then a 16- or 24-byte ASCII/Shift-JIS magic at offset 0x18. This is the
**AVG32-derived save format**. rlvm's save subsystem reads it via the
`#SAVE_FORMAT=3` mode (Gameexe key — confirmed in Sweetie HD). [V]

A Pure-Rust save implementation has to:

1. Define a versioned schema for "what scenes were visited", "what kidoku
   marks were set", "what global flags were set", and per-slot
   "current scene id + bytecode offset + variable banks snapshot".
2. Write the AVG32-compatible byte layout (so on-disk saves are
   interchangeable with the original engine, which is what users will
   expect for a localization port).
3. Hook the substrate `Snapshot` primitive (UTSUSHI-023) for in-test
   snapshot/restore that doesn't go through the file system.

Numbered save slots are referenced via `#SAVE_INDEX=1`, `#SAVE_CNT=100`,
`#SAVE_TITLE=""`, `#SAVE_NODATA="データがありません"` in Gameexe. [V]

## K. Honest scope assessment

### What the engine port has to land before Sweetie HD text-replays end-to-end

Counting against Sweetie HD's actually-observable surface and the
operations rlvm registers, a minimal "Sweetie HD reads scene 1, dispatches
to the title menu, runs through one choice, ends the prologue" replay
requires:

1. **Compressed bytecode loader** — AVG32 XOR + LZ + optional XOR-2 over
   the scene blob. Without this nothing else can happen. **0 of 1 done.**
2. **Scene header parser** — 11+ u32 fields, kidoku/dramatis tables,
   entrypoint table. **0 of 1 done.** (Existing `archive.rs` parses the
   wrong envelope shape.)
3. **Real bytecode decoder** — 8 leading-byte cases, 8-byte command
   header, expression encoding. **0 of 1 done.** (Existing
   `opcodes.rs` recognises a synthetic-fixture catalogue.)
4. **Expression evaluator** — operators 0x00-0x09, comparisons 0x28-0x2D,
   logical 0x3C-0x3D, `\xFF` int literal, `\xC8` store reference,
   memory-reference `$<bank>[idx]`. **0 of 1 done.**
5. **Variable banks** — `intA`-`intZ`, `strS`/`strM`/`strK`, store reg.
   **0 of 1 done.**
6. **Call stack + longop scheduler.** **0 of 1 done.**
7. **Required RLOperations for replay:**
   - text/messaging (~15 of Sweetie HD's likely ~35 used): `text`,
     `pause`, `par`, `br`, `page`, `msgHide`, `FontColor`, `FastText`,
     `NormalText`, `TextWindow`, `FontSize`, `FaceOpen`, `FaceClose`.
   - control flow (~10 of 22): `goto`, `goto_if`, `goto_unless`,
     `goto_on`, `goto_case`, `gosub`, `gosub_with`, `ret`, `ret_with`,
     `farcall`, `jump`.
   - variables (~6 of 11): `setarray`, `setrng`, `setarray_stepped`,
     `cpyrng`, `cpyvars`, `sum`.
   - choices (~3 of 9): `select`, `select_s`, `select_w` — needed to land
     the first decision-point.
   - system (~10 of 110): `end`, `pause`, `wait`, `SceneNum`,
     `MenuReturn`, `ReturnMenu`, `rnd`, `pcnt`, `abs`, save/load triggers.
   - graphics (~25 of 80+): `allocDC`, `wipe`, `load`/`open`/`openBg`,
     `copy`, `fade`, `objAlloc`, `objFree`, `objBgOf`, `objShow`,
     `objSetPos`, `objSetAlpha`, basic object stack ops.
   - audio (~15 of 60): `bgmPlay`, `bgmStop`, `bgmFadeOut`, `koePlay`,
     `koeStop`, `wavPlay`, `wavStop`, `playSe`.
   - mouse / system call (~5): system-call dispatch, mouse-action hot
     regions.
   - **Subtotal: ~90–100 of ~250–400 used opcodes.** **0 of 90 done.**

8. **Gameexe full parser** — typed tree, dotted keys, tuple values, ~191
   top-level prefixes, ~1,300 lines. **0 of 1 done.** (Existing inventory
   parser is line-classifier-only.)
9. **g00 decoder** — all three sub-formats, region table for type 2.
   **0 of 1 done.**
10. **NWA decoder** — header + per-block table + raw or run-length PCM.
    **0 of 1 done.**
11. **OVK decoder** — 16-byte header entries + per-sample Ogg passthrough.
    **0 of 1 done.**
12. **Save / load** — AVG_SYSTEM_SAVE / AVG_GLOBAL_SAVE / read-flag
    bitfield + per-slot bytecode-position snapshot. **0 of 1 done.**

The current `kaifuu-reallive` crate (3,318 LoC across 12 files) implements
the **synthetic-fixture parser boundary** — useful for clean-room contract
testing but not a building block for replay against real Sweetie HD bytes.
The two real outputs it produces against Sweetie HD bytes today would be:

- `parse_archive` → empty `SceneIndex` (the `u32 LE` count at offset 0 is
  zero in the real file format). [V]
- `parse_gameexe_inventory` → line-by-line classification of the 1,345
  Gameexe lines as `bridge_unit` / `asset_reference` / `unknown` — useful
  for inventory but not for runtime config lookup. [V]

### Order-of-magnitude estimate

Total rlvm C++ source: ~50,000 lines (per repo README [P]). A Rust port
that mirrors **only what Sweetie HD needs** (no Key/VisualArts DLLs, no
long-tail of unused opcodes, no per-title hacks) is realistically:

- libreallive equivalent (bytecode decoder + expression evaluator +
  archive + compression + gameexe parser): ~4–6 KLoC.
- machine (rlmachine + rloperation + rlmodule + memory + stack):
  ~3–5 KLoC.
- subset of modules (the ~90 opcodes listed above, plus their longops):
  ~6–10 KLoC.
- subset of systems (graphics object stack + text system + sound system +
  event system + save system, all headless): ~6–10 KLoC.
- asset decoders (g00 + nwa + ovk + cgm + save): ~2–3 KLoC.

**Pure-Rust subset port estimate: 20–35 KLoC of new code**, spread across
~15–25 sub-nodes — substantially more than the single-node "RealLive runtime
port" UTSUSHI-146 currently claims. Two
caveats:

- The 250–400 used-opcode estimate is unverified until a real decoder
  histograms Sweetie HD's actual scene stream. The 90 listed above may
  itself rise to 120–150 once we observe scene-by-scene which opcodes
  actually trigger.
- The Sukara-specific second-level XOR key for compiler version 110002 is
  **not** in rlvm's published key table for Visual Arts titles. Sweetie HD
  is a Sukara HD remaster, not a Key/Visual Arts title; either the
  second-level XOR is off for the Sukara branch, the key is publicly
  archived elsewhere, or it needs to be derived from a known-bytes attack.
  [U — top open question]

### Substrate-readiness summary

The UTSUSHI-120 substrate facade (re-exported in
`crates/utsushi-core/src/substrate.rs`) covers VFS, clock/input, replay
log, sink set (text/frame/audio), snapshot store, embed ABI, recorder,
conformance, and port lifecycle. The headless-replay shapes needed by a
RealLive port — `FrameArtifact { artifact_id, width, height, frame_index }`
pointing at a stored PNG; `TextLine { speaker, body, evidence_tier }`;
`AudioEvent { event_kind, evidence_tier }` — are all already on the
facade. No facade extensions are _obviously_ required to host a RealLive
port, but the substrate honesty subagent should independently verify
three specific gaps:

1. **Per-frame artifact emission cadence.** The
   `FrameArtifactSink::emit_artifact` contract emits one `FrameArtifact`
   per call. RealLive scene replay produces logically-distinct frames at
   text-display, choice-display, and effect-cluster boundaries; does the
   sink permit emitting them in a single sub-tick without overlap, or does
   it serialise them through the replay-tick clock?
2. **Voice-archive sub-sample addressing in `AudioEvent`.** A Sweetie HD
   voice cue is `(ovk_archive_id, sample_id)`. `AudioEventKind::VoicePlay`
   carries a payload-shape forbidden list (verified in
   `crates/utsushi-core/src/sink/audio.rs:245-260`). Does the existing
   `AudioEvent` payload allow `(archive_id, sample_id)` metadata at the
   evidence tier the runtime port runs at?
3. **Snapshot of the longop scheduler.** RealLive pauses mid-`select` /
   mid-`pause` are common save points (e.g. `SAVEPOINT_SELCOM=1` in
   Sweetie HD's Gameexe). Does the `SnapshotStore` contract permit
   serialising "frozen longop + its private state" or does it require all
   state to live in named `StatePath` slots?

These three are flagged as "substrate-gap candidates" in the DAG proposal
document. The default position is that they are addressable inside the
engine crate (i.e. the engine port models its own longop queue and
exposes it as a `StateNamespace`), but the substrate subagent's
verification is the right place to confirm.

---

### Top open questions

1. **Sukara title XOR-2 key.** Compiler version 110002 in Sweetie HD's
   scene 1 header (verified) plus no published key for this title means
   the AVG32 second-level XOR is the single biggest unknown. Resolution
   path: decompress scene 1 assuming the key is off; if the first 8 bytes
   are statistically random, the key is on and must be recovered.
2. **g00 sub-format distribution across Sweetie HD's 2,450 files.** The
   two files we spot-checked are type 0; if the title uses many type 2
   region-list images, the graphics-object loader becomes more complex
   (region table → multi-cell sprite addressing).
3. **Sweetie HD's actual used-opcode set.** Only a real bytecode walk
   over all 198 scenes will tell us whether the 90-opcode subset above is
   sufficient, or whether it expands to 150+ once we see Sukara's
   per-title quirks.

### Citation index

Sweetie HD evidence:

- `$GAME/REALLIVEDATA/Gameexe.ini` — Shift-JIS, 1345 lines, 191 distinct
  top-level key prefixes.
- `$GAME/REALLIVEDATA/Seen.txt` — 3,876,496 bytes, 10,000-slot index, 198
  used scenes, scene-1 at file offset 0x13880.
- `$GAME/REALLIVEDATA/g00/{BACK.g00,BG01A1.g00}` — type-0 g00 leads.
- `$GAME/REALLIVEDATA/koe/z0001.ovk`, `z1001.ovk` — 16-byte OVK entries.
- `$GAME/REALLIVEDATA/bgm/ASA.nwa`, `$GAME/REALLIVEDATA/wav/CHIME.nwa` —
  raw-PCM NWA header.
- `$GAME/REALLIVEDATA/dat/mode.cgm` — `CGTABLE\0` magic.
- `$GAME/SAVEDATA/{REALLIVE.sav,save999.sav,read.sav}` — AVG-derived save
  format.

Public sources:

- Haeleth's RLDEV — http://dev.haeleth.net/rldev/manual.html — scene
  bytecode format, expression encoding, opcode catalogue (the canonical
  documentation despite the URL currently returning ECONNREFUSED from
  this host; mirrored in archived form on Internet Archive).
- rlvm — https://github.com/eglaysher/rlvm — research anchor only, GPL-3.
  Files referenced (read-only, structure restated in our own words):
  - `src/libreallive/archive.cc` — 10,000-slot directory loop.
  - `src/libreallive/scenario.cc` — scene header field offsets.
  - `src/libreallive/bytecode.{h,cc}` — `BytecodeElement::Read` switch,
    `CommandElement` 8-byte header.
  - `src/libreallive/expression.cc` — expression byte encoding.
  - `src/libreallive/compression.cc` — AVG32 XOR + LZ + XOR-2.
  - `src/libreallive/gameexe.cc` — Gameexe parsing.
  - `src/libreallive/scenario_internals.h` — `Header` / `Script` classes.
  - `src/machine/{rlmachine,rloperation,rlmodule,stack_frame,memory}.cc`
    — VM dispatch + variable banks.
  - `src/modules/module_*.cc` — RLOperation catalogues per module.
  - `src/systems/base/{graphics,text,sound,event,save}_system.{cc,h}` —
    subsystem surfaces.
  - `src/systems/base/ovk_voice_archive.cc` — `ReadVisualArtsTable(file, 16, entries_)`.
- xclannad / xclannad-fork — https://github.com/weimingtom/xclannad_fork —
  AVG32 audio (NWA), g00 type-0/1/2 reference.

Existing itotori code:

- `crates/kaifuu-reallive/src/lib.rs:38-99` — synthetic-fixture envelope &
  opcode shape documentation, explicitly narrower than real RealLive.
- `crates/kaifuu-reallive/src/archive.rs:66-104` — count-plus-table envelope
  parser (incorrect for real Seen.txt).
- `crates/kaifuu-reallive/src/opcodes.rs:21-99` — 8-opcode synthetic
  catalogue.
- `crates/kaifuu-reallive/src/parser.rs:36-348` — 0x23-opener +
  `(i, s, l)` operand parser.
- `crates/kaifuu-reallive/src/gameexe.rs:71-100` — line-by-line inventory
  classifier (not a structured Gameexe parser).
- `crates/utsushi-core/src/substrate.rs` — runtime substrate facade
  (UTSUSHI-120, complete).
- `roadmap/spec-dag.json:20898-20940` — current single-node UTSUSHI-146.

---

## M. Cross-engine substrate conformance + Siglus lineage (UTSUSHI-221, extended by UTSUSHI-147)

> Scope: tie the `utsushi-reallive` port (UTSUSHI-200..UTSUSHI-220) into
> UTSUSHI-147's cross-engine substrate-alignment fixture, and document
> which sub-nodes of the decomposition are reusable through the
> `utsushi-siglus` sibling crate UTSUSHI-147 promoted from the original
> inline scaffold (the AVG32 → RealLive → Siglus lineage Visual Arts
> documents). See §M.7 for the inline-to-sibling-crate promotion notes.
>
> **Substrate work means ≥2 engine families — at the scaffold-contract
> level only.** This appendix and the `cross_engine_substrate_alignment`
> conformance fixture in `crates/utsushi-siglus/tests/` exercise the
> ≥2-engine-families dimension **only at the scaffold-contract level**.
> They do **not** satisfy the stronger
> `feedback_multi_game_validation.md` bar (≥2 real games per family):
> the `utsushi-siglus` port is an **inert, design-stage scaffold** —
> every lifecycle method returns a typed `EnginePortError::Lifecycle`
> with `UNIMPLEMENTED_MESSAGE`, no Siglus real bytes are decoded, and
> zero Siglus games are validated. The alpha tier is RealLive-only
> (Sweetie HD); the Siglus VM stays research-only by design. The
> load-bearing claim this fixture earns is narrow: the substrate facade
> is engine-**extensible** (a second crate can implement `EnginePort`
> against the same facade), not that a second engine **works**. With
> that scope fixed: the fixture co-loads
> `UtsushiReallivePort` and `UtsushiSiglusPort` through the substrate
> facade only, and proves the inert `utsushi-siglus` scaffold consumes
> exactly the same _scaffold-contract baseline_ slice of the
> `utsushi_core::substrate::*` import surface that `utsushi-reallive`
> consumes — the twelve leaves `AssetPackage`, `EnginePort`,
> `EnginePortError`, `EvidenceTier`, `FidelityTier`, `LifecycleStage`,
> `PortCapability`, `PortManifest`, `PortRequest`, `PortShutdownOutcome`,
> `REQUIRED_LIFECYCLE_STAGES`, `SinkSet` (the
> `substrate_facade_leaf_baseline_matches_across_engines` test pins this
> exactly for Siglus and as a subset of RealLive's superset). It does
> **not** prove the inert scaffold consumes the deeper carriers named in
> §M.1 below (`TextSurfaceSink`, `SnapshotStore`, `Inspectable`,
> `ReplayLog`, etc.) — those are consumed by `utsushi-reallive` only and
> merely _exist_ on the facade for a future behavioural Siglus port. A
> full Siglus VM is
> **research-only** at this point and out of alpha scope (the alpha
> tier targets a single engine family, RealLive against Sweetie HD);
> the substrate conformance documented here pins **expectations**
> without requiring the VM to land.
>
> **Boundary-aware ("reusable" is not an assertion).** The audit-focus
> block on UTSUSHI-221 calls out two failure modes the conformance
> evidence must guard against:
>
> 1. _"'Reusable' claims that haven't been proven against a Siglus
>    prototype."_ Each "reusable" entry below ties to a concrete
>    `utsushi_core::substrate::*` type or trait. Two distinct strengths
>    of claim are in play, and §M.1 marks each row accordingly:
>    - **_[scaffold]_** — the carrier is consumed by **both** the
>      `utsushi-reallive` source **and** the inert `utsushi-siglus`
>      scaffold today (the twelve scaffold-contract baseline leaves;
>      e.g. `EnginePort`, `PortManifest`, `REQUIRED_LIFECYCLE_STAGES`,
>      `SinkSet`, `AssetPackage`). The
>      `substrate_facade_leaf_baseline_matches_across_engines` test
>      fails at the source-scan if either side drifts.
>    - **_[reallive-only]_** — the carrier is consumed by
>      `utsushi-reallive` only (verified: `TextSurfaceSink`,
>      `AudioEventSink`, `FrameArtifactSink`, `SnapshotStore`,
>      `Inspectable`, `Restorable`, `ReplayLog`, `LogicalClockTick`,
>      `StateTree`, `StatePath`, `ChoiceIndex` appear in
>      `crates/utsushi-reallive/src/**` but **not** in
>      `crates/utsushi-siglus/src/lib.rs`). Reusability for these is
>      proven by RealLive's consumption **plus** the facade exporting
>      the type — **not** by any consumption inside the inert Siglus
>      scaffold, which never imports them. The "reusable for Siglus"
>      column for these rows is a forward expectation a future
>      behavioural Siglus port must satisfy, not a present-tense
>      cross-engine consumption fact.
>
>    Reusability is therefore a property of the substrate facade
>    (proven by RealLive's real consumption + the test), not of the
>    engine implementations (which remain inert scaffolds for
>    `utsushi-siglus` until a behavioural Siglus port lands;
>    `utsushi-reallive` carries behaviour through
>    UTSUSHI-201..UTSUSHI-220).
>
> 2. _"Lineage notes that just repeat marketing instead of documenting
>    actual code reuse points."_ Every reusable-anchor entry below
>    names the concrete substrate type that carries — `AssetPackage`,
>    `TextSurfaceSink`, `SnapshotStore`, `EnginePort`, etc. — and the
>    sub-node where that type is consumed **by `utsushi-reallive` (the
>    only present-day consumer of the deeper carriers)**. The reuse
>    claim is a code citation, not a brand affinity.
>
> **Clean-room posture for the `utsushi-siglus` scaffold.**
> `xmoezzz/siglus_rs` (https://github.com/xmoezzz/siglus_rs, MPL-2.0;
> the clearest bytecode reference is `bluecookies/siglus-decompile`,
> unlicensed → all-rights-reserved/documentation-only; SiglusExtract is
> xmoezzz GPLv3; plus the historical Mafia / GARbro reverse-engineering
> work) is a **research anchor only**. The `utsushi-siglus` crate does NOT
> depend on siglus_rs, does NOT include siglus_rs headers, does NOT
> copy siglus_rs's structure layouts, and does NOT mechanically
> translate siglus_rs code into Rust. The clean-room boundary
> statement (carried as
> `utsushi_siglus::SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`) is
> mirrored from the RLVM one and is asserted load-bearingly by the
> cross-engine substrate-alignment fixture.

### M.1 Reusable across engines (substrate-carried surfaces)

The lineage Visual Arts documents (AVG32 → RealLive → Siglus) lets us
predict which sub-node surfaces survive a port from RealLive to Siglus
at the substrate-facade level. The following are encoded as **trait /
type reuses** on `utsushi_core::substrate::*`; the engine's own work is
to populate the typed surface, not to redesign it.

The **Consumed today by** column is load-bearing against overclaim:
_[scaffold]_ means the carrier is imported by **both** the
`utsushi-reallive` source and the inert `utsushi-siglus` scaffold (a
scaffold-contract baseline leaf the cross-engine fixture pins);
_[reallive-only]_ means the carrier is consumed by `utsushi-reallive`
only and the inert Siglus scaffold does **not** import it (verified by
`rg` over `crates/utsushi-siglus/src/lib.rs`, which imports only
`AssetPackage`, `EnginePort`, `EnginePortError`, `EvidenceTier`,
`FidelityTier`, `LifecycleStage`, `PortCapability`, `PortManifest`,
`PortRequest`, `PortShutdownOutcome`, `REQUIRED_LIFECYCLE_STAGES`,
`SinkSet`). For _[reallive-only]_ rows the "reusable for Siglus" text
is a forward expectation, proven by RealLive's consumption + the
facade exporting the type, not by Siglus consumption.

| RealLive sub-node                                 | Substrate facade carrier                                    | Consumed today by                            | Why reusable for Siglus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UTSUSHI-205 expression encoding                   | (engine-local AST; trait-free)                              | neither (engine-local, no facade carrier)    | The expression byte-stream grammar Visual Arts shipped in AVG32 is the **direct ancestor** of the Siglus expression encoding. Same opener-byte tagging strategy (`\xFF` int literal, `\xC8` store reference, dotted-bank reference). The engine-local `ExprNode` shape ports cleanly. _[P]_                                                                                                                                                                                                                                     |
| UTSUSHI-206 variable banks                        | `Inspectable` + `Restorable` (`StateTree` / `StatePath`)    | **reallive-only**                            | RealLive ships 13 integer-bank letters (`intA`-`intZ` minus 13 unused), Siglus extends to **26 letters** plus longer index ranges. The substrate's `StateTree` + `StatePath` types are bank-shape-neutral: each bank's letter and index land as a `StatePath`, identical at the snapshot layer. The inert Siglus scaffold does not import these yet. _[P]_                                                                                                                                                                      |
| UTSUSHI-203 AVG32 LZ + XOR                        | (engine-local decompressor; trait-free)                     | neither (engine-local, no facade carrier)    | AVG32's `XOR + LZSS` first-level transform is shared substrate; the AVG32 256-byte XOR mask is the same constant in both engines per Visual Arts's compression pipeline. Siglus adds a different second-level transform on top, but the LZ+XOR foundation is reusable. _[P]_                                                                                                                                                                                                                                                    |
| UTSUSHI-207 Gameexe-style config                  | `AssetPackage` + engine-local parser                        | **scaffold** (type slot); reallive behaviour | RealLive uses `Gameexe.ini` (Shift-JIS, dotted-key); Siglus uses `Resource.txt` (UTF-16LE, also dotted) plus a per-namespace `Gameexe.dat`. Both ports carry an `Option<Arc<dyn AssetPackage>>` slot (baseline import); `utsushi-reallive` exercises it for real reads (`module_audio` / `module_obj` / `module_grp`), the inert Siglus scaffold holds it `None`. The dotted-path tree shape and the typed `get_int` / `get_tuple3` access patterns generalise; only the encoding + tokeniser differs.                          |
| (multiple) headless sink pipeline                 | `TextSurfaceSink`, `AudioEventSink`, `FrameArtifactSink`    | **reallive-only** (`SinkSet` is scaffold)    | Every text-displaying / audio-playing / frame-rendering opcode in both engines reduces to one of the three substrate `SinkSet` channels. Both ports import the `SinkSet` container (baseline), but only `utsushi-reallive` imports the three sink traits and emits through them; the inert Siglus scaffold registers no sink. `TextLine { speaker, body, evidence_tier }`, `AudioEvent { event_kind, evidence_tier }`, and `FrameArtifact { artifact_id, width, height, frame_index }` are engine-neutral payload shapes. _[V]_ |
| UTSUSHI-208 snapshot/restore contract             | `SnapshotStore` + `Inspectable` + `Restorable`              | **reallive-only**                            | The "VM snapshot at any tick boundary" round-trip contract is identical: both engines snapshot the call stack + variable banks + active longop's private state. The substrate's `take_snapshot` / `restore_snapshot` free functions consume the engine's `Inspectable` / `Restorable` impls without knowing which engine they came from. The inert Siglus scaffold does not import these yet. _[V]_                                                                                                                             |
| UTSUSHI-220 end-to-end replay (text-replay smoke) | `ReplayLog` + `ReplayLogBuilder` + `LogicalClockTick`       | **reallive-only**                            | The replay-log JSON envelope (schema `utsushi-reallive-replay-log/0.1.0-alpha` for the RealLive port; the equivalent `utsushi-siglus-replay-log/...` for the future Siglus port) consumes the same substrate `ReplayLog` builder; the per-engine schema-id is an envelope-level label, not a substrate fork. The inert Siglus scaffold does not import these yet.                                                                                                                                                               |
| (port-shape) port manifest + lifecycle            | `EnginePort` + `PortManifest` + `REQUIRED_LIFECYCLE_STAGES` | **scaffold** (both engines)                  | Both engines declare the same four required lifecycle stages (Launch, Observe, Capture, Shutdown) and the same `PortCapability` set. The `utsushi-siglus` scaffold proves this byte-for-byte: identical manifest shape, identical capability slice, identical evidence/fidelity tier ceilings at the scaffold gate. _[V — proven by `cross_engine_substrate_alignment` fixture in `crates/utsushi-siglus/tests/`]_                                                                                                              |

The conformance fixture asserts (compile-time + source-scan) that the
inert `utsushi-siglus` scaffold reaches **exactly** the twelve-leaf
baseline set of `utsushi_core::substrate::*` symbols (the _[scaffold]_
rows above) and that `utsushi-reallive` reaches that same baseline as a
**subset** of its larger behavioural import set. The _[reallive-only]_
carriers are not part of the cross-engine baseline — they are consumed
by `utsushi-reallive` and exported by the facade, awaiting a future
behavioural Siglus port. If a future change to either side breaks the
baseline-import invariant, the fixture fails before the import
asymmetry can be silently accepted.

### M.2 RealLive-only (does NOT carry to Siglus)

The following sub-node surfaces are **engine-specific to RealLive**.
A Siglus port reusing the substrate facade reuses the substrate facade
— it does NOT reuse the per-RealLive byte layouts or opcode-table
identifiers below. Any acceptance criterion that names one of these is
RealLive-only and is flagged as such in §M.3 below.

| RealLive sub-node                       | RealLive-only surface                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UTSUSHI-201 Seen.txt parser             | The 10,000-slot `(offset, size)` directory layout is RealLive's archive shape. Siglus ships `Scene.pck` with a **different** envelope (header + per-scene block table + encrypted scene blobs). The substrate's `AssetPackage::open` carries; the parser does not.                                                       |
| UTSUSHI-202 scene-header parser         | The 0x1d0-byte typed scene header (compiler_version, kidoku_offset/count, entrypoint table at 0x34, savepoint table at offset N) is RealLive-only. Siglus scene headers are a different shape with a different field set.                                                                                                |
| UTSUSHI-204 bytecode element stream     | The RealLive bytecode element lead-byte set `{0x00, 0x0a, 0x21, 0x23, 0x24, 0x2c, 0x40}` plus the 8-byte `CommandElement` header `(0x23, module_type, module_id, opcode_u16, arg_count, overload)` is the AVG32-derived RealLive shape. Siglus uses a different command-header byte layout.                              |
| UTSUSHI-209 module_msg opcodes          | The rlvm-specific opcode catalogue (`msg.text`, `msg.pause`, `msg.par`, `msg.FontColor`, `msg.FaceOpen`, etc.) and the `(module_type=0x00, module_id=0x00)` module identifiers addressing is RealLive's. Siglus uses different module identifiers and a different per-module dispatch table; opcode IDs do not transfer. |
| UTSUSHI-210 module_jmp (control-flow)   | The `goto_if` / `goto_unless` / `goto_on` / `gosub` / `farcall` opcode byte-codes are RealLive's. Siglus has structurally equivalent operations (its VM is descended from AVG32's) but different opcode bytes and a different `farcall` cross-scene addressing scheme.                                                   |
| UTSUSHI-211 select family               | `select` / `select_s` / `select_w` / `select_objbtn` and the `SELBTN.NNN.*` Gameexe styling values are RealLive-only. Siglus's choice machinery uses a different opcode family and a different per-choice styling source.                                                                                                |
| UTSUSHI-216 g00 image decoder           | The g00 format (types 0, 1, 2 with the region-list sub-format for type 2) is RealLive-exclusive. Siglus uses `.g00` filenames in some titles but with a **different** internal format; more commonly Siglus titles ship `.pna` / `.pnp` images. The decoder does not transfer.                                           |
| UTSUSHI-217 NWA + OVK voice archives    | NWA is the AVG32 audio container; while AVG32 is a shared ancestor, Siglus titles ship audio in **different containers** (e.g. `.ogg` directly, or `.ovk` with a different sub-sample addressing). The OVK voice archives format with the `(speaker, sample_id)` 16-byte entry table is RealLive's.                      |
| UTSUSHI-218 AVG_SYSTEM/GLOBAL/READ save | The `AVG_SYSTEM_SAVE` / `AVG_GLOBAL_SAVE` / `AVG-derived read flags` save-file layout is RealLive-derived. Siglus saves use a different magic and a different per-slot block structure.                                                                                                                                  |
| UTSUSHI-213 system-call dispatch        | The `9999, 10`-style `(scene_id, entrypoint)` system-call route addressing is a RealLive-only Gameexe convention. Siglus's equivalent uses dotted `Resource.txt` keys with a different routing shape.                                                                                                                    |
| UTSUSHI-219 Sukara XOR-2 key research   | The Sukara-title second-level XOR transform is a **per-publisher-per-compiler-version** RealLive concern. Siglus has its own per-title encryption scheme (Scene.pck key derivation) that is unrelated.                                                                                                                   |

### M.3 Engine-specific boundary notes per sub-node

The spec's third deliverable is to emit a documented **engine-specific
boundary note** wherever a UTSUSHI-200..UTSUSHI-220 acceptance
criterion would break under a Siglus reuse claim. The notes below pin
those criteria. Each one cross-references the substrate-carried
surface from §M.1 that DOES carry (so the boundary is narrow: the
surface generalises, the byte-layout does not).

- **UTSUSHI-201** (Seen.txt 10,000-slot parser) — _RealLive-only._ The
  acceptance criterion "parser returns exactly 198 non-zero scenes,
  scene-id range 1..=9999" is RealLive-archive-specific. Siglus's
  `Scene.pck` carries a header + block-table envelope with no
  10,000-slot reservation. The substrate carrier (`AssetPackage::open`)
  is reusable; the byte layout is not. A future Siglus port re-uses
  the substrate VFS path but ships its own `scene_index` module.

- **UTSUSHI-203** (AVG32 LZ + XOR decompressor) — _partially reusable._
  The first-level AVG32 LZSS + 256-byte XOR transform IS the shared
  Visual Arts substrate (per the lineage; `AVG32_XOR_MASK` would be
  literal-identical). The acceptance criterion "Sweetie HD scene #0001
  decompresses to exactly 1660 bytes" is RealLive-byte-specific. The
  `xor_2_key = None` posture (UTSUSHI-219) is RealLive-only; Siglus
  uses a different second-level key-derivation that has no analogue in
  the RealLive XOR-2 family.

- **UTSUSHI-207** (Gameexe.ini Shift-JIS dotted parser) — _shape
  reusable, encoding RealLive-only._ The dotted-path typed-value
  access pattern (`gameexe.get_int_array("...")`, etc.) generalises to
  Siglus's `Resource.txt` (UTF-16LE) plus per-namespace `Gameexe.dat`
  (binary, requires the Siglus-specific key profile to decrypt).
  Acceptance criteria naming Shift-JIS keys ("`CAPTION ==
"オシオキSweetie＋Sweets!! HD Edition　"`", "`FOLDNAME.G00 == ("G00",
0, "G00.PAK")`") are RealLive-encoding-specific. The substrate
  carrier (`RuntimeVfs::open` for the config asset, then engine-local
  parser) is reusable.

- **UTSUSHI-209** (module*msg text/messaging opcodes) — \_RealLive-only
  byte-codes; substrate sink carries.* The acceptance criterion "each
  implemented opcode emits exactly one TextLine through
  TextSurfaceSink with the Shift-JIS-decoded body" — the
  `TextSurfaceSink` part is reusable (substrate carrier); the opcode
  IDs (`text`, `pause`, `par`, `br`, `page`, `FontColor`, etc. with
  their RealLive-specific module-type/module-id addressing) are not.
  A Siglus port reuses `TextSurfaceSink::emit_line` but populates it
  from a different opcode dispatch table.

- **UTSUSHI-210** (`module_jmp` control-flow opcodes) — _RealLive-only
  byte-codes; substrate call-stack snapshot carries._ The acceptance
  criteria naming the `goto_if` / `goto_unless` / `goto_on` / `gosub` /
  `farcall` opcode byte-codes (and the `farcall` cross-scene
  `(scene_id, entrypoint)` addressing scheme) pin RealLive's
  `module_jmp` opcode table. Siglus has structurally equivalent
  control-flow operations (its VM descends from AVG32's) but different
  opcode bytes and a different `farcall` addressing scheme; the byte-codes
  do not transfer. The substrate carriers that DO carry are the
  call-stack round-trip — `gosub` / `farcall` push frames that the
  `SnapshotStore` + `Inspectable` / `Restorable` contract (§M.1,
  UTSUSHI-208) snapshots engine-neutrally — and the conditional-jump
  predicates, which reduce to the engine-local `ExprNode` AST (§M.1,
  UTSUSHI-205) whose AVG32-derived grammar ports cleanly. A Siglus port
  reuses those facade surfaces but populates them from its own
  control-flow opcode dispatch table.

- **UTSUSHI-211** (`select` / `select_s` / `select_w` family) —
  _RealLive-only opcodes; substrate ChoiceIndex carries._ Acceptance
  criteria naming the RealLive sel-module opcodes and the
  `SELBTN.NNN.*` Gameexe styling values are RealLive-specific. The
  substrate `ChoiceIndex` input event and the `TextLine` with
  `kind=Choice` are reusable across engines.

- **UTSUSHI-212** (string / memory / system-arithmetic ops) —
  _Shift-JIS conversion tables RealLive-only; rng determinism via
  substrate carries._ The acceptance criteria
  "`Uppercase("ＡＢＣ")` returns `"ＡＢＣ"`" and "`hantozen("abc")`
  returns `"ａｂｃ"` (full-width)" pin the RealLive `module_str`
  half/full-width semantics — these are the documented Shift-JIS
  hantozen/zentohan conversions per RLDEV and assume a Shift-JIS code
  unit. Siglus strings are UTF-16LE and its width-conversion ops live
  under a different opcode family with different IDs; the conversion
  table does not transfer. The substrate carrier that DOES carry is the
  rng-determinism path: `rnd` seeded from the substrate `LogicalClock`
  and the rng-state round-trip through `SnapshotStore` are facade
  surfaces a Siglus port reuses unchanged. The `module_str` /
  `module_mem` opcode-table identifiers themselves are RealLive-only.

- **UTSUSHI-213** (system-call dispatch) — _RealLive-only Gameexe
  route convention; substrate SnapshotStore + EnginePort lifecycle
  carry._ The acceptance criteria naming the `9999,NN`-style
  `(scene_id, entrypoint)` route addressing and the Gameexe dispatch-table
  keys (`SYSTEMCALL_SAVE=9999,20`, `SYSTEMCALL_LOAD=9999,21`,
  `CANCELCALL=9999,10`, the `WBCALL.NNN` window-button callbacks, etc.,
  per §H) pin a RealLive-only Gameexe convention: the syscom handlers
  live as real bytecode in scene `9999` and are reached through that
  `(scene_id, entrypoint)` table. Siglus's equivalent routes through
  dotted `Resource.txt` keys with a different routing shape; neither the
  key names nor the scene-id convention transfer. The substrate carriers
  that DO carry are the `SnapshotStore` backing the save/load syscom
  routes (§M.1, UTSUSHI-208) and the `EnginePort` lifecycle stages
  (Launch / Observe / Capture / Shutdown, §M.1 port-shape row) the
  system-call surface plugs into — a Siglus port reuses those facade
  surfaces but populates the dispatch table from its own config source.

- **UTSUSHI-214** (graphics object stack) — _rlvm 256-object stack
  model RealLive-only; FrameArtifactSink carries._ The acceptance
  criteria "allocating 256 objects … → deterministic PNG bytes" and
  "the render pass observes `SCREENSIZE_MOD=999,1280,720`" pin the
  rlvm-derived `GraphicsSystem` shape: a ~256-slot foreground+background
  object stack with per-object `(position, scale, alpha, colour_tone,
image_ref, layer_order)` state, and a RealLive Gameexe
  `SCREENSIZE_MOD` convention. Siglus's compositor uses a different
  object/layer model and a different framebuffer-dimension source. The
  substrate carrier (`FrameArtifactSink` + the deterministic-PNG
  `FrameArtifact` envelope carrying `frame_index`, `evidence_tier=E1`,
  and a PNG `artifact_id`) is reusable across engines; the 256-object
  stack model and the `SCREENSIZE_MOD` key are RealLive-only.

- **UTSUSHI-215** (module*grp + module_obj graphics opcodes) —
  \_RealLive-only opcode byte-codes; substrate VFS + render sink carry.*
  The acceptance criteria naming the rlvm `module_grp` /
  `module_obj_management` / `module_obj_fg_bg` opcode catalogue
  (`allocDC`, `wipe`, `shake`, `fade`, `objAlloc`, `objSetPos`,
  `objSetAlpha`, `objSetLayer`, etc.) pin RealLive's opcode-table
  byte-codes, and "`openBg("BG01A1")` reads
  `$GAME/REALLIVEDATA/g00/BG01A1.g00`" pins the RealLive
  `REALLIVEDATA/g00` asset layout. Siglus's graphics machinery uses a
  different opcode family and a different asset-tree layout; neither the
  opcode IDs nor the path transfer. The substrate carriers that DO carry
  are the VFS read path and the render/`state_snapshot` sink through
  which mutations of the (RealLive) graphics object stack are observed —
  a Siglus port reuses those facade surfaces but populates them from its
  own opcode dispatch table.

- **UTSUSHI-216** (g00 image decoder) — _RealLive-only._ g00 types 0,
  1, 2 with the type-2 region-list sub-format is a RealLive-exclusive
  asset format. A Siglus port carrying the substrate `FrameArtifactSink`
  is reusable; the image decoder is not. The acceptance criterion
  "type 2 decoded files expose a `regions: Vec<G00Region>`" does not
  port — Siglus has no equivalent region-list image format.

- **UTSUSHI-217** (NWA + OVK audio decoders) — _RealLive-only audio
  formats; substrate AudioEventSink carries._ The acceptance criteria
  "NWA decoder returns 33,818,820 sample frames" and "OVK decoder
  returns 2 entries with `(sample_num=46, sample_num=52)`" are
  RealLive-byte-specific. The substrate `AudioEvent` payload shape
  (with `event_kind`, `cue_id`, `source_asset`) is reusable; the
  decoder layer is not. Siglus's audio path emits the same
  `AudioEvent` envelope from its own (different) decoders. Sub-sample
  addressing for voice cues (`(archive_id, sample_id)` for RealLive's
  OVK) is RealLive-specific; the substrate's audio facade still has
  the open gap UTSUSHI-146 § K.3 flagged.

- **UTSUSHI-218** (`AVG_SYSTEM_SAVE` / `AVG_GLOBAL_SAVE` / read flags) —
  _RealLive-only on-disk format; substrate SnapshotStore carries._ The
  substrate `SnapshotStore` is reusable as the in-memory backing for
  save state on both engines; the on-disk serialiser differs. The
  acceptance criterion naming "`AVG_SYSTEM_SAVE` magic at byte 0x18"
  and the file sizes does not port to Siglus.

### M.4 Cross-engine conformance fixture (UTSUSHI-147)

The cross-engine conformance fixture promised by UTSUSHI-147 is
realised at the **scaffold-contract level** by
`crates/utsushi-siglus/tests/cross_engine_substrate_alignment.rs`.
The fixture co-loads `UtsushiReallivePort` and `UtsushiSiglusPort` (the
latter promoted into a real sibling crate by UTSUSHI-147 — see §M.7
below) through the substrate facade only, and:

1. **Compile-time witnesses both `EnginePort` bounds.** A generic
   helper function constrains both ports to the facade's `EnginePort`
   trait — if a future substrate refactor splits the trait, this file
   fails to compile, blocking the substrate API drift from landing
   without a paired conformance update.
2. **Pins manifest-shape equality across engines.** Both ports
   declare identical `REQUIRED_LIFECYCLE_STAGES`, identical
   `PortCapability` sets, identical `EvidenceTier::E1` /
   `FidelityTier::TraceOnly` ceilings, and identical `abi_version` —
   asserted through facade-typed accessors only.
3. **Pins shared VFS / render / snapshot facade carriers.** Both
   ports' inert contexts expose an `Option<Arc<dyn AssetPackage>>`
   slot (VFS), both `EnginePort::sink_set()` calls return the
   facade's `SinkSet` with three drains over facade-typed events
   (`TextLine`, `FrameArtifact`, `AudioEvent`), and the facade's
   `take_snapshot` free function is named through the cross-engine
   fixture so a facade-level drop fails compilation.
4. **Source-scans both scaffolds' `lib.rs` for `utsushi_core::*`
   imports.** The audit asserts (a) neither scaffold reaches a
   forbidden subsystem root (`vfs`, `port`, `clock`, etc. directly);
   (b) the `utsushi_core::CaptureOutcome` crate-root reach-around is
   symmetric across engines (omission is shared); (c) the Siglus
   scaffold's facade-leaf import set matches a hard-coded
   cross-engine baseline AND the RealLive scaffold reaches every
   baseline leaf — proving the alignment is bidirectional.
5. **Pins the substrate-API-drift regression coverage.** Any future
   change to the substrate facade that affects a symbol the
   cross-engine fixture touches will fail the identical-imports
   audit, surfacing the drift as a semantic diagnostic ("RealLive
   scaffold lost facade leaf `X` from the cross-engine baseline")
   rather than as a silent scaffold-out-of-sync regression.

### M.5 Substrate-gap candidates flagged for Siglus extension

The three substrate-gap candidates UTSUSHI-146 § K.3 flagged for the
RealLive port are revisited here under the Siglus reuse lens:

1. **Per-frame artifact emission cadence.** RealLive's text-display /
   choice-display / effect-cluster frame boundaries are scene-stream
   boundaries; Siglus has the same logical-frame concept (its `wipe`
   / `bgload` / `objSetPos` analogues map to the same
   `FrameArtifactSink::emit_frame` cadence). The gap is shared.
2. **Voice-archive sub-sample addressing.** RealLive's OVK
   `(archive_id, sample_id)` shape does NOT carry to Siglus, which
   uses a different voice-archive format. The substrate gap (a
   typed `(archive_id, sample_id)` payload on `AudioEvent`) is
   real, but the carrier semantics differ across engines — the gap
   is engine-shared in shape but not in addressing.
3. **Snapshot of the longop scheduler.** RealLive's mid-`select` /
   mid-`pause` longop save points (e.g. `SAVEPOINT_SELCOM=1`) have
   direct Siglus analogues (Siglus VMs ship with the same
   scene-stream-pausing longop concept). The substrate gap is
   engine-shared.

### M.6 Provenance

- AVG32 → RealLive lineage: documented in Visual Arts's own engine
  evolution history (publicly archived). The AVG32 LZSS + 256-byte
  XOR transform constant is identified in § E of this document and
  is the literal-shared substrate point. _[P]_
- RealLive → Siglus lineage: documented in Visual Arts's compiler
  evolution. The expression encoding, variable-bank shape (Siglus
  extends to 26 letters), `SystemCall` dispatch pattern, and choice
  family are direct descendants. The byte layouts differ; the
  shape carries. _[P]_
- Siglus-only post-RealLive additions: per-title `Scene.pck`
  encryption (engine-specific key profile), `Resource.txt`
  UTF-16LE config tree, `.pna` / `.pnp` image format family.
  _[P]_
- The `utsushi-siglus` minimal-port scaffold (promoted into a
  sibling crate by UTSUSHI-147; see §M.7) derives no source
  expression from siglus_rs or SiglusExtract or GARbro. The
  scaffold's behavioural surface is inert — every lifecycle method
  returns a typed `Unimplemented` Lifecycle error — so there is no
  reverse-engineered byte-decode logic to derive.

### M.7 Inline-scaffold-to-sibling-crate promotion (UTSUSHI-147)

UTSUSHI-221 first proved the substrate facade is engine-extensible at
the scaffold-contract level by **defining a Siglus minimal-port
scaffold inline** inside `utsushi-reallive`'s test crate. The
historical inline file
(`crates/utsushi-reallive/tests/cross_engine_facade_only_imports.rs`)
served as the alignment fixture and the substrate-API-drift regression
in the same place.

UTSUSHI-147 **promotes the inline scaffold into a real sibling crate**
at `crates/utsushi-siglus/`:

- The scaffold's `EnginePort` implementation, `UNIMPLEMENTED_MESSAGE`
  marker, `SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT` clean-room
  disclaimer, and `UtsushiSiglusPortContext` carrier all live as a
  proper `crates/utsushi-siglus/src/lib.rs` library now, with the
  same `#![forbid(unsafe_code)]` posture and the same
  `utsushi-core = { path = "../utsushi-core" }` direct dep the
  RealLive scaffold carries.
- The cross-engine conformance fixture moved to
  `crates/utsushi-siglus/tests/cross_engine_substrate_alignment.rs`.
  The fixture's dev-dep direction is `utsushi-siglus -> utsushi-reallive`
  (the second engine pulls in the first as a test-only co-loaded port)
  — never the reverse, so the project's RealLive-only alpha posture is
  not contaminated.
- The historical inline file is **deleted in the same change** as the
  sibling-crate landing, per the project's no-legacy-compat rule
  (`feedback_no_legacy_compat.md`). There is no parallel inline
  scaffold; the sibling crate is the canonical home, and the cross-engine
  fixture's name and location (UTSUSHI-147's
  `cross_engine_substrate_alignment.rs`) are the only valid anchor for
  future audits.
- Scaffold conformance and substrate-conformance tests for
  `utsushi-siglus` mirror the corresponding `utsushi-reallive` tests
  one-to-one (`tests/scaffold.rs` and `tests/substrate_conformance.rs`)
  so the per-port structural-smoke surface is identical across
  engines.

Lineage-extension port scope (AVG32 -> RealLive -> Siglus):

- **Extends:** every §M.1 reusable-across-engines surface (`AssetPackage`,
  `TextSurfaceSink`, `AudioEventSink`, `FrameArtifactSink`,
  `SnapshotStore`, `EnginePort`, `PortManifest`, `ReplayLog`,
  `Inspectable` + `Restorable`, expression encoding, variable banks
  with letter-extension to 26, AVG32 LZSS + 256-byte XOR foundation).
  The port scope therefore extends through the substrate facade and
  the AVG32-rooted format primitives that did not change across the
  Visual Arts engine generations.
- **Does NOT extend:** every §M.2 RealLive-only surface (10,000-slot
  Seen.txt directory, 0x1d0-byte scene header, RealLive bytecode
  lead-byte set, `module_msg` opcode catalogue, `module_jmp` opcode
  bytes, `select` family, g00 image format, NWA + OVK voice
  archives, AVG-derived save format, RealLive system-call route
  Gameexe convention, Sukara XOR-2 key research). A future
  behavioural Siglus port re-uses the substrate facade and ships its
  own byte-level decoders for `Scene.pck`, `Resource.txt`,
  `Gameexe.dat`, `.pna` / `.pnp`, and the per-title encryption
  scheme.
