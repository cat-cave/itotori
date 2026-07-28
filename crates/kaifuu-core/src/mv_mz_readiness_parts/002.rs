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


