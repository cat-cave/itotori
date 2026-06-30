//! Gameexe.ini Shift-JIS line walker and key-family classifier.
//!
//! Clean-room provenance (KAIFUU-174 / KAIFUU-190):
//! - The key-family catalogue is derived from publicly archived Haeleth
//!   RLDEV documentation plus the RealLive key surface inventory at
//!   `docs/research/reallive-engine.md` §B (which itself was assembled from
//!   RLDEV plus byte-level counts taken against Sweetie HD's real bytes).
//!   No expression is copied from rlvm.
//! - KAIFUU-190 replaces the previous 10-prefix hard-coded subset with a
//!   pattern-based classifier covering the documented RealLive surface.
//!   Keys that still don't match a documented family are recorded with a
//!   typed [`UnknownReason`] and paired with a
//!   `kaifuu.reallive.inventory.unknown_gameexe_key` warning, so no byte is
//!   silently dropped.
//! - Multi-game validation: the Gameexe.ini key-naming convention is
//!   hard-coded by the RealLive engine compiler — the catalogue
//!   generalises across titles even though byte-level evidence here is
//!   from Sweetie HD only. Second-corpus retroactive validation is welcome
//!   but not blocking (see test file header).

use serde::{Deserialize, Serialize};

use crate::encoding::decode_shift_jis_slot;

/// Stable warning code emitted for non-catalogue Gameexe.ini keys.
pub const UNKNOWN_GAMEEXE_KEY_CODE: &str = "kaifuu.reallive.inventory.unknown_gameexe_key";

/// One Gameexe.ini entry classified for the inventory layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeInventoryEntry {
    /// 1-based line number.
    pub line_number: u64,
    /// Byte offset of the line within the file.
    pub byte_offset: u64,
    /// Byte length of the line (excluding the terminator).
    pub byte_len: u64,
    /// Upper-cased raw key text (e.g. `#FOLDNAME.G00`).
    pub key: String,
    /// Decoded value text. For triple-equals lines (`#FOLDNAME.*`,
    /// `#NAMAE`, `#SE.*`, `#DSTRACK`) the value is the full RHS string;
    /// per-group split is reported in the typed [`GameexeKeyFamily`].
    pub value: String,
    /// High-level treatment bucket the inventory layer consumes.
    pub treatment: GameexeKeyTreatment,
    /// Typed family classification (carries suffix/index data).
    pub family: GameexeKeyFamily,
}

/// High-level treatment of one Gameexe.ini entry.
///
/// This is the bucket consumed by the inventory layer. The richer
/// per-family classification is in [`GameexeInventoryEntry::family`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameexeKeyTreatment {
    /// User-visible translatable text (window title, character display
    /// name, save-dialog messages, etc.). Emitted as a BridgeUnit.
    BridgeUnit,
    /// Asset path or asset-archive declaration. Emitted as an
    /// AssetReference only.
    AssetReference,
    /// Engine configuration knob: counts, sizes, mode flags, scene-call
    /// dispatch tuples, layout coordinates, palette tables. Neither
    /// translatable nor an asset path.
    Config,
    /// Non-catalogue key. Carries a typed [`UnknownReason`] in
    /// [`GameexeKeyFamily::Unknown`]; warning is paired in
    /// `GameexeInventoryReport`.
    Unknown,
}

/// Typed key family classification.
///
/// Each variant captures the per-key suffix / index data the family
/// uses, so downstream consumers can route keys by family without
/// re-parsing the raw key string.
///
/// Family naming and grouping is taken from
/// `docs/research/reallive-engine.md` §B. Where a family has documented
/// suffix structure (e.g. `#FOLDNAME.G00 = "G00" = 0 : "G00.PAK"`,
/// `#WAKU.NNN.MMM.FIELD`, `#KOEONOFF.NNN.(MMM).ON="..."`), the
/// classifier records the suffix segments here; full parsing of the
/// triple-equals RHS shape is left to the consumers that need it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "family")]
pub enum GameexeKeyFamily {
    // ---- Engine bootstrap / window ----
    /// `#CAPTION="…"` — window-title text (translatable).
    Caption,
    /// `#SUBTITLE=…` — subtitle config.
    Subtitle,
    /// `#REGNAME="HADASHI\OSHIOKIHD"` — registry-key identifier.
    RegName,
    /// `#DISKMARK="…"` — disk-marker filename.
    DiskMark,
    /// `#VERSION_STR="…"` — translatable version string.
    VersionStr,
    /// `#SCREENSIZE_MOD=999,1280,720` — `(mode_flag, width, height)`.
    ScreenSizeMod,
    /// `#MMX_ENABLE`, `#D3D_ENABLE`, `#MEMORY`, `#DEMONSTRATION`,
    /// `#X_Z_KEY_MOD`, `#ALT_ENTER_USE`, `#CTRL_USE`, `#GRAPHIC_DISP_MODE`,
    /// `#WAIP_WINDOWCLOSE`, `#GRPCOM_WINDOWCLOSE`, `#ANIME_HISPEED_MODE`,
    /// `#MANUAL_PATH`, `#MASK` — engine bootstrap knobs.
    EngineBootstrap,
    /// `#DEBUG_MESSAGE_LOG`, `#DEBUG_GAMEEND_WARNING`,
    /// `#DEBUG_WINDOW_CAPTION`, `#DEBUG_SAVE_HISTORY_CNT`,
    /// `#DEBUG_MEMORY_WARNING_SIZE` — debug-build knobs.
    Debug,

    // ---- Scene routing / system-call dispatch ----
    /// `#SEEN_START`, `#SEEN_MENU`, `#SEEN_TEXT_CURENT` — scene-id
    /// entrypoints.
    SeenEntry,
    /// `#CANCELCALL=9999,10`, `#CANCELCALL_MOD=1`.
    CancelCall,
    /// `#SYSTEMCALL_SAVE`, `#SYSTEMCALL_LOAD`, `#SYSTEMCALL_SYSTEM`,
    /// `#SYSTEMCALL_<NAME>_MOD`.
    SystemCall,
    /// `#LOADCALL=9999,40`, `#LOADCALL_MOD=1`.
    LoadCall,
    /// `#EXAFTERCALL`, `#EXAFTERCALL_MOD`.
    ExAfterCall,
    /// `#MOUSEACTIONCALL.NNN.MOD`, `#MOUSEACTIONCALL.NNN.SEEN`,
    /// `#MOUSEACTIONCALL.NNN.AREA`.
    MouseActionCall {
        /// Decimal index after the first dot (e.g. `000` for
        /// `#MOUSEACTIONCALL.000.AREA`).
        index: String,
        /// Sub-field after the index (e.g. `AREA`, `SEEN`, `MOD`).
        field: String,
    },
    /// `#WBCALL.NNN=9999,XX` — per-window-button callback dispatch.
    WbCall {
        /// Decimal index after the first dot.
        index: String,
    },

    // ---- Asset folder remap ----
    /// `#FOLDNAME.G00 = "G00" = 0 : "G00.PAK"` — triple-valued.
    FolderName {
        /// Suffix after `#FOLDNAME.` (e.g. `G00`, `BGM`, `KOE`).
        kind: String,
    },

    // ---- Save spec ----
    /// `#SAVE_USE`, `#SAVE_FORMAT`, `#SAVE_INDEX`, `#SAVE_CNT`,
    /// `#SAVE_TITLE`, `#SAVE_THUMBNAIL`, `#SAVEPOINT_*`,
    /// `#QUICK_SAVEDATA_USE`. Most are config; `#SAVE_TITLE` /
    /// `#SAVE_NODATA` are translatable strings.
    Save {
        /// Suffix after `#SAVE` (e.g. `_USE`, `_FORMAT`, `POINT_MESSAGE`).
        field: String,
    },
    /// `#SAVE_NODATA="データがありません"` — translatable empty-slot message.
    SaveNoData,
    /// `#SAVEMESSAGE_*`, `#LOADMESSAGE_*`, `#DLGSAVEMESSAGE_*`,
    /// `#DLGLOADMESSAGE_*`, `#SYSTEM_SAVELOADMESSAGE_STR`,
    /// `#SAVELOADDLG_*` — save/load dialog text and layout. The `_STR`
    /// suffix variants are translatable; the rest are config.
    SaveLoadMessage {
        /// Raw suffix (e.g. `_TITLE_STR`, `_MESS`, `DLG_USE`).
        field: String,
    },

    // ---- Speaker / character roster (translatable) ----
    /// `#NAMAE="和人" = "和人" = (1,016, -1)` — speaker registry.
    Namae,
    /// `#NAME.A="可変名前Ａ"`, `#NAME_MAXLEN=…`, `#LOCALNAME.A=…` —
    /// player-input localised name slots. The `.X` suffix variants are
    /// translatable; `_MAXLEN` is config.
    Name {
        /// Suffix after `#NAME` (`.A`, `.B`, `_MAXLEN`).
        field: String,
    },
    /// `#LOCALNAME.A="…"` — localised display name.
    LocalName {
        /// Suffix after `#LOCALNAME.`.
        slot: String,
    },

    // ---- Voice on/off menu ----
    /// `#KOEONOFF.005.(000,002,003,004).ON="女の子全て"` — per-character
    /// voice-toggle menu line.
    KoeOnOff {
        /// Decimal index after the first dot.
        index: String,
        /// Speaker-id set captured as the bracketed sub-expression.
        speakers: String,
    },
    /// `#KOEONOFF_MENU_MOD`, `#KOEFILE_MOD`, `#KOEWAIT_TIME`,
    /// `#INIT_KOEMODE` — voice-engine config knobs.
    KoeConfig {
        /// Raw suffix (e.g. `_MENU_MOD`, `WAIT_TIME`).
        field: String,
    },
    /// `#KOEREPLAYICON.*` — voice-replay icon graphics.
    KoeReplayIcon {
        /// Sub-field after `#KOEREPLAYICON.`.
        field: String,
    },

    // ---- System command catalogue ----
    /// `#SYSCOM.005.000="フルスクリーン"` — system-menu entry.
    /// `prefix` is `U:` / `N:` if present.
    Syscom {
        /// Dotted index segments after `#SYSCOM.` (e.g. `005` or
        /// `005.000`).
        index: String,
    },
    /// `#SYSCOM_USE`, `#SYSCOM_MOD`, `#SYSCOM_MOD2` — syscom config.
    SyscomConfig {
        /// Suffix after `#SYSCOM_`.
        field: String,
    },

    // ---- Text-window / WAKU theme ----
    /// `#WAKU.NNN.MMM.FIELD=…` — text-window decoration theme variant.
    Waku {
        /// First-level index (e.g. `000`).
        theme: String,
        /// Optional variant index (e.g. `000`).
        variant: Option<String>,
        /// Sub-field (e.g. `NAME`, `MOVE_BOX`, `TYPE`).
        field: String,
    },
    /// `#WINDOW.NNN.FIELD=…` — text-window-layer config.
    Window {
        /// First-level index after `#WINDOW.`.
        index: String,
        /// Sub-field (e.g. `MOJI_SIZE`, `POS`).
        field: String,
    },
    /// `#WINDOW_ATTR=…`, `#WINDOW_MOVE_USE=…`, etc. — non-indexed
    /// window-layer config.
    WindowConfig {
        /// Suffix after `#WINDOW_`.
        field: String,
    },
    /// `#MSGBK_WINDOW.NNN.FIELD=…` — backlog window theme.
    MessageBackWindow {
        /// Index after `#MSGBK_WINDOW.`.
        index: String,
        /// Sub-field.
        field: String,
    },
    /// `#MSGBK_BUTTON_DISP_MODE` — backlog button config.
    MessageBackConfig {
        /// Raw suffix after `#MSGBK_`.
        field: String,
    },
    /// `#FULLSCREEN_MSGBK.NNN.FIELD=…` — fullscreen backlog theme.
    FullScreenMessageBack {
        /// Index after `#FULLSCREEN_MSGBK.`.
        index: String,
        /// Sub-field.
        field: String,
    },
    /// `#FULLSCREEN_MSGBK_PAT_NO`, `_MAX_MOJI_SIZE`, etc. — fullscreen
    /// backlog non-indexed config.
    FullScreenMessageBackConfig {
        /// Suffix after `#FULLSCREEN_MSGBK_`.
        field: String,
    },

    // ---- Choice-button / SEL theme ----
    /// `#SELBTN.NNN.FIELD=…` — choice-button theme.
    SelBtn {
        /// Index after `#SELBTN.`.
        index: String,
        /// Sub-field.
        field: String,
    },
    /// `#SEL.NNN=…` — choice-region declaration.
    Sel {
        /// Index after `#SEL.`.
        index: String,
    },
    /// `#SEL_CURSOR`, `#SEL_WAIT_USE`, `#SEL_WINDOWCLEAR`,
    /// `#SEL_MOUSESET`, `#SEL_FLUSH_USE`, `#SELPOINT_RETURN_MESS_STR`,
    /// `#DEFAULT_SEL_WINDOW`, etc. — choice-region config.
    SelConfig {
        /// Raw suffix after `#SEL` (without leading dot).
        field: String,
    },

    // ---- Button-object animation ----
    /// `#BTNOBJ.ACTION.NNN.STATE=…`, `#BTNOBJ.SE.NNN.STATE=…`,
    /// `#BTNOBJ.GROUP.NNN`. The leading sub-namespace is captured as
    /// `kind`.
    BtnObj {
        /// Sub-namespace after `#BTNOBJ.` (e.g. `ACTION`, `SE`, `GROUP`).
        kind: String,
        /// Remaining dotted suffix.
        rest: String,
    },

    // ---- System buttons ----
    /// `#SYSBTN.NNN.FIELD=…`.
    SysBtn {
        /// Index after `#SYSBTN.`.
        index: String,
        /// Sub-field.
        field: String,
    },
    /// `#SYSBTN_HIDE_STR`, `#SYSBTN_HIDE_USE`, `#SYSBTN_PAT_NO`,
    /// `#SYSBTN_PAT_MOD` — system-button non-indexed config.
    SysBtnConfig {
        /// Suffix after `#SYSBTN_`.
        field: String,
    },

    // ---- Mouse cursor ----
    /// `#MOUSE_CURSOR.NNN.…` — cursor-sprite table.
    MouseCursor {
        /// Remaining suffix after `#MOUSE_CURSOR.`, dotted.
        rest: String,
    },
    /// `#MOUSE_CURSOR_WINDOWBUTTON_<NAME>=…`,
    /// `#MOUSE_CURSOR_MESSAGEBACK_<NAME>=…`, `#MOUSE_CURSOR_RESET` —
    /// cursor-button-region table.
    MouseCursorRegion {
        /// Suffix after `#MOUSE_CURSOR_`.
        field: String,
    },
    /// `#MOUSE_DISP`, `#MOUSE_MOVE` — mouse-pointer config.
    MouseConfig {
        /// Suffix after `#MOUSE_`.
        field: String,
    },

    // ---- Object render layers ----
    /// `#OBJECT.NNN=…`.
    Object {
        /// Index after `#OBJECT.`.
        index: String,
    },
    /// `#OBJECT_MAX=256`.
    ObjectMax,
    /// `#OBJDISP.NNN=…`.
    ObjDisp {
        /// Index after `#OBJDISP.`.
        index: String,
    },
    /// `#INIT_OBJECT1_ONOFF_MOD`, `#INIT_WEATHER_ONOFF_MOD`,
    /// `#INIT_EXCOLOR_ONOFF_MOD`, `#INIT_SELPOINT_USE`,
    /// `#INIT_SCREENMODE`, `#INIT_FONT_*`, `#INIT_KOEMODE`,
    /// `#INIT_ORIGINALSETING`, `#INIT_MESSAGE_SPEED*` — startup defaults.
    Init {
        /// Suffix after `#INIT_`.
        field: String,
    },

    // ---- Audio / sound ----
    /// `#BGM_MODE`, `#BGM_KOEFADE_USE`, `#BGM_KOEFADE_VOL` — BGM config.
    BgmConfig {
        /// Suffix after `#BGM_`.
        field: String,
    },
    /// `#SE.NNN = "NAME" = 0` — sound-effect bank entry.
    SoundEffect {
        /// Index after `#SE.`.
        index: String,
    },
    /// `#SOUND_DEFAULT` — sound subsystem default channel.
    SoundDefault,
    /// `#DSTRACK = 00000000 - 08466742 - 04233233 = "ASA" = "ASA"` —
    /// digital-soundtrack mapping.
    DsTrack,
    /// `#PCM_VOLMOD.NNN=…` — per-channel PCM volume modulation.
    PcmVolMod {
        /// Index after `#PCM_VOLMOD.`.
        index: String,
    },
    /// `#SERIALPDT.NNN=…` — serial palette mapping for sound or graphic.
    SerialPdt {
        /// Index after `#SERIALPDT.`.
        index: String,
    },

    // ---- Shake / motion / cinematic ----
    /// `#SHAKE.NNN=(…)(…)…` — screen-shake offset sequence.
    Shake {
        /// Index after `#SHAKE.`.
        index: String,
    },
    /// `#SHAKEZOOM.NNN=(…)(…)…` — shake + zoom keyframes.
    ShakeZoom {
        /// Index after `#SHAKEZOOM.`.
        index: String,
    },
    /// `#QUARTERVIEW_SIZE` — quarter-view layout config.
    QuarterViewSize,
    /// `#HAIKEICHR_BUFNO`, `#HAIKEICHR_LAYER`, `#HAIKEICHR_PARAM` —
    /// background-character config.
    HaikeiChr {
        /// Suffix after `#HAIKEICHR_`.
        field: String,
    },

    // ---- Misc UI / hint icons ----
    /// `#HINT.AUTOMODE.*`, `#HINT.READJUMP.*` — hint-icon graphics.
    Hint {
        /// Sub-namespace (`AUTOMODE`, `READJUMP`).
        kind: String,
        /// Remaining dotted suffix.
        rest: String,
    },
    /// `#COLOR_TABLE.NNN=…` — palette table entry.
    ColorTable {
        /// Index after `#COLOR_TABLE.`.
        index: String,
    },
    /// `#MASK.NNN="_mask03"` — indexed transition-mask graphic
    /// reference. Distinct from the bare `#MASK` config knob in
    /// [`EngineBootstrap`].
    Mask {
        /// Index after `#MASK.`.
        index: String,
    },
    /// `#CGTABLE_FILENAME="mode.cgm"`, `#CGTABLE_MOD=0`.
    CgTable {
        /// Suffix after `#CGTABLE_`.
        field: String,
    },
    /// `#READJUMP_SYSTEM_USE`, `#UNREADJUMP_STR` — text-skip config.
    /// `_STR` variant is translatable.
    ReadJump {
        /// Raw suffix.
        field: String,
    },
    /// `#KEYWAIT_R_CURSOR`, `#KEYWAIT_P_CURSOR` — wait-cursor config.
    KeyWait {
        /// Suffix after `#KEYWAIT_`.
        field: String,
    },
    /// `#MESSAGE_KEY_WAIT_USE`, `#MESSAGE_KEY_WAIT_TIME` — message
    /// pacing config.
    MessageKeyWait {
        /// Suffix after `#MESSAGE_KEY_WAIT_`.
        field: String,
    },
    /// `#FONT_SHADOW_SETTING_MOD` — font-shadow config.
    FontConfig {
        /// Suffix after `#FONT_`.
        field: String,
    },
    /// `#RETURN_CURSOR_DISP`, `#CURSOR.*` — return / mouse cursor config.
    Cursor {
        /// Suffix after `#CURSOR.` or after `#RETURN_CURSOR_`.
        field: String,
    },
    /// `#GAME_END_MESS_STR`, `#MENU_RETURN_MESS_STR`,
    /// `#SYSTEM_ANIME_STR` — UI message strings (translatable).
    UiMessageStr {
        /// Raw key text after `#` (for downstream routing).
        key: String,
    },
    /// `#CDDA_BGM_SETUP_NEED`, `#CDDA_DAT_SETUP_NEED`,
    /// `#CDDA_KOE_SETUP_NEED`, `#CDDA_MOV_SETUP_NEED` — installer flags.
    CddaSetup {
        /// Suffix after `#CDDA_`.
        field: String,
    },

    // ---- Pre-KAIFUU-190 minimal-subset assets (kept as families) ----
    /// `#G00BUF=8` and any other `#G00*` config (image-buffer count etc.).
    G00Family,
    /// `#KOEPAC=koe.ovk` and other `#KOE*` asset / pack declarations
    /// not covered by [`KoeOnOff`] / [`KoeConfig`] / [`KoeReplayIcon`].
    KoePack,
    /// `#SEEN_*` other than [`SeenEntry`] — fallback for any
    /// `#SEEN*=path` declaration.
    SeenAsset,
    /// `#NWK*=…`, `#OVK*=…` — audio archive declarations.
    NwkOvk,
    /// `#GAMEEXE_VERSION=…`.
    GameexeVersion,

    // ---- Unknown ----
    /// Catch-all. Carries the raw key and a typed reason.
    Unknown {
        /// Raw key text as parsed (upper-cased, including leading `#`).
        raw_key: String,
        /// Why the classifier rejected the key.
        reason: UnknownReason,
    },
}

/// Why the classifier could not assign a key to a documented family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownReason {
    /// Key parses as `#<NAME>` / `#<NAME>.<...>` but the name doesn't
    /// match any documented family.
    UnknownFamily,
    /// Key is structurally malformed: empty, `#=`, `#.`, contains
    /// nothing after `#`, etc.
    MalformedKey,
}

/// Warning emitted by [`parse_gameexe_inventory`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeIniDiagnostic {
    pub code: String,
    pub line_number: u64,
    pub key: String,
    pub message: String,
}

/// Output of [`parse_gameexe_inventory`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeInventoryReport {
    pub entries: Vec<GameexeInventoryEntry>,
    pub warnings: Vec<GameexeIniDiagnostic>,
}

/// Parse a Gameexe.ini blob into one inventory entry per recognized line.
///
/// The parser is forgiving: it splits on `\n` (consuming any preceding
/// `\r`) and accepts both `#KEY=VALUE` and `#KEY VALUE` shapes. Empty
/// lines and lines without a leading `#` are ignored.
pub fn parse_gameexe_inventory(bytes: &[u8]) -> GameexeInventoryReport {
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut cursor: usize = 0;
    let mut line_number: u64 = 0;
    while cursor < bytes.len() {
        line_number += 1;
        let line_start = cursor;
        // Find the end of this line (newline or EOF).
        let mut newline = cursor;
        while newline < bytes.len() && bytes[newline] != b'\n' {
            newline += 1;
        }
        let mut line_end = newline;
        // Trim trailing `\r` from the line bytes (CRLF support).
        if line_end > line_start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let line_bytes = &bytes[line_start..line_end];
        cursor = (newline + 1).min(bytes.len() + 1);
        if cursor > bytes.len() {
            cursor = bytes.len();
        }

        // Skip empties / non-key lines.
        let trimmed = trim_leading_ascii_ws(line_bytes);
        if trimmed.is_empty() || trimmed[0] != b'#' {
            continue;
        }

        // Split the line at the first `=` or whitespace into key/value.
        let (key_bytes, value_bytes) = split_key_value(trimmed);
        let key = String::from_utf8_lossy(key_bytes)
            .to_string()
            .to_uppercase();
        let value_decoded = decode_shift_jis_slot(value_bytes).text;
        let value = trim_inline_value(&value_decoded);

        let (family, treatment) = classify_key(&key, &value);
        if treatment == GameexeKeyTreatment::Unknown {
            warnings.push(GameexeIniDiagnostic {
                code: UNKNOWN_GAMEEXE_KEY_CODE.to_string(),
                line_number,
                key: key.clone(),
                message: format!(
                    "Gameexe.ini key {key} is not in the documented RealLive key surface \
                     (KAIFUU-190 catalogue); recording with typed UnknownReason"
                ),
            });
        }

        entries.push(GameexeInventoryEntry {
            line_number,
            byte_offset: line_start as u64,
            byte_len: (line_end - line_start) as u64,
            key,
            value,
            treatment,
            family,
        });
    }
    GameexeInventoryReport { entries, warnings }
}

fn trim_leading_ascii_ws(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    &bytes[start..]
}

fn split_key_value(bytes: &[u8]) -> (&[u8], &[u8]) {
    let mut key_end = 0;
    while key_end < bytes.len() {
        let byte = bytes[key_end];
        if byte == b'=' || byte.is_ascii_whitespace() {
            break;
        }
        key_end += 1;
    }
    let key = &bytes[..key_end];
    let mut value_start = key_end;
    while value_start < bytes.len()
        && (bytes[value_start] == b'=' || bytes[value_start].is_ascii_whitespace())
    {
        value_start += 1;
    }
    let value = if value_start <= bytes.len() {
        &bytes[value_start..]
    } else {
        &[]
    };
    (key, value)
}

/// Trim a decoded raw value: strip the wrapping `"…"` when present and
/// the value is a single quoted-string declaration, otherwise return the
/// raw decoded text as-is. Triple-equals lines (`#NAMAE`, `#FOLDNAME`,
/// `#SE.*`, `#DSTRACK`) keep the full RHS so downstream tuple parsers
/// can re-split.
fn trim_inline_value(decoded: &str) -> String {
    let trimmed = decoded.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        // Only strip when there's exactly one pair of quotes (no inner
        // `"=…="` triple-equals shape).
        let inner = &trimmed[1..trimmed.len() - 1];
        if !inner.contains('"') {
            return inner.to_string();
        }
    }
    trimmed.to_string()
}

/// Return `true` when a trimmed Gameexe.ini RHS is a purely numeric
/// config value (a single integer like `8`, or a numeric tuple like
/// `1,2,3`) rather than an asset path or pack declaration. Used to keep
/// numeric `#G00*` knobs (`#G00BUF=8`) classified as
/// [`GameexeKeyTreatment::Config`] instead of an asset reference.
fn is_numeric_config_value(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let mut saw_digit = false;
    for part in trimmed.split(',') {
        let part = part.trim();
        // Each comma-separated component must be a signed integer.
        match part.strip_prefix(['-', '+']).unwrap_or(part) {
            "" => return false,
            digits if digits.bytes().all(|b| b.is_ascii_digit()) => {
                saw_digit = true;
            }
            _ => return false,
        }
    }
    saw_digit
}

/// Classify a single upper-cased Gameexe.ini key into its
/// [`GameexeKeyFamily`] and high-level [`GameexeKeyTreatment`] bucket.
///
/// The key includes the leading `#`. Suffixes are passed by reference to
/// the `helpers` module so the per-family enum payload captures the
/// per-key suffix data without re-allocating the raw key string.
fn classify_key(key: &str, value: &str) -> (GameexeKeyFamily, GameexeKeyTreatment) {
    // Reject structurally malformed keys early.
    if key.len() <= 1 || !key.starts_with('#') {
        return (
            GameexeKeyFamily::Unknown {
                raw_key: key.to_string(),
                reason: UnknownReason::MalformedKey,
            },
            GameexeKeyTreatment::Unknown,
        );
    }
    let bare = &key[1..];
    if bare.is_empty() || bare.starts_with('.') || bare.starts_with('=') {
        return (
            GameexeKeyFamily::Unknown {
                raw_key: key.to_string(),
                reason: UnknownReason::MalformedKey,
            },
            GameexeKeyTreatment::Unknown,
        );
    }

    // ---- Indexed families: try the longest prefix first ----
    if let Some(rest) = bare.strip_prefix("FOLDNAME.") {
        return (
            GameexeKeyFamily::FolderName {
                kind: rest.to_string(),
            },
            GameexeKeyTreatment::AssetReference,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSEACTIONCALL.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::MouseActionCall { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("WBCALL.") {
        return (
            GameexeKeyFamily::WbCall {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("WAKU.") {
        // Two shapes: `WAKU.NNN.FIELD` and `WAKU.NNN.MMM.FIELD`.
        let segments: Vec<&str> = rest.splitn(3, '.').collect();
        return match segments.as_slice() {
            [theme, field] => (
                GameexeKeyFamily::Waku {
                    theme: (*theme).to_string(),
                    variant: None,
                    field: (*field).to_string(),
                },
                GameexeKeyTreatment::Config,
            ),
            [theme, variant, field] => (
                GameexeKeyFamily::Waku {
                    theme: (*theme).to_string(),
                    variant: Some((*variant).to_string()),
                    field: (*field).to_string(),
                },
                GameexeKeyTreatment::Config,
            ),
            _ => (
                GameexeKeyFamily::Waku {
                    theme: rest.to_string(),
                    variant: None,
                    field: String::new(),
                },
                GameexeKeyTreatment::Config,
            ),
        };
    }
    if let Some(rest) = bare.strip_prefix("WINDOW.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::Window { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("WINDOW_") {
        return (
            GameexeKeyFamily::WindowConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "WINDOW_ATTR" {
        return (
            GameexeKeyFamily::WindowConfig {
                field: "ATTR".to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MSGBK_WINDOW.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::MessageBackWindow { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MSGBK_") {
        return (
            GameexeKeyFamily::MessageBackConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("FULLSCREEN_MSGBK.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::FullScreenMessageBack { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("FULLSCREEN_MSGBK_") {
        return (
            GameexeKeyFamily::FullScreenMessageBackConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "FULLSCREEN_MSGBK" {
        return (
            GameexeKeyFamily::FullScreenMessageBackConfig {
                field: String::new(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSCOM.") {
        return (
            GameexeKeyFamily::Syscom {
                index: rest.to_string(),
            },
            // The SYSCOM RHS is a translatable `U:"…"` label; treat
            // SYSCOM lines as bridge-units. The protected `U:` prefix is
            // carried through in `value`.
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSCOM_") {
        return (
            GameexeKeyFamily::SyscomConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SELBTN.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::SelBtn { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SEL.") {
        return (
            GameexeKeyFamily::Sel {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SELPOINT_") {
        // e.g. `#SELPOINT_RETURN_MESS_STR` — translatable.
        let treatment = if rest.ends_with("_STR") {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::SelConfig {
                field: format!("POINT_{rest}"),
            },
            treatment,
        );
    }
    if bare == "DEFAULT_SEL_WINDOW" {
        return (
            GameexeKeyFamily::SelConfig {
                field: "DEFAULT_SEL_WINDOW".to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SEL_") {
        return (
            GameexeKeyFamily::SelConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("BTNOBJ.") {
        let (kind, rest_after) = split_first_dot(rest);
        return (
            GameexeKeyFamily::BtnObj {
                kind,
                rest: rest_after,
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSBTN.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::SysBtn { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSBTN_") {
        // `#SYSBTN_HIDE_STR` is translatable, others are config.
        let treatment = if rest.ends_with("_STR") {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::SysBtnConfig {
                field: rest.to_string(),
            },
            treatment,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSE_CURSOR_WINDOWBUTTON_") {
        return (
            GameexeKeyFamily::MouseCursorRegion {
                field: format!("WINDOWBUTTON_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSE_CURSOR_MESSAGEBACK_") {
        return (
            GameexeKeyFamily::MouseCursorRegion {
                field: format!("MESSAGEBACK_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "MOUSE_CURSOR_RESET" {
        return (
            GameexeKeyFamily::MouseCursorRegion {
                field: "RESET".to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSE_CURSOR.") {
        return (
            GameexeKeyFamily::MouseCursor {
                rest: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "MOUSE_CURSOR" {
        return (
            GameexeKeyFamily::MouseCursor {
                rest: String::new(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSE_") {
        return (
            GameexeKeyFamily::MouseConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("OBJECT.") {
        return (
            GameexeKeyFamily::Object {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "OBJECT_MAX" {
        return (GameexeKeyFamily::ObjectMax, GameexeKeyTreatment::Config);
    }
    if let Some(rest) = bare.strip_prefix("OBJDISP.") {
        return (
            GameexeKeyFamily::ObjDisp {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("INIT_") {
        return (
            GameexeKeyFamily::Init {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("BGM_") {
        return (
            GameexeKeyFamily::BgmConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SE.") {
        return (
            GameexeKeyFamily::SoundEffect {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "SOUND_DEFAULT" {
        return (GameexeKeyFamily::SoundDefault, GameexeKeyTreatment::Config);
    }
    if bare == "DSTRACK" {
        return (
            GameexeKeyFamily::DsTrack,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if let Some(rest) = bare.strip_prefix("PCM_VOLMOD.") {
        return (
            GameexeKeyFamily::PcmVolMod {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SERIALPDT.") {
        return (
            GameexeKeyFamily::SerialPdt {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("KOEONOFF.") {
        // Shape: `NNN.(MMM[,…]).ON`
        return (parse_koeonoff(rest), GameexeKeyTreatment::BridgeUnit);
    }
    if let Some(rest) = bare.strip_prefix("KOEREPLAYICON.") {
        return (
            GameexeKeyFamily::KoeReplayIcon {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "KOEREPLAYICON" {
        return (
            GameexeKeyFamily::KoeReplayIcon {
                field: String::new(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare.starts_with("KOEONOFF_") || bare == "KOEFILE_MOD" || bare == "KOEWAIT_TIME" {
        return (
            GameexeKeyFamily::KoeConfig {
                field: bare.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SHAKEZOOM.") {
        return (
            GameexeKeyFamily::ShakeZoom {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SHAKE.") {
        return (
            GameexeKeyFamily::Shake {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("HINT.") {
        let (kind, rest_after) = split_first_dot(rest);
        return (
            GameexeKeyFamily::Hint {
                kind,
                rest: rest_after,
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("COLOR_TABLE.") {
        return (
            GameexeKeyFamily::ColorTable {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MASK.") {
        return (
            GameexeKeyFamily::Mask {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::AssetReference,
        );
    }
    if let Some(rest) = bare.strip_prefix("CGTABLE_") {
        return (
            GameexeKeyFamily::CgTable {
                field: rest.to_string(),
            },
            // CGTABLE_FILENAME is an asset path; CGTABLE_MOD is config.
            if rest == "FILENAME" {
                GameexeKeyTreatment::AssetReference
            } else {
                GameexeKeyTreatment::Config
            },
        );
    }
    if let Some(rest) = bare.strip_prefix("CDDA_") {
        return (
            GameexeKeyFamily::CddaSetup {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("HAIKEICHR_") {
        return (
            GameexeKeyFamily::HaikeiChr {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("KEYWAIT_") {
        return (
            GameexeKeyFamily::KeyWait {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MESSAGE_KEY_WAIT_") {
        return (
            GameexeKeyFamily::MessageKeyWait {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("FONT_") {
        return (
            GameexeKeyFamily::FontConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("RETURN_CURSOR_") {
        return (
            GameexeKeyFamily::Cursor {
                field: format!("RETURN_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("CURSOR.") {
        return (
            GameexeKeyFamily::Cursor {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "CURSOR" {
        return (
            GameexeKeyFamily::Cursor {
                field: String::new(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "QUARTERVIEW_SIZE" {
        return (
            GameexeKeyFamily::QuarterViewSize,
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SAVE_") {
        let treatment = match rest {
            "TITLE" | "NODATA" => GameexeKeyTreatment::BridgeUnit,
            _ => GameexeKeyTreatment::Config,
        };
        let family = if rest == "NODATA" {
            GameexeKeyFamily::SaveNoData
        } else {
            GameexeKeyFamily::Save {
                field: format!("_{rest}"),
            }
        };
        return (family, treatment);
    }
    if let Some(rest) = bare.strip_prefix("SAVEPOINT_") {
        return (
            GameexeKeyFamily::Save {
                field: format!("POINT_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "QUICK_SAVEDATA_USE" {
        return (
            GameexeKeyFamily::Save {
                field: "QUICK_USE".to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SAVEMESSAGE_") {
        let treatment = if rest.ends_with("_STR") {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("SAVE_{rest}"),
            },
            treatment,
        );
    }
    if let Some(rest) = bare.strip_prefix("LOADMESSAGE_") {
        let treatment = if rest.ends_with("_STR") {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("LOAD_{rest}"),
            },
            treatment,
        );
    }
    if let Some(rest) = bare.strip_prefix("DLGSAVEMESSAGE_") {
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("DLGSAVE_{rest}"),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if let Some(rest) = bare.strip_prefix("DLGLOADMESSAGE_") {
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("DLGLOAD_{rest}"),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if bare == "SYSTEM_SAVELOADMESSAGE_STR" {
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: "SYSTEM_STR".to_string(),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if let Some(rest) = bare.strip_prefix("SAVELOADDLG_") {
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("DLG_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("DEBUG_") {
        return (
            GameexeKeyFamily::Debug,
            // `DEBUG_WINDOW_CAPTION` is a window-title string. Treat
            // remaining DEBUG_* as config.
            match rest {
                "WINDOW_CAPTION" => GameexeKeyTreatment::BridgeUnit,
                _ => GameexeKeyTreatment::Config,
            },
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSTEMCALL_") {
        return (
            GameexeKeyFamily::SystemCall,
            // The `_MOD` and `_<NAME>` variants are both scene-call dispatch
            // tuples / mode flags; all config.
            {
                let _ = rest;
                GameexeKeyTreatment::Config
            },
        );
    }
    if let Some(rest) = bare.strip_prefix("LOADCALL")
        && (rest.is_empty() || rest == "_MOD")
    {
        return (GameexeKeyFamily::LoadCall, GameexeKeyTreatment::Config);
    }
    if let Some(rest) = bare.strip_prefix("CANCELCALL")
        && (rest.is_empty() || rest == "_MOD")
    {
        return (GameexeKeyFamily::CancelCall, GameexeKeyTreatment::Config);
    }
    if let Some(rest) = bare.strip_prefix("EXAFTERCALL")
        && (rest.is_empty() || rest == "_MOD")
    {
        return (GameexeKeyFamily::ExAfterCall, GameexeKeyTreatment::Config);
    }
    if bare == "SEEN_START" || bare == "SEEN_MENU" || bare == "SEEN_TEXT_CURENT" {
        return (GameexeKeyFamily::SeenEntry, GameexeKeyTreatment::Config);
    }
    if bare.starts_with("SEEN") {
        return (
            GameexeKeyFamily::SeenAsset,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "NAMAE" {
        return (GameexeKeyFamily::Namae, GameexeKeyTreatment::BridgeUnit);
    }
    if let Some(rest) = bare.strip_prefix("NAME") {
        // `#NAME.A`, `#NAME_MAXLEN`.
        let treatment = if rest.starts_with('.') {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::Name {
                field: rest.to_string(),
            },
            treatment,
        );
    }
    if let Some(rest) = bare.strip_prefix("LOCALNAME.") {
        return (
            GameexeKeyFamily::LocalName {
                slot: rest.to_string(),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if let Some(rest) = bare.strip_prefix("READJUMP_") {
        return (
            GameexeKeyFamily::ReadJump {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "UNREADJUMP_STR" {
        return (
            GameexeKeyFamily::ReadJump {
                field: "UNREAD_STR".to_string(),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    // Single-string UI messages.
    if matches!(
        bare,
        "GAME_END_MESS_STR" | "MENU_RETURN_MESS_STR" | "SYSTEM_ANIME_STR"
    ) {
        return (
            GameexeKeyFamily::UiMessageStr {
                key: bare.to_string(),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if bare == "CAPTION" {
        return (GameexeKeyFamily::Caption, GameexeKeyTreatment::BridgeUnit);
    }
    if bare == "SUBTITLE" {
        return (GameexeKeyFamily::Subtitle, GameexeKeyTreatment::Config);
    }
    if bare == "REGNAME" {
        return (
            GameexeKeyFamily::RegName,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "DISKMARK" {
        return (
            GameexeKeyFamily::DiskMark,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "VERSION_STR" {
        return (
            GameexeKeyFamily::VersionStr,
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if bare == "SCREENSIZE_MOD" {
        return (GameexeKeyFamily::ScreenSizeMod, GameexeKeyTreatment::Config);
    }
    if matches!(
        bare,
        "MMX_ENABLE"
            | "D3D_ENABLE"
            | "MEMORY"
            | "DEMONSTRATION"
            | "X_Z_KEY_MOD"
            | "ALT_ENTER_USE"
            | "CTRL_USE"
            | "GRAPHIC_DISP_MODE"
            | "WAIP_WINDOWCLOSE"
            | "GRPCOM_WINDOWCLOSE"
            | "ANIME_HISPEED_MODE"
            | "MANUAL_PATH"
            | "MASK"
            | "D"
            | "MSGBK_BUTTON_DISP_MODE"
    ) {
        return (
            GameexeKeyFamily::EngineBootstrap,
            GameexeKeyTreatment::Config,
        );
    }
    // Pre-KAIFUU-190 minimal-subset asset prefixes (kept as family
    // members so the catalogue stays exhaustive for the keys those
    // titles use).
    if bare.starts_with("G00") {
        // `#G00BUF=8` and similar numeric knobs are image-buffer
        // counts/config, not asset paths. Only reserve AssetReference
        // for actual `#G00*` path/pack declarations. A numeric RHS must
        // never be emitted as a literal asset-path reference.
        let treatment = if is_numeric_config_value(value) {
            GameexeKeyTreatment::Config
        } else {
            GameexeKeyTreatment::AssetReference
        };
        return (GameexeKeyFamily::G00Family, treatment);
    }
    if bare.starts_with("KOE") {
        return (
            GameexeKeyFamily::KoePack,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare.starts_with("NWK") || bare.starts_with("OVK") {
        return (
            GameexeKeyFamily::NwkOvk,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "GAMEEXE_VERSION" {
        return (
            GameexeKeyFamily::GameexeVersion,
            GameexeKeyTreatment::Config,
        );
    }

    (
        GameexeKeyFamily::Unknown {
            raw_key: key.to_string(),
            reason: UnknownReason::UnknownFamily,
        },
        GameexeKeyTreatment::Unknown,
    )
}

fn split_first_dot(rest: &str) -> (String, String) {
    match rest.find('.') {
        Some(idx) => (rest[..idx].to_string(), rest[idx + 1..].to_string()),
        None => (rest.to_string(), String::new()),
    }
}

fn parse_koeonoff(rest: &str) -> GameexeKeyFamily {
    // Shape: `NNN.(MMM[,…]).ON` (`.ON` may be `.OFF`; we ignore the
    // trailing field, just capture index and bracketed speakers).
    let (index, after_index) = split_first_dot(rest);
    // `after_index` may start with `(...)`.
    let mut speakers = String::new();
    if let Some(open) = after_index.find('(')
        && let Some(close) = after_index[open + 1..].find(')')
    {
        speakers = after_index[open + 1..open + 1 + close].to_string();
    }
    GameexeKeyFamily::KoeOnOff { index, speakers }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first(report: &GameexeInventoryReport) -> &GameexeInventoryEntry {
        report.entries.first().expect("at least one entry")
    }

    #[test]
    fn parses_caption_as_bridge_unit() {
        let ini = b"#CAPTION=\"Test Title\"\n";
        let report = parse_gameexe_inventory(ini);
        let entry = first(&report);
        assert_eq!(entry.key, "#CAPTION");
        assert_eq!(entry.value, "Test Title");
        assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
        assert!(matches!(entry.family, GameexeKeyFamily::Caption));
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn classifies_foldname_family_with_kind_suffix() {
        let ini = b"#FOLDNAME.G00 = \"G00\" = 0 : \"G00.PAK\"\n";
        let report = parse_gameexe_inventory(ini);
        let entry = first(&report);
        assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
        match &entry.family {
            GameexeKeyFamily::FolderName { kind } => assert_eq!(kind, "G00"),
            other => panic!("expected FolderName, got {other:?}"),
        }
    }

    #[test]
    fn classifies_screensize_mod_as_config() {
        let ini = b"#SCREENSIZE_MOD=999,1280,720\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
        assert!(matches!(entry.family, GameexeKeyFamily::ScreenSizeMod));
    }

    #[test]
    fn classifies_waku_two_level_index() {
        let ini = b"#WAKU.000.000.NAME=\"_waku10\"\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::Waku {
                theme,
                variant,
                field,
            } => {
                assert_eq!(theme, "000");
                assert_eq!(variant.as_deref(), Some("000"));
                assert_eq!(field, "NAME");
            }
            other => panic!("expected Waku, got {other:?}"),
        }
        assert_eq!(entry.value, "_waku10");
    }

    #[test]
    fn classifies_waku_one_level_index() {
        let ini = b"#WAKU.000.TYPE=5\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::Waku {
                theme,
                variant,
                field,
            } => {
                assert_eq!(theme, "000");
                assert!(variant.is_none());
                assert_eq!(field, "TYPE");
            }
            other => panic!("expected Waku, got {other:?}"),
        }
    }

    #[test]
    fn classifies_syscom_indexed_as_bridge_unit() {
        let ini = b"#SYSCOM.005.000=\"FullScreen\"\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::Syscom { index } => assert_eq!(index, "005.000"),
            other => panic!("expected Syscom, got {other:?}"),
        }
        assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
    }

    #[test]
    fn classifies_object_max_and_object_indexed() {
        let report = parse_gameexe_inventory(b"#OBJECT_MAX=256\n#OBJECT.001=0,0,0\n");
        assert_eq!(report.entries.len(), 2);
        assert!(matches!(
            report.entries[0].family,
            GameexeKeyFamily::ObjectMax
        ));
        match &report.entries[1].family {
            GameexeKeyFamily::Object { index } => assert_eq!(index, "001"),
            other => panic!("expected Object, got {other:?}"),
        }
    }

    #[test]
    fn classifies_koeonoff_indexed_as_bridge_unit_with_speaker_set() {
        let ini = "#KOEONOFF.005.(000,002,003,004).ON=\"women\"\n".as_bytes();
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::KoeOnOff { index, speakers } => {
                assert_eq!(index, "005");
                assert_eq!(speakers, "000,002,003,004");
            }
            other => panic!("expected KoeOnOff, got {other:?}"),
        }
        assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
    }

    #[test]
    fn classifies_namae_as_bridge_unit() {
        let ini = "#NAMAE=\"Kazuto\" = \"Kazuto\" = (1,016, -1)\n".as_bytes();
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        assert!(matches!(entry.family, GameexeKeyFamily::Namae));
        assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
    }

    #[test]
    fn classifies_mouseactioncall_index_and_field() {
        let ini = b"#MOUSEACTIONCALL.000.AREA=1232,0,1279,719\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::MouseActionCall { index, field } => {
                assert_eq!(index, "000");
                assert_eq!(field, "AREA");
            }
            other => panic!("expected MouseActionCall, got {other:?}"),
        }
        assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
    }

    #[test]
    fn classifies_se_indexed_as_asset_reference() {
        let ini = b"#SE.000 = \"SELECT\" = 0\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::SoundEffect { index } => assert_eq!(index, "000"),
            other => panic!("expected SoundEffect, got {other:?}"),
        }
        assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
    }

    #[test]
    fn classifies_dstrack_as_asset_reference() {
        let ini = b"#DSTRACK = 00000000 - 08466742 - 04233233 = \"ASA\" = \"ASA\"\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        assert!(matches!(entry.family, GameexeKeyFamily::DsTrack));
        assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
    }

    #[test]
    fn classifies_window_indexed_field() {
        let ini = b"#WINDOW.000.MOJI_SIZE=36\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::Window { index, field } => {
                assert_eq!(index, "000");
                assert_eq!(field, "MOJI_SIZE");
            }
            other => panic!("expected Window, got {other:?}"),
        }
    }

    #[test]
    fn classifies_window_config_attr() {
        let ini = b"#WINDOW_ATTR=100,100,160,200,0\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::WindowConfig { field } => assert_eq!(field, "ATTR"),
            other => panic!("expected WindowConfig, got {other:?}"),
        }
        assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
    }

    #[test]
    fn classifies_save_nodata_as_bridge_unit() {
        let ini = "#SAVE_NODATA=\"empty\"\n".as_bytes();
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        assert!(matches!(entry.family, GameexeKeyFamily::SaveNoData));
        assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
    }

    #[test]
    fn classifies_savemessage_str_as_bridge_unit() {
        let ini = "#SAVEMESSAGE_TITLE_STR=\"confirm\"\n".as_bytes();
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        assert_eq!(entry.treatment, GameexeKeyTreatment::BridgeUnit);
    }

    #[test]
    fn classifies_btnobj_with_kind_and_rest() {
        let ini = b"#BTNOBJ.ACTION.000.HIT=1\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::BtnObj { kind, rest } => {
                assert_eq!(kind, "ACTION");
                assert_eq!(rest, "000.HIT");
            }
            other => panic!("expected BtnObj, got {other:?}"),
        }
    }

    #[test]
    fn classifies_hint_subfamily() {
        let ini = b"#HINT.AUTOMODE.POS=1140,0\n";
        let entry = first(&parse_gameexe_inventory(ini)).clone();
        match entry.family {
            GameexeKeyFamily::Hint { kind, rest } => {
                assert_eq!(kind, "AUTOMODE");
                assert_eq!(rest, "POS");
            }
            other => panic!("expected Hint, got {other:?}"),
        }
    }

    #[test]
    fn classifies_mask_indexed_as_asset_reference() {
        let entry = first(&parse_gameexe_inventory(b"#MASK.003=\"_mask03\"\n")).clone();
        match entry.family {
            GameexeKeyFamily::Mask { index } => assert_eq!(index, "003"),
            other => panic!("expected Mask, got {other:?}"),
        }
        assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
    }

    #[test]
    fn classifies_color_table_indexed() {
        let entry = first(&parse_gameexe_inventory(b"#COLOR_TABLE.001=255,255,255\n")).clone();
        match entry.family {
            GameexeKeyFamily::ColorTable { index } => assert_eq!(index, "001"),
            other => panic!("expected ColorTable, got {other:?}"),
        }
    }

    #[test]
    fn classifies_init_family() {
        let entry = first(&parse_gameexe_inventory(b"#INIT_SCREENMODE=0\n")).clone();
        match entry.family {
            GameexeKeyFamily::Init { field } => assert_eq!(field, "SCREENMODE"),
            other => panic!("expected Init, got {other:?}"),
        }
    }

    #[test]
    fn numeric_g00_knob_is_config_not_asset_reference() {
        // `#G00BUF=8` is an image-buffer count, not an asset path; it
        // must not be emitted as a literal asset reference.
        let report = parse_gameexe_inventory(b"#G00BUF=8\n");
        let entry = first(&report);
        assert_eq!(entry.treatment, GameexeKeyTreatment::Config);
        assert!(matches!(entry.family, GameexeKeyFamily::G00Family));
    }

    #[test]
    fn path_g00_declaration_stays_asset_reference() {
        // A non-numeric `#G00*` RHS is an actual path/pack declaration.
        let report = parse_gameexe_inventory(b"#G00PACK=bg.g00\n");
        let entry = first(&report);
        assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
        assert!(matches!(entry.family, GameexeKeyFamily::G00Family));
    }

    #[test]
    fn koepac_stays_asset_reference() {
        let report = parse_gameexe_inventory(b"#KOEPAC=koe.ovk\n");
        let entry = first(&report);
        assert_eq!(entry.treatment, GameexeKeyTreatment::AssetReference);
        assert!(matches!(entry.family, GameexeKeyFamily::KoePack));
    }

    #[test]
    fn negative_test_bare_hash_yields_malformed_unknown() {
        let report = parse_gameexe_inventory(b"#\n");
        let entry = first(&report);
        assert_eq!(entry.treatment, GameexeKeyTreatment::Unknown);
        match &entry.family {
            GameexeKeyFamily::Unknown { reason, .. } => {
                assert_eq!(*reason, UnknownReason::MalformedKey);
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
        assert_eq!(report.warnings.len(), 1);
        assert_eq!(report.warnings[0].code, UNKNOWN_GAMEEXE_KEY_CODE);
    }

    #[test]
    fn negative_test_hash_dot_only_yields_malformed_unknown() {
        let report = parse_gameexe_inventory(b"#.foo=1\n");
        let entry = first(&report);
        assert_eq!(entry.treatment, GameexeKeyTreatment::Unknown);
        match &entry.family {
            GameexeKeyFamily::Unknown { reason, .. } => {
                assert_eq!(*reason, UnknownReason::MalformedKey);
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn negative_test_garbage_family_yields_unknown_family() {
        let report = parse_gameexe_inventory(b"#NONSENSE_FAMILY_THAT_DOES_NOT_EXIST=1\n");
        let entry = first(&report);
        assert_eq!(entry.treatment, GameexeKeyTreatment::Unknown);
        match &entry.family {
            GameexeKeyFamily::Unknown { reason, raw_key } => {
                assert_eq!(*reason, UnknownReason::UnknownFamily);
                assert!(raw_key.contains("NONSENSE_FAMILY"));
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn unknown_carries_raw_key_text() {
        let report = parse_gameexe_inventory(b"#WEIRDXXX=42\n");
        let entry = first(&report);
        match &entry.family {
            GameexeKeyFamily::Unknown { raw_key, .. } => {
                assert_eq!(raw_key, "#WEIRDXXX");
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn handles_crlf_line_endings_and_blank_lines() {
        let ini = b"\r\n#CAPTION=\"Hi\"\r\n\r\n#REGNAME=Tester\r\n";
        let report = parse_gameexe_inventory(ini);
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.entries[0].key, "#CAPTION");
        assert_eq!(report.entries[1].key, "#REGNAME");
    }
}
