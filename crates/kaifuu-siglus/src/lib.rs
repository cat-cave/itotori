//! Pure-Rust SiglusEngine (Siglus) format stack — crate **skeleton**.
//! This crate mirrors the proven [`kaifuu-reallive`](../kaifuu_reallive/index.html)
//! module shape for the Siglus engine family: a container reader
//! ([`archive`]), the constant 256-byte XOR + per-game second-layer key
//! transform ([`decrypt`]), the proprietary Siglus LZSS codec
//! ([`decompress`] / [`compress`]), the `Gameexe.dat` → UTF-16LE codec
//! ([`gameexe`]) and its category-indexed reader + sanitized inventory
//! ([`gameexe_inventory`]), the scene bytecode stack VM / decompiler ([`opcode`])
//! and its expression decoder ([`expression`]), the v0.2 BridgeBundle
//! producer ([`bridge`]), and byte-correct patch-back ([`patchback`]).
//! # Status
//! The `Scene.pck` container path is **implemented and proven on real Siglus
//! title bytes**: [`archive`] walks the real `0x5C`-header + SceneList (scene
//! count + packed plaintext names), [`decrypt`] applies the documented
//! constant 256-byte table plus the gated per-game second-layer key, and
//! [`decompress`] is the real proprietary Siglus LZSS; [`scene_decode`] ties
//! them into a full decode + sanitized report. The [`gameexe`] `Gameexe.dat`
//! decode (outer header → optional exe-angou key → constant-256 Gameexe table →
//! Siglus LZSS → UTF-16LE inventory) is likewise wired against the real format.
//! The scene-bytecode [`opcode`] partitioner is likewise implemented and proven
//! on real bytes: it parses the decompressed scene's `S_tnm_scn_header`, locates
//! the `scn` instruction section, and walks it into a fully-covering,
//! exactly-offset instruction stream + sanitized per-opcode histogram
//! (structural partition only — operand *semantics* are decoded downstream). The
//! scene [`expression`] decoder is likewise implemented and proven on real
//! bytes: it folds the partitioned operand stream into typed [`SiglusExpr`]
//! trees (int/str literals, element/variable refs, unary/binary operators,
//! gosub/command calls) with zero unparsed operand bytes and a complete,
//! sanitized operator histogram. The [`compress`], [`bridge`], and
//! bundle-driven [`patchback`] paths are implemented; the narrow real
//! [`known_key_smoke`] profile remains available for its separately-declared
//! capability boundary.
//! The exe-angou / second-layer key is the **key-discovery layer's
//! deliverable**, now recovered natively in-process from `SiglusEngine.exe`
//! bytes by [`exe_angou`] (a static PE opcode scan — no Wine, no execution); it
//! is consumed here only as resolved material bound to a structured secret-ref,
//! never a raw literal. Both owned titles (`karetoshi`, `gamekoi`) set
//! `extra_key_use` / `exe_angou_mode`: with the recovered key their
//! `Gameexe.dat` **body** and their `Scene.pck` scene **payloads** both decode
//! (proven on real bytes — karetoshi's 298 and gamekoi's 278 scenes all decode
//! to non-empty bytecode via the `exe-key XOR -> constant scene-table XOR ->
//! LZSS` pipeline), and without a key the decoders record the typed
//! `second_layer_key_required` / `exe_angou_key_required` diagnostic before any
//! output rather than fabricating a result; a wrong key trips the typed
//! `compressed_size_mismatch` gate, also before any output. Nothing here
//! masquerades as a working decode; the constant table and LZSS are validated by
//! a synthetic known-key round-trip and by the real-bytes container walk + full
//! payload decode.
//! # Clean-room provenance
//! - All Siglus format observations any successor node consumes are
//!   **re-derived from publicly archived format documentation** and
//!   **re-tested against bytes from a real Siglus title** before being
//!   encoded. No source expression is copied, vendored, linked, or
//!   mechanically translated from any reference project.
//! - The corrected reference-project provenance (the same citation the
//!   citation-correctness audit enforces) is carried as a grep-pinnable
//!   public `const` — [`SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`].
//!   `xmoezzz/siglus_rs` (`https://github.com/xmoezzz/siglus_rs`) is a
//!   **research anchor only**, licensed **MPL-2.0**.
//!   `bluecookies/siglus-decompile`
//!   (`https://github.com/bluecookies/siglus-decompile`) is the clearest
//!   bytecode reference but states **no license** → treated as
//!   **all-rights-reserved, documentation-only**. `SiglusExtract`
//!   (xmoezzz) is **GPLv3**. None of these is vendored, linked, or
//!   mechanically translated; this crate owns the full Siglus stack
//!   natively and takes no dependency on any of them (see this crate's
//!   `Cargo.toml`).
//! - No `Command::new`, no Wine, no Windows helper, no external archiver,
//!   no `SiglusExtract` shell-out. Each module is a pure function over
//!   `&[u8]`; the filesystem-owning adapter lives elsewhere.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod adapter;
pub mod archive;
pub mod bridge;
pub mod compress;
pub mod decompress;
pub mod decrypt;
pub mod engine_profile;
pub mod exe_angou;
pub mod expression;
pub mod flow;
pub mod gameexe;
pub mod gameexe_inventory;
pub mod known_key_smoke;
pub mod opcode;
pub mod patchback;
pub mod scene_decode;
pub mod syscall;

/// Stable namespace prefix carried by every `NotImplemented` diagnostic
/// raised by this skeleton crate.
/// The skeleton's honesty contract is grep-pinnable on this marker: a
/// successor node that lands a real implementation removes the
/// `NotImplemented` arm it replaces (no aliasing, no dual path). Every
/// module-local `*Error::NotImplemented` `Display` form begins with
/// `kaifuu.siglus.<module>.not_implemented`, which starts with this
/// marker, so an audit can assert "no entry point silently fakes
/// success" by checking the returned error string.
pub const SIGLUS_UNIMPLEMENTED_MARKER: &str = "kaifuu.siglus";

/// Clean-room boundary statement for the Siglus reference projects,
/// carried as a public `const &str` so audit tooling (and the
/// citation-correctness audit) can pin the no-vendoring / no-derivation
/// posture with the **correct** provenance without parsing the module
/// doc-comment.
/// Correctness note: an earlier repo statement mis-attributed the
/// project to the wrong repository owner under an incorrect license. The
/// accurate provenance, enforced here, is `xmoezzz/siglus_rs` under
/// MPL-2.0.
pub const SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT: &str = concat!(
    "xmoezzz/siglus_rs (https://github.com/xmoezzz/siglus_rs, MPL-2.0) is a research anchor only. ",
    "bluecookies/siglus-decompile (https://github.com/bluecookies/siglus-decompile) is the clearest ",
    "Siglus bytecode reference but states no license, so it is treated as all-rights-reserved and ",
    "documentation-only. SiglusExtract (xmoezzz) is GPLv3. kaifuu-siglus does not depend on, vendor, ",
    "link, include headers from, copy structure layouts from, or mechanically translate any of these ",
    "projects; the Siglus format stack is owned natively in Rust. Format hypotheses are re-derived and ",
    "re-tested against a real Siglus title's bytes before being encoded.",
);

pub use adapter::{
    ADAPTER_CAPABILITY_ID, ADAPTER_SCHEMA_VERSION, ADAPTER_SOURCE_NODE_ID,
    ADAPTER_SUPPORT_BOUNDARY, AdapterError, AdapterPatchReport, IdentityRoundTrip, InScopeChange,
    RejectOnSecretReport, ResolvedSiglusKey, SecretLeakFinding, SiglusAdapterCapability,
    SiglusContainerKind, SiglusSupportedVariant, SiglusTranslatedEdit, TranslatedRoundTrip,
    TranslatedRoundTripReport, apply_gameexe_translation, apply_scene_translation,
    build_profiled_gameexe_container, build_profiled_scene_container,
    extract_gameexe as adapter_extract_gameexe, extract_scene as adapter_extract_scene,
    patch_container_file, roundtrip_identity_gameexe, roundtrip_identity_scene,
    scan_for_secret_leak,
};
pub use archive::{
    SCENE_PCK_HEADER_BYTE_LEN, SiglusArchiveError, SiglusSceneEntry, SiglusSceneIndex,
    parse_scene_pck,
};
pub use bridge::{
    BridgeOpts, BridgeProduceError, BridgeSceneInput, ProducedBundle, produce_bundle,
    produce_scene_pack_bundle, produce_whole_scene_pack_bundle,
};
pub use compress::{SiglusCompressError, compress_siglus_lzss};
pub use decompress::{SiglusDecompressError, decompress_siglus_lzss};
pub use decrypt::{
    SIGLUS_CONSTANT_XOR_TABLE, SIGLUS_GAMEEXE_XOR_TABLE, SIGLUS_SECOND_LAYER_KEY_BYTE_LEN,
    SIGLUS_XOR_TABLE_LEN, SiglusDecryptError, SiglusSecondLayerKey, SiglusSecondLayerMaterial,
    apply_gameexe_xor_table, apply_xor_table,
};
pub use engine_profile::{
    SIGLUS_ENGINE_FAMILY, SIGLUS_ENGINE_PROFILE_ADAPTER_ID, SIGLUS_ENGINE_PROFILE_ID,
    SIGLUS_EXE_ANGOU_KEY_REQUIREMENT_ID, SiglusCipherMethod, SiglusCipherPosture,
    SiglusEngineProfile, SiglusEngineProfileError,
};
pub use exe_angou::{
    EXE_ANGOU_KEY_BYTE_LEN, ExeAngouKeyError, ExeAngouKeyRecovery, ExeAngouKeyReport,
    recover_exe_angou_key,
};
pub use expression::{
    FM_INT, FM_LIST, FM_STR, SceneExpressionDecode, SceneExpressionError, SiglusArgForm,
    SiglusBinaryOp, SiglusElementHead, SiglusExpr, SiglusExpressionError, SiglusOperand,
    SiglusOperatorHistogram, SiglusPush, SiglusUnaryOp, UnsupportedOperatorSite, decode_operand,
    decode_operand_stream, decode_scene_expressions,
};
pub use flow::{
    FlowUnderflowReport, SceneFlowDecode, SceneFlowError, SiglusChoiceArm, SiglusChoiceUnit,
    SiglusJump, SiglusJumpKind, SiglusStatement, SiglusTextSurface, decode_scene_flow,
};
pub use gameexe::{
    GameexeDatEntry, GameexeDatError, GameexeDatHeader, GameexeDatReport, decode_gameexe_dat,
    read_gameexe_header,
};
pub use gameexe_inventory::{
    GameexeInventory, GameexeInventorySummary, GameexeReadError, GameexeValueShape, category_of,
    read_gameexe_inventory,
};
pub use known_key_smoke::{
    GameexeEntryDigest, GameexeExtractionReport, KNOWN_KEY_SMOKE_CAPABILITY_ID,
    KNOWN_KEY_SMOKE_SCHEMA_VERSION, KNOWN_KEY_SMOKE_SUPPORT_BOUNDARY, KnownKeySmokeError,
    OutOfProfileReport, PatchRoundTripReport, SceneExtractionReport, ScenePatchVerification,
    SceneUnitDigest, SiglusGameexeEntry, SiglusGameexeExtraction, SiglusKnownKeyCapability,
    SiglusKnownKeyCompression, SiglusKnownKeyContainerSource, SiglusKnownKeyEncoding,
    SiglusKnownKeyPatchSpec, SiglusKnownKeyProfile, SiglusKnownKeySmokeFixture,
    SiglusKnownKeySmokeReport, SiglusSceneExtraction, SiglusSceneUnit,
    build_synthetic_gameexe_fixture, build_synthetic_out_of_profile_scene_fixture,
    build_synthetic_scene_fixture, extract_gameexe, extract_scene, patch_and_verify_scene,
    patch_scene_unit, run_known_key_smoke_from_fixture,
};
pub use opcode::{
    SCN_HEADER_BYTE_LEN, SCN_HEADER_DECLARED_SIZE, SiglusInstruction, SiglusOpcode,
    SiglusOpcodeHistogram, SiglusParseError, SiglusScenePartition, partition_scene,
};
pub use patchback::bundle_driven::{
    PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE, PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE,
    PATCHBACK_PROVENANCE_MISMATCH_CODE, PATCHBACK_SCENE_REENCODE_CODE, PATCHBACK_SELF_CHECK_CODE,
    PATCHBACK_STALE_SOURCE_CODE, PatchbackEncoding, PatchbackError, PatchbackOpts, PatchedScenePck,
    TranslatedBundleV02, TranslatedUnitTarget, apply_translated_bundle,
};
pub use patchback::delta::{SiglusDeltaError, SiglusScenePatchDelta, produce_scene_delta};
pub use scene_decode::{
    SceneDecodeError, SiglusSceneDigest, SiglusSceneFailure, SiglusScenePackReport,
    decode_scene_chunk, decode_scene_pack,
};
pub use syscall::{
    GLOBAL_SELBTN_SYSTEM_FUNCTION_ID, SceneSyscallDecode, SceneSyscallError, SiglusCallArgument,
    SiglusCallArgumentRole, SiglusCallTarget, SiglusSelChoice, SiglusSelOption, SiglusStringRef,
    SiglusSyscallDiagnostic, SiglusTypedCall, decode_scene_syscalls, system_function_name,
};
