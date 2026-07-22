use super::*;

// Deliverable 1 — RGSS3 layered-transform PROFILE fields

/// The RGSSAD v3 XOR keystream scheme, as profile fields. The base key is
/// derived from a per-archive `seed` (`key = seed * mul + add`); each file
/// carries its own key and its data is XORed with an advancing keystream
/// (`k = k * data_mul + data_add`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rgss3XorKeystreamScheme {
    /// Base-key derivation multiplier applied to the archive seed.
    pub seed_multiplier: u32,
    /// Base-key derivation addend.
    pub seed_addend: u32,
    /// Per-file data keystream advance multiplier.
    pub data_multiplier: u32,
    /// Per-file data keystream advance addend.
    pub data_addend: u32,
}

impl Rgss3XorKeystreamScheme {
    /// The modelled RGSSAD v3 scheme.
    pub const fn rgss3() -> Self {
        Self {
            seed_multiplier: 9,
            seed_addend: 3,
            data_multiplier: 7,
            data_addend: 3,
        }
    }

    /// Derive the per-archive base key from the header seed.
    pub const fn base_key(self, seed: u32) -> u32 {
        seed.wrapping_mul(self.seed_multiplier)
            .wrapping_add(self.seed_addend)
    }

    /// Advance a keystream word.
    pub const fn advance(self, key: u32) -> u32 {
        key.wrapping_mul(self.data_multiplier)
            .wrapping_add(self.data_addend)
    }
}

/// One binary-patcher patch-back RISK / dependency, represented as a checked
/// constraint. Deliverable 3: a re-pack that violates any of these produces a
/// corrupt archive, so the profile carries them as fields the validator checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rgss3PatchBackDependency {
    /// Re-serialising a `.rvdata2` must preserve the Ruby Marshal object graph
    /// (types, order, symbol identity) — a lossy re-encode breaks `Marshal.load`.
    MarshalStructurePreserved,
    /// A string-table / dialogue rewrite must update the Marshal `long` length
    /// prefixes; a rewrite that leaves stale byte-length prefixes desyncs the
    /// stream.
    StringTableRewriteBoundsUpdated,
    /// `Scripts.rvdata2` code payloads are additionally zlib-deflated; a patched
    /// script must be re-deflated before Marshal-embedding.
    ScriptsZlibRecompressed,
    /// The RGSSAD per-file XOR keystream must be reproduced on re-pack, or the
    /// engine reads garbage.
    XorKeystreamReproduced,
    /// RGSSAD stores absolute offsets + sizes; a size change must recompute the
    /// whole directory, not just the changed entry.
    ArchiveOffsetsRecomputed,
}

impl Rgss3PatchBackDependency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MarshalStructurePreserved => "marshal_structure_preserved",
            Self::StringTableRewriteBoundsUpdated => "string_table_rewrite_bounds_updated",
            Self::ScriptsZlibRecompressed => "scripts_zlib_recompressed",
            Self::XorKeystreamReproduced => "xor_keystream_reproduced",
            Self::ArchiveOffsetsRecomputed => "archive_offsets_recomputed",
        }
    }

    /// The layer the dependency guards (used for typed findings).
    pub fn semantic_code(self) -> SemanticErrorCode {
        match self {
            Self::MarshalStructurePreserved | Self::StringTableRewriteBoundsUpdated => {
                SemanticErrorCode::MissingCodecCapability
            }
            Self::ScriptsZlibRecompressed => SemanticErrorCode::MissingCodecCapability,
            Self::XorKeystreamReproduced => SemanticErrorCode::MissingCryptoCapability,
            Self::ArchiveOffsetsRecomputed => SemanticErrorCode::MissingPatchBackCapability,
        }
    }

    /// The full set of patch-back dependencies a byte-correct RGSS3 repack MUST
    /// satisfy, in canonical order.
    pub fn required() -> [Self; 5] {
        [
            Self::MarshalStructurePreserved,
            Self::StringTableRewriteBoundsUpdated,
            Self::ScriptsZlibRecompressed,
            Self::XorKeystreamReproduced,
            Self::ArchiveOffsetsRecomputed,
        ]
    }
}

/// A declared patch-back dependency plus whether the profile asserts the
/// re-pack path satisfies it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rgss3PatchBackDependencyDecl {
    pub dependency: Rgss3PatchBackDependency,
    /// Whether the declared re-pack path satisfies the constraint. A required
    /// dependency declared unsatisfied is a blocking finding.
    pub satisfied: bool,
}

/// The RGSS3 layered-transform profile: the RGSSAD archive, the XOR keystream,
/// the Ruby Marshal (+zlib) codec, the surface, and the patch-back mode + its
/// checked dependency constraints, all as profile fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rgss3LayeredTransformProfile {
    pub schema_version: String,
    /// Canonical engine family token (`rgss3`).
    pub engine_family: String,
    pub profile_id: String,
    pub container: ContainerTransform,
    /// RGSSAD signature bytes (`RGSSAD\0`) — recorded so the detector boundary
    /// is a profile field, not a magic literal buried in code.
    pub container_magic: Vec<u8>,
    pub archive_version: u8,
    pub crypto: CryptoTransform,
    pub crypto_scheme: Rgss3XorKeystreamScheme,
    pub codec: CodecTransform,
    pub marshal_major: u8,
    pub marshal_minor: u8,
    /// `Scripts.rvdata2` code payloads are zlib-deflated inside the Marshal
    /// string (unlike the other data files).
    pub scripts_zlib_deflated: bool,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
    pub patch_back_dependencies: Vec<Rgss3PatchBackDependencyDecl>,
}

impl Rgss3LayeredTransformProfile {
    /// The canonical, honest RGSS3 profile: every field pinned to the modelled
    /// transform stack and every required patch-back dependency declared
    /// satisfied.
    pub fn canonical() -> Self {
        Self {
            schema_version: RGSS3_PROFILE_SCHEMA_VERSION.to_string(),
            engine_family: RGSS3_ENGINE_FAMILY.to_string(),
            profile_id: "profile/rgss3/vx-ace/canonical".to_string(),
            container: ContainerTransform::Rgssad,
            container_magic: RGSSAD_MAGIC.to_vec(),
            archive_version: RGSS3_ARCHIVE_VERSION,
            crypto: CryptoTransform::Xor,
            crypto_scheme: Rgss3XorKeystreamScheme::rgss3(),
            codec: CodecTransform::RubyMarshal,
            marshal_major: RUBY_MARSHAL_VERSION.0,
            marshal_minor: RUBY_MARSHAL_VERSION.1,
            scripts_zlib_deflated: true,
            surface: SurfaceTransform::ArchiveEntry,
            patch_back: PatchBackTransform::RepackArchive,
            patch_back_dependencies: Rgss3PatchBackDependency::required()
                .into_iter()
                .map(|dependency| Rgss3PatchBackDependencyDecl {
                    dependency,
                    satisfied: true,
                })
                .collect(),
        }
    }
}

/// A structured profile-validation finding — typed, never a bare string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3ProfileFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub semantic_code: String,
    pub message: String,
}

impl Rgss3ProfileFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: self.code.clone(),
            severity: self.severity,
            field: self.field.clone(),
            semantic_code: self.semantic_code.clone(),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The profile-validation report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3ProfileReport {
    pub schema_version: String,
    pub engine_family: String,
    pub profile_id: String,
    pub status: OperationStatus,
    pub findings: Vec<Rgss3ProfileFinding>,
}

impl Rgss3ProfileReport {
    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        let redacted = Self {
            schema_version: self.schema_version.clone(),
            engine_family: self.engine_family.clone(),
            profile_id: redact_for_log_or_report(&self.profile_id),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(Rgss3ProfileFinding::redacted_for_report)
                .collect(),
        };
        stable_json(&redacted)
    }
}

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    semantic_code: SemanticErrorCode,
    message: String,
) -> Rgss3ProfileFinding {
    Rgss3ProfileFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        semantic_code: semantic_code.as_str().to_string(),
        message,
    }
}

/// Validate an RGSS3 layered-transform profile against the modelled transform
/// stack. Every inconsistency is a typed finding; a blocking finding flips the
/// report to `Failed`. Total and side-effect-free.
pub fn validate_rgss3_profile(profile: &Rgss3LayeredTransformProfile) -> Rgss3ProfileReport {
    let mut findings = Vec::new();

    if profile.engine_family != RGSS3_ENGINE_FAMILY {
        findings.push(finding(
            "rgss3.profile.wrong_engine_family",
            PartialDiagnosticSeverity::P0,
            "engineFamily",
            SemanticErrorCode::UnknownEngineVariant,
            format!(
                "engineFamily must be {RGSS3_ENGINE_FAMILY}, got {}",
                profile.engine_family
            ),
        ));
    }
    if profile.container != ContainerTransform::Rgssad {
        findings.push(finding(
            "rgss3.profile.wrong_container",
            PartialDiagnosticSeverity::P0,
            "container",
            SemanticErrorCode::MissingContainerCapability,
            format!(
                "RGSS3 container must be rgssad, got {:?}",
                profile.container
            ),
        ));
    }
    if profile.container_magic != RGSSAD_MAGIC {
        findings.push(finding(
            "rgss3.profile.wrong_magic",
            PartialDiagnosticSeverity::P0,
            "containerMagic",
            SemanticErrorCode::UnsupportedVariantPacked,
            "containerMagic must be the RGSSAD signature".to_string(),
        ));
    }
    if profile.archive_version != RGSS3_ARCHIVE_VERSION {
        findings.push(finding(
            "rgss3.profile.wrong_archive_version",
            PartialDiagnosticSeverity::P0,
            "archiveVersion",
            SemanticErrorCode::UnsupportedVariantPacked,
            format!(
                "VX Ace RGSSAD is version {RGSS3_ARCHIVE_VERSION}, got {}",
                profile.archive_version
            ),
        ));
    }
    if profile.crypto != CryptoTransform::Xor {
        findings.push(finding(
            "rgss3.profile.wrong_crypto",
            PartialDiagnosticSeverity::P0,
            "crypto",
            SemanticErrorCode::MissingCryptoCapability,
            format!("RGSS3 crypto must be xor, got {:?}", profile.crypto),
        ));
    }
    if profile.codec != CodecTransform::RubyMarshal {
        findings.push(finding(
            "rgss3.profile.wrong_codec",
            PartialDiagnosticSeverity::P0,
            "codec",
            SemanticErrorCode::MissingCodecCapability,
            format!("RGSS3 codec must be ruby_marshal, got {:?}", profile.codec),
        ));
    }
    if (profile.marshal_major, profile.marshal_minor) != RUBY_MARSHAL_VERSION {
        findings.push(finding(
            "rgss3.profile.wrong_marshal_version",
            PartialDiagnosticSeverity::P0,
            "marshalVersion",
            SemanticErrorCode::MissingCodecCapability,
            format!(
                "VX Ace Marshal is {}.{}, got {}.{}",
                RUBY_MARSHAL_VERSION.0,
                RUBY_MARSHAL_VERSION.1,
                profile.marshal_major,
                profile.marshal_minor
            ),
        ));
    }
    if profile.patch_back != PatchBackTransform::RepackArchive {
        findings.push(finding(
            "rgss3.profile.wrong_patch_back",
            PartialDiagnosticSeverity::P0,
            "patchBack",
            SemanticErrorCode::MissingPatchBackCapability,
            format!(
                "RGSS3 patch-back must be repack_archive, got {:?}",
                profile.patch_back
            ),
        ));
    }

    // Deliverable 3: every required patch-back dependency must be present AND
    // declared satisfied. A missing or unsatisfied one is a blocking finding.
    for required in Rgss3PatchBackDependency::required() {
        match profile
            .patch_back_dependencies
            .iter()
            .find(|decl| decl.dependency == required)
        {
            None => findings.push(finding(
                "rgss3.profile.patch_back_dependency_missing",
                PartialDiagnosticSeverity::P0,
                "patchBackDependencies",
                required.semantic_code(),
                format!(
                    "required patch-back dependency {} is not declared",
                    required.as_str()
                ),
            )),
            Some(decl) if !decl.satisfied => findings.push(finding(
                "rgss3.profile.patch_back_dependency_unsatisfied",
                PartialDiagnosticSeverity::P0,
                "patchBackDependencies",
                required.semantic_code(),
                format!(
                    "patch-back dependency {} is declared unsatisfied — repack would corrupt the archive",
                    required.as_str()
                ),
            )),
            Some(_) => {}
        }
    }

    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };
    Rgss3ProfileReport {
        schema_version: RGSS3_PROFILE_SCHEMA_VERSION.to_string(),
        engine_family: profile.engine_family.clone(),
        profile_id: profile.profile_id.clone(),
        status,
        findings,
    }
}
