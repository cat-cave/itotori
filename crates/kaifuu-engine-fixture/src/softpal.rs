use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use kaifuu_core::{
    AdapterCapabilities, AdapterCapabilityMatrix, AdapterFailure, AdapterFailureSemanticParams,
    ArchiveParameter, ArchiveParameterKind, ArchiveParameterSource, AssetInventoryManifest,
    AssetInventoryRequest, AssetList, AssetListRequest, Capability, CapabilityLevelStatus,
    CapabilityReport, CapabilityStatus, CodecTransform, ContainerTransform, CryptoTransform,
    DetectRequest, DetectionEvidence, DetectionResult, EngineAdapter, EngineProfile,
    EvidenceStatus, ExtractRequest, ExtractionResult, GameProfile, KaifuuResult,
    LayeredAccessCapabilityContract, LayeredAccessOperationContract, OperationStatus,
    PatchBackTransform, PatchPreflightRequest, PatchRequest, PatchResult, ProfileRequest,
    ProfileRequirement, RequirementCategory, RequirementStatus, SemanticErrorCode,
    SourceFingerprint, SurfaceTransform, VerificationResult, VerifyRequest, content_hash,
    deterministic_id,
};

use crate::{bytes_contains, case_insensitive_find, read_file_prefix, read_u32_le};

// Softpal ADV (Amuse Craft / "Pal") engine adapter (SOFTPAL).
// Provenance: these constants encode the publicly observable file shape of the
// Softpal ADV System, cross-checked against two owned titles (Kizuna Kirameku
// Koi Iroha / v21465 and Dimension Totsu Lovers / v60663). No copyrighted bytes
// are embedded — only fixed format signatures (the same magics any Softpal
// title exposes) are encoded. Detection classifies `engine=softpal`; the real
// extract / patch-back / verify surface (PAC container + TEXT.DAT decode/decrypt
// + SCRIPT.SRC dialogue/choice disassembly) is delegated to the deterministic
// `kaifuu-softpal` reader (see `softpal/real.rs`). PAC repack, non-text/asset
// surfaces, the full Sv20 opcode table, and runtime support are not claimed.
// Signatures (all observed on both real titles):
// * `dll/Pal.dll` present — the definitive Softpal ("Pal" engine) marker.
// * `.pac` archives open with magic `PAC ` (`50 41 43 20`) and, in the case
// of `data.pac`, list `SCRIPT.SRC` and `TEXT.DAT` entries in the file table.
// * The `SCRIPT.SRC` payload opens with `Sv20` (`53 76 32 30`); the `Sv`
// followed by a two-digit version tolerates other script-format revisions
// (e.g. `Sv10`).
// * The `TEXT.DAT` payload opens with a one-byte encryption flag then
// `TEXT_LIST__`; the flag is `$` (encrypted — v21465) or `_` (plaintext —
// v60663), so BOTH real titles' enc-flag states are recognised.
pub const SOFTPAL_DETECTOR_ADAPTER_ID: &str = "kaifuu.softpal";
// `PAC ` — trailing space is part of the 4-byte magic.
const SOFTPAL_PAC_MAGIC: &[u8] = b"PAC ";
const SOFTPAL_DATA_PAC_NAME: &str = "data.pac";
const SOFTPAL_PAL_DLL_DIR: &str = "dll";
const SOFTPAL_PAL_DLL_NAME: &str = "Pal.dll";
const SOFTPAL_SCRIPT_SRC_NAME: &str = "SCRIPT.SRC";
const SOFTPAL_TEXT_DAT_NAME: &str = "TEXT.DAT";
// Entry-name byte sequences searched for inside a `.pac` file table.
const SOFTPAL_SCRIPT_SRC_ENTRY: &[u8] = b"SCRIPT.SRC";
const SOFTPAL_TEXT_DAT_ENTRY: &[u8] = b"TEXT.DAT";
// `SCRIPT.SRC` payload magic prefix (`Sv`, then a two-digit version).
const SOFTPAL_SCRIPT_SRC_MAGIC_PREFIX: &[u8] = b"Sv";
// `TEXT.DAT` payload tag following the one-byte encryption flag.
const SOFTPAL_TEXT_LIST_TAG: &[u8] = b"TEXT_LIST__";
// Encryption-flag byte that precedes `TEXT_LIST__`: `$` encrypted, `_` plaintext.
const SOFTPAL_TEXT_DAT_ENC_ENCRYPTED: u8 = b'$';
const SOFTPAL_TEXT_DAT_ENC_PLAINTEXT: u8 = b'_';
// Bound the PAC file-table prefix scan so a multi-megabyte / tens-of-MB `.pac`
// is never fully read merely to recognise its entry names. Real `data.pac`
// tables list `SCRIPT.SRC`/`TEXT.DAT` within the first few KB (v21465 @16092,
// v60663 @7812); a 1 MiB window gives a wide margin for larger archives'
// file tables while staying bounded and identify-level.
const SOFTPAL_PAC_TABLE_SCAN_LEN: usize = 1 << 20;
// Sanity bound on the PAC entry count (LE u32 @ offset 8) so a file that merely
// opens with `PAC ` cannot pass the container check with a garbage table.
const SOFTPAL_PAC_MAX_ENTRIES: u32 = 1_000_000;
const SOFTPAL_PROFILE_ID: &str = "019ed000-0000-7000-8000-0000000c1001";
const SOFTPAL_GAME_ID: &str = "kaifuu-softpal-detected-title";
const SOFTPAL_SUPPORT_BOUNDARY: &str = "Softpal adapter identifies the Amuse Craft/Pal (Softpal ADV) engine by Pal.dll, a PAC archive listing SCRIPT.SRC/TEXT.DAT, and the Sv-version/TEXT_LIST script magics; it extracts the dialogue + choice text surfaces (PAC container + TEXT.DAT decode/decrypt + SCRIPT.SRC disassembly) and patches them back by rebuilding TEXT.DAT and repointing SCRIPT.SRC as loose files. PAC repack, non-text/asset-image surfaces, the full Sv20 opcode table, and runtime support are not claimed.";

// Softpal ADV (Amuse Craft / "Pal") engine detector. Identify-only: it
// classifies `engine=softpal` from Pal.dll / PAC+SCRIPT.SRC/TEXT.DAT / script
// magics; PAC extraction, decompilation, decryption, and patch-back are later
// Softpal nodes and are reported Unsupported here. See the `SOFTPAL_*`
// constants above for the signature provenance and false-positive rationale.
#[derive(Debug, Default, Clone, Copy)]
pub struct SoftpalProfileDetectorAdapter;

// Softpal ADV (Amuse Craft / "Pal") engine detector.
// Detection is a small deterministic decision over three independent,
// Softpal-specific signals (see the `SOFTPAL_*` constant provenance block):
// 1. `dll/Pal.dll` present — definitive Pal-engine marker.
// 2. a `.pac` (`PAC ` magic) whose file table names both `SCRIPT.SRC`
// and `TEXT.DAT` — the ADV script/text container.
// 3. loose `SCRIPT.SRC` (`Sv<nn>`) AND `TEXT.DAT` (`[$_]TEXT_LIST__`)
// script magics — enc-flag-robust script pair.
// Any one of (1), (2), or (3) classifies `engine=softpal` at identify level.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SoftpalVariant {
    // `dll/Pal.dll` present — the strongest, definitive Softpal signal.
    PalDll,
    // A `.pac` archive lists both `SCRIPT.SRC` and `TEXT.DAT` (no Pal.dll).
    PacScripts,
    // Loose `SCRIPT.SRC` + `TEXT.DAT` script magics (no Pal.dll, no PAC table).
    LooseScripts,
    // A `.pac` opened with `PAC ` magic but its table did not name the Softpal
    // scripts, or a Softpal-named file was present without a recognised
    // signature. Diagnostic — reported, but NOT `detected` (false-positive
    // guard: bare `PAC ` magic is not enough to claim the Softpal engine).
    UnknownPacOnly,
    NotSoftpal,
}

#[derive(Debug, Clone)]
struct SoftpalState {
    pal_dll_present: bool,
    // Any `.pac` in the game dir opened with the `PAC ` magic.
    pac_present: bool,
    // A `.pac` whose file table names both `SCRIPT.SRC` and `TEXT.DAT`.
    pac_scripts: bool,
    // Relative name of the `.pac` that matched the scripts signature.
    scripts_pac_name: Option<String>,
    // Loose `SCRIPT.SRC` opening with the `Sv<nn>` script magic.
    loose_script_src: bool,
    // Loose `TEXT.DAT` opening with `[$_]TEXT_LIST__`.
    loose_text_dat: bool,
    // Encryption-flag byte observed on a loose `TEXT.DAT` (`$`/`_`), if any.
    text_dat_enc_flag: Option<u8>,
    variant: SoftpalVariant,
}

impl SoftpalState {
    fn enc_flag_label(&self) -> &'static str {
        match self.text_dat_enc_flag {
            Some(SOFTPAL_TEXT_DAT_ENC_ENCRYPTED) => "encrypted ($)",
            Some(SOFTPAL_TEXT_DAT_ENC_PLAINTEXT) => "plaintext (_)",
            _ => "unobserved",
        }
    }

    fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if self.pal_dll_present {
            evidence.push(format!("{SOFTPAL_PAL_DLL_DIR}/{SOFTPAL_PAL_DLL_NAME}"));
        }
        if let Some(name) = &self.scripts_pac_name {
            evidence.push(name.clone());
        } else if self.pac_present {
            evidence.push("*.pac".to_string());
        }
        if self.loose_script_src {
            evidence.push(SOFTPAL_SCRIPT_SRC_NAME.to_string());
        }
        if self.loose_text_dat {
            evidence.push(SOFTPAL_TEXT_DAT_NAME.to_string());
        }
        evidence
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("engineFamily".to_string(), "softpal".to_string());
        metadata.insert(
            "signal.palDll".to_string(),
            self.pal_dll_present.to_string(),
        );
        metadata.insert(
            "signal.pacScripts".to_string(),
            self.pac_scripts.to_string(),
        );
        metadata.insert(
            "signal.looseScriptSrc".to_string(),
            self.loose_script_src.to_string(),
        );
        metadata.insert(
            "signal.looseTextDat".to_string(),
            self.loose_text_dat.to_string(),
        );
        metadata.insert(
            "textDatEncFlag".to_string(),
            self.enc_flag_label().to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            SOFTPAL_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: format!("{SOFTPAL_PAL_DLL_DIR}/{SOFTPAL_PAL_DLL_NAME}"),
                status: if self.pal_dll_present {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "Softpal Pal.dll engine marker".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SOFTPAL_DATA_PAC_NAME.to_string(),
                status: if self.pac_scripts {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "Softpal PAC archive listing SCRIPT.SRC and TEXT.DAT".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "softpal-pac-parser".to_string(),
                status: RequirementStatus::Satisfied,
                description:
                    "PAC archive parsing, SCRIPT.SRC dialogue/choice disassembly, and TEXT.DAT decode/decrypt are provided by the kaifuu-softpal reader (dialogue + choice extract/patch-back)"
                        .to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }
}

mod engine_adapter;
mod inspection;
mod real;
