use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use kaifuu_core::{
    ASSET_INVENTORY_SCHEMA_VERSION, AdapterCapabilities, AdapterCapabilityMatrix, AdapterFailure,
    AssetInventoryAsset, AssetInventoryAssetKind, AssetInventoryAssetRef, AssetInventoryManifest,
    AssetInventoryPatchMode, AssetInventoryRequest, AssetInventorySurface,
    AssetInventorySurfaceKind, AssetInventoryTextSourceKind, AssetKind, AssetList,
    AssetListRequest, AssetProfile, BGI_BYTECODE_SUPPORT_BOUNDARY, BGI_ENGINE_FAMILY,
    BgiBytecodePatchCase, BgiBytecodeStringReference, BgiBytecodeTextSurface, BridgeBundle,
    BridgeUnit, Capability, CapabilityLevelStatus, CapabilityReport, CapabilityStatus,
    CodecTransform, ContainerTransform, CryptoTransform, DetectRequest, DetectionEvidence,
    DetectionResult, EngineAdapter, EngineProfile, EvidenceStatus, ExtractRequest,
    ExtractionResult, GameProfile, KaifuuResult, LayeredAccessCapabilityContract,
    LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus, LayeredAccessOperationContract,
    LayeredAccessProfile, LayeredTextSurfaceAccess, OperationStatus, PatchBackTransform,
    PatchPreflightRequest, PatchRef, PatchRequest, PatchResult, ProfileRequest, ProfileRequirement,
    RequirementCategory, RequirementStatus, SourceFingerprint, SurfaceTransform, TextSurface,
    VerificationResult, VerifyRequest, atomic_write_bytes, content_hash, deterministic_id,
    parse_bgi_bytecode_bytes, patch_bgi_bytecode_bytes, safe_join_relative, sha256_hash_bytes,
};
use serde_json::json;

pub const BGI_BYTECODE_ADAPTER_ID: &str = "kaifuu.bgi";
const BGI_BYTECODE_PROFILE_ID: &str = "019ed000-0000-7000-8000-000000013001";
const BGI_BYTECODE_GAME_ID: &str = "kaifuu-bgi-loose-bytecode";
const BGI_ADAPTER_SUPPORT_BOUNDARY: &str = "BGI/Ethornell adapter support is limited to loose, unencrypted scenario bytecode files already outside BURIKO ARC20/BSE/DSC containers. It detects header and no-header bytecode, extracts Shift-JIS string references, and patches them by rebuilding the string table plus rewriting code-size-relative offsets. It does not unpack archives, decrypt BSE, decompress DSC/CompressedBG, execute opcodes, or rebuild game archives.";

#[derive(Clone)]
struct BgiScriptAsset {
    relative_path: String,
    bytes: Vec<u8>,
    references: Vec<BgiBytecodeStringReference>,
}

pub struct BgiBytecodeAdapter;

impl BgiBytecodeAdapter {
    fn capabilities_for_adapter() -> AdapterCapabilities {
        AdapterCapabilities::new(
            BGI_BYTECODE_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::supported(Capability::Patching),
                CapabilityReport::supported(Capability::Verification),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::ContainerAccess),
                CapabilityReport::supported(Capability::CryptoAccess),
                CapabilityReport::supported(Capability::CodecAccess),
                CapabilityReport::supported(Capability::PatchBack),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "BSE/DSC/CompressedBG and encrypted or compressed containers are outside the loose-bytecode adapter boundary",
                ),
                CapabilityReport::unsupported(
                    Capability::KeyProfile,
                    "loose BGI bytecode fixtures use null-key access; no key profile is consumed",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "opcode execution and runtime validation are outside the BGI bytecode patch adapter",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages are handled by kaifuu-delta, not this engine adapter",
                ),
            ],
            AdapterCapabilityMatrix::new(
                BGI_BYTECODE_ADAPTER_ID,
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
            ),
        )
        .with_access_contract(Self::access_contract())
    }

    fn access_contract() -> LayeredAccessCapabilityContract {
        let base = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![
                CodecTransform::ShiftJisText,
                CodecTransform::BytecodeDecompile,
            ],
            supported_patch_back: vec![PatchBackTransform::RecompileBytecode],
            support_boundary: Some(BGI_ADAPTER_SUPPORT_BOUNDARY.to_string()),
        };
        let identify = base.clone();
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            ..base.clone()
        };
        let extract = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Extraction],
            ..base.clone()
        };
        let patch = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Patching],
            ..base
        };
        let mut contract = LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract,
            patch,
        };
        contract.normalize();
        contract
    }

    fn requirements(found: bool) -> Vec<ProfileRequirement> {
        vec![ProfileRequirement {
            category: RequirementCategory::File,
            key: "bgi-loose-scenario-bytecode".to_string(),
            status: if found {
                RequirementStatus::Satisfied
            } else {
                RequirementStatus::Missing
            },
            description: "At least one loose BGI/Ethornell scenario bytecode file must parse as header or no-header bytecode".to_string(),
            placeholder: Some("scenario/001 or scenario/001.bgi".to_string()),
            secret: false,
        }]
    }

    fn scan_assets(game_dir: &Path) -> KaifuuResult<Vec<BgiScriptAsset>> {
        let mut files = Vec::new();
        collect_regular_files(game_dir, game_dir, &mut files)?;
        files.sort();
        let mut assets = Vec::new();
        for relative_path in files {
            let path = safe_join_relative(game_dir, &relative_path)?;
            let bytes = fs::read(&path)?;
            let Ok((_variant, references)) = parse_bgi_bytecode_bytes(&bytes) else {
                continue;
            };
            assets.push(BgiScriptAsset {
                relative_path,
                bytes,
                references,
            });
        }
        Ok(assets)
    }

    fn profile_from_assets(&self, assets: &[BgiScriptAsset]) -> GameProfile {
        let asset_profiles = assets.iter().map(Self::asset_profile).collect::<Vec<_>>();
        let mut surfaces = Vec::new();
        for asset in assets {
            for reference in &asset.references {
                surfaces.push(Self::layered_surface(asset, reference));
            }
        }
        let mut layered_access = LayeredAccessProfile {
            schema_version: kaifuu_core::PROFILE_SCHEMA_VERSION.to_string(),
            surfaces,
        };
        layered_access.normalize();
        GameProfile {
            schema_version: kaifuu_core::PROFILE_SCHEMA_VERSION.to_string(),
            profile_id: BGI_BYTECODE_PROFILE_ID.to_string(),
            game_id: BGI_BYTECODE_GAME_ID.to_string(),
            title: "BGI/Ethornell loose bytecode".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: BGI_BYTECODE_ADAPTER_ID.to_string(),
                engine_family: BGI_ENGINE_FAMILY.to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(assets).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: Some(
                    kaifuu_core::ProofHash::new(sha256_hash_bytes(
                        Self::source_fingerprint_payload(assets).as_bytes(),
                    ))
                    .expect("sha256_hash_bytes yields a canonical ProofHash"),
                ),
                engine_evidence: assets
                    .iter()
                    .map(|asset| format!("{}:{} refs", asset.relative_path, asset.references.len()))
                    .collect(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: asset_profiles,
            layered_access: Some(layered_access),
            capabilities: self.capabilities().reports,
            requirements: Self::requirements(!assets.is_empty()),
            metadata: BTreeMap::from([
                (
                    "supportBoundary".to_string(),
                    BGI_ADAPTER_SUPPORT_BOUNDARY.to_string(),
                ),
                (
                    "parserBoundary".to_string(),
                    BGI_BYTECODE_SUPPORT_BOUNDARY.to_string(),
                ),
            ]),
        }
    }

    fn source_fingerprint_payload(assets: &[BgiScriptAsset]) -> String {
        assets.iter().fold(String::new(), |mut payload, asset| {
            write!(
                payload,
                "{}\n{}\n",
                asset.relative_path,
                sha256_hash_bytes(&asset.bytes)
            )
            .expect("writing to a String cannot fail");
            payload
        })
    }

    fn asset_profile(asset: &BgiScriptAsset) -> AssetProfile {
        AssetProfile {
            asset_id: asset.relative_path.clone(),
            path: asset.relative_path.clone(),
            asset_kind: AssetKind::Script,
            text_surfaces: Self::text_surfaces(asset),
            source_hash: Some(sha256_hash_bytes(&asset.bytes)),
            patching: CapabilityReport::supported(Capability::Patching),
        }
    }

    fn text_surfaces(asset: &BgiScriptAsset) -> Vec<TextSurface> {
        let mut surfaces = asset
            .references
            .iter()
            .map(|reference| Self::text_surface(reference.text_surface))
            .collect::<Vec<_>>();
        surfaces.sort_by_key(|surface| serde_json::to_string(surface).unwrap_or_default());
        surfaces.dedup();
        surfaces
    }

    fn text_surface(surface: BgiBytecodeTextSurface) -> TextSurface {
        match surface {
            BgiBytecodeTextSurface::CharacterName => TextSurface::SpeakerName,
            BgiBytecodeTextSurface::Dialogue
            | BgiBytecodeTextSurface::Backlog
            | BgiBytecodeTextSurface::RubyKanji
            | BgiBytecodeTextSurface::RubyFurigana
            | BgiBytecodeTextSurface::Other => TextSurface::Dialogue,
            BgiBytecodeTextSurface::FileReference => TextSurface::MetadataText,
        }
    }

    fn text_surface_name(surface: BgiBytecodeTextSurface) -> &'static str {
        match surface {
            BgiBytecodeTextSurface::CharacterName => "speaker_name",
            BgiBytecodeTextSurface::Dialogue | BgiBytecodeTextSurface::Other => "dialogue",
            BgiBytecodeTextSurface::Backlog => "backlog",
            BgiBytecodeTextSurface::RubyKanji => "ruby_kanji",
            BgiBytecodeTextSurface::RubyFurigana => "ruby_furigana",
            BgiBytecodeTextSurface::FileReference => "file_reference",
        }
    }

    fn layered_surface(
        asset: &BgiScriptAsset,
        reference: &BgiBytecodeStringReference,
    ) -> LayeredTextSurfaceAccess {
        LayeredTextSurfaceAccess {
            surface_id: format!("{}#{}", asset.relative_path, reference.reference_id),
            asset_id: asset.relative_path.clone(),
            path: asset.relative_path.clone(),
            text_surface: Self::text_surface(reference.text_surface),
            surface_transform: SurfaceTransform::BinaryOffset,
            surface_selector: reference.reference_id.clone(),
            container: ContainerTransform::LooseFile,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::ShiftJisText,
            patch_back: PatchBackTransform::RecompileBytecode,
            key_material_status: LayeredAccessKeyMaterialStatus::NotRequired,
            helper_status: LayeredAccessHelperStatus::NotRequired,
            key_requirement_refs: vec![],
            notes: vec![
                "BGI string pointer is code-size-relative and rewritten during patch-back"
                    .to_string(),
            ],
        }
    }

    fn detected_variant(assets: &[BgiScriptAsset]) -> &'static str {
        if assets
            .iter()
            .any(|asset| asset.bytes.starts_with(b"BurikoCompiledScriptVer1.00\0"))
        {
            "bgi-bytecode-header"
        } else {
            "bgi-bytecode-no-header"
        }
    }

    fn bridge_units(assets: &[BgiScriptAsset]) -> Vec<BridgeUnit> {
        let mut units = Vec::new();
        let mut index = 1usize;
        for asset in assets {
            for reference in &asset.references {
                units.push(BridgeUnit {
                    bridge_unit_id: deterministic_id("bgiunit", index),
                    source_unit_key: format!("{}#{}", asset.relative_path, reference.reference_id),
                    occurrence_id: format!(
                        "{}@{}",
                        asset.relative_path, reference.pointer_offset_byte
                    ),
                    source_hash: content_hash(&reference.decoded_text),
                    source_locale: "ja-JP".to_string(),
                    source_text: reference.decoded_text.clone(),
                    speaker: String::new(),
                    text_surface: Self::text_surface_name(reference.text_surface).to_string(),
                    protected_spans: vec![],
                    patch_ref: PatchRef {
                        asset_id: asset.relative_path.clone(),
                        write_mode: "recompile_bytecode".to_string(),
                        source_unit_key: reference.reference_id.clone(),
                    },
                });
                index += 1;
            }
        }
        units
    }

    fn asset_inventory_from_assets(&self, assets: &[BgiScriptAsset]) -> AssetInventoryManifest {
        let inventory_assets = assets
            .iter()
            .map(|asset| AssetInventoryAsset {
                asset_id: asset.relative_path.clone(),
                asset_key: asset.relative_path.clone(),
                asset_kind: AssetInventoryAssetKind::Script,
                path: Some(asset.relative_path.clone()),
                source_hash: Some(sha256_hash_bytes(&asset.bytes)),
                metadata: BTreeMap::from([(
                    "bgiStringReferenceCount".to_string(),
                    asset.references.len().to_string(),
                )]),
            })
            .collect::<Vec<_>>();
        let mut surfaces = Vec::new();
        for asset in assets {
            for reference in &asset.references {
                surfaces.push(AssetInventorySurface {
                    surface_id: format!("{}#{}", asset.relative_path, reference.reference_id),
                    asset_surface_kind: AssetInventorySurfaceKind::Credits,
                    source_asset_ref: AssetInventoryAssetRef {
                        asset_id: asset.relative_path.clone(),
                        asset_key: Some(asset.relative_path.clone()),
                    },
                    source_location: Some(json!({
                        "range": {
                            "startByte": reference.string_start_byte,
                            "endByte": reference.string_end_byte
                        }
                    })),
                    source_text: Some(reference.decoded_text.clone()),
                    source_hash: Some(content_hash(&reference.decoded_text)),
                    text_source_kind: AssetInventoryTextSourceKind::Metadata,
                    patch_mode: AssetInventoryPatchMode::AssetReplacementRequired,
                    patching: CapabilityReport::supported(Capability::Patching),
                    patch_payload: None,
                    metadata_hash: None,
                    notes: vec![
                        "BGI bytecode string reference; patch rewrites relative offsets"
                            .to_string(),
                    ],
                });
            }
        }
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("bgiinv", 1),
            adapter_id: BGI_BYTECODE_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets: inventory_assets,
            surfaces,
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: BTreeMap::from([(
                "supportBoundary".to_string(),
                BGI_ADAPTER_SUPPORT_BOUNDARY.to_string(),
            )]),
        };
        manifest.stamp_asset_metadata_hashes();
        manifest
    }

    fn patch_fail(
        patch_export_id: &str,
        output_hash: impl Into<String>,
        error_code: impl Into<String>,
        asset_ref: impl Into<String>,
        message: impl Into<String>,
    ) -> PatchResult {
        PatchResult {
            schema_version: kaifuu_core::PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("bgi-patch", 1),
            patch_export_id: patch_export_id.to_string(),
            status: OperationStatus::Failed,
            output_hash: output_hash.into(),
            failures: vec![AdapterFailure {
                error_code: error_code.into(),
                adapter: BGI_BYTECODE_ADAPTER_ID.to_string(),
                engine: Some(BGI_ENGINE_FAMILY.to_string()),
                detected_variant: Some("bgi-bytecode".to_string()),
                asset_ref: Some(asset_ref.into()),
                required_capability: Some(Capability::PatchBack),
                support_boundary: message.into(),
                remediation: Some(
                    "re-extract the BGI bytecode bridge and regenerate the patch export"
                        .to_string(),
                ),
            }],
        }
    }
}

fn collect_regular_files(root: &Path, current: &Path, out: &mut Vec<String>) -> KaifuuResult<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_regular_files(root, &path, out)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root)?;
            out.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

fn copy_dir_tree(source: &Path, destination: &Path) -> KaifuuResult<()> {
    fs::create_dir_all(destination)?;
    let mut files = Vec::new();
    collect_regular_files(source, source, &mut files)?;
    for relative in files {
        let source_path = safe_join_relative(source, &relative)?;
        let destination_path = safe_join_relative(destination, &relative)?;
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source_path, destination_path)?;
    }
    Ok(())
}

mod engine_adapter;
