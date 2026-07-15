use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use kaifuu_core::{
    AdapterCapabilities, AdapterCapabilityMatrix, AdapterFailure, AdapterFailureSemanticParams,
    ArchiveParameter, ArchiveParameterKind, ArchiveParameterSource, AssetInventoryManifest,
    AssetInventoryRequest, AssetList, AssetListRequest, Capability, CapabilityReport,
    CapabilityStatus, CodecTransform, ContainerTransform, CryptoTransform, DetectRequest,
    DetectionEvidence, DetectionResult, EngineAdapter, EngineProfile, EvidenceStatus,
    ExtractRequest, ExtractionResult, GameProfile, KaifuuResult, LayeredAccessCapabilityContract,
    LayeredAccessOperationContract, OperationStatus, PatchBackTransform, PatchPreflightRequest,
    PatchRequest, PatchResult, ProfileRequest, ProfileRequirement, RequirementCategory,
    RequirementStatus, SemanticErrorCode, SourceFingerprint, SurfaceTransform, VerificationResult,
    VerifyRequest, content_hash, deterministic_id,
};

use crate::{read_file_prefix, read_u32_le};

// NeXAS engine detector (NEXAS-DETECTOR). NeXAS ships its assets in category
// `.pac` archives (Bgm/Config/Face/Script/Se/Stand/System/Thumbnail/Visual/
// Voice*.pac) whose container magic is `"PAC\0"` (`50 41 43 00`) — the 4th byte
// is a NUL, which is exactly what distinguishes it from the Softpal `"PAC "`
// (`50 41 43 20`, 4th byte a space) container. Both engines reuse the `.pac`
// extension, so detection keys on the MAGIC BYTES, never the extension. No
// copyrighted bytes are embedded — only the fixed container signature (magic +
// sane count @0x04 + small pack_type @0x08) and the well-known category-archive
// names. The NeXAS engine is statically linked into the game exe and ships NO
// Pal.dll, so a NeXAS title never trips the Softpal detector. Identify-only
// here: the actual PAC extraction + per-entry decompression lives in the
// `kaifuu-nexas` crate (a later capability), reported Unsupported by this
// detector.
pub const NEXAS_DETECTOR_ADAPTER_ID: &str = "kaifuu.nexas";
// NeXAS container magic: "PAC" then a NUL byte (Softpal's is "PAC" + space).
const NEXAS_PAC_MAGIC: &[u8] = b"PAC\0";
// Byte offsets of the little-endian u32 count / pack_type within the header.
const NEXAS_COUNT_OFFSET: usize = 0x04;
const NEXAS_PACK_TYPE_OFFSET: usize = 0x08;
const NEXAS_HEADER_BYTE_LEN: usize = 0x0C;
// Sanity bounds guarding against a random file that merely opens with "PAC\0".
const NEXAS_PAC_MAX_ENTRIES: u32 = 1_000_000;
// GARbro's NeXAS Compression enum tops out at 4 (DeflateOrNone); allow a small
// margin so an unusual-but-plausible pack_type is still recognised without
// admitting a garbage dword.
const NEXAS_PACK_TYPE_MAX: u32 = 8;
// Well-known NeXAS category-archive base names (corroborating evidence, not
// required for detection). Matched case-insensitively against `*.pac` stems.
const NEXAS_CATEGORY_ARCHIVES: &[&str] = &[
    "bgm",
    "config",
    "effect",
    "face",
    "script",
    "se",
    "stand",
    "system",
    "thumbnail",
    "visual",
    "voice",
    "voice2",
    "voice3",
    "voice4",
];
const NEXAS_PROFILE_ID: &str = "019ed000-0000-7000-8000-0000000e1001";
const NEXAS_GAME_ID: &str = "kaifuu-nexas-detected-title";
const NEXAS_SUPPORT_BOUNDARY: &str = "NeXAS detector identifies the NeXAS engine by its `PAC\\0` container magic (50 41 43 00, 4th byte NUL — distinct from Softpal `PAC ` 50 41 43 20) with a sane count @0x04 and small pack_type @0x08, plus the well-known category-archive names (Bgm/Face/Script/Stand/System/Voice*.pac), for identify only; PAC extraction and per-entry decompression (stored/LZSS/Huffman/zlib-Deflate) live in the kaifuu-nexas crate, and script decode, image decode, patch-back, and runtime support are not claimed by this detector.";

// NeXAS engine detector adapter. Identify-only: classifies `engine=nexas` from
// the `PAC\0` container magic (+ sane header + category-archive names); PAC
// extraction / decompression live in the `kaifuu-nexas` crate and are reported
// Unsupported here. See the `NEXAS_*` constants above for signature provenance.
#[derive(Debug, Default, Clone, Copy)]
pub struct NexasProfileDetectorAdapter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NexasVariant {
    // At least one `.pac` opens with the `PAC\0` magic and a sane header
    // (count + pack_type) — the definitive NeXAS container signal.
    NexasPac,
    // A file opens with the `PAC\0` magic but its header (count / pack_type) is
    // out of range. Diagnostic — reported, but NOT `detected` (a bare magic is
    // not enough to claim the NeXAS engine).
    UnknownPacOnly,
    NotNexas,
}

#[derive(Debug, Clone)]
struct NexasState {
    // A `.pac` opened with the `PAC\0` magic AND a sane count + pack_type.
    nexas_pac: bool,
    // A `.pac` opened with the `PAC\0` magic but a header out of range.
    unknown_pac_magic: bool,
    // Relative name of the `.pac` that first matched the NeXAS signature.
    primary_pac_name: Option<String>,
    // Category-archive base names present (case-insensitive), e.g. "system".
    category_hits: Vec<String>,
    // Observed pack_type words across the recognised NeXAS archives (sorted).
    pack_types: Vec<u32>,
    variant: NexasVariant,
}

impl NexasState {
    fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if let Some(name) = &self.primary_pac_name {
            evidence.push(name.clone());
        }
        evidence.extend(self.category_hits.iter().map(|hit| format!("{hit}.pac")));
        evidence
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("engineFamily".to_string(), "nexas".to_string());
        metadata.insert("signal.pacMagic".to_string(), self.nexas_pac.to_string());
        metadata.insert(
            "signal.categoryArchives".to_string(),
            self.category_hits.len().to_string(),
        );
        metadata.insert(
            "packTypes".to_string(),
            self.pack_types
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(","),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            NEXAS_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: "*.pac".to_string(),
                status: if self.nexas_pac {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "NeXAS `PAC\\0`-magic category archive (Bgm/Face/Script/System/Voice*.pac)"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "nexas-pac-reader".to_string(),
                status: RequirementStatus::Unsupported,
                description:
                    "PAC extraction + per-entry decompression are provided by the kaifuu-nexas crate, outside this detector"
                        .to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }
}

mod engine_adapter;
mod inspection;
