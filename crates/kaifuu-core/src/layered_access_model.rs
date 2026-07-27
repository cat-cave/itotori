use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerTransform {
    Identity,
    Directory,
    LooseFile,
    ProjectAsset,
    Archive,
    Xp3,
    SiglusPck,
    Rgssad,
    WolfArchive,
    AssetBundle,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CryptoTransform {
    NullKey,
    Xor,
    FixedKey,
    KeyProfile,
    RpgMakerAssetXor,
    RpgMakerAssetKey,
    HelperGated,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodecTransform {
    Identity,
    PngImage,
    M4aAudio,
    OggAudio,
    Utf8Text,
    Utf16Text,
    ShiftJisText,
    JsonText,
    RpgMakerMvMzJson,
    /// TyranoScript KAG-style square-bracket scenario markup (`.ks`): the
    /// `kaifuu-tyrano` plaintext codec (dialogue + choice/link + speaker text).
    TyranoScriptMarkup,
    RubyMarshal,
    BytecodeDecompile,
    BinaryTable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceTransform {
    Identity,
    JsonPointer,
    ArchiveEntry,
    BinaryOffset,
    TableRecord,
    RuntimeTrace,
    OcrRegion,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchBackTransform {
    Identity,
    ReplaceFile,
    RewriteJson,
    RepackArchive,
    RecompileBytecode,
    ReplaceAsset,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayeredAccessKeyMaterialStatus {
    NotRequired,
    Resolved,
    Missing,
    HelperGated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayeredAccessHelperStatus {
    NotRequired,
    Available,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredTextSurfaceAccess {
    pub surface_id: String,
    pub asset_id: String,
    pub path: String,
    pub text_surface: TextSurface,
    pub surface_transform: SurfaceTransform,
    pub surface_selector: String,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub patch_back: PatchBackTransform,
    pub key_material_status: LayeredAccessKeyMaterialStatus,
    pub helper_status: LayeredAccessHelperStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_requirement_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl LayeredTextSurfaceAccess {
    pub fn plaintext_identity(
        asset_id: impl Into<String>,
        path: impl Into<String>,
        text_surface: TextSurface,
        surface_selector: impl Into<String>,
    ) -> Self {
        let asset_id = asset_id.into();
        let path = path.into();
        let surface_name = serde_json::to_string(&text_surface)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        Self {
            surface_id: format!("{asset_id}#{surface_name}"),
            asset_id,
            path,
            text_surface,
            surface_transform: SurfaceTransform::Identity,
            surface_selector: surface_selector.into(),
            container: ContainerTransform::Identity,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::Identity,
            patch_back: PatchBackTransform::RewriteJson,
            key_material_status: LayeredAccessKeyMaterialStatus::NotRequired,
            helper_status: LayeredAccessHelperStatus::NotRequired,
            key_requirement_refs: vec![],
            notes: vec!["plaintext identity access path; no container unpack, key material, or codec conversion required".to_string()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessProfile {
    pub schema_version: String,
    pub surfaces: Vec<LayeredTextSurfaceAccess>,
}

impl LayeredAccessProfile {
    pub fn plaintext_identity_for_asset(
        asset_id: impl Into<String>,
        path: impl Into<String>,
        text_surfaces: &[TextSurface],
        surface_selector: impl Into<String>,
    ) -> Self {
        let asset_id = asset_id.into();
        let path = path.into();
        let surface_selector = surface_selector.into();
        let mut profile = Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            surfaces: text_surfaces
                .iter()
                .cloned()
                .map(|surface| {
                    LayeredTextSurfaceAccess::plaintext_identity(
                        asset_id.clone(),
                        path.clone(),
                        surface,
                        surface_selector.clone(),
                    )
                })
                .collect(),
        };
        profile.normalize();
        profile
    }

    pub fn normalize(&mut self) {
        for surface in &mut self.surfaces {
            surface.key_requirement_refs.sort();
            surface.key_requirement_refs.dedup();
            surface.notes.sort();
            surface.notes.dedup();
        }
        self.surfaces
            .sort_by_key(|surface| (surface.asset_id.clone(), surface.surface_id.clone()));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessCapabilityContract {
    pub identify: LayeredAccessOperationContract,
    pub inventory: LayeredAccessOperationContract,
    pub extract: LayeredAccessOperationContract,
    pub patch: LayeredAccessOperationContract,
}

impl LayeredAccessCapabilityContract {
    pub fn plaintext_identity() -> Self {
        let identify = LayeredAccessOperationContract::supported_identity(vec![
            Capability::Detection,
            Capability::ProfileGeneration,
        ]);
        let inventory = LayeredAccessOperationContract::supported_identity(vec![
            Capability::AssetListing,
            Capability::AssetInventory,
        ]);
        let extract =
            LayeredAccessOperationContract::supported_identity(vec![Capability::Extraction]);
        let patch = LayeredAccessOperationContract::supported_identity(vec![
            Capability::Patching,
            Capability::LineParityPatching,
        ]);
        Self {
            identify,
            inventory,
            extract,
            patch,
        }
    }

    pub fn normalize(&mut self) {
        self.identify.normalize();
        self.inventory.normalize();
        self.extract.normalize();
        self.patch.normalize();
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            identify: self.identify.redacted_for_report(),
            inventory: self.inventory.redacted_for_report(),
            extract: self.extract.redacted_for_report(),
            patch: self.patch.redacted_for_report(),
        }
    }

    /// `true` iff EVERY operation in this contract stays within the
    /// identity / null-key rung. When true, the contract itself declares no
    /// broader transform support, so any `Supported` container/crypto/codec/
    /// patch report backed only by this contract is identity/null-key-only.
    pub fn is_identity_or_null_key_only(&self) -> bool {
        self.identify.is_identity_or_null_key_only()
            && self.inventory.is_identity_or_null_key_only()
            && self.extract.is_identity_or_null_key_only()
            && self.patch.is_identity_or_null_key_only()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessOperationContract {
    pub status: CapabilityStatus,
    pub required_capabilities: Vec<Capability>,
    pub supported_surfaces: Vec<SurfaceTransform>,
    pub supported_containers: Vec<ContainerTransform>,
    pub supported_crypto: Vec<CryptoTransform>,
    pub supported_codecs: Vec<CodecTransform>,
    pub supported_patch_back: Vec<PatchBackTransform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_boundary: Option<String>,
}

impl LayeredAccessOperationContract {
    pub fn supported_identity(required_capabilities: Vec<Capability>) -> Self {
        let mut contract = Self {
            status: CapabilityStatus::Supported,
            required_capabilities,
            supported_surfaces: vec![SurfaceTransform::Identity, SurfaceTransform::JsonPointer],
            supported_containers: vec![ContainerTransform::Identity, ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::Identity, CodecTransform::JsonText],
            supported_patch_back: vec![PatchBackTransform::Identity, PatchBackTransform::RewriteJson],
            support_boundary: Some(
                "plaintext identity pipeline only; no archive rebuild, encrypted input, helper, or decompile support claimed"
                    .to_string(),
            ),
        };
        contract.normalize();
        contract
    }

    pub fn normalize(&mut self) {
        self.required_capabilities
            .sort_by_key(|capability| serde_json::to_string(capability).unwrap_or_default());
        self.required_capabilities.dedup();
        self.supported_surfaces.sort();
        self.supported_surfaces.dedup();
        self.supported_containers.sort();
        self.supported_containers.dedup();
        self.supported_crypto.sort();
        self.supported_crypto.dedup();
        self.supported_codecs.sort();
        self.supported_codecs.dedup();
        self.supported_patch_back.sort();
        self.supported_patch_back.dedup();
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut contract = self.clone();
        contract.support_boundary = contract
            .support_boundary
            .as_deref()
            .map(redact_for_log_or_report);
        contract
    }

    /// `true` iff every declared transform stays within the
    /// identity / null-key rung — only identity/loose-file/directory
    /// containers, null-key crypto, plaintext-text codecs, identity/JSON-pointer
    /// surfaces, and identity/JSON-rewrite patch-back. This is exactly the
    /// surface produced by [`Self::supported_identity`]; anything beyond (an
    /// archive container, a non-null crypto, a binary codec, an archive/bytecode
    /// patch-back) makes it `false`, i.e. a genuine broader-transform claim a
    /// consumer can distinguish from identity/null-key-only.
    pub fn is_identity_or_null_key_only(&self) -> bool {
        self.supported_containers.iter().all(|container| {
            matches!(
                container,
                ContainerTransform::Identity
                    | ContainerTransform::LooseFile
                    | ContainerTransform::Directory
            )
        }) && self
            .supported_crypto
            .iter()
            .all(|crypto| matches!(crypto, CryptoTransform::NullKey))
            && self.supported_surfaces.iter().all(|surface| {
                matches!(
                    surface,
                    SurfaceTransform::Identity | SurfaceTransform::JsonPointer
                )
            })
            && self.supported_codecs.iter().all(|codec| {
                matches!(
                    codec,
                    CodecTransform::Identity
                        | CodecTransform::JsonText
                        | CodecTransform::Utf8Text
                        | CodecTransform::Utf16Text
                        | CodecTransform::ShiftJisText
                        | CodecTransform::RpgMakerMvMzJson
                        | CodecTransform::TyranoScriptMarkup
                )
            })
            && self.supported_patch_back.iter().all(|patch_back| {
                matches!(
                    patch_back,
                    PatchBackTransform::Identity | PatchBackTransform::RewriteJson
                )
            })
    }
}
