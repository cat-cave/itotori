use std::fmt;

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};

use super::model::UnknownReason;

/// Typed key family classification.
/// Each variant captures the per-key suffix / index data the family
/// uses, so downstream consumers can route keys by family without
/// re-parsing the raw key string.
/// Family naming and grouping is taken from
/// `docs/research/reallive-engine.md` §B. Where a family has documented
/// suffix structure (e.g. `#FOLDNAME.G00 = "G00" = 0: "G00.PAK"`,
/// `#WAKU.NNN.MMM.FIELD`, `#KOEONOFF.NNN.(MMM).ON="..."`), the
/// classifier records the suffix segments here; full parsing of the
/// triple-equals RHS shape is left to the consumers that need it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "family")]
pub enum GameexeKeyFamily {
    /// `#CAPTION="…"` — window-title text (translatable).
    Caption,
    /// `#SUBTITLE=…` — subtitle config.
    Subtitle,
    /// `#REGNAME="<vendor registry key>"` — registry-key identifier.
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

    /// `#SEEN_START`, `#SEEN_MENU`, `#SEEN_TEXT_CURENT` — scene-id
    /// entrypoints.
    SeenEntry,
    /// `#CANCELCALL=9999,10`, `#CANCELCALL_MOD=1`.
    CancelCall,
    /// `#SYSTEMCALL_SAVE`, `#SYSTEMCALL_LOAD`, `#SYSTEMCALL_SYSTEM`,
    /// `#SYSTEMCALL_<NAME>_MOD`. `payload` is the suffix after
    /// `SYSTEMCALL_` (e.g. `SAVE`, `LOAD`, `SYSTEM`, `<NAME>_MOD`), so a
    /// typed consumer can distinguish the sub-call without re-parsing the
    /// raw key.
    SystemCall {
        /// Raw suffix after `#SYSTEMCALL_`.
        payload: String,
    },
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

    /// `#FOLDNAME.G00 = "G00" = 0: "G00.PAK"` — triple-valued.
    FolderName {
        /// Suffix after `#FOLDNAME.` (e.g. `G00`, `BGM`, `KOE`).
        kind: String,
    },

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

    /// `#BTNOBJ.ACTION.NNN.STATE=…`, `#BTNOBJ.SE.NNN.STATE=…`,
    /// `#BTNOBJ.GROUP.NNN`. The leading sub-namespace is captured as
    /// `kind`.
    BtnObj {
        /// Sub-namespace after `#BTNOBJ.` (e.g. `ACTION`, `SE`, `GROUP`).
        kind: String,
        /// Remaining dotted suffix.
        rest: String,
    },

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
    /// `#DLL.NNN = "rlBabel"` — RealLive extension-DLL slot binding. The
    /// RHS is an engine extension-module name (e.g. the RLDEV `rlBabel`
    /// text-formatting / translation-support DLL) that the VM resolves for
    /// extended system-call dispatch. It is an engine configuration
    /// binding, not translatable text and not a game-content asset path.
    Dll {
        /// Decimal slot index after `#DLL.`.
        index: String,
    },

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

    /// Catch-all. Carries the raw key and a typed reason.
    Unknown {
        /// Raw key text as parsed (upper-cased, including leading `#`).
        raw_key: String,
        /// Why the classifier rejected the key.
        reason: UnknownReason,
    },
}

impl fmt::Debug for GameexeKeyFamily {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("GameexeKeyFamily");
        debug.field("variant", &std::mem::discriminant(self));
        if let Self::Unknown { raw_key, reason } = self {
            debug
                .field("raw_key", &RedactedContentSummary::from_text(raw_key))
                .field("reason", reason);
        }
        debug.finish()
    }
}
