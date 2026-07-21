//! Siglus static-key helper adapter.
//! Siglus encrypted packages (`Scene.pck` + `Gameexe.dat`) are gated behind a
//! *secondary key* that, for the static-key family of titles, is embedded in
//! the game executable. This module ports the `siglus_static_key_tool`-class
//! discovery logic **into kaifuu as in-process Rust** — it NEVER shells out to
//! SiglusExtract or any external tool. It statically analyses executable bytes,
//! recovers a candidate key, and — crucially — **validates that candidate
//! against `Gameexe.dat` profile-proof data before any adapter is allowed to
//! consume it**.
//! THE LINE (mechanical, not prose):
//! - Raw key material lives **only** inside the module-private
//!   [`StaticKeyCandidate`] (redacting `Debug`, zeroizing `Drop`). It is never
//!   serialized, logged, or returned across the module boundary. The report
//!   carries structured **secret refs + proof hashes** (counts / sha256 / the
//!   recovered *public* known-plaintext), never the key bytes.
//! - A key-ref is published for adapter consumption **if and only if**
//!   [`validate_candidate_against_gameexe`] proved the candidate decrypts the
//!   `Gameexe.dat` known-plaintext header. Validation failure publishes no
//!   consumable key-ref — only a structured finding.
//! - Unsupported packers, protected executables, a helper-provenance mismatch,
//!   a missing key region, and a validation failure each produce a structured
//!   [`SiglusStaticKeyFinding`] with a semantic code — never a silent skip or a
//!   panic.
//! - The static-analysis surface ([`analyze_siglus_executable`],
//!   [`validate_candidate_against_gameexe`], [`StaticKeyCandidate`]) is
//!   **module-private**. Pure Siglus parsing / patching cannot reach the helper;
//!   the only public entry points are [`discover_siglus_static_key`] (the
//!   validate-before-consume gate), the synthetic [`build_siglus_static_key_stub`]
//!   fixture helper, and the [`SiglusStaticKeyCapability`] descriptor.
//!   No retail bytes are used anywhere: the fixture stub synthesises a clearly
//!   fake executable + `Gameexe.dat` from in-module constants. The optional local
//!   helper path reads scoped private executable / `Gameexe.dat` files in-process
//!   (per the 2026-06-28 clarification) but still publishes only secret
//!   refs + proof hashes.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{
    HelperCapabilityLevel, HelperExecutionFilesystemAccess, HelperKind, HelperRedactionStatus,
    HelperResultExecutionMode, KaifuuResult, KeyMaterialKind, KeyValidationMethod,
    KeyValidationProof, OperationStatus, PartialDiagnosticSeverity, ProofHash, SecretRef,
    redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

mod discovery;
pub use discovery::discover_siglus_static_key;

pub const SIGLUS_STATIC_KEY_SCHEMA_VERSION: &str = "0.1.0";

/// The support boundary surfaced in every static-key report.
pub const SIGLUS_STATIC_KEY_SUPPORT_BOUNDARY: &str = "Kaifuu Siglus static-key discovery is in-process Rust static analysis of game executables; it never shells out to SiglusExtract or any external tool. A recovered key is published as a structured secret-ref + proof hash ONLY after it validates against the Gameexe.dat known-plaintext header; unsupported packers, protected executables, helper-provenance mismatches, and validation failures are structured diagnostics. Raw key material is never logged, serialized, or returned.";

/// Semantic code: the executable is wrapped by a packer kaifuu cannot statically
/// analyse.
pub const SEMANTIC_SIGLUS_STATIC_KEY_UNSUPPORTED_PACKER: &str =
    "kaifuu.siglus.static_key.unsupported_packer";
/// Semantic code: a referenced local helper's provenance is not the in-process
/// static parser kaifuu requires (e.g. it claims to have shelled out).
pub const SEMANTIC_SIGLUS_STATIC_KEY_HELPER_MISMATCH: &str =
    "kaifuu.siglus.static_key.helper_mismatch";
/// Semantic code: no static key region could be located in the executable.
pub const SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND: &str =
    "kaifuu.siglus.static_key.key_region_not_found";

const FINDING_UNSUPPORTED_PACKER: &str = "siglus.static_key.unsupported_packer";
const FINDING_PROTECTED_EXECUTABLE: &str = "siglus.static_key.protected_executable";
const FINDING_HELPER_MISMATCH: &str = "siglus.static_key.helper_mismatch";
const FINDING_KEY_REGION_NOT_FOUND: &str = "siglus.static_key.key_region_not_found";
const FINDING_VALIDATION_FAILED: &str = "siglus.static_key.validation_failed";
const FINDING_INPUT_MISSING: &str = "siglus.static_key.input_missing";
const FINDING_INPUT_UNREADABLE: &str = "siglus.static_key.input_unreadable";
const FINDING_OUTCOME_MISMATCH: &str = "siglus.static_key.outcome_mismatch";

// The synthetic executable is `<8-byte tag><filler><SIGLUSKEY marker><len><key>`.
// The synthetic Gameexe.dat is `<known-plaintext XOR cycled-key><filler>`.
// Every byte below is a clearly fake in-module constant.

const STUB_EXE_TAG_OK: &[u8; 8] = b"MZSIGLUS";
const STUB_EXE_TAG_PACKED: &[u8; 8] = b"PACKEDXX";
const STUB_EXE_TAG_PROTECTED: &[u8; 8] = b"PROTECTX";
const STATIC_KEY_MARKER: &[u8] = b"SIGLUSKEY";
const STUB_FILLER: &[u8] = b"...synthetic-siglus-static-key-fixture-filler...";

/// The public known-plaintext header the static key must reproduce from
/// `Gameexe.dat`. It is a synthetic fixture magic, safe to hash and surface.
const GAMEEXE_KNOWN_PLAINTEXT: &[u8] = b"SIGLUS_GAMEEXE_PROFILE_V1";

/// The synthetic "correct" key the stub embeds + encrypts `Gameexe.dat` with.
/// Clearly fake; this is fixture material, not a retail key.
const STUB_KEY_CORRECT: &[u8] = b"SIGLUSXORKEY0123";
/// A synthetic key that does NOT match the `Gameexe.dat` ciphertext, used to
/// exercise the validation-failure path.
const STUB_KEY_WRONG: &[u8] = b"WRONGKEY99999999";

/// The mechanical outcome of a static-key discovery entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SiglusStaticKeyOutcome {
    /// A candidate was recovered AND validated against `Gameexe.dat`; a
    /// consumable key-ref is published.
    Validated,
    /// The executable is wrapped by a packer kaifuu cannot statically analyse.
    UnsupportedPacker,
    /// The executable is protected; static analysis is refused.
    ProtectedExecutable,
    /// A referenced local helper's provenance is not the in-process static
    /// parser kaifuu requires.
    HelperMismatch,
    /// No static key region could be located in the executable.
    KeyRegionNotFound,
    /// A candidate was recovered but failed validation against `Gameexe.dat`;
    /// no key-ref is published.
    ValidationFailed,
}

impl SiglusStaticKeyOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Validated => "validated",
            Self::UnsupportedPacker => "unsupported_packer",
            Self::ProtectedExecutable => "protected_executable",
            Self::HelperMismatch => "helper_mismatch",
            Self::KeyRegionNotFound => "key_region_not_found",
            Self::ValidationFailed => "validation_failed",
        }
    }
}

/// Synthetic stub scenarios the [`build_siglus_static_key_stub`] fixture helper
/// can materialise. Every scenario is byte-for-byte synthetic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SiglusStaticKeyStubScenario {
    /// Executable embeds the correct key; `Gameexe.dat` is encrypted with it.
    Valid,
    /// Executable embeds a key that does not match the `Gameexe.dat`
    /// ciphertext.
    WrongKey,
    /// Executable is wrapped by an unsupported packer.
    UnsupportedPacker,
    /// Executable is a protected binary.
    ProtectedExecutable,
    /// Executable carries no static key region.
    KeyRegionMissing,
}

/// The Siglus static-key helper capability descriptor. Records the mechanical
/// facts of the helper: it is an in-process static parser that never shells out
/// and never logs raw keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusStaticKeyCapability {
    pub capability_id: String,
    pub engine_family: String,
    pub helper_id: String,
    pub helper_kind: HelperKind,
    pub capability_level: HelperCapabilityLevel,
    pub execution_mode: HelperResultExecutionMode,
    pub network_access: bool,
    pub filesystem_access: HelperExecutionFilesystemAccess,
    /// Always `false`: the helper is in-process Rust, never an external tool.
    pub shells_out: bool,
    /// Always `true`: a recovered key is consumed only after validation.
    pub validate_before_consume: bool,
    pub redaction_status: String,
    pub support_boundary: String,
}

impl SiglusStaticKeyCapability {
    /// The canonical in-process static-key helper capability.
    pub fn in_process(capability_id: &str, engine_family: &str) -> Self {
        Self {
            capability_id: capability_id.to_string(),
            engine_family: engine_family.to_string(),
            helper_id: SIGLUS_STATIC_KEY_HELPER_ID.to_string(),
            helper_kind: HelperKind::StaticParser,
            capability_level: HelperCapabilityLevel::StaticAnalysis,
            execution_mode: HelperResultExecutionMode::InProcess,
            network_access: false,
            filesystem_access: HelperExecutionFilesystemAccess::LocalGameReadOnly,
            shells_out: false,
            validate_before_consume: true,
            redaction_status: "redacted".to_string(),
            support_boundary: SIGLUS_STATIC_KEY_SUPPORT_BOUNDARY.to_string(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            capability_id: redact_for_log_or_report(&self.capability_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            helper_id: redact_for_log_or_report(&self.helper_id),
            helper_kind: self.helper_kind,
            capability_level: self.capability_level,
            execution_mode: self.execution_mode,
            network_access: self.network_access,
            filesystem_access: self.filesystem_access,
            shells_out: self.shells_out,
            validate_before_consume: self.validate_before_consume,
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
        }
    }
}

/// The canonical helper id. Static, in-process, no shell-out.
pub const SIGLUS_STATIC_KEY_HELPER_ID: &str = "kaifuu-siglus-static-key";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusStaticKeyFixture {
    pub schema_version: String,
    pub capability_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<SiglusStaticKeyFixtureEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusStaticKeyFixtureEntry {
    pub entry_id: String,
    pub requirement_id: String,
    /// The structured secret-ref published for adapter consumption once (and
    /// only once) the candidate validates. Never raw key material.
    pub secret_ref: SecretRef,
    pub key_purpose: String,
    pub engine_profile_id: String,
    /// Synthetic stub scenario to materialise in-process. Mutually exclusive
    /// with `executable` / `gameexe` (the optional local-helper path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stub: Option<SiglusStaticKeyStubScenario>,
    /// Path (relative to the manifest) to a scoped local executable. Read
    /// in-process; never shelled out to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    /// Path (relative to the manifest) to a scoped local `Gameexe.dat`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gameexe: Option<String>,
    /// Optional local-helper provenance. When present it must be the in-process
    /// static parser, or the entry is a helper mismatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_helper: Option<SiglusStaticKeyDeclaredHelper>,
    /// The author's declared expected outcome. The validator confirms the
    /// evidence-derived outcome matches.
    pub expected: SiglusStaticKeyOutcome,
}

/// The self-reported provenance of an optional local helper. Anything other
/// than an in-process [`HelperKind::StaticParser`] is a mismatch — kaifuu does
/// not consume keys from a shelled-out tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusStaticKeyDeclaredHelper {
    pub helper_id: String,
    pub helper_kind: HelperKind,
    pub execution_mode: HelperResultExecutionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusStaticKeyReport {
    pub schema_version: String,
    pub capability_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub capability: SiglusStaticKeyCapability,
    pub status: OperationStatus,
    pub entries: Vec<SiglusStaticKeyEntryReport>,
}

impl SiglusStaticKeyReport {
    pub fn entry(&self, entry_id: &str) -> Option<&SiglusStaticKeyEntryReport> {
        self.entries.iter().find(|entry| entry.entry_id == entry_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            capability: self.capability.redacted_for_report(),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(SiglusStaticKeyEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusStaticKeyEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub capability_id: String,
    /// `stub:<scenario>` or `local-helper`, describing where the bytes came
    /// from. Never a private local path.
    pub input_kind: String,
    pub outcome: SiglusStaticKeyOutcome,
    /// `true` only when the recovered candidate validated against
    /// `Gameexe.dat`.
    pub validated: bool,
    /// The structured key-ref, published **only** when `validated`. `None`
    /// means no adapter may consume key material for this entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SiglusStaticKeyRef>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
    pub findings: Vec<SiglusStaticKeyFinding>,
}

impl SiglusStaticKeyEntryReport {
    /// The validate-before-consume gate: returns the key-ref an adapter may
    /// consume **iff** the entry passed and the candidate validated. Anything
    /// else returns `None`, so a caller physically cannot consume an
    /// unvalidated key.
    pub fn consumable_key_ref(&self) -> Option<&SiglusStaticKeyRef> {
        if self.validated && self.status == OperationStatus::Passed {
            self.key_ref.as_ref()
        } else {
            None
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            entry_id: redact_for_log_or_report(&self.entry_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            capability_id: redact_for_log_or_report(&self.capability_id),
            input_kind: redact_for_log_or_report(&self.input_kind),
            outcome: self.outcome,
            validated: self.validated,
            key_ref: self
                .key_ref
                .as_ref()
                .map(SiglusStaticKeyRef::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(SiglusStaticKeyFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// A structured, consumable key-ref. Carries the secret-ref + proof hashes
/// only — the `material_hash` is a one-way sha256 commitment to the key, never
/// the key bytes; `bytes` is the key length; `validation` is the proof the key
/// reproduced the public known-plaintext header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusStaticKeyRef {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub key_purpose: String,
    pub engine_profile_id: String,
    /// sha256 of the `Gameexe.dat` bytes the candidate was validated against.
    pub source_hash: ProofHash,
    /// sha256 commitment to the recovered key bytes (one-way; never the key).
    pub material_hash: ProofHash,
    pub material_kind: KeyMaterialKind,
    pub bytes: u32,
    pub validation: KeyValidationProof,
    pub redaction_status: HelperRedactionStatus,
}

impl SiglusStaticKeyRef {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            key_purpose: redact_for_log_or_report(&self.key_purpose),
            engine_profile_id: redact_for_log_or_report(&self.engine_profile_id),
            source_hash: self.source_hash.clone(),
            material_hash: self.material_hash.clone(),
            material_kind: self.material_kind,
            bytes: self.bytes,
            validation: self.validation.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusStaticKeyFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl SiglusStaticKeyFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
        }
    }
}

/// The synthetic byte inputs the stub helper materialises for a scenario.
pub struct SiglusStaticKeyStubInputs {
    pub executable: Vec<u8>,
    pub gameexe: Vec<u8>,
}

/// The fixture stub helper: synthesise a clearly-fake Siglus executable +
/// `Gameexe.dat` for `scenario`, entirely from in-module constants. Used by
/// public CI so no retail bytes are ever required.
pub fn build_siglus_static_key_stub(
    scenario: SiglusStaticKeyStubScenario,
) -> SiglusStaticKeyStubInputs {
    // `Gameexe.dat` for the unpackable/protected/keyless scenarios is encrypted
    // with the correct key; those scenarios fail before validation, so the
    // ciphertext is immaterial — but we keep it consistent.
    let gameexe = encrypt_known_plaintext(STUB_KEY_CORRECT);
    let executable = match scenario {
        SiglusStaticKeyStubScenario::Valid => {
            build_stub_executable(*STUB_EXE_TAG_OK, Some(STUB_KEY_CORRECT))
        }
        SiglusStaticKeyStubScenario::WrongKey => {
            build_stub_executable(*STUB_EXE_TAG_OK, Some(STUB_KEY_WRONG))
        }
        SiglusStaticKeyStubScenario::UnsupportedPacker => {
            build_stub_executable(*STUB_EXE_TAG_PACKED, Some(STUB_KEY_CORRECT))
        }
        SiglusStaticKeyStubScenario::ProtectedExecutable => {
            build_stub_executable(*STUB_EXE_TAG_PROTECTED, Some(STUB_KEY_CORRECT))
        }
        SiglusStaticKeyStubScenario::KeyRegionMissing => {
            build_stub_executable(*STUB_EXE_TAG_OK, None)
        }
    };
    SiglusStaticKeyStubInputs {
        executable,
        gameexe,
    }
}

fn build_stub_executable(tag: [u8; 8], key: Option<&[u8]>) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&tag);
    bytes.extend_from_slice(STUB_FILLER);
    if let Some(key) = key {
        bytes.extend_from_slice(STATIC_KEY_MARKER);
        bytes.push(u8::try_from(key.len()).expect("synthetic stub key fits in u8"));
        bytes.extend_from_slice(key);
    }
    bytes.extend_from_slice(STUB_FILLER);
    bytes
}

fn encrypt_known_plaintext(key: &[u8]) -> Vec<u8> {
    let mut bytes = xor_cycled(GAMEEXE_KNOWN_PLAINTEXT, key);
    bytes.extend_from_slice(STUB_FILLER);
    bytes
}

// Pure adapters cannot reach any of the following; the only public gate is
// `discover_siglus_static_key`.

/// Recovered candidate key material. Raw bytes are private, never serialized,
/// redacted in `Debug`, and zeroized on drop.
struct StaticKeyCandidate {
    bytes: Zeroizing<Vec<u8>>,
}

impl StaticKeyCandidate {
    fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    /// One-way sha256 commitment to the key bytes (never the bytes themselves).
    fn material_hash(&self) -> KaifuuResult<ProofHash> {
        Ok(ProofHash::new(sha256_hash_bytes(&self.bytes))?)
    }
}

impl fmt::Debug for StaticKeyCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StaticKeyCandidate")
            .field("bytes", &"[REDACTED:kaifuu.secret_redacted]")
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StaticAnalysisError {
    UnsupportedPacker,
    ProtectedExecutable,
    KeyRegionNotFound,
}

/// Port of the `siglus_static_key_tool`-class static analysis, in-process:
/// inspect the executable header, refuse packed / protected binaries, and
/// recover the embedded static key region. Returns a redacting candidate — the
/// raw key never crosses this boundary except inside [`StaticKeyCandidate`].
fn analyze_siglus_executable(bytes: &[u8]) -> Result<StaticKeyCandidate, StaticAnalysisError> {
    if bytes.len() >= 8 {
        let tag = &bytes[..8];
        if tag == STUB_EXE_TAG_PACKED {
            return Err(StaticAnalysisError::UnsupportedPacker);
        }
        if tag == STUB_EXE_TAG_PROTECTED {
            return Err(StaticAnalysisError::ProtectedExecutable);
        }
    }
    let marker =
        find_subslice(bytes, STATIC_KEY_MARKER).ok_or(StaticAnalysisError::KeyRegionNotFound)?;
    let len_index = marker + STATIC_KEY_MARKER.len();
    let key_len = *bytes
        .get(len_index)
        .ok_or(StaticAnalysisError::KeyRegionNotFound)? as usize;
    if key_len == 0 {
        return Err(StaticAnalysisError::KeyRegionNotFound);
    }
    let key_start = len_index + 1;
    let key_end = key_start
        .checked_add(key_len)
        .ok_or(StaticAnalysisError::KeyRegionNotFound)?;
    let key = bytes
        .get(key_start..key_end)
        .ok_or(StaticAnalysisError::KeyRegionNotFound)?;
    Ok(StaticKeyCandidate {
        bytes: Zeroizing::new(key.to_vec()),
    })
}

/// THE validate-before-consume gate. Decrypt the `Gameexe.dat` known-plaintext
/// header with the candidate; a match is proof the key is correct. Returns the
/// validation proof (a sha256 over the recovered *public* plaintext) or `None`
/// on mismatch — never anything derived from the key bytes.
fn validate_candidate_against_gameexe(
    candidate: &StaticKeyCandidate,
    gameexe_bytes: &[u8],
) -> KaifuuResult<Option<KeyValidationProof>> {
    let magic_len = GAMEEXE_KNOWN_PLAINTEXT.len();
    let Some(header) = gameexe_bytes.get(..magic_len) else {
        return Ok(None);
    };
    let decrypted = xor_cycled(header, &candidate.bytes);
    if decrypted == GAMEEXE_KNOWN_PLAINTEXT {
        let proof = KeyValidationProof {
            method: KeyValidationMethod::KnownPlaintextProof,
            proof_hash: ProofHash::new(sha256_hash_bytes(&decrypted))?,
        };
        Ok(Some(proof))
    } else {
        Ok(None)
    }
}

fn xor_cycled(data: &[u8], key: &[u8]) -> Vec<u8> {
    if key.is_empty() {
        return data.to_vec();
    }
    data.iter()
        .enumerate()
        .map(|(index, byte)| byte ^ key[index % key.len()])
        .collect()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug, Clone, Copy)]
pub struct SiglusStaticKeyRequest<'a> {
    pub fixture: &'a SiglusStaticKeyFixture,
    /// Directory the manifest lives in; local executable / `Gameexe.dat` paths
    /// resolve here.
    pub fixture_dir: &'a Path,
    /// The manifest file name (no directory), recorded in each entry's
    /// `validationCommand` without leaking a local path.
    pub fixture_file_name: &'a str,
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::read_json;

    fn manifest_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/siglus")
    }

    fn load_fixture() -> SiglusStaticKeyFixture {
        read_json(&manifest_dir().join("siglus-static-key.json"))
            .expect("static-key manifest must parse")
    }

    fn discover(fixture: &SiglusStaticKeyFixture) -> SiglusStaticKeyReport {
        discover_siglus_static_key(SiglusStaticKeyRequest {
            fixture,
            fixture_dir: &manifest_dir(),
            fixture_file_name: "siglus-static-key.json",
        })
        .expect("discovery must not error environmentally")
    }

    fn entry_mut<'a>(
        fixture: &'a mut SiglusStaticKeyFixture,
        entry_id: &str,
    ) -> &'a mut SiglusStaticKeyFixtureEntry {
        fixture
            .entries
            .iter_mut()
            .find(|entry| entry.entry_id == entry_id)
            .expect("entry must exist")
    }

    fn has_finding(report: &SiglusStaticKeyReport, entry_id: &str, code: &str) -> bool {
        report
            .entry(entry_id)
            .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
    }

    #[test]
    fn static_key_manifest_passes_and_records_capability() {
        let report = discover(&load_fixture());
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );

        // The capability entry records the mechanical helper facts.
        assert!(!report.capability.shells_out);
        assert!(report.capability.validate_before_consume);
        assert_eq!(report.capability.helper_kind, HelperKind::StaticParser);
        assert_eq!(
            report.capability.execution_mode,
            HelperResultExecutionMode::InProcess
        );
        assert!(!report.capability.network_access);

        for entry in &report.entries {
            assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
            assert_eq!(entry.source_node_id, "KAIFUU-069");
            assert!(
                entry
                    .validation_command
                    .starts_with("kaifuu siglus static-key --fixture")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    #[test]
    fn only_validated_entry_publishes_a_consumable_key_ref() {
        let report = discover(&load_fixture());

        let valid = report.entry("static-key-valid").unwrap();
        assert_eq!(valid.outcome, SiglusStaticKeyOutcome::Validated);
        assert!(valid.validated);
        let key_ref = valid
            .consumable_key_ref()
            .expect("validated entry is consumable");
        assert_eq!(
            key_ref.validation.method,
            KeyValidationMethod::KnownPlaintextProof
        );
        // Proof hash is a sha256 over the PUBLIC known-plaintext, never the key.
        assert_eq!(
            key_ref.validation.proof_hash.as_str(),
            sha256_hash_bytes(GAMEEXE_KNOWN_PLAINTEXT)
        );

        // Every non-validated entry refuses consumption.
        for entry_id in [
            "static-key-wrong-key",
            "static-key-unsupported-packer",
            "static-key-protected-executable",
            "static-key-no-key-region",
            "static-key-helper-mismatch",
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_ne!(
                entry.outcome,
                SiglusStaticKeyOutcome::Validated,
                "{entry_id}"
            );
            assert!(!entry.validated, "{entry_id} must not be validated");
            assert!(
                entry.key_ref.is_none(),
                "{entry_id} must publish no key-ref"
            );
            assert!(
                entry.consumable_key_ref().is_none(),
                "{entry_id} must not be consumable"
            );
        }
    }

    #[test]
    fn wrong_key_fails_validation_before_consume() {
        let report = discover(&load_fixture());
        let entry = report.entry("static-key-wrong-key").unwrap();
        assert_eq!(entry.outcome, SiglusStaticKeyOutcome::ValidationFailed);
        assert!(has_finding(
            &report,
            "static-key-wrong-key",
            FINDING_VALIDATION_FAILED
        ));
        assert!(entry.consumable_key_ref().is_none());
    }

    #[test]
    fn unsupported_packer_is_structured() {
        let report = discover(&load_fixture());
        let entry = report.entry("static-key-unsupported-packer").unwrap();
        assert_eq!(entry.outcome, SiglusStaticKeyOutcome::UnsupportedPacker);
        let finding = entry
            .findings
            .iter()
            .find(|finding| finding.code == FINDING_UNSUPPORTED_PACKER)
            .expect("structured packer finding");
        assert_eq!(
            finding.semantic_code.as_deref(),
            Some(SEMANTIC_SIGLUS_STATIC_KEY_UNSUPPORTED_PACKER)
        );
    }

    #[test]
    fn protected_executable_is_structured() {
        let report = discover(&load_fixture());
        let entry = report.entry("static-key-protected-executable").unwrap();
        assert_eq!(entry.outcome, SiglusStaticKeyOutcome::ProtectedExecutable);
        assert!(has_finding(
            &report,
            "static-key-protected-executable",
            FINDING_PROTECTED_EXECUTABLE
        ));
    }

    #[test]
    fn helper_provenance_mismatch_is_structured_and_short_circuits() {
        let report = discover(&load_fixture());
        let entry = report.entry("static-key-helper-mismatch").unwrap();
        assert_eq!(entry.outcome, SiglusStaticKeyOutcome::HelperMismatch);
        assert!(has_finding(
            &report,
            "static-key-helper-mismatch",
            FINDING_HELPER_MISMATCH
        ));
    }

    #[test]
    fn missing_key_region_is_structured() {
        let report = discover(&load_fixture());
        let entry = report.entry("static-key-no-key-region").unwrap();
        assert_eq!(entry.outcome, SiglusStaticKeyOutcome::KeyRegionNotFound);
        assert!(has_finding(
            &report,
            "static-key-no-key-region",
            FINDING_KEY_REGION_NOT_FOUND
        ));
    }

    #[test]
    fn validator_fails_on_outcome_mismatch() {
        let mut fixture = load_fixture();
        // Claim the wrong-key entry validates; evidence says otherwise.
        entry_mut(&mut fixture, "static-key-wrong-key").expected =
            SiglusStaticKeyOutcome::Validated;
        let report = discover(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "static-key-wrong-key",
            FINDING_OUTCOME_MISMATCH
        ));
    }

    #[test]
    fn report_never_carries_raw_key_material() {
        use std::fmt::Write as _;
        let report = discover(&load_fixture());
        let json = report.stable_json().expect("stable json");

        // The synthetic key bytes (and their hex) must never appear.
        let key_text = String::from_utf8_lossy(STUB_KEY_CORRECT);
        assert!(!json.contains(key_text.as_ref()), "raw key leaked");
        let key_hex: String = STUB_KEY_CORRECT
            .iter()
            .fold(String::new(), |mut acc, byte| {
                let _ = write!(acc, "{byte:02x}");
                acc
            });
        assert!(!json.contains(&key_hex), "raw key hex leaked");

        // The key-ref carries a one-way commitment + count, not the key.
        let key_ref = report
            .entry("static-key-valid")
            .unwrap()
            .key_ref
            .as_ref()
            .unwrap();
        assert_eq!(key_ref.bytes as usize, STUB_KEY_CORRECT.len());
        assert_eq!(
            key_ref.material_hash.as_str(),
            sha256_hash_bytes(STUB_KEY_CORRECT)
        );
        // The commitment is a hash, not the key.
        assert!(!key_ref.material_hash.as_str().contains(key_text.as_ref()));
    }

    #[test]
    fn candidate_debug_is_redacted_and_zeroized() {
        let candidate = StaticKeyCandidate {
            bytes: Zeroizing::new(STUB_KEY_CORRECT.to_vec()),
        };
        let rendered = format!("{candidate:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains(&String::from_utf8_lossy(STUB_KEY_CORRECT).into_owned()));
    }

    // (Compile-time guarantee: `analyze_siglus_executable`,
    // `validate_candidate_against_gameexe`, and `StaticKeyCandidate` are not
    // `pub`, so pure Siglus parsing / patching cannot reach the helper. These
    // tests merely exercise the in-module gate.)

    #[test]
    fn analysis_recovers_then_validation_gates_the_candidate() {
        let valid = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::Valid);
        let candidate =
            analyze_siglus_executable(&valid.executable).expect("valid stub yields a candidate");
        assert!(
            validate_candidate_against_gameexe(&candidate, &valid.gameexe)
                .unwrap()
                .is_some()
        );

        let wrong = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::WrongKey);
        let wrong_candidate =
            analyze_siglus_executable(&wrong.executable).expect("wrong stub still yields bytes");
        assert!(
            validate_candidate_against_gameexe(&wrong_candidate, &wrong.gameexe)
                .unwrap()
                .is_none(),
            "wrong key must not validate"
        );

        let packer = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::UnsupportedPacker);
        assert_eq!(
            analyze_siglus_executable(&packer.executable).err(),
            Some(StaticAnalysisError::UnsupportedPacker)
        );
        let protected =
            build_siglus_static_key_stub(SiglusStaticKeyStubScenario::ProtectedExecutable);
        assert_eq!(
            analyze_siglus_executable(&protected.executable).err(),
            Some(StaticAnalysisError::ProtectedExecutable)
        );
        let keyless = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::KeyRegionMissing);
        assert_eq!(
            analyze_siglus_executable(&keyless.executable).err(),
            Some(StaticAnalysisError::KeyRegionNotFound)
        );
    }
}
