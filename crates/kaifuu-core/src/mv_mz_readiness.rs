//! RPG Maker MV/MZ JSON-text readiness record + public fixture generator
//! This module is the **declaration substrate** the later MV/MZ slices
//! (map / database / plugin-profile,..112) consume. It pins
//! exactly which `www/data/*.json` surfaces the adapter is ready to
//! *inventory* as JSON text, and — mechanically separate from that — it
//! records that the engine's encrypted image/audio media is **not**
//! extractable or patchable by this node.
//! # Two mechanically-distinct evidence channels
//! 1. [`MvMzJsonTextSurface`] — a JSON-text surface the adapter inventories.
//!    Every such surface flows through an [`IdentityContainer`]: a plain
//!    project directory, UTF-8 JSON-text codec, JSON-pointer addressing,
//!    in-place JSON rewrite on patch-back. There is **no** cryptographic leg
//!    (`crypto == NullKey`) and the codec is never a media codec.
//! 2. [`EncryptedMediaDiagnostic`] — an encrypted `*.rpgmvp` / `*.rpgmvm` /
//!    `*.rpgmvo` media surface. Each one is hard-pinned `extractable = false`
//!    and `patchable = false` with a media codec and a non-identity crypto
//!    leg.
//!    The distinction is **not prose**. [`MvMzReadinessRecord::validate`]
//!    returns structured [`MvMzReadinessViolation`]s — never `Ok` — if a
//!    JSON-text surface ever claims a media codec or a crypto transform, or if
//!    an encrypted-media diagnostic is ever marked extractable or patchable.
//!    Downstream slices and ALPHA-004's capability matrix gate on `validate`.
//! # Fixtures are public + deterministic
//! [`mv_mz_fixture_manifest`] / [`generate_mv_mz_fixture_tree`] emit only
//! synthetic public JSON (`System.json`, `Map001.json`, `CommonEvents.json`,
//! database files) plus a manifest of ids / relative paths / SHA-256 content
//! hashes / byte counts. No retail bytes, no private paths, no screenshots,
//! and **no encrypted asset bytes** are ever written — the encrypted-media
//! channel is metadata (globs / kinds / ids) only.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::registry::CapabilityLevel;
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, PatchBackTransform,
    SurfaceTransform, atomic_write_text, sha256_hash_bytes, stable_json,
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
            reason: "KAIFUU-108 declares MV/MZ JSON-text inventory only; encrypted media \
                     extraction and patch-back are not claimed by this node."
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
                "KAIFUU-109",
                "Map + common-event text slice consumes the map and common-event surfaces.",
                &[Maps, CommonEvents],
            ),
            Self::new(
                "KAIFUU-110",
                "Database slice consumes the database name/description/message surfaces.",
                &[Database],
            ),
            Self::new(
                "KAIFUU-111",
                "System/terms slice consumes the System.json metadata and terms surfaces.",
                &[System, Terms],
            ),
            Self::new(
                "KAIFUU-112",
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

/// The MV/MZ JSON-text readiness record consumed..112 and
/// ALPHA-004's capability matrix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzReadinessRecord {
    pub schema_version: String,
    pub engine_family: String,
    pub variant: String,
    pub capability: CapabilityLevel,
    pub identity: IdentityContainer,
    pub json_text_surfaces: Vec<MvMzJsonTextSurface>,
    pub encrypted_media_diagnostics: Vec<EncryptedMediaDiagnostic>,
    pub fixture_profiles: Vec<MvMzFixtureProfile>,
}

impl MvMzReadinessRecord {
    /// The canonical, fully-populated readiness record: all six JSON-text
    /// surfaces, the three encrypted-media diagnostics, and the four
    /// downstream consumer profiles.
    pub fn canonical() -> Self {
        Self {
            schema_version: MV_MZ_READINESS_SCHEMA_VERSION.to_string(),
            engine_family: MV_MZ_ENGINE_FAMILY.to_string(),
            variant: MV_MZ_VARIANT.to_string(),
            capability: CapabilityLevel::Inventory,
            identity: IdentityContainer::json_text(),
            json_text_surfaces: MvMzSurfaceRole::all()
                .into_iter()
                .map(MvMzJsonTextSurface::inventory)
                .collect(),
            encrypted_media_diagnostics: EncryptedMediaDiagnostic::canonical(),
            fixture_profiles: MvMzFixtureProfile::canonical(),
        }
    }

    /// Deterministic, array-compacted stable JSON for persistence.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }

    /// Mechanically enforce the JSON-text-vs-encrypted-media boundary.
    /// Returns every violation found; `Ok` only when the record is
    /// fully consistent.
    pub fn validate(&self) -> Result<(), Vec<MvMzReadinessViolation>> {
        let mut violations = Vec::new();

        if self.engine_family != MV_MZ_ENGINE_FAMILY {
            violations.push(MvMzReadinessViolation::WrongEngineFamily {
                found: self.engine_family.clone(),
            });
        }
        if self.variant != MV_MZ_VARIANT {
            violations.push(MvMzReadinessViolation::WrongVariant {
                found: self.variant.clone(),
            });
        }
        if self.capability > CapabilityLevel::Inventory {
            violations.push(MvMzReadinessViolation::CapabilityAboveInventory {
                found: self.capability,
            });
        }
        if !self.identity.is_identity() {
            violations.push(MvMzReadinessViolation::IdentityContainerNotIdentity {
                crypto: self.identity.crypto,
            });
        }

        for surface in &self.json_text_surfaces {
            if is_media_codec(surface.codec) {
                violations.push(MvMzReadinessViolation::JsonTextSurfaceClaimsMediaCodec {
                    surface_id: surface.surface_id.clone(),
                    codec: surface.codec,
                });
            }
            if surface.surface != SurfaceTransform::JsonPointer {
                violations.push(MvMzReadinessViolation::JsonTextSurfaceNotJsonPointer {
                    surface_id: surface.surface_id.clone(),
                    surface: surface.surface,
                });
            }
            if surface.capability > CapabilityLevel::Inventory {
                violations.push(MvMzReadinessViolation::JsonTextSurfaceAboveInventory {
                    surface_id: surface.surface_id.clone(),
                    capability: surface.capability,
                });
            }
        }

        for diagnostic in &self.encrypted_media_diagnostics {
            if diagnostic.extractable {
                violations.push(MvMzReadinessViolation::EncryptedMediaMarkedExtractable {
                    diagnostic_id: diagnostic.diagnostic_id.clone(),
                });
            }
            if diagnostic.patchable {
                violations.push(MvMzReadinessViolation::EncryptedMediaMarkedPatchable {
                    diagnostic_id: diagnostic.diagnostic_id.clone(),
                });
            }
            if !is_media_codec(diagnostic.codec) {
                violations.push(MvMzReadinessViolation::EncryptedMediaNotMediaCodec {
                    diagnostic_id: diagnostic.diagnostic_id.clone(),
                    codec: diagnostic.codec,
                });
            }
            if diagnostic.crypto == CryptoTransform::NullKey {
                violations.push(MvMzReadinessViolation::EncryptedMediaClaimsIdentityCrypto {
                    diagnostic_id: diagnostic.diagnostic_id.clone(),
                });
            }
        }

        let known: std::collections::BTreeSet<&str> = self
            .json_text_surfaces
            .iter()
            .map(|s| s.surface_id.as_str())
            .collect();
        for profile in &self.fixture_profiles {
            for surface_id in &profile.surface_ids {
                if !known.contains(surface_id.as_str()) {
                    violations.push(MvMzReadinessViolation::FixtureProfileUnknownSurface {
                        consumer_node: profile.consumer_node.clone(),
                        surface_id: surface_id.clone(),
                    });
                }
            }
        }

        if violations.is_empty() {
            Ok(())
        } else {
            Err(violations)
        }
    }
}

// Negative fixture: encrypted-media-only evidence stays outside JSON text

/// The encrypted-media-only negative fixture: a project whose *only*
/// evidence is encrypted media. It carries the encrypted-media diagnostics
/// but **zero** JSON-text surfaces, proving that encrypted media never
/// bootstraps a JSON-text support claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzNegativeFixture {
    pub fixture_id: String,
    pub record: MvMzReadinessRecord,
}

impl MvMzNegativeFixture {
    /// Build the canonical encrypted-media-only negative fixture.
    pub fn encrypted_media_only() -> Self {
        let record = MvMzReadinessRecord {
            schema_version: MV_MZ_READINESS_SCHEMA_VERSION.to_string(),
            engine_family: MV_MZ_ENGINE_FAMILY.to_string(),
            variant: MV_MZ_VARIANT.to_string(),
            capability: CapabilityLevel::Inventory,
            identity: IdentityContainer::json_text(),
            // No JSON-text evidence: encrypted media alone claims nothing.
            json_text_surfaces: Vec::new(),
            encrypted_media_diagnostics: EncryptedMediaDiagnostic::canonical(),
            fixture_profiles: Vec::new(),
        };
        Self {
            fixture_id: MV_MZ_NEGATIVE_FIXTURE_ID.to_string(),
            record,
        }
    }

    /// Mechanical proof: the record is internally consistent, yet it claims
    /// **no** JSON-text surface while still recording non-extractable /
    /// non-patchable encrypted-media diagnostics. Encrypted-media-only
    /// evidence therefore stays outside JSON-text support by construction.
    pub fn proves_encrypted_media_outside_json_text(&self) -> bool {
        self.record.validate().is_ok()
            && self.record.json_text_surfaces.is_empty()
            && !self.record.encrypted_media_diagnostics.is_empty()
            && self
                .record
                .encrypted_media_diagnostics
                .iter()
                .all(|d| !d.extractable && !d.patchable)
    }

    /// A tampered clone that flips the encrypted media to extractable +
    /// patchable. [`MvMzReadinessRecord::validate`] must reject it — used by
    /// tests to prove the boundary is enforced, not merely asserted.
    pub fn tampered_claims_encrypted_media(&self) -> MvMzReadinessRecord {
        let mut record = self.record.clone();
        for diagnostic in &mut record.encrypted_media_diagnostics {
            diagnostic.extractable = true;
            diagnostic.patchable = true;
        }
        record
    }
}

// Public fixture generator

/// One file in the public MV/MZ fixture tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzFixtureFile {
    pub id: String,
    pub relative_path: String,
    pub role: Option<MvMzSurfaceRole>,
    pub content_sha256: String,
    pub byte_count: u64,
}

/// Deterministic manifest of the public MV/MZ fixture tree. Contains ids,
/// relative paths, content hashes, and byte counts only — never the bytes
/// themselves, and never any retail or encrypted asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzFixtureManifest {
    pub schema_version: String,
    pub fixture_id: String,
    pub files: Vec<MvMzFixtureFile>,
}

impl MvMzFixtureManifest {
    /// Deterministic, array-compacted stable JSON for persistence.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }
}

/// The synthetic public fixture files, sorted by relative path. Pure /
/// deterministic — no disk access. Each tuple is
/// `(relative_path, role, content)`.
fn fixture_files() -> Vec<(&'static str, Option<MvMzSurfaceRole>, String)> {
    // Project-root marker (MV ships `Game.rpgproject` beside `www/`). Public
    // synthetic content; identifies the tree without retail bytes.
    let game_rpgproject = "RPGMV 1.6.2\n".to_string();

    // System.json declares encrypted media exists (so archive detection
    // identifies the tree) but the encrypted bytes are NEVER shipped — the
    // encrypted-media channel is metadata only. `gameTitle`/`currencyUnit`
    // back the System role; `terms`/type-lists back the Terms role.
    let system_json = r#"{
  "gameTitle": "Itotori Public MV/MZ Fixture",
  "currencyUnit": "G",
  "hasEncryptedImages": true,
  "hasEncryptedAudio": true,
  "locale": "en_US",
  "terms": {
    "basic": ["Level", "Lv", "HP", "MP"],
    "params": ["Max HP", "Max MP", "Attack"],
    "commands": [null, "Fight", "Escape", "Item"],
    "messages": {
      "actorDamage": "%1 took %2 damage!",
      "actorRecovery": "%1 recovered %2 HP!"
    }
  },
  "equipTypes": ["", "Weapon", "Shield"],
  "skillTypes": ["", "Magic", "Special"],
  "weaponTypes": ["", "Dagger"],
  "armorTypes": ["", "Light Armor"],
  "elements": ["", "Fire", "Ice"]
}
"#
    .to_string();

    // Map001.json: 101 setup, 401 dialogue (with a \V[n] control span), 102
    // choices, 105/405 scrolling text — the map JSON-text surface.
    let map001_json = r#"{
  "displayName": "Public Fixture Town",
  "events": [null, {"id": 1, "pages": [{"list": [
    {"code": 101, "indent": 0, "parameters": ["Actor1", 0, 0, 2, "Guide"]},
    {"code": 401, "indent": 0, "parameters": ["Welcome \\v[1] to the public fixture."]},
    {"code": 401, "indent": 0, "parameters": ["This text is synthetic."]},
    {"code": 102, "indent": 0, "parameters": [["Continue", "Leave"], 1, 0, 2, 0]},
    {"code": 402, "indent": 0, "parameters": [0, "Continue"]},
    {"code": 404, "indent": 0, "parameters": []},
    {"code": 105, "indent": 0, "parameters": [2, false]},
    {"code": 405, "indent": 0, "parameters": ["Scrolling synthetic narration."]},
    {"code": 356, "indent": 0, "parameters": ["FixturePlugin demo"]},
    {"code": 0, "indent": 0, "parameters": []}
  ]}]}]
}
"#
    .to_string();

    // CommonEvents.json: a single common event with a 401 line.
    let common_events_json =
        r#"[null, {"id": 1, "name": "Intro", "trigger": 0, "switchId": 1, "list": [
  {"code": 101, "indent": 0, "parameters": ["", 0, 0, 2]},
  {"code": 401, "indent": 0, "parameters": ["Common-event synthetic line."]},
  {"code": 0, "indent": 0, "parameters": []}
]}]
"#
        .to_string();

    // Database files: Actors + Items name/description surfaces.
    let actors_json =
        "[null, {\"id\": 1, \"name\": \"Fixture Hero\", \"nickname\": \"Test\", \"profile\": \"A synthetic actor.\"}]\n"
            .to_string();
    let items_json =
        "[null, {\"id\": 1, \"name\": \"Public Potion\", \"description\": \"Restores synthetic HP.\"}]\n"
            .to_string();

    let mut files = vec![
        ("Game.rpgproject", None, game_rpgproject),
        (
            "www/data/System.json",
            Some(MvMzSurfaceRole::System),
            system_json,
        ),
        (
            "www/data/Map001.json",
            Some(MvMzSurfaceRole::Maps),
            map001_json,
        ),
        (
            "www/data/CommonEvents.json",
            Some(MvMzSurfaceRole::CommonEvents),
            common_events_json,
        ),
        (
            "www/data/Actors.json",
            Some(MvMzSurfaceRole::Database),
            actors_json,
        ),
        (
            "www/data/Items.json",
            Some(MvMzSurfaceRole::Database),
            items_json,
        ),
    ];
    files.sort_by(|a, b| a.0.cmp(b.0));
    files
}

/// Build the deterministic public fixture manifest without touching disk.
pub fn mv_mz_fixture_manifest() -> MvMzFixtureManifest {
    let files = fixture_files()
        .into_iter()
        .map(|(relative_path, role, content)| {
            let bytes = content.as_bytes();
            MvMzFixtureFile {
                id: format!("{MV_MZ_FIXTURE_ID}/{relative_path}"),
                relative_path: relative_path.to_string(),
                role,
                content_sha256: sha256_hash_bytes(bytes),
                byte_count: bytes.len() as u64,
            }
        })
        .collect();
    MvMzFixtureManifest {
        schema_version: MV_MZ_FIXTURE_MANIFEST_SCHEMA_VERSION.to_string(),
        fixture_id: MV_MZ_FIXTURE_ID.to_string(),
        files,
    }
}

/// Write the public MV/MZ fixture tree under `root` and return the manifest.
/// Only deterministic public JSON (and the project-root marker) is written;
/// no retail bytes, private paths, screenshots, or encrypted assets. Files
/// are written atomically. The returned manifest is byte-identical to
/// [`mv_mz_fixture_manifest`].
pub fn generate_mv_mz_fixture_tree(root: &Path) -> KaifuuResult<MvMzFixtureManifest> {
    for (relative_path, _role, content) in fixture_files() {
        let target = root.join(relative_path);
        atomic_write_text(&target, &content)?;
    }
    Ok(mv_mz_fixture_manifest())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_record_validates_and_covers_all_roles() {
        let record = MvMzReadinessRecord::canonical();
        assert_eq!(record.engine_family, "rpg_maker_mv_mz");
        assert_eq!(record.variant, "mv_or_mz");
        assert_eq!(record.capability, CapabilityLevel::Inventory);
        assert_eq!(record.json_text_surfaces.len(), 6);
        assert!(record.identity.is_identity());
        // Every role is present exactly once.
        for role in MvMzSurfaceRole::all() {
            assert_eq!(
                record
                    .json_text_surfaces
                    .iter()
                    .filter(|s| s.role == role)
                    .count(),
                1,
                "role {role:?} present once"
            );
        }
        record.validate().expect("canonical record is consistent");
    }

    #[test]
    fn identity_container_has_no_crypto_leg() {
        let identity = IdentityContainer::json_text();
        assert_eq!(identity.crypto, CryptoTransform::NullKey);
        assert_eq!(identity.codec, CodecTransform::JsonText);
        assert!(!is_media_codec(identity.codec));
        assert!(identity.is_identity());
    }

    #[test]
    fn encrypted_media_diagnostics_are_all_unsupported() {
        let record = MvMzReadinessRecord::canonical();
        assert!(!record.encrypted_media_diagnostics.is_empty());
        for diagnostic in &record.encrypted_media_diagnostics {
            assert!(!diagnostic.extractable, "{}", diagnostic.diagnostic_id);
            assert!(!diagnostic.patchable, "{}", diagnostic.diagnostic_id);
            assert!(is_media_codec(diagnostic.codec));
            assert_ne!(diagnostic.crypto, CryptoTransform::NullKey);
        }
    }

    #[test]
    fn validate_rejects_json_text_surface_with_media_codec() {
        let mut record = MvMzReadinessRecord::canonical();
        record.json_text_surfaces[0].codec = CodecTransform::PngImage;
        let violations = record.validate().expect_err("media codec must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::JsonTextSurfaceClaimsMediaCodec { .. }
        )));
    }

    #[test]
    fn validate_rejects_extractable_or_patchable_encrypted_media() {
        let mut record = MvMzReadinessRecord::canonical();
        record.encrypted_media_diagnostics[0].extractable = true;
        record.encrypted_media_diagnostics[1].patchable = true;
        let violations = record.validate().expect_err("must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::EncryptedMediaMarkedExtractable { .. }
        )));
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::EncryptedMediaMarkedPatchable { .. }
        )));
    }

    #[test]
    fn validate_rejects_identity_container_with_crypto() {
        let mut record = MvMzReadinessRecord::canonical();
        record.identity.crypto = CryptoTransform::RpgMakerAssetXor;
        let violations = record.validate().expect_err("crypto leg must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::IdentityContainerNotIdentity { .. }
        )));
    }

    #[test]
    fn validate_rejects_capability_above_inventory() {
        let mut record = MvMzReadinessRecord::canonical();
        record.capability = CapabilityLevel::Extract;
        record.json_text_surfaces[0].capability = CapabilityLevel::Patch;
        let violations = record.validate().expect_err("must fail");
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, MvMzReadinessViolation::CapabilityAboveInventory { .. }))
        );
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::JsonTextSurfaceAboveInventory { .. }
        )));
    }

    #[test]
    fn fixture_profiles_reference_known_surface_ids() {
        let record = MvMzReadinessRecord::canonical();
        let known: std::collections::BTreeSet<&str> = record
            .json_text_surfaces
            .iter()
            .map(|s| s.surface_id.as_str())
            .collect();
        let nodes: Vec<&str> = record
            .fixture_profiles
            .iter()
            .map(|p| p.consumer_node.as_str())
            .collect();
        assert_eq!(
            nodes,
            ["KAIFUU-109", "KAIFUU-110", "KAIFUU-111", "KAIFUU-112"]
        );
        for profile in &record.fixture_profiles {
            assert!(!profile.surface_ids.is_empty());
            for surface_id in &profile.surface_ids {
                assert!(known.contains(surface_id.as_str()), "{surface_id}");
            }
        }
    }

    #[test]
    fn validate_rejects_profile_referencing_unknown_surface() {
        let mut record = MvMzReadinessRecord::canonical();
        record.fixture_profiles[0]
            .surface_ids
            .push("mv_mz/json_text/nonexistent".to_string());
        let violations = record.validate().expect_err("unknown surface must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::FixtureProfileUnknownSurface { .. }
        )));
    }

    #[test]
    fn negative_fixture_keeps_encrypted_media_outside_json_text() {
        let negative = MvMzNegativeFixture::encrypted_media_only();
        assert!(negative.proves_encrypted_media_outside_json_text());
        assert!(negative.record.json_text_surfaces.is_empty());
        negative
            .record
            .validate()
            .expect("encrypted-media-only record is internally consistent");
    }

    #[test]
    fn negative_fixture_tampered_claim_is_mechanically_rejected() {
        let negative = MvMzNegativeFixture::encrypted_media_only();
        let tampered = negative.tampered_claims_encrypted_media();
        let violations = tampered
            .validate()
            .expect_err("tampered extractable/patchable claim must fail validation");
        // Both flips, across all three diagnostics, surface as violations.
        let extractable = violations
            .iter()
            .filter(|v| {
                matches!(
                    v,
                    MvMzReadinessViolation::EncryptedMediaMarkedExtractable { .. }
                )
            })
            .count();
        let patchable = violations
            .iter()
            .filter(|v| {
                matches!(
                    v,
                    MvMzReadinessViolation::EncryptedMediaMarkedPatchable { .. }
                )
            })
            .count();
        assert_eq!(extractable, 3);
        assert_eq!(patchable, 3);
    }

    #[test]
    fn fixture_manifest_is_deterministic_and_public() {
        let a = mv_mz_fixture_manifest();
        let b = mv_mz_fixture_manifest();
        assert_eq!(a, b, "manifest must be deterministic");
        assert_eq!(a.fixture_id, MV_MZ_FIXTURE_ID);
        assert!(!a.files.is_empty());
        // Sorted by relative path; every file carries a sha256 + byte count.
        let mut sorted = a.files.clone();
        sorted.sort_by(|x, y| x.relative_path.cmp(&y.relative_path));
        assert_eq!(a.files, sorted);
        for file in &a.files {
            assert!(file.content_sha256.starts_with("sha256:"));
            assert!(file.byte_count > 0);
            // No retail/private/encrypted leakage in the manifest paths.
            let path = &file.relative_path;
            assert!(!path.contains(".."), "no parent escapes: {path}");
            assert!(!path.starts_with('/'), "no absolute paths: {path}");
            for encrypted in [".rpgmvp", ".rpgmvm", ".rpgmvo", ".rpgmvu", ".png_", ".m4a_"] {
                assert!(!path.ends_with(encrypted), "no encrypted asset: {path}");
            }
            for binary in [".png", ".jpg", ".jpeg", ".m4a", ".ogg", ".webp"] {
                assert!(!path.ends_with(binary), "no media/screenshot asset: {path}");
            }
        }
    }

    #[test]
    fn generated_tree_matches_manifest_and_detects_as_rpg_maker() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest =
            generate_mv_mz_fixture_tree(tmp.path()).expect("fixture generation succeeds");
        assert_eq!(manifest, mv_mz_fixture_manifest());

        // Files exist on disk with the manifested byte counts and hashes.
        for file in &manifest.files {
            let on_disk = tmp.path().join(&file.relative_path);
            let bytes = std::fs::read(&on_disk).expect("written file");
            assert_eq!(bytes.len() as u64, file.byte_count);
            assert_eq!(sha256_hash_bytes(&bytes), file.content_sha256);
        }

        // The synthetic tree is identified as RPG Maker MV/MZ by the shared
        // archive detector (System.json encryption fields), so downstream
        // slices can reuse engine identification on a public tree.
        let www = tmp.path().join("www");
        let detection = crate::ArchiveDetectionReport::scan(&www);
        assert!(
            detection.rows.iter().any(|row| {
                row.engine_family == crate::ArchiveEngineFamily::RpgMakerMvMz && row.detected
            }),
            "public fixture tree must detect as RPG Maker MV/MZ"
        );

        // No encrypted asset bytes were ever written.
        for entry in walkdir(tmp.path()) {
            let name = entry.to_string_lossy().to_string();
            for encrypted in [".rpgmvp", ".rpgmvm", ".rpgmvo", ".rpgmvu", ".png_", ".m4a_"] {
                assert!(
                    !name.ends_with(encrypted),
                    "no encrypted asset on disk: {name}"
                );
            }
        }
    }

    /// Minimal recursive file walk for the no-encrypted-asset disk assertion.
    fn walkdir(root: &Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path);
                }
            }
        }
        out
    }

    #[test]
    fn record_and_manifest_round_trip_through_stable_json() {
        let record = MvMzReadinessRecord::canonical();
        let json = record.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: MvMzReadinessRecord = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, record);

        let manifest = mv_mz_fixture_manifest();
        let mjson = manifest.stable_json().expect("stable json");
        let mparsed: MvMzFixtureManifest = serde_json::from_str(&mjson).expect("round trip");
        assert_eq!(mparsed, manifest);
    }
}
