//! Canonical readiness record and encrypted-media boundary fixture.

use serde::{Deserialize, Serialize};

use crate::registry::CapabilityLevel;
use crate::{CryptoTransform, KaifuuResult, SurfaceTransform, stable_json};

use super::model::*;

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
