//! UTSUSHI-200 alpha gate 2 — `utsushi-reallive` engine-port crate scaffold.
//!
//! This crate is the **non-synthetic engine-port scaffold** that
//! demonstrates the UTSUSHI-120 substrate facade is engine-extensible
//! beyond the synthetic [`utsushi-fixture`](../utsushi_fixture/index.html)
//! port. It is intentionally a **scaffold only**: every lifecycle method
//! returns a typed [`EnginePortError::Lifecycle`] with the message
//! [`UNIMPLEMENTED_MESSAGE`] and the matching [`LifecycleStage`]. No
//! opcode handlers, no archive parsers, no VFS reads. The behavioural
//! work lands continuously after alpha (UTSUSHI-201..UTSUSHI-221).
//!
//! # Clean-room provenance
//!
//! - All RealLive format observations consumed by this crate's eventual
//!   implementation are derived from publicly archived format
//!   documentation (Haeleth's RLDEV site,
//!   `https://dev.haeleth.net/rldev.shtml`) plus the Sweetie HD bytes
//!   audited under `docs/audits/real-bytes-validation-2026-06-24.md`. No
//!   source expression is copied from RLDEV or rlvm.
//! - rlvm (`https://github.com/eglaysher/rlvm`) is a **research anchor
//!   only**. Its license is GPLv3+ and is incompatible with itotori's
//!   distribution posture if linked or derived. This crate does NOT
//!   depend on rlvm, does NOT include rlvm headers, does NOT copy rlvm's
//!   structure layouts, and does NOT mechanically translate rlvm code
//!   into Rust. If a hypothesis about RealLive's format was confirmed by
//!   reading rlvm, the hypothesis is re-derived and re-tested against
//!   Sweetie HD bytes before being encoded here.
//! - siglus_rs and xclannad are explicitly out of scope for this crate.
//!   The RealLive port targets RealLive — sibling engines get sibling
//!   port crates so cross-engine bleed is impossible at the crate-graph
//!   level.
//! - No `Command::new`, no Wine, no Windows helper, no remote helper.
//!   When the lifecycle methods grow real bodies they will consume the
//!   substrate's [`utsushi_core::substrate::AssetPackage`] surface — not
//!   the host filesystem — and emit through the substrate's
//!   [`utsushi_core::substrate::SinkSet`] sinks.
//!
//! # Substrate-facade containment
//!
//! Every `utsushi_core::*` import in this crate is sourced through
//! `utsushi_core::substrate::*`. Reaching past the facade (e.g. through
//! the legacy `utsushi_core::vfs::*` direct path, the still-public
//! `utsushi_core::port::*` re-exports, or any `__internal` / `sealed`
//! path) is rejected at audit time. The `tests/substrate_conformance.rs`
//! integration test pins this rule at the build level.
//!
//! # Surface
//!
//! - [`UtsushiReallivePort`] — the [`utsushi_core::substrate::EnginePort`]
//!   implementor. Holds an inert [`UtsushiReallivePortContext`] that the
//!   continuous-tier follow-up nodes will populate with an asset package
//!   and a scene index.
//! - [`UtsushiReallivePortContext`] — the carrier struct the eventual
//!   implementation will use to thread the asset package and the
//!   `utsushi-reallive`-owned [`RealSceneIndex`] into the lifecycle
//!   methods. Carries `Option<...>` slots today; the post-alpha nodes
//!   will replace the `Option` with required fields once the inventory
//!   cross-reference is plumbed.
//! - [`UNIMPLEMENTED_MESSAGE`] — the typed string every lifecycle method
//!   currently returns inside [`EnginePortError::Lifecycle`]. Pinned as a
//!   public `const` so the scaffold conformance test can assert against
//!   it without string-matching the human-readable display form.
//! - [`RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`] — the boundary statement
//!   carried as a public `const &str` so audit tooling (and the scaffold
//!   conformance test) can pin the no-vendoring, no-derivation posture
//!   without parsing the crate-level docstring.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod gameexe;

// UTSUSHI-217: in-crate `AudioEvent` carrier + sink, the audible
// counterpart to UTSUSHI-214's headless render pipeline.
pub mod audio;

// UTSUSHI-217: typed decoders for the `.nwa` BGM / SE container and
// the `.ovk` voice archive container.
pub mod nwa;
pub mod ovk;

pub use audio::{
    AUDIO_EVENT_STORE_MISS_CODE, AudioEvent, AudioEventEmitter, AudioEventKind, AudioEventPayload,
    AudioEventStoreError, InMemoryAudioEventStore,
};
pub use nwa::{
    NWA_COMPRESSION_MODE_MAX, NWA_COMPRESSION_MODE_RAW_PCM, NWA_HEADER_BYTE_LEN,
    NWA_HEADER_TRUNCATED_CODE, NWA_OUT_OF_PROFILE_COMPRESSION_CODE, NWA_UNSUPPORTED_BPS_CODE,
    NWA_UNSUPPORTED_CHANNELS_CODE, NwaCompressionMode, NwaDecodeError, NwaFile, NwaHeader,
    decode_nwa, decode_nwa_header, nwa_block_table_byte_len,
};
pub use ovk::{
    OGG_PAGE_MAGIC, OVK_ENTRY_BODY_OUT_OF_BOUNDS_CODE, OVK_ENTRY_BYTE_LEN,
    OVK_ENTRY_TABLE_TRUNCATED_CODE, OVK_HEADER_BYTE_LEN, OVK_HEADER_TRUNCATED_CODE, OvkDecodeError,
    OvkEntry, OvkFile, decode_ovk,
};

pub use gameexe::{
    GAMEEXE_SHIFT_JIS_DECODE_FAILURE_CODE, Gameexe, GameexeParseError, GameexeValue, NamaeEntry,
    SyscomLabel, SyscomVisibility, parse_into_arc as parse_gameexe_into_arc,
};

use std::sync::Arc;

use utsushi_core::substrate::{
    AssetPackage, EnginePort, EnginePortError, EvidenceTier, FidelityTier, LifecycleStage,
    PortCapability, PortManifest, PortRequest, PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES,
    SinkSet,
};
// `CaptureOutcome` is the typed return value of `EnginePort::capture` and
// is therefore load-bearing for any implementor. It is currently reachable
// only via the crate root (`utsushi_core::CaptureOutcome`) — the substrate
// facade in `crates/utsushi-core/src/substrate.rs` does not yet re-export
// it. This is the **single** non-facade `utsushi_core::*` import in this
// crate; it is forced by the `EnginePort::capture` signature, not chosen.
// The audit grep that asserts no sealed / internal substrate paths are
// imported still returns zero hits — `CaptureOutcome` is a public root
// type, not an internal one. Tracked as a known facade omission that a
// follow-up
// substrate slice should fix; until then we use the root path with a
// narrow rename so the import site is grep-pinnable.
use utsushi_core::CaptureOutcome as SubstrateCaptureOutcome;

// UTSUSHI-201: `utsushi-reallive` owns its own `Seen.txt` parser. The
// scene-index types below are the ones successor nodes
// (UTSUSHI-202..UTSUSHI-221) consume.
pub mod scene_index;

// UTSUSHI-202: typed decoder for the 0x1d0-byte scene header that
// prefixes every populated scene blob. Consumes the scene-blob slice
// pointed at by a `RealSceneEntry` from UTSUSHI-201 and produces a
// typed `SceneHeader` plus the list of non-fatal warnings observed
// during the walk.
pub mod scene_header;

// UTSUSHI-203: AVG32 LZSS + XOR decompressor for the scene bytecode
// payload pointed at by `SceneHeader::bytecode_offset`. Consumes the
// compressed slice and produces the post-LZSS plaintext bytecode.
pub mod decompressor;

// UTSUSHI-204: typed lead-byte lexer for the decompressed bytecode
// stream produced by `AvgDecompressor::decompress`. Produces a
// `Vec<BytecodeElement>` whose `byte_offset`/`byte_len` ranges
// partition the input slice exactly.
pub mod bytecode_element;

// UTSUSHI-205: RealLive expression byte-stream parser + evaluator.
// `parse_expression` consumes the `raw_bytes` payload of a
// `BytecodeElement::Expression` (UTSUSHI-204) and produces a typed
// `ExprNode`. `evaluate` / `evaluate_assignment` reduce the AST against
// a typed `VarBanks` snapshot.
pub mod expression;
pub mod expression_eval;

// UTSUSHI-206: sparse `VarBanks` adopted into the substrate
// `Inspectable` / `Restorable` traits. Replaces UTSUSHI-205's dense
// `[i32; 4096]` representation; integer banks clamp to the
// rlvm-documented 2 000 indices per bank, string banks store raw
// Shift-JIS bytes, and the store register lives on the same struct.
pub mod var_banks;

// UTSUSHI-208: `RLOperation` trait, dispatch outcomes, and the
// fail-soft `RlopRegistry` / `LongOpScheduler` plumbing the VM
// consumes during `step`. The per-module RLOperation tables (the
// actual text / control-flow / sys operations) land in UTSUSHI-209
// and UTSUSHI-210; this module only ships the trait, the dispatch
// outcome enum, and the test-controllable scheduler implementations.
pub mod rlop;

// UTSUSHI-208: bytecode VM. Owns the active `(scene, pc)`, the call
// stack, the typed variable banks, and the suspended-longop queue.
// The substrate `Inspectable` / `Restorable` impls round-trip the
// whole VM through the snapshot store (paused longops carry their
// private state through the round trip — acceptance criterion #3).
pub mod vm;

// UTSUSHI-220: end-to-end Sweetie HD scene-1 text-replay smoke. Drives
// a Seen.txt envelope through the full UTSUSHI-201..UTSUSHI-210 chain
// and produces a typed `ReplayLog` containing the alpha-defining
// `TextLine` events.
pub mod replay;

// UTSUSHI-227: patched-Seen.txt replay-and-verify smoke. Consumes a
// `ReplayLog` (or drives one via `replay_scene`) and reports whether
// any captured `TextLine` body carries an expected substring. The
// alpha-defining "verifiable patch landed" gate.
pub mod replay_validate;

// UTSUSHI-216: g00 image-format decoder (types 0, 1, 2). Owns the
// shared LZSS variants and the corpus-wide lead-byte histogram that
// emits `utsushi.reallive.g00_no_type_N_in_corpus` for types not
// represented in a given corpus.
pub mod g00;

// UTSUSHI-213: system-call dispatch wired to Gameexe routes. Owns the
// typed `SyscallDispatcher` that builds a route table from the
// Sweetie HD-shaped `Gameexe.ini` and invokes each route through the
// UTSUSHI-211 `FarcallOp` (no private dispatch path).
pub mod syscall;

// UTSUSHI-214: graphics object stack (256 slots × 2 planes) — the
// rlvm `GraphicsSystem` equivalent. Owns per-object state
// (`position`, `scale`, `alpha`, `colour_tone`, `image_ref`,
// `layer_order`) but no rasterisation logic; the headless render
// pipeline at [`render_pipeline`] is what walks the stack and emits
// PNGs.
pub mod graphics_objects;

// UTSUSHI-214: headless render pipeline + deterministic PNG encoder.
// Walks the [`graphics_objects::GraphicsObjectStack`], rasterises into
// a `Framebuffer`, encodes a deterministic (no timestamp metadata)
// PNG, and stores the bytes in an [`render_pipeline::InMemoryFrameArtifactStore`]
// keyed by a SHA-256-derived `artifact_id`. The artifact-store is
// intentionally byte-retaining so the audit-focus "stub `Vec` that
// doesn't actually retain bytes" cannot apply.
pub mod render_pipeline;

// UTSUSHI-218: AVG-derived save format (`SAVE_FORMAT=3`). Typed
// reader/writer for `REALLIVE.sav` (per-slot system save),
// `save999.sav` (global save), and `read.sav` (per-line read flags).
// The substrate `SnapshotStore` is the in-memory backing for save
// state; the on-disk serialiser is intentionally separate.
pub mod save;

pub use syscall::{
    HotRegion, SYSCALL_KIND_COUNT, SYSCALL_MISSING_SCREEN_SIZE_CODE,
    SYSCALL_MOUSE_AREA_MALFORMED_CODE, SYSCALL_ROUTE_MALFORMED_PAIR_CODE, ScreenSize,
    SyscallDispatchBuildError, SyscallDispatcher, SyscallRoute, SyscallRouteKind,
    WBCALL_SLOT_COUNT,
};

pub use graphics_objects::{
    GRAPHICS_OBJECT_SLOT_COUNT, GRAPHICS_OBJECT_TOTAL_SLOTS, GraphicsAlpha, GraphicsColourTone,
    GraphicsObject, GraphicsObjectKind, GraphicsObjectStack, GraphicsPlane, GraphicsPosition,
    GraphicsScale, GraphicsStackError, ImageRef, WipeColour,
};
pub use render_pipeline::{
    FrameArtifactStoreError, FrameEmission, Framebuffer, InMemoryFrameArtifactStore, PNG_BIT_DEPTH,
    PNG_COLOUR_TYPE_RGBA, PNG_FILE_MAGIC, RENDER_PIPELINE_ARTIFACT_MISS_CODE,
    RENDER_PIPELINE_ZERO_SCREEN_SIZE_CODE, RGBA_BYTES_PER_PIXEL, RenderPass, RenderPassBuildError,
    adler32, crc32_ieee, encode_png_rgba_deterministic, sha256_hex,
};

pub use save::{
    AVG_SAVE_PREAMBLE_BYTE_LEN, AvgSavePreamble, GLOBAL_SAVE_MAGIC, GlobalSave, ReadFlags,
    SAVE_FORMAT_AVG_DERIVED, SAVE_STATE_INSPECTABLE_ID, SWEETIE_HD_COMPILER_VERSION,
    SYSTEM_SAVE_MAGIC, SaveDecodeError, SaveRoundTrip, SaveState, SystemSave,
};

pub use g00::{
    G00_HEADER_PREAMBLE_BYTE_LEN, G00_LZSS_INITIAL_CURSOR, G00_LZSS_MAX_RUN, G00_LZSS_MIN_RUN,
    G00_LZSS_RING_BUFFER_LEN, G00_REGION_RECORD_BYTE_LEN, G00_TYPE_PALETTED_LZSS, G00_TYPE_RAW_BGR,
    G00_TYPE_REGIONED_LZSS, G00_TYPE1_PALETTE_BYTE_LEN, G00CorpusHistogram, G00DecodeError,
    G00Image, G00Rect, G00Region, G00Type, G00Warning, decode_g00,
};

pub use replay::{
    DEFAULT_REPLAY_STEP_BUDGET, REPLAY_LOG_SCHEMA_VERSION, ReplayError, ReplayEvent, ReplayLog,
    ReplayOpts, ReplayOutcome, replay_scene, replay_scene_bytes, replay_until_first_pause,
    restore_into_fresh_vm,
};
pub use replay_validate::{
    NO_MATCH_SAMPLE_BODIES_CAP, NO_MATCH_SAMPLE_BODY_BYTE_CAP, ReplayValidation,
    validate_log_contains, validate_replay_contains,
};

pub use scene_header::{
    COMPILER_VERSION_1_0, COMPILER_VERSION_1_10, COMPILER_VERSION_1_1110,
    ENTRYPOINT_TABLE_BYTE_OFFSET, ENTRYPOINT_TABLE_LEN, EntrypointEntry,
    SAVEPOINT_BLOCK_BYTE_OFFSET, SCENE_HEADER_BYTE_LEN, SceneHeader, SceneHeaderError,
    SceneHeaderWarning, is_documented_compiler_version,
};

pub use bytecode_element::{
    BytecodeDecodeError, BytecodeElement, COMMA_LEAD_BYTE, COMMA_LEAD_BYTE_ALT,
    COMMAND_HEADER_BYTE_LEN, COMMAND_LEAD_BYTE, EXPRESSION_LEAD_BYTE, META_ELEMENT_BYTE_LEN,
    META_ENTRYPOINT_LEAD_BYTE, META_KIDOKU_LEAD_BYTE, META_LINE_LEAD_BYTE,
    SELECTION_OPTION_MARKER_MAX, SELECTION_OPTION_MARKER_MIN, TextoutEncoding,
    decode_bytecode_stream,
};
pub use decompressor::{
    AVG32_COMPRESSED_PREAMBLE_LEN, AVG32_LZSS_MAX_BACK_DISTANCE, AVG32_LZSS_MAX_RUN,
    AVG32_LZSS_MIN_RUN, AVG32_XOR_MASK, AVG32_XOR_MASK_LEN, AVG32_XOR2_KEY_LEN, AvgDecompressor,
    DecompressError, DecompressWarning,
};
pub use expression::{
    AssignOp, BANK_BYTE_INT_A, BANK_BYTE_INT_B, BANK_BYTE_INT_F, BANK_BYTE_INT_G, COMMA_BYTE,
    EXPRESSION_BACKSLASH, EXPRESSION_INT_LITERAL_TAG, EXPRESSION_STORE_REGISTER_TAG,
    EXPRESSION_TOKEN_LEAD, ExprNode, ExprOp, ExpressionParseError, ExpressionWarning,
    ParsedExpression, UnaryOp, parse_expression, parse_expression_with_warnings,
};
pub use expression_eval::{EvaluationError, bank_byte_to_index, evaluate, evaluate_assignment};
pub use scene_index::{
    REAL_SCENE_DIRECTORY_BYTE_LEN, REAL_SCENE_DIRECTORY_SLOT_BYTE_LEN,
    REAL_SCENE_DIRECTORY_SLOT_COUNT, RealSceneEntry, RealSceneIndex, RealSceneIndexError,
};
pub use var_banks::{
    BANK_BYTE_INT_M, BANK_BYTE_STR_K, BANK_BYTE_STR_M, BANK_BYTE_STR_S, BANK_INDEX_CAP, BankId,
    INT_BANK_COUNT, STR_BANK_COUNT, VAR_BANKS_INSPECTABLE_ID, Value, VarBanks,
    VarBanksRestoreError, VarBanksWarning,
};

pub use rlop::{
    AfterNPollsScheduler, AlwaysReadyScheduler, ChoiceInputScheduler, DEFAULT_PAUSE_POLLS,
    DispatchOutcome, ExprValue, LongOp, LongOpId, LongOpIdSequence, LongOpReadiness,
    LongOpScheduler, MSG_MODULE_ID, MSG_MODULE_TYPE, MsgFontColorOp, MsgFontSizeOp, MsgLineBreakOp,
    MsgLineNumberOp, MsgMsgClearOp, MsgMsgHideOp, MsgNameCloseOp, MsgNameOpenOp, MsgOpcode,
    MsgPageOp, MsgParagraphBreakOp, MsgPauseOp, MsgRuntime, MsgTextWindowOp, NeverReadyScheduler,
    OPCODE_FONT_COLOR, OPCODE_FONT_SIZE, OPCODE_LINE_BREAK, OPCODE_LINE_NUMBER, OPCODE_MSG_CLEAR,
    OPCODE_MSG_HIDE, OPCODE_NAME_CLOSE, OPCODE_NAME_OPEN, OPCODE_PAGE, OPCODE_PARAGRAPH_BREAK,
    OPCODE_PAUSE, OPCODE_SELECT_OBJBTN, OPCODE_SELECT_S, OPCODE_SELECT_W,
    OPCODE_SELECT_W_SWEETIE_HD_ALIAS, OPCODE_TEXT_WINDOW, PAUSE_PRIVATE_STATE_MAGIC, PauseLongOp,
    PauseLongOpDecodeError, RLOperation, RlopKey, RlopRegistry, SEL_MODULE_ID, SEL_MODULE_TYPE,
    SEL_OPCODE_SELECT, SEL_RLOP_COUNT, SELECT_PRIVATE_STATE_MAGIC, SelRuntime, SelRuntimeWarning,
    SelectLongOp, SelectLongOpDecodeError, SelectObjbtnOp, SelectOp, SelectSOp, SelectVariant,
    SelectWOp, SelectionChoiceCountScheduler, dispatch_textout, register_sel_rlops,
    register_text_rlops, text_module_msg_keys,
};

pub use rlop::module_mem::{
    MEM_MODULE_ID, MEM_MODULE_TYPE, MEM_RLOP_COUNT, MemOpcode, OPCODE_CPYRNG, OPCODE_CPYVARS,
    OPCODE_SETARRAY, OPCODE_SETARRAY_STEPPED, OPCODE_SETRNG, OPCODE_SETRNG_STEPPED, OPCODE_SUM,
    OPCODE_SUMS, register_mem_rlops,
};

pub use rlop::module_str::{
    OPCODE_ATOI, OPCODE_HANTOZEN, OPCODE_INTOUT, OPCODE_ITOA, OPCODE_LOWERCASE, OPCODE_STRCAT,
    OPCODE_STRCPY, OPCODE_STRLEN, OPCODE_STRLPOS, OPCODE_STROUT, OPCODE_STRPOS, OPCODE_UPPERCASE,
    OPCODE_ZENTOHAN, STR_MODULE_ID, STR_MODULE_TYPE, STR_RLOP_COUNT, StrOpcode, StrRuntime,
    hantozen_bytes, register_str_rlops, zentohan_bytes,
};

pub use rlop::module_grp::{
    BG_PLANE_SLOT, GRP_MODULE_ID, GRP_MODULE_TYPE, GRP_RLOP_COUNT, GrpAllocDcOp, GrpColourOp,
    GrpCopyOp, GrpFadeOp, GrpInvertOp, GrpLightOp, GrpLoadOp, GrpMonoOp, GrpOpcode, GrpOpenBgOp,
    GrpShakeOp, GrpStretchBlitOp, GrpWipeOp, GrpZoomOp, OPCODE_GRP_ALLOC_DC, OPCODE_GRP_COLOUR,
    OPCODE_GRP_COPY, OPCODE_GRP_FADE, OPCODE_GRP_FILL, OPCODE_GRP_INVERT, OPCODE_GRP_LIGHT,
    OPCODE_GRP_LOAD, OPCODE_GRP_MONO, OPCODE_GRP_OPEN, OPCODE_GRP_OPEN_BG, OPCODE_GRP_SHAKE,
    OPCODE_GRP_STRETCH_BLIT, OPCODE_GRP_WIPE, OPCODE_GRP_ZOOM, register_grp_rlops,
};

pub use rlop::module_obj::{
    BgCanvas, DEFAULT_FADE_TICKS_PER_MS, DcAllocation, FADE_PRIVATE_STATE_MAGIC, FadeLongOp,
    FadeLongOpDecodeError, FadeSchedule, GraphicsRuntime, GraphicsRuntimeWarning,
    GraphicsStateSnapshot, OBJ_BG_MODULE_ID, OBJ_BG_MODULE_TYPE, OBJ_FG_MODULE_ID,
    OBJ_FG_MODULE_TYPE, OBJ_MGMT_MODULE_ID, OBJ_MGMT_MODULE_TYPE, OBJ_RLOP_COUNT, OPCODE_OBJ_ALLOC,
    OPCODE_OBJ_COPY, OPCODE_OBJ_FREE, OPCODE_OBJ_HIDE, OPCODE_OBJ_INIT, OPCODE_OBJ_SET_ALPHA,
    OPCODE_OBJ_SET_LAYER, OPCODE_OBJ_SET_POS, OPCODE_OBJ_SET_SCALE, OPCODE_OBJ_SHOW, ObjAllocOp,
    ObjCopyOp, ObjFgBgOp, ObjFgBgOpcode, ObjFreeOp, ObjInitOp, ObjMgmtOpcode, register_obj_rlops,
};

pub use rlop::module_audio::{
    AUDIO_RLOP_COUNT, AudioRuntime, AudioRuntimeWarning, BGM_MODULE_ID, BGM_MODULE_TYPE,
    BgmFadeOutOp, BgmLoopOp, BgmOpcode, BgmPlayOp, BgmStatusOp, BgmStopOp, HasSeOp, KOE_MODULE_ID,
    KOE_MODULE_TYPE, KoeOpcode, KoePlayExOp, KoePlayOp, KoeStatusOp, KoeStopOp, KoeWaitOp,
    OPCODE_BGM_FADE_OUT, OPCODE_BGM_LOOP, OPCODE_BGM_PLAY, OPCODE_BGM_STATUS, OPCODE_BGM_STOP,
    OPCODE_HAS_SE, OPCODE_KOE_PLAY, OPCODE_KOE_PLAY_EX, OPCODE_KOE_STATUS, OPCODE_KOE_STOP,
    OPCODE_KOE_WAIT, OPCODE_PLAY_SE, OPCODE_WAV_LOOP, OPCODE_WAV_PLAY, OPCODE_WAV_STOP,
    PCM_MODULE_ID, PCM_MODULE_TYPE, PcmOpcode, PlaySeOp, SE_MODULE_ID, SE_MODULE_TYPE, SeOpcode,
    WavLoopOp, WavPlayOp, WavStopOp, register_audio_rlops,
};

pub use rlop::module_sys::{
    OPCODE_ABS, OPCODE_CONSTRAIN, OPCODE_COS, OPCODE_MAX, OPCODE_MIN, OPCODE_PCNT, OPCODE_POWER,
    OPCODE_RND, OPCODE_SIN, SYS_MODULE_ID, SYS_MODULE_TYPE, SYS_RLOP_COUNT,
    SYS_RUNTIME_INSPECTABLE_ID, SysOpcode, SysRuntime, XorShift64State, register_sys_rlops,
};

pub use rlop::module_ctrl::{
    CONTROL_FLOW_RLOP_COUNT, FARCALL_ARG_BANK, FARCALL_ARG_BANK_SLOT_CAP, FarcallOp,
    FarcallWithArgsOp, GosubIfOp, GosubOp, GotoIfOp, GotoOnOp, GotoOp, GotoUnlessOp, HaltOp,
    KEY_FARCALL, KEY_FARCALL_WITH_ARGS, KEY_GOSUB, KEY_GOSUB_IF, KEY_GOTO, KEY_GOTO_IF,
    KEY_GOTO_ON, KEY_GOTO_UNLESS, KEY_HALT, KEY_RET, KEY_RTL, MODULE_JMP_ID, MODULE_JMP_TYPE,
    OPCODE_FARCALL, OPCODE_FARCALL_WITH_ARGS, OPCODE_GOSUB, OPCODE_GOSUB_IF, OPCODE_GOTO,
    OPCODE_GOTO_IF, OPCODE_GOTO_ON, OPCODE_GOTO_UNLESS, OPCODE_HALT, OPCODE_RET, OPCODE_RTL, RetOp,
    RtlOp, register_control_flow_rlops,
};

pub use vm::{
    DEFAULT_STEP_BUDGET, InMemorySceneStore, STACK_DEPTH_LIMIT, Scene, SceneId, SceneStore,
    StackFrame, StackFrameKind, StepManyOutcome, StepOutcome, VM_INSPECTABLE_ID, Vm, VmError,
    VmEvent, VmWarning,
};

/// Stable port id used by the manifest and by audit tooling.
const PORT_ID: &str = "utsushi-reallive";

/// Crate semantic version, sourced from Cargo metadata.
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Typed message every lifecycle method on the scaffold returns inside
/// [`EnginePortError::Lifecycle`]. The substrate's typed-error enum has
/// no dedicated `Unimplemented` variant, so the scaffold uses the
/// `Lifecycle { stage, message }` shape with this constant message. The
/// scaffold conformance test asserts on the constant value, not on the
/// rendered `Display` string.
///
/// When a successor node (UTSUSHI-201..UTSUSHI-221) replaces a lifecycle
/// body with real behaviour, it MUST stop returning this value — the
/// orchestration-level audit looks for this exact string as a "still a
/// scaffold" marker.
pub const UNIMPLEMENTED_MESSAGE: &str = "unimplemented: utsushi-reallive scaffold";

/// The clean-room boundary statement carried as a publicly reachable
/// `const &str`. Audit tooling and the scaffold conformance test can pin
/// this without scraping the crate-level docstring.
///
/// The statement is intentionally short and free of host-local paths so
/// it passes the substrate's
/// [`utsushi_core::substrate::reject_unredacted_local_paths`] filter
/// verbatim.
pub const RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT: &str = concat!(
    "rlvm (https://github.com/eglaysher/rlvm) is a research anchor only. ",
    "utsushi-reallive does not depend on rlvm, does not include rlvm headers, ",
    "does not copy rlvm's structure layouts, and does not mechanically translate ",
    "rlvm code into Rust. Format hypotheses are re-derived and re-tested against ",
    "publicly-archived RLDEV documentation and Sweetie HD bytes before being encoded.",
);

/// Inert context the scaffold owns. The post-alpha nodes will populate
/// the `asset_package` and `scene_index` slots from the runner's
/// [`PortRequest::vfs`] (resolved to a typed [`AssetPackage`]) and from
/// an `utsushi-reallive` [`RealSceneIndex`] parse, respectively.
///
/// The carrier is intentionally a struct (not a tuple) so the audit
/// surface is named: every field has a docstring, every field's type is
/// reachable from the substrate facade plus this crate's own scene-index
/// module. No runtime configuration knobs are introduced here — the only
/// legitimate way to feed this struct is by replacing the construction
/// call in a successor node.
#[derive(Clone, Default)]
pub struct UtsushiReallivePortContext {
    /// Asset package the eventual implementation will read SEEN.TXT,
    /// Gameexe.ini, and bgm/wav/koe entries from. Wrapped in
    /// `Option<Arc<dyn AssetPackage>>` so the scaffold can be constructed
    /// without any I/O wiring; once UTSUSHI-201+ lands real behaviour,
    /// the `Option` is removed.
    asset_package: Option<Arc<dyn AssetPackage>>,
    /// The `utsushi-reallive`-owned [`RealSceneIndex`] the eventual
    /// implementation will consume as the inventory cross-reference for
    /// bridge-unit derivation. Held as `Option<Arc<...>>` for the same
    /// reason as `asset_package`.
    scene_index: Option<Arc<RealSceneIndex>>,
}

impl UtsushiReallivePortContext {
    /// Build an inert context. The scaffold uses this; successor nodes
    /// will introduce typed builder methods that require the asset
    /// package + scene index to be present.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Optional accessor exposed so audit tooling can inspect whether a
    /// context has been hydrated. Returns `None` while the scaffold is
    /// inert.
    pub fn asset_package(&self) -> Option<&Arc<dyn AssetPackage>> {
        self.asset_package.as_ref()
    }

    /// Optional accessor for the cross-reference [`RealSceneIndex`].
    /// Returns `None` while the scaffold is inert.
    pub fn scene_index(&self) -> Option<&Arc<RealSceneIndex>> {
        self.scene_index.as_ref()
    }

    /// Number of [`RealSceneEntry`] rows the cross-reference scene
    /// index carries, if any. Exposed so the scaffold conformance test
    /// can pin "the scaffold's inert context reports zero
    /// cross-reference entries" without poking at the `Option`
    /// directly.
    pub fn cross_reference_entry_count(&self) -> usize {
        self.scene_index
            .as_ref()
            .map(|index| index.len())
            .unwrap_or(0)
    }
}

impl std::fmt::Debug for UtsushiReallivePortContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UtsushiReallivePortContext")
            .field(
                "asset_package",
                &self
                    .asset_package
                    .as_ref()
                    .map(|_| "<present>")
                    .unwrap_or("<absent>"),
            )
            .field("scene_index_entries", &self.cross_reference_entry_count())
            .finish()
    }
}

/// Engine port scaffold for the RealLive runtime. Implements
/// [`utsushi_core::substrate::EnginePort`] with a typed
/// [`EnginePortError::Lifecycle`] return on every lifecycle method.
///
/// The struct owns an empty [`SinkSet`] (no text/frame/audio sinks
/// registered) and an inert [`UtsushiReallivePortContext`]. Both are
/// intentionally minimal — the scaffold's purpose is structural, not
/// behavioural.
#[derive(Debug)]
pub struct UtsushiReallivePort {
    context: UtsushiReallivePortContext,
    sink_set: SinkSet,
}

impl UtsushiReallivePort {
    /// Audit-grade manifest declaration. Mirrors
    /// [`EnginePort::MANIFEST`] for direct introspection without going
    /// through the trait.
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi RealLive Engine Port (scaffold)",
        version: PORT_VERSION,
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::TraceOnly,
        evidence_tier_max: EvidenceTier::E1,
        limitations: &[
            "UTSUSHI-200 scaffold only: every lifecycle method returns a typed Lifecycle error.",
            "rlvm is referenced as a research anchor only; no rlvm source is vendored, linked, or mechanically translated.",
            "Real Seen.txt / scene-header / decompressor / VM behaviour lands in UTSUSHI-201..UTSUSHI-221 (continuous tier).",
        ],
    };

    /// Construct the scaffold with an inert context and an empty sink
    /// set. The successor nodes will replace this with typed
    /// constructors that demand a hydrated [`UtsushiReallivePortContext`].
    pub fn new() -> Self {
        Self {
            context: UtsushiReallivePortContext::empty(),
            sink_set: SinkSet::new(),
        }
    }

    /// Borrow the (inert) context. Exposed so the conformance test can
    /// assert the cross-reference accessor returns zero without going
    /// through the lifecycle.
    pub fn context(&self) -> &UtsushiReallivePortContext {
        &self.context
    }
}

impl Default for UtsushiReallivePort {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePort for UtsushiReallivePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        Err(unimplemented_lifecycle(LifecycleStage::Launch))
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        Err(unimplemented_lifecycle(LifecycleStage::Observe))
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(
        &mut self,
        request: &PortRequest<'_>,
    ) -> Result<SubstrateCaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        Err(unimplemented_lifecycle(LifecycleStage::Capture))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        Err(unimplemented_lifecycle(LifecycleStage::Shutdown))
    }
}

/// Construct the typed scaffold-marker error every lifecycle method
/// returns. Centralised so the conformance test (and the eventual
/// successor nodes) have one place to look when checking whether a
/// stage is "still a scaffold".
fn unimplemented_lifecycle(stage: LifecycleStage) -> EnginePortError {
    EnginePortError::Lifecycle {
        stage,
        message: UNIMPLEMENTED_MESSAGE.to_string(),
        source: None,
    }
}

/// Compile-time assertion that the boundary statement is non-empty.
/// The runtime mirror lives in `tests/scaffold.rs`.
const _: () = {
    assert!(!RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT.is_empty());
    assert!(!UNIMPLEMENTED_MESSAGE.is_empty());
};

// Reference touch so the [`RealSceneEntry`] type stays visible from
// `__doctest_scene_entry_kind` without dragging it into the scaffold's
// runtime carrier surface. Successor nodes will replace this with a real
// constructor that demands a populated scene index.
#[doc(hidden)]
pub fn __doctest_real_scene_entry_kind() -> std::marker::PhantomData<RealSceneEntry> {
    std::marker::PhantomData
}
