//! MV/MZ readiness surface and validation model.

use serde::{Deserialize, Serialize};

use crate::registry::CapabilityLevel;
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, PatchBackTransform, SurfaceTransform,
};

/// Readiness-record schema version. Bumped with any breaking field change
/// consumed..112.
pub const MV_MZ_READINESS_SCHEMA_VERSION: &str = "0.1.0";
/// Public fixture manifest schema version.
pub const MV_MZ_FIXTURE_MANIFEST_SCHEMA_VERSION: &str = "0.1.0";

/// Canonical `engine_family` wire value for the readiness record.
pub const MV_MZ_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";
/// Canonical `variant` wire value (MV and MZ share the JSON-text corpus).
pub const MV_MZ_VARIANT: &str = "mv_or_mz";

/// Stable id of the canonical public fixture tree.
pub const MV_MZ_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-json-text-public";
/// Stable id of the encrypted-media-only negative fixture.
pub const MV_MZ_NEGATIVE_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-encrypted-media-only-negative";

// Surface roles

/// The six JSON-text surface roles the MV/MZ adapter inventories. Each role
/// owns a stable [`MvMzJsonTextSurface::surface_id`] downstream slices
/// reference by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzSurfaceRole {
    /// `data/Map*.json` event-command text (`401`/`405`/`102`/`101`/...).
    Maps,
    /// `data/CommonEvents.json` event-command text.
    CommonEvents,
    /// `data/{Actors,Items,Weapons,Armors,Skills,Enemies,...}.json`
    /// name/description/message surfaces.
    Database,
    /// `data/System.json` `gameTitle` / `currencyUnit` metadata text.
    System,
    /// `data/System.json` `terms.{basic,params,commands,messages}` + type
    /// lists.
    Terms,
    /// Plugin-command / script diagnostics (`356`/`357`/`355`/`655`/`122`)
    /// recorded as structured findings rather than claimed text.
    PluginProfileDiagnostics,
}

impl MvMzSurfaceRole {
    /// All six roles in canonical (record) order.
    pub fn all() -> [Self; 6] {
        [
            Self::Maps,
            Self::CommonEvents,
            Self::Database,
            Self::System,
            Self::Terms,
            Self::PluginProfileDiagnostics,
        ]
    }

    /// Stable string segment used in surface ids.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Maps => "maps",
            Self::CommonEvents => "common_events",
            Self::Database => "database",
            Self::System => "system",
            Self::Terms => "terms",
            Self::PluginProfileDiagnostics => "plugin_profile_diagnostics",
        }
    }

    /// Stable, public surface id (no retail bytes; deterministic).
    pub fn surface_id(self) -> String {
        format!("mv_mz/json_text/{}", self.as_str())
    }

    /// File glob (relative to the project root) the role inventories.
    pub fn file_glob(self) -> &'static str {
        match self {
            Self::Maps => "www/data/Map*.json",
            Self::CommonEvents => "www/data/CommonEvents.json",
            Self::Database => {
                "www/data/{Actors,Classes,Items,Weapons,Armors,Skills,Enemies,States,Troops}.json"
            }
            Self::System | Self::Terms => "www/data/System.json",
            Self::PluginProfileDiagnostics => "www/data/{Map*,CommonEvents,Troops}.json",
        }
    }
}

// Identity container

/// The transform stack a JSON-text surface flows through. Every leg is
/// *identity* with respect to cryptography and media re-encoding: a plain
/// project directory holds UTF-8 JSON text addressed by JSON pointer and
/// patched back by rewriting the same JSON in place. No key material, no
/// decryption, no media transcode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityContainer {
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
}

impl IdentityContainer {
    /// The canonical JSON-text identity container.
    pub fn json_text() -> Self {
        Self {
            container: ContainerTransform::ProjectAsset,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::JsonText,
            surface: SurfaceTransform::JsonPointer,
            patch_back: PatchBackTransform::RewriteJson,
        }
    }

    /// True iff the container claims no cryptographic transform — the
    /// mechanical definition of "identity" for this node.
    pub fn is_identity(&self) -> bool {
        self.crypto == CryptoTransform::NullKey
            && !is_media_codec(self.codec)
            && self.patch_back != PatchBackTransform::ReplaceAsset
    }
}

/// True iff `codec` is an encrypted/binary media codec (image or audio). A
/// JSON-text surface must never carry one; an encrypted-media diagnostic
/// must always carry one.
pub fn is_media_codec(codec: CodecTransform) -> bool {
    matches!(
        codec,
        CodecTransform::PngImage | CodecTransform::M4aAudio | CodecTransform::OggAudio
    )
}

// JSON-text surface

/// One JSON-text surface the MV/MZ adapter is ready to inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzJsonTextSurface {
    pub surface_id: String,
    pub role: MvMzSurfaceRole,
    pub file_glob: String,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub capability: CapabilityLevel,
}

impl MvMzJsonTextSurface {
    /// The canonical inventory-level JSON-text surface for `role`.
    pub fn inventory(role: MvMzSurfaceRole) -> Self {
        Self {
            surface_id: role.surface_id(),
            role,
            file_glob: role.file_glob().to_string(),
            codec: CodecTransform::JsonText,
            surface: SurfaceTransform::JsonPointer,
            capability: CapabilityLevel::Inventory,
        }
    }
}

// Encrypted-media diagnostic

/// Kind of encrypted MV/MZ media surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaKind {
    Image,
    Audio,
}

/// A declaration that an encrypted media surface exists and is explicitly
/// **out of scope** for this node. The `extractable` / `patchable` flags are
/// hard-pinned `false`; [`MvMzReadinessRecord::validate`] rejects the record
/// if either is ever flipped to `true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaDiagnostic {
    pub diagnostic_id: String,
    pub media_kind: EncryptedMediaKind,
    pub media_glob: String,
    pub codec: CodecTransform,
    pub crypto: CryptoTransform,
    /// Always `false` for this node.
    pub extractable: bool,
    /// Always `false` for this node.
    pub patchable: bool,
    pub reason: String,
}

impl EncryptedMediaDiagnostic {
    fn unsupported(
        id_suffix: &str,
        media_kind: EncryptedMediaKind,
        media_glob: &str,
        codec: CodecTransform,
    ) -> Self {
        Self {
            diagnostic_id: format!("mv_mz/encrypted_media/{id_suffix}"),
            media_kind,
            media_glob: media_glob.to_string(),
            codec,
            crypto: CryptoTransform::RpgMakerAssetXor,
            extractable: false,
            patchable: false,
            reason: "The readiness record covers MV/MZ JSON-text inventory only; encrypted media \
                     extraction and patch-back are unsupported."
                .to_string(),
        }
    }

    /// Canonical encrypted-media diagnostics (`*.rpgmvp` images, `*.rpgmvm` /
    /// `*.rpgmvo` audio), all unsupported.
    pub fn canonical() -> Vec<Self> {
        vec![
            Self::unsupported(
                "rpgmvp_image",
                EncryptedMediaKind::Image,
                "www/img/**/*.rpgmvp",
                CodecTransform::PngImage,
            ),
            Self::unsupported(
                "rpgmvm_audio",
                EncryptedMediaKind::Audio,
                "www/audio/**/*.rpgmvm",
                CodecTransform::M4aAudio,
            ),
            Self::unsupported(
                "rpgmvo_audio",
                EncryptedMediaKind::Audio,
                "www/audio/**/*.rpgmvo",
                CodecTransform::OggAudio,
            ),
        ]
    }
}

// Fixture profiles (downstream consumers)

/// Maps a downstream consumer node to the exact JSON-text surface ids it
/// reads from this readiness record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzFixtureProfile {
    pub consumer_node: String,
    pub description: String,
    pub surface_ids: Vec<String>,
}

impl MvMzFixtureProfile {
    fn new(consumer_node: &str, description: &str, roles: &[MvMzSurfaceRole]) -> Self {
        Self {
            consumer_node: consumer_node.to_string(),
            description: description.to_string(),
            surface_ids: roles.iter().map(|r| r.surface_id()).collect(),
        }
    }

    /// The canonical..112 consumer profiles.
    pub fn canonical() -> Vec<Self> {
        use MvMzSurfaceRole::{
            CommonEvents, Database, Maps, PluginProfileDiagnostics, System, Terms,
        };
        vec![
            Self::new(
                "map-common-event",
                "Map + common-event text slice consumes the map and common-event surfaces.",
                &[Maps, CommonEvents],
            ),
            Self::new(
                "database-terms",
                "Database slice consumes the database name/description/message surfaces.",
                &[Database],
            ),
            Self::new(
                "system-terms",
                "System/terms slice consumes the System.json metadata and terms surfaces.",
                &[System, Terms],
            ),
            Self::new(
                "plugin-profile",
                "Plugin-profile diagnostics slice consumes the plugin/script diagnostic surface.",
                &[PluginProfileDiagnostics],
            ),
        ]
    }
}

// Readiness record

/// A structured violation of the JSON-text-vs-encrypted-media boundary.
/// `validate` returns one per offending surface/diagnostic so failures are
/// machine-actionable findings, never prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum MvMzReadinessViolation {
    /// Record `engine_family` is not `rpg_maker_mv_mz`.
    WrongEngineFamily { found: String },
    /// Record `variant` is not `mv_or_mz`.
    WrongVariant { found: String },
    /// Record-level capability claims more than `inventory`.
    CapabilityAboveInventory { found: CapabilityLevel },
    /// Identity container carries a non-identity crypto/codec/patch leg.
    IdentityContainerNotIdentity { crypto: CryptoTransform },
    /// A JSON-text surface claimed a media codec.
    JsonTextSurfaceClaimsMediaCodec {
        surface_id: String,
        codec: CodecTransform,
    },
    /// A JSON-text surface is not addressed by JSON pointer.
    JsonTextSurfaceNotJsonPointer {
        surface_id: String,
        surface: SurfaceTransform,
    },
    /// A JSON-text surface claimed more than `inventory`.
    JsonTextSurfaceAboveInventory {
        surface_id: String,
        capability: CapabilityLevel,
    },
    /// An encrypted-media diagnostic was marked extractable.
    EncryptedMediaMarkedExtractable { diagnostic_id: String },
    /// An encrypted-media diagnostic was marked patchable.
    EncryptedMediaMarkedPatchable { diagnostic_id: String },
    /// An encrypted-media diagnostic does not carry a media codec.
    EncryptedMediaNotMediaCodec {
        diagnostic_id: String,
        codec: CodecTransform,
    },
    /// An encrypted-media diagnostic claims the identity (null-key) crypto.
    EncryptedMediaClaimsIdentityCrypto { diagnostic_id: String },
    /// A fixture profile references a surface id with no backing surface.
    FixtureProfileUnknownSurface {
        consumer_node: String,
        surface_id: String,
    },
}
