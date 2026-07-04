//! Pure-Rust SiglusEngine (Siglus) format stack — crate **skeleton**
//! (siglus-05).
//!
//! This crate mirrors the proven [`kaifuu-reallive`](../kaifuu_reallive/index.html)
//! module shape for the Siglus engine family: a container reader
//! ([`archive`]), the constant 256-byte XOR + per-game second-layer key
//! transform ([`decrypt`]), the proprietary Siglus LZSS codec
//! ([`decompress`] / [`compress`]), the `Gameexe.dat` → UTF-16LE inventory
//! ([`gameexe`]), the scene bytecode stack VM / decompiler ([`opcode`])
//! and its expression decoder ([`expression`]), the v0.2 BridgeBundle
//! producer ([`bridge`]), and byte-correct patch-back ([`patchback`]).
//!
//! # Skeleton status (siglus-05)
//!
//! Every public entry point in the **core format stack** ([`archive`],
//! [`decrypt`], [`decompress`], [`compress`], [`gameexe`], [`opcode`],
//! [`expression`], [`bridge`], [`patchback`]) is a **typed stub**. The one
//! exception is [`known_key_smoke`] (KAIFUU-070): a NARROW, honestly-scoped
//! known-key Scene/Gameexe extract-patch-verify smoke over a single declared
//! profiled format. It is a real implementation of that narrow profile only —
//! it does NOT claim broad Siglus support, does NOT alias around the core-stack
//! stubs, and returns a typed `not_implemented` for any out-of-profile case.
//! The bytes-dependent
//! Siglus work (real Scene.pck reading, key recovery, LZSS, decompilation,
//! patchback) is gated behind the blocked-external `siglus-01`/`siglus-02`
//! recon+realization nodes — there is no plaintext Siglus game tree to
//! build against yet (the owned karetoshi/gamekoi titles are copy-
//! protected DVD images, unrealizable under the no-Wine / no-shell-out
//! laws). So this node lands the crate scaffold ONLY:
//!
//! - Every fallible entry point returns a structured, module-local
//!   `NotImplemented` error whose message carries the
//!   [`SIGLUS_UNIMPLEMENTED_MARKER`] namespace. Nothing here fabricates a
//!   synthetic success: there is no tautological stub that masquerades as
//!   a working decompiler/patchback. When the downstream bytes nodes land,
//!   they replace the `Err(NotImplemented)` body with a real
//!   re-derived-and-retested-on-real-bytes implementation — they do not
//!   alias around it.
//!
//! # Clean-room provenance
//!
//! - All Siglus format observations any successor node consumes are
//!   **re-derived from publicly archived format documentation** and
//!   **re-tested against bytes from a real Siglus title** before being
//!   encoded. No source expression is copied, vendored, linked, or
//!   mechanically translated from any reference project.
//! - The corrected reference-project provenance (the same citation the
//!   siglus-25 audit-fix node enforces) is carried as a grep-pinnable
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

pub mod archive;
pub mod bridge;
pub mod compress;
pub mod decompress;
pub mod decrypt;
pub mod expression;
pub mod gameexe;
pub mod known_key_smoke;
pub mod opcode;
pub mod patchback;

/// Stable namespace prefix carried by every `NotImplemented` diagnostic
/// raised by this skeleton crate.
///
/// The skeleton's honesty contract is grep-pinnable on this marker: a
/// successor node that lands a real implementation removes the
/// `NotImplemented` arm it replaces (no aliasing, no dual path). Every
/// module-local `*Error::NotImplemented` `Display` form begins with
/// `kaifuu.siglus.<module>.not_implemented`, which starts with this
/// marker, so an audit can assert "no entry point silently fakes
/// success" by checking the returned error string.
pub const SIGLUS_UNIMPLEMENTED_MARKER: &str = "kaifuu.siglus";

/// Clean-room boundary statement for the Siglus reference projects,
/// carried as a public `const &str` so audit tooling (and the siglus-25
/// citation-correctness node) can pin the no-vendoring / no-derivation
/// posture with the **correct** provenance without parsing the module
/// doc-comment.
///
/// Correctness note: an earlier repo statement mis-attributed the
/// project to the wrong repository owner under an incorrect license. The
/// accurate provenance, enforced here and by siglus-25, is
/// `xmoezzz/siglus_rs` under MPL-2.0.
pub const SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT: &str = concat!(
    "xmoezzz/siglus_rs (https://github.com/xmoezzz/siglus_rs, MPL-2.0) is a research anchor only. ",
    "bluecookies/siglus-decompile (https://github.com/bluecookies/siglus-decompile) is the clearest ",
    "Siglus bytecode reference but states no license, so it is treated as all-rights-reserved and ",
    "documentation-only. SiglusExtract (xmoezzz) is GPLv3. kaifuu-siglus does not depend on, vendor, ",
    "link, include headers from, copy structure layouts from, or mechanically translate any of these ",
    "projects; the Siglus format stack is owned natively in Rust. Format hypotheses are re-derived and ",
    "re-tested against a real Siglus title's bytes before being encoded.",
);

pub use archive::{
    SCENE_PCK_HEADER_BYTE_LEN, SiglusArchiveError, SiglusSceneEntry, SiglusSceneIndex,
    parse_scene_pck,
};
pub use bridge::{BridgeOpts, BridgeProduceError, ProducedBundle, produce_bundle};
pub use compress::{SiglusCompressError, compress_siglus_lzss};
pub use decompress::{SiglusDecompressError, decompress_siglus_lzss};
pub use decrypt::{
    SIGLUS_SECOND_LAYER_KEY_BYTE_LEN, SIGLUS_XOR_TABLE_LEN, SiglusDecryptError,
    SiglusSecondLayerKey, apply_xor_table,
};
pub use expression::{SiglusExpr, SiglusExpressionError, decode_expression};
pub use gameexe::{GameexeDatEntry, GameexeDatError, GameexeDatReport, parse_gameexe_dat};
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
pub use opcode::{SiglusOpcode, SiglusParseError, parse_scene_bytecode};
pub use patchback::bundle_driven::{
    PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE, PATCHBACK_NOT_IMPLEMENTED_CODE,
    PATCHBACK_PROVENANCE_MISMATCH_CODE, PatchbackError, PatchbackOpts, TranslatedBundleV02,
    TranslatedUnitTarget, apply_translated_bundle,
};
pub use patchback::delta::{SiglusDeltaError, SiglusScenePatchDelta, produce_scene_delta};
