//! RGSS3 / RGSSAD (RPG Maker VX Ace) layered-transform profile.
//! This module establishes the *tested transform boundaries* a production
//! RGSS3 adapter will later be built on. It is deliberately a PROFILE +
//! FIXTURE scaffold, not a full extraction/patching adapter: it pins the
//! RGSS3 transform stack as [layered-transform profile fields][`Rgss3LayeredTransformProfile`],
//! decodes a SYNTHETIC RGSSAD v3 archive structure and a SYNTHETIC Ruby
//! Marshal 4.8 blob to their structure (deterministically, no retail bytes),
//! and represents the binary-patcher patch-back risks as
//! [checked dependency constraints][`Rgss3PatchBackDependency`].
//! RGSS3 / VX Ace is its OWN engine family (`rgss3`) — distinct from RPG Maker
//! MV/MZ (`rpg_maker_mv_mz*`, JSON text + XOR-masked media). It shares only the
//! "RPG Maker" brand, not the container/codec/crypto:
//! | Layer | RGSS3 / VX Ace (this module) |
//! | container | RGSSAD archive (`.rgss3a`, magic `RGSSAD\0` v3) |
//! | crypto | per-file XOR keystream seeded from a base key |
//! | codec | Ruby Marshal 4.8 (`.rvdata2`); Scripts +zlib |
//! | surface | archive-entry / string table |
//! | patch-back | repack archive (reproduce keystream + offsets) |
//! The shared transform vocabulary already carries the tokens this family
//! needs ([`ContainerTransform::Rgssad`], [`CryptoTransform::Xor`],
//! [`CodecTransform::RubyMarshal`], [`PatchBackTransform::RepackArchive`]), and
//! the [`crate::packed_engine_readiness`] validator already checks a
//! `rgss3` readiness profile against those. This module goes one layer deeper:
//! it makes the RGSSAD keystream and the Ruby Marshal decode *executable and
//! tested* so the adapter starts from a real, proven boundary.
//! # Fidelity boundary (honest scoping)
//! The RGSSAD keystream constants and the Marshal subset modelled here are a
//! FAITHFUL-SHAPED synthetic scheme: the seed→key derivation, the per-file key,
//! and the advancing `k = k*7 + 3` keystream match the documented RGSSAD v3
//! shape, and the Marshal reader implements the real 4.8 integer/string/symbol/
//! array/hash/ivar grammar. Before a production adapter claims real-title
//! extraction, the exact constants MUST be validated against an oracle
//! (GARbro's `Rgssad` reader / rlvm) on real bytes — that validation is the
//! adapter's job, not this scaffold's. Everything here is exercised only on
//! bytes this module itself synthesises from known values.

use serde::{Deserialize, Serialize};

use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, OperationStatus,
    PartialDiagnosticSeverity, PatchBackTransform, SemanticErrorCode, SurfaceTransform,
    redact_for_log_or_report, stable_json,
};

/// Schema version of the RGSS3 profile record.
pub const RGSS3_PROFILE_SCHEMA_VERSION: &str = "0.1.0";

/// The canonical engine-family token for RPG Maker VX Ace / RGSS3.
pub const RGSS3_ENGINE_FAMILY: &str = "rgss3";

/// The RGSSAD archive signature: the 6 ASCII bytes `RGSSAD`, a `\0`, then the
/// version byte. VX Ace (`.rgss3a`) is version 3.
pub const RGSSAD_MAGIC: [u8; 7] = *b"RGSSAD\0";

/// The RGSSAD archive version RPG Maker VX Ace writes.
pub const RGSS3_ARCHIVE_VERSION: u8 = 3;

/// The Ruby Marshal format version VX Ace `.rvdata2` files carry (major.minor).
pub const RUBY_MARSHAL_VERSION: (u8, u8) = (4, 8);

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

// Deliverable 2 — Ruby Marshal 4.8 reader/writer over a bounded subset

/// A decoded Ruby Marshal value over the bounded subset VX Ace `.rvdata2`
/// structure needs: nil, booleans, `Fixnum`, byte strings, symbols, arrays,
/// and hashes. `IVAR`-wrapped strings (encoding metadata) and symbol back-links
/// are read transparently; the writer emits the canonical link-free form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarshalValue {
    Nil,
    Bool(bool),
    /// A Ruby `Fixnum` (the Marshal `long` encoding).
    Int(i64),
    /// A Ruby `String` — Marshal carries raw bytes; encoding is an ivar.
    ByteString(Vec<u8>),
    Symbol(String),
    Array(Vec<MarshalValue>),
    /// A Ruby `Hash`, preserving insertion order (Marshal is order-significant).
    Hash(Vec<(MarshalValue, MarshalValue)>),
}

impl MarshalValue {
    /// A lossy UTF-8 view of a byte string (VX Ace strings are UTF-8).
    pub fn as_str_lossy(&self) -> Option<String> {
        match self {
            Self::ByteString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }
}

/// A typed Marshal decode error — never a panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarshalError {
    UnexpectedEof,
    BadVersion { major: u8, minor: u8 },
    UnsupportedType(u8),
    BadSymbolLink(i64),
    NonSymbolHashOrIvarKey,
}

impl std::fmt::Display for MarshalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEof => f.write_str("unexpected end of Marshal stream"),
            Self::BadVersion { major, minor } => {
                write!(f, "unsupported Marshal version {major}.{minor}")
            }
            Self::UnsupportedType(tag) => write!(f, "unsupported Marshal type tag 0x{tag:02x}"),
            Self::BadSymbolLink(index) => write!(f, "symbol back-link {index} out of range"),
            Self::NonSymbolHashOrIvarKey => {
                f.write_str("expected a symbol key in a hash or ivar block")
            }
        }
    }
}

impl std::error::Error for MarshalError {}

struct MarshalReader<'a> {
    bytes: &'a [u8],
    pos: usize,
    symbols: Vec<String>,
}

impl<'a> MarshalReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            pos: 0,
            symbols: Vec::new(),
        }
    }

    fn next_u8(&mut self) -> Result<u8, MarshalError> {
        let byte = *self
            .bytes
            .get(self.pos)
            .ok_or(MarshalError::UnexpectedEof)?;
        self.pos += 1;
        Ok(byte)
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], MarshalError> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or(MarshalError::UnexpectedEof)?;
        let slice = self
            .bytes
            .get(self.pos..end)
            .ok_or(MarshalError::UnexpectedEof)?;
        self.pos = end;
        Ok(slice)
    }

    /// The Marshal `long` integer encoding (also used for lengths + counts).
    fn read_long(&mut self) -> Result<i64, MarshalError> {
        let c = self.next_u8()? as i8;
        if c == 0 {
            return Ok(0);
        }
        if c > 0 {
            if c > 4 {
                return Ok(i64::from(c) - 5);
            }
            let mut value: i64 = 0;
            for i in 0..c as usize {
                value |= i64::from(self.next_u8()?) << (8 * i);
            }
            Ok(value)
        } else {
            if c < -4 {
                return Ok(i64::from(c) + 5);
            }
            let n = (-c) as usize;
            let mut value: i64 = -1;
            for i in 0..n {
                value &= !(0xffi64 << (8 * i));
                value |= i64::from(self.next_u8()?) << (8 * i);
            }
            Ok(value)
        }
    }

    fn read_byte_seq(&mut self) -> Result<Vec<u8>, MarshalError> {
        let len = self.read_long()?;
        let len = usize::try_from(len).map_err(|_| MarshalError::UnexpectedEof)?;
        Ok(self.take(len)?.to_vec())
    }

    fn read_symbol_define(&mut self) -> Result<String, MarshalError> {
        let bytes = self.read_byte_seq()?;
        let symbol = String::from_utf8_lossy(&bytes).into_owned();
        self.symbols.push(symbol.clone());
        Ok(symbol)
    }

    fn read_value(&mut self) -> Result<MarshalValue, MarshalError> {
        let tag = self.next_u8()?;
        match tag {
            b'0' => Ok(MarshalValue::Nil),
            b'T' => Ok(MarshalValue::Bool(true)),
            b'F' => Ok(MarshalValue::Bool(false)),
            b'i' => Ok(MarshalValue::Int(self.read_long()?)),
            b'"' => Ok(MarshalValue::ByteString(self.read_byte_seq()?)),
            b':' => Ok(MarshalValue::Symbol(self.read_symbol_define()?)),
            b';' => {
                let index = self.read_long()?;
                let symbol = usize::try_from(index)
                    .ok()
                    .and_then(|i| self.symbols.get(i).cloned())
                    .ok_or(MarshalError::BadSymbolLink(index))?;
                Ok(MarshalValue::Symbol(symbol))
            }
            b'[' => {
                let count = self.read_long()?;
                let count = usize::try_from(count).map_err(|_| MarshalError::UnexpectedEof)?;
                let mut items = Vec::with_capacity(count);
                for _ in 0..count {
                    items.push(self.read_value()?);
                }
                Ok(MarshalValue::Array(items))
            }
            b'{' => {
                let count = self.read_long()?;
                let count = usize::try_from(count).map_err(|_| MarshalError::UnexpectedEof)?;
                let mut pairs = Vec::with_capacity(count);
                for _ in 0..count {
                    let key = self.read_value()?;
                    let value = self.read_value()?;
                    pairs.push((key, value));
                }
                Ok(MarshalValue::Hash(pairs))
            }
            // IVAR wrapper: an object followed by its instance variables. VX Ace
            // strings carry an `:E`/`:encoding` ivar. Decode the inner object,
            // then transparently consume (and discard) the ivar block.
            b'I' => {
                let inner = self.read_value()?;
                let ivar_count = self.read_long()?;
                let ivar_count =
                    usize::try_from(ivar_count).map_err(|_| MarshalError::UnexpectedEof)?;
                for _ in 0..ivar_count {
                    // Key must be a symbol; value is discarded.
                    match self.read_value()? {
                        MarshalValue::Symbol(_) => {}
                        _ => return Err(MarshalError::NonSymbolHashOrIvarKey),
                    }
                    let _ = self.read_value()?;
                }
                Ok(inner)
            }
            other => Err(MarshalError::UnsupportedType(other)),
        }
    }
}

/// Decode a full Ruby Marshal 4.8 stream (with the `\x04\x08` header) into its
/// structure. Bounded to the VX Ace `.rvdata2` subset; unsupported type tags
/// are a typed error, never a panic.
pub fn read_marshal(bytes: &[u8]) -> Result<MarshalValue, MarshalError> {
    let mut reader = MarshalReader::new(bytes);
    let major = reader.next_u8()?;
    let minor = reader.next_u8()?;
    if (major, minor) != RUBY_MARSHAL_VERSION {
        return Err(MarshalError::BadVersion { major, minor });
    }
    reader.read_value()
}

/// Append the Marshal `long` encoding of `n`.
fn write_long(n: i64, out: &mut Vec<u8>) {
    if n == 0 {
        out.push(0);
        return;
    }
    if n > 0 {
        if n <= 122 {
            out.push((n + 5) as u8);
            return;
        }
        let mut buf = Vec::new();
        let mut value = n as u64;
        while value > 0 {
            buf.push((value & 0xff) as u8);
            value >>= 8;
        }
        out.push(buf.len() as u8);
        out.extend_from_slice(&buf);
    } else {
        if n >= -123 {
            out.push((n - 5) as i8 as u8);
            return;
        }
        let mut buf = Vec::new();
        let mut value = n;
        loop {
            let byte = (value & 0xff) as u8;
            buf.push(byte);
            value >>= 8; // arithmetic shift preserves sign
            if value == -1 && (byte & 0x80) != 0 {
                break;
            }
        }
        out.push((-(buf.len() as i64)) as i8 as u8);
        out.extend_from_slice(&buf);
    }
}

fn write_value(value: &MarshalValue, out: &mut Vec<u8>) {
    match value {
        MarshalValue::Nil => out.push(b'0'),
        MarshalValue::Bool(true) => out.push(b'T'),
        MarshalValue::Bool(false) => out.push(b'F'),
        MarshalValue::Int(n) => {
            out.push(b'i');
            write_long(*n, out);
        }
        MarshalValue::ByteString(bytes) => {
            out.push(b'"');
            write_long(bytes.len() as i64, out);
            out.extend_from_slice(bytes);
        }
        MarshalValue::Symbol(name) => {
            out.push(b':');
            write_long(name.len() as i64, out);
            out.extend_from_slice(name.as_bytes());
        }
        MarshalValue::Array(items) => {
            out.push(b'[');
            write_long(items.len() as i64, out);
            for item in items {
                write_value(item, out);
            }
        }
        MarshalValue::Hash(pairs) => {
            out.push(b'{');
            write_long(pairs.len() as i64, out);
            for (key, val) in pairs {
                write_value(key, out);
                write_value(val, out);
            }
        }
    }
}

/// Encode a value to a canonical Ruby Marshal 4.8 stream (link-free: symbols
/// are written in full each time, no ivar wrappers). For a value that was
/// itself decoded from a canonical stream, this is the inverse of
/// [`read_marshal`] — the structure-preservation guarantee the
/// [`Rgss3PatchBackDependency::MarshalStructurePreserved`] dependency depends on.
pub fn write_marshal(value: &MarshalValue) -> Vec<u8> {
    let mut out = vec![RUBY_MARSHAL_VERSION.0, RUBY_MARSHAL_VERSION.1];
    write_value(value, &mut out);
    out
}

/// Build a SYNTHETIC `.rvdata2`-shaped Marshal blob from KNOWN values: an array
/// modelling a VX Ace `System`-style record — an id, a title string, a symbol
/// tag, and a nested hash mapping a symbol to a string. No retail bytes.
pub fn synthetic_rvdata2_value() -> MarshalValue {
    MarshalValue::Array(vec![
        MarshalValue::Int(3),
        MarshalValue::ByteString(b"synthetic game title".to_vec()),
        MarshalValue::Symbol("vx_ace".to_string()),
        MarshalValue::Hash(vec![
            (
                MarshalValue::Symbol("greeting".to_string()),
                MarshalValue::ByteString("hello world".as_bytes().to_vec()),
            ),
            (
                MarshalValue::Symbol("enabled".to_string()),
                MarshalValue::Bool(true),
            ),
            (
                MarshalValue::Symbol("nothing".to_string()),
                MarshalValue::Nil,
            ),
        ]),
    ])
}

// Deliverable 1/3 support — SYNTHETIC RGSSAD v3 archive structure

/// One decoded RGSSAD directory entry + its decrypted payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgssadEntry {
    pub name: String,
    pub payload: Vec<u8>,
}

/// A typed RGSSAD decode error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RgssadError {
    BadMagic,
    BadVersion(u8),
    UnexpectedEof,
}

impl std::fmt::Display for RgssadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadMagic => f.write_str("not an RGSSAD archive"),
            Self::BadVersion(v) => write!(f, "unsupported RGSSAD version {v}"),
            Self::UnexpectedEof => f.write_str("unexpected end of RGSSAD archive"),
        }
    }
}

impl std::error::Error for RgssadError {}

/// XOR a data payload against the advancing per-file keystream (word-wise, LE),
/// starting from `file_key`. Self-inverse, so the same routine encrypts and
/// decrypts.
fn rgssad_xor_payload(scheme: Rgss3XorKeystreamScheme, file_key: u32, data: &mut [u8]) {
    let mut key = file_key;
    for chunk in data.chunks_mut(4) {
        let key_bytes = key.to_le_bytes();
        for (byte, key_byte) in chunk.iter_mut().zip(key_bytes.iter()) {
            *byte ^= key_byte;
        }
        key = scheme.advance(key);
    }
}

/// Build a SYNTHETIC RGSSAD v3 (`.rgss3a`) archive from KNOWN entries: header
/// (`RGSSAD\0` + version 3 + seed), a directory of XOR-obfuscated entries, and
/// per-file XOR-keystream-encrypted payloads. Deterministic; no retail bytes.
pub fn build_synthetic_rgss3a(
    scheme: Rgss3XorKeystreamScheme,
    seed: u32,
    entries: &[(&str, &[u8])],
) -> Vec<u8> {
    let base_key = scheme.base_key(seed);

    // Directory record size: offset+size+file_key+name_len (4 u32) + name bytes.
    let mut dir_size = 0usize;
    for (name, _) in entries {
        dir_size += 16 + name.len();
    }
    // Header (7 magic + 1 version + 4 seed) + directory + terminator (one u32).
    let data_start = 8 + 4 + dir_size + 4;

    let mut out = Vec::new();
    out.extend_from_slice(&RGSSAD_MAGIC);
    out.push(RGSS3_ARCHIVE_VERSION);
    out.extend_from_slice(&seed.to_le_bytes());

    // Assign a distinct per-file key + running offset to each entry.
    let mut offset = data_start as u32;
    let mut file_keys = Vec::with_capacity(entries.len());
    let mut offsets = Vec::with_capacity(entries.len());
    for (index, (_, payload)) in entries.iter().enumerate() {
        let file_key = base_key
            .wrapping_add((index as u32).wrapping_mul(0x0100_0193))
            .wrapping_add(1);
        file_keys.push(file_key);
        offsets.push(offset);
        offset = offset.wrapping_add(payload.len() as u32);
    }

    // Write the directory (each u32 + the name bytes XOR the base key).
    let push_masked_u32 = |out: &mut Vec<u8>, value: u32| {
        out.extend_from_slice(&(value ^ base_key).to_le_bytes());
    };
    for (index, (name, _)) in entries.iter().enumerate() {
        push_masked_u32(&mut out, offsets[index]);
        push_masked_u32(&mut out, entries[index].1.len() as u32);
        push_masked_u32(&mut out, file_keys[index]);
        push_masked_u32(&mut out, name.len() as u32);
        let key_bytes = base_key.to_le_bytes();
        for (i, byte) in name.as_bytes().iter().enumerate() {
            out.push(byte ^ key_bytes[i % 4]);
        }
    }
    // Terminator: an offset of 0 marks end-of-directory (masked).
    push_masked_u32(&mut out, 0);

    // Write each encrypted payload at its offset (they are contiguous here).
    for (index, (_, payload)) in entries.iter().enumerate() {
        let mut data = payload.to_vec();
        rgssad_xor_payload(scheme, file_keys[index], &mut data);
        debug_assert_eq!(out.len(), offsets[index] as usize);
        out.extend_from_slice(&data);
    }
    out
}

/// Decode a SYNTHETIC RGSSAD v3 archive built by [`build_synthetic_rgss3a`]
/// back into its directory + decrypted payloads. Typed errors, never a panic.
pub fn decode_synthetic_rgss3a(
    scheme: Rgss3XorKeystreamScheme,
    bytes: &[u8],
) -> Result<Vec<RgssadEntry>, RgssadError> {
    if bytes.len() < 8 || bytes[0..7] != RGSSAD_MAGIC {
        return Err(RgssadError::BadMagic);
    }
    let version = bytes[7];
    if version != RGSS3_ARCHIVE_VERSION {
        return Err(RgssadError::BadVersion(version));
    }
    let read_u32 = |bytes: &[u8], at: usize| -> Result<u32, RgssadError> {
        let slice = bytes.get(at..at + 4).ok_or(RgssadError::UnexpectedEof)?;
        Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    };

    let seed = read_u32(bytes, 8)?;
    let base_key = scheme.base_key(seed);
    let key_bytes = base_key.to_le_bytes();

    let mut pos = 12;
    let mut records = Vec::new();
    loop {
        let offset = read_u32(bytes, pos)? ^ base_key;
        pos += 4;
        if offset == 0 {
            break;
        }
        let size = read_u32(bytes, pos)? ^ base_key;
        pos += 4;
        let file_key = read_u32(bytes, pos)? ^ base_key;
        pos += 4;
        let name_len = (read_u32(bytes, pos)? ^ base_key) as usize;
        pos += 4;
        let name_raw = bytes
            .get(pos..pos + name_len)
            .ok_or(RgssadError::UnexpectedEof)?;
        let name: String = name_raw
            .iter()
            .enumerate()
            .map(|(i, byte)| (byte ^ key_bytes[i % 4]) as char)
            .collect();
        pos += name_len;
        records.push((name, offset as usize, size as usize, file_key));
    }

    let mut entries = Vec::with_capacity(records.len());
    for (name, offset, size, file_key) in records {
        let mut payload = bytes
            .get(offset..offset + size)
            .ok_or(RgssadError::UnexpectedEof)?
            .to_vec();
        rgssad_xor_payload(scheme, file_key, &mut payload);
        entries.push(RgssadEntry { name, payload });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_profile_validates_green() {
        let profile = Rgss3LayeredTransformProfile::canonical();
        let report = validate_rgss3_profile(&profile);
        assert!(report.is_ok(), "{report:#?}");
        assert!(report.findings.is_empty());
        // The engine family token is the canonical `rgss3`, distinct from MV/MZ.
        assert_eq!(profile.engine_family, "rgss3");
        assert_ne!(profile.engine_family, "rpg_maker_mv_mz");
        // Layered transform fields are pinned to the RGSS3 stack.
        assert_eq!(profile.container, ContainerTransform::Rgssad);
        assert_eq!(profile.crypto, CryptoTransform::Xor);
        assert_eq!(profile.codec, CodecTransform::RubyMarshal);
        assert_eq!(profile.surface, SurfaceTransform::ArchiveEntry);
        assert_eq!(profile.patch_back, PatchBackTransform::RepackArchive);
    }

    #[test]
    fn profile_round_trips_through_json() {
        let profile = Rgss3LayeredTransformProfile::canonical();
        let json = serde_json::to_string(&profile).expect("serialize");
        let back: Rgss3LayeredTransformProfile = serde_json::from_str(&json).expect("round trip");
        assert_eq!(profile, back);
    }

    #[test]
    fn wrong_codec_is_a_typed_finding() {
        let mut profile = Rgss3LayeredTransformProfile::canonical();
        profile.codec = CodecTransform::JsonText;
        let report = validate_rgss3_profile(&profile);
        assert_eq!(report.status, OperationStatus::Failed);
        let finding = report
            .findings
            .iter()
            .find(|f| f.code == "rgss3.profile.wrong_codec")
            .expect("codec finding");
        assert_eq!(
            finding.semantic_code,
            SemanticErrorCode::MissingCodecCapability.as_str()
        );
        assert!(finding.severity.is_blocking());
    }

    #[test]
    fn every_required_patch_back_dependency_is_declared() {
        let profile = Rgss3LayeredTransformProfile::canonical();
        for required in Rgss3PatchBackDependency::required() {
            assert!(
                profile
                    .patch_back_dependencies
                    .iter()
                    .any(|d| d.dependency == required && d.satisfied),
                "missing satisfied dependency {}",
                required.as_str()
            );
        }
    }

    #[test]
    fn missing_patch_back_dependency_fails() {
        let mut profile = Rgss3LayeredTransformProfile::canonical();
        profile
            .patch_back_dependencies
            .retain(|d| d.dependency != Rgss3PatchBackDependency::XorKeystreamReproduced);
        let report = validate_rgss3_profile(&profile);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.code == "rgss3.profile.patch_back_dependency_missing")
        );
    }

    #[test]
    fn unsatisfied_patch_back_dependency_fails() {
        let mut profile = Rgss3LayeredTransformProfile::canonical();
        for decl in &mut profile.patch_back_dependencies {
            if decl.dependency == Rgss3PatchBackDependency::MarshalStructurePreserved {
                decl.satisfied = false;
            }
        }
        let report = validate_rgss3_profile(&profile);
        assert_eq!(report.status, OperationStatus::Failed);
        let finding = report
            .findings
            .iter()
            .find(|f| f.code == "rgss3.profile.patch_back_dependency_unsatisfied")
            .expect("unsatisfied finding");
        assert_eq!(
            finding.semantic_code,
            SemanticErrorCode::MissingCodecCapability.as_str()
        );
    }

    #[test]
    fn report_stable_json_redacts_and_serializes() {
        let mut profile = Rgss3LayeredTransformProfile::canonical();
        profile.profile_id = "/home/trevor/private/leak.rgss3a".to_string();
        profile.codec = CodecTransform::Unknown;
        let report = validate_rgss3_profile(&profile);
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        assert!(!json.contains("/home/trevor/private/leak.rgss3a"));
    }

    #[test]
    fn marshal_long_matches_known_ruby_encodings() {
        // Known Marshal `long` encodings (verified against Ruby's Marshal.dump).
        for (value, expected) in [
            (0i64, vec![0x00u8]),
            (1, vec![0x06]),
            (122, vec![0x7f]),
            (123, vec![0x01, 0x7b]),
            (256, vec![0x02, 0x00, 0x01]),
            (-1, vec![0xfa]),
            (-123, vec![0x80]),
            (-124, vec![0xff, 0x84]),
        ] {
            let mut out = Vec::new();
            write_long(value, &mut out);
            assert_eq!(out, expected, "encoding of {value}");
            // And the reader inverts the writer.
            let mut reader = MarshalReader::new(&out);
            assert_eq!(reader.read_long().unwrap(), value, "decoding of {value}");
        }
    }

    #[test]
    fn synthetic_marshal_blob_decodes_to_its_structure() {
        let value = synthetic_rvdata2_value();
        let blob = write_marshal(&value);
        // The blob carries the real Marshal 4.8 header.
        assert_eq!(&blob[0..2], &[0x04, 0x08]);

        let decoded = read_marshal(&blob).expect("decode");
        assert_eq!(decoded, value);

        // Spot-check the decoded structure matches the KNOWN values.
        let MarshalValue::Array(items) = &decoded else {
            panic!("expected top-level array");
        };
        assert_eq!(items[0], MarshalValue::Int(3));
        assert_eq!(
            items[1].as_str_lossy().as_deref(),
            Some("synthetic game title")
        );
        assert_eq!(items[2], MarshalValue::Symbol("vx_ace".to_string()));
        let MarshalValue::Hash(pairs) = &items[3] else {
            panic!("expected nested hash");
        };
        assert_eq!(pairs[0].0, MarshalValue::Symbol("greeting".to_string()));
        assert_eq!(pairs[0].1.as_str_lossy().as_deref(), Some("hello world"));
        assert_eq!(pairs[2].1, MarshalValue::Nil);
    }

    #[test]
    fn marshal_write_read_is_structure_preserving() {
        // The MarshalStructurePreserved patch-back dependency: encode(decode(x))
        // is byte-identical for a canonical stream. This is the executable proof
        // behind the profile's patch-back constraint.
        let blob = write_marshal(&synthetic_rvdata2_value());
        let decoded = read_marshal(&blob).expect("decode");
        let reencoded = write_marshal(&decoded);
        assert_eq!(
            blob, reencoded,
            "re-serialised Marshal must be byte-identical"
        );
    }

    #[test]
    fn marshal_reads_ivar_wrapped_string_transparently() {
        // A hand-built IVAR-wrapped string as real VX Ace writes it:
        // I "hi" <ivar_count=1>:E T (encoding = UTF-8)
        let mut blob = vec![0x04u8, 0x08];
        blob.push(b'I');
        blob.push(b'"');
        write_long(2, &mut blob);
        blob.extend_from_slice(b"hi");
        write_long(1, &mut blob); // one ivar
        blob.push(b':');
        write_long(1, &mut blob);
        blob.push(b'E');
        blob.push(b'T'); // true = UTF-8

        let decoded = read_marshal(&blob).expect("decode ivar string");
        assert_eq!(decoded, MarshalValue::ByteString(b"hi".to_vec()));
    }

    #[test]
    fn marshal_symbol_backlink_resolves() {
        // Two symbols where the second is a back-link (`;`) to the first —
        // exactly how Ruby dedups repeated symbol keys.
        let mut blob = vec![0x04u8, 0x08];
        blob.push(b'[');
        write_long(2, &mut blob);
        blob.push(b':'); // define symbol 0
        write_long(3, &mut blob);
        blob.extend_from_slice(b"tag");
        blob.push(b';'); // link to symbol 0
        write_long(0, &mut blob);

        let decoded = read_marshal(&blob).expect("decode symlink");
        assert_eq!(
            decoded,
            MarshalValue::Array(vec![
                MarshalValue::Symbol("tag".to_string()),
                MarshalValue::Symbol("tag".to_string()),
            ])
        );
    }

    #[test]
    fn marshal_errors_are_typed_not_panics() {
        assert_eq!(read_marshal(&[]).unwrap_err(), MarshalError::UnexpectedEof);
        assert_eq!(
            read_marshal(&[0x04, 0x07, b'0']).unwrap_err(),
            MarshalError::BadVersion { major: 4, minor: 7 }
        );
        // 'c' (class) is outside the supported subset → typed error.
        assert_eq!(
            read_marshal(&[0x04, 0x08, b'c']).unwrap_err(),
            MarshalError::UnsupportedType(b'c')
        );
    }

    #[test]
    fn synthetic_rgss3a_round_trips() {
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        // One payload is itself a Marshal blob (a real `.rvdata2` shape).
        let marshal_payload = write_marshal(&synthetic_rvdata2_value());
        let entries: Vec<(&str, &[u8])> = vec![
            ("Data/System.rvdata2", marshal_payload.as_slice()),
            (
                "Data/Map001.rvdata2",
                b"synthetic map bytes \x00\x01\x02\x03\x04",
            ),
        ];
        let archive = build_synthetic_rgss3a(scheme, 0x1234_5678, &entries);

        // Header is the real RGSSAD signature + version 3.
        assert_eq!(&archive[0..7], &RGSSAD_MAGIC);
        assert_eq!(archive[7], RGSS3_ARCHIVE_VERSION);

        let decoded = decode_synthetic_rgss3a(scheme, &archive).expect("decode archive");
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].name, "Data/System.rvdata2");
        assert_eq!(decoded[0].payload, marshal_payload);
        assert_eq!(decoded[1].name, "Data/Map001.rvdata2");
        assert_eq!(
            decoded[1].payload,
            b"synthetic map bytes \x00\x01\x02\x03\x04"
        );

        // End-to-end: the extracted RGSSAD payload decodes as Marshal — the full
        // layered transform (container -> crypto -> codec) on synthetic bytes.
        let inner = read_marshal(&decoded[0].payload).expect("decode extracted marshal");
        assert_eq!(inner, synthetic_rvdata2_value());
    }

    #[test]
    fn rgss3a_payload_is_actually_obfuscated() {
        // The archive must not contain the plaintext payload verbatim — the XOR
        // keystream is really applied.
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        let plaintext = b"the quick brown fox jumps over the lazy dog!!";
        let archive = build_synthetic_rgss3a(scheme, 42, &[("a.rvdata2", plaintext)]);
        assert!(
            !archive.windows(plaintext.len()).any(|w| w == plaintext),
            "payload must be XOR-obfuscated in the archive"
        );
        let decoded = decode_synthetic_rgss3a(scheme, &archive).expect("decode");
        assert_eq!(decoded[0].payload, plaintext);
    }

    #[test]
    fn rgss3a_wrong_magic_is_typed_error() {
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        assert_eq!(
            decode_synthetic_rgss3a(scheme, b"NOTRGSS\x03....").unwrap_err(),
            RgssadError::BadMagic
        );
    }

    #[test]
    fn keystream_scheme_derivation_is_deterministic() {
        let scheme = Rgss3XorKeystreamScheme::rgss3();
        assert_eq!(scheme.base_key(0), 3);
        assert_eq!(scheme.base_key(1), 12);
        assert_eq!(scheme.advance(3), 24);
    }
}
