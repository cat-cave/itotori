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
