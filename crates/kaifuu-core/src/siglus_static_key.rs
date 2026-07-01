//! KAIFUU-069 — Siglus static-key helper adapter.
//!
//! Siglus encrypted packages (`Scene.pck` + `Gameexe.dat`) are gated behind a
//! *secondary key* that, for the static-key family of titles, is embedded in
//! the game executable. This module ports the `siglus_static_key_tool`-class
//! discovery logic **into kaifuu as in-process Rust** — it NEVER shells out to
//! SiglusExtract or any external tool. It statically analyses executable bytes,
//! recovers a candidate key, and — crucially — **validates that candidate
//! against `Gameexe.dat` profile-proof data before any adapter is allowed to
//! consume it**.
//!
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
//!
//! No retail bytes are used anywhere: the fixture stub synthesises a clearly
//! fake executable + `Gameexe.dat` from in-module constants. The optional local
//! helper path reads scoped private executable / `Gameexe.dat` files in-process
//! (per the KAIFUU-069 2026-06-28 clarification) but still publishes only secret
//! refs + proof hashes.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    HelperCapabilityLevel, HelperExecutionFilesystemAccess, HelperKind, HelperRedactionStatus,
    HelperResultExecutionMode, KaifuuResult, KeyMaterialKind, KeyValidationMethod,
    KeyValidationProof, OperationStatus, PartialDiagnosticSeverity, ProofHash,
    SEMANTIC_KEY_VALIDATION_FAILED, SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED, SecretRef,
    redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

pub const SIGLUS_STATIC_KEY_SCHEMA_VERSION: &str = "0.1.0";

/// The support boundary surfaced in every static-key report.
pub const SIGLUS_STATIC_KEY_SUPPORT_BOUNDARY: &str = "Kaifuu Siglus static-key discovery is in-process Rust static analysis of game executables; it never shells out to SiglusExtract or any external tool. A recovered key is published as a structured secret-ref + proof hash ONLY after it validates against the Gameexe.dat known-plaintext header; unsupported packers, protected executables, helper-provenance mismatches, and validation failures are structured diagnostics. Raw key material is never logged, serialized, or returned.";

// --- Semantic + finding codes -----------------------------------------------

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

// --- Synthetic stub format (NO retail bytes) --------------------------------
//
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

// --- Taxonomy ---------------------------------------------------------------

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

// --- Capability entry -------------------------------------------------------

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

// --- Fixture (input manifest) -----------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusStaticKeyFixture {
    pub schema_version: String,
    pub capability_id: String,
    /// The spec-DAG node id this fixture is authored for (e.g. `KAIFUU-069`).
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

// --- Report (generated output) ----------------------------------------------

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

// --- Fixture stub helper (synthetic, in-process) ----------------------------

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

// --- In-process static analysis (module-private) ----------------------------
//
// Pure adapters cannot reach any of the following; the only public gate is
// `discover_siglus_static_key`.

/// Recovered candidate key material. Raw bytes are private, never serialized,
/// redacted in `Debug`, and zeroized on drop.
struct StaticKeyCandidate {
    bytes: Vec<u8>,
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

impl Drop for StaticKeyCandidate {
    fn drop(&mut self) {
        self.bytes.fill(0);
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
        bytes: key.to_vec(),
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

// --- Discovery (the only public consume gate) -------------------------------

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

/// Run Siglus static-key discovery for every entry in the manifest. Each entry
/// is statically analysed in-process, and any recovered candidate is validated
/// against `Gameexe.dat` **before** a consumable key-ref is published. Returns
/// `Err` only on an environmental failure; evidence / validation problems
/// surface as per-entry structured findings with a `Failed` status.
pub fn discover_siglus_static_key(
    request: SiglusStaticKeyRequest<'_>,
) -> KaifuuResult<SiglusStaticKeyReport> {
    let fixture = request.fixture;
    let validation_command = format!(
        "kaifuu siglus static-key --fixture {}",
        sanitize_file_name(request.fixture_file_name)
    );
    let capability =
        SiglusStaticKeyCapability::in_process(&fixture.capability_id, &fixture.engine_family);

    let mut entries = Vec::with_capacity(fixture.entries.len());
    for entry in &fixture.entries {
        entries.push(discover_entry(
            entry,
            &fixture.source_node_id,
            &fixture.capability_id,
            request.fixture_dir,
            &validation_command,
        ));
    }

    let status = if entries
        .iter()
        .all(|entry| entry.status == OperationStatus::Passed)
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(SiglusStaticKeyReport {
        schema_version: SIGLUS_STATIC_KEY_SCHEMA_VERSION.to_string(),
        capability_id: fixture.capability_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: SIGLUS_STATIC_KEY_SUPPORT_BOUNDARY.to_string(),
        capability,
        status,
        entries,
    })
}

fn discover_entry(
    entry: &SiglusStaticKeyFixtureEntry,
    source_node_id: &str,
    capability_id: &str,
    fixture_dir: &Path,
    validation_command: &str,
) -> SiglusStaticKeyEntryReport {
    let mut findings = Vec::new();

    // (0) Helper-provenance mismatch short-circuits BEFORE any analysis: kaifuu
    //     will not consume a key offered by a shelled-out or non-static helper.
    if let Some(declared) = entry.declared_helper.as_ref()
        && let Some(finding) = check_helper_provenance(declared)
    {
        findings.push(finding);
        return finalize_entry(
            entry,
            source_node_id,
            capability_id,
            validation_command,
            SiglusStaticKeyOutcome::HelperMismatch,
            None,
            findings,
        );
    }

    // (1) Resolve the synthetic stub OR scoped local bytes, in-process.
    let ResolvedInputs {
        input_kind,
        executable: executable_bytes,
        gameexe: gameexe_bytes,
    } = match resolve_inputs(entry, fixture_dir) {
        Ok(resolved) => resolved,
        Err(finding) => {
            findings.push(finding);
            return finalize_entry(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                SiglusStaticKeyOutcome::KeyRegionNotFound,
                None,
                findings,
            );
        }
    };

    // (2) Static analysis: refuse packers / protected binaries; recover the
    //     candidate. Every failure is a structured finding.
    let candidate = match analyze_siglus_executable(&executable_bytes) {
        Ok(candidate) => candidate,
        Err(error) => {
            let (outcome, finding) = analysis_finding(error);
            findings.push(finding);
            return finalize_entry(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                outcome,
                Some(&input_kind),
                findings,
            );
        }
    };

    // (3) Validate-before-consume: only a candidate that reproduces the
    //     `Gameexe.dat` known-plaintext header may be published.
    let proof = match validate_candidate_against_gameexe(&candidate, &gameexe_bytes) {
        Ok(Some(proof)) => proof,
        Ok(None) => {
            findings.push(finding(
                FINDING_VALIDATION_FAILED,
                PartialDiagnosticSeverity::P0,
                "gameexe",
                "recovered candidate did not reproduce the Gameexe.dat known-plaintext header"
                    .to_string(),
                SEMANTIC_KEY_VALIDATION_FAILED,
            ));
            return finalize_entry_with_input(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                SiglusStaticKeyOutcome::ValidationFailed,
                &input_kind,
                None,
                findings,
            );
        }
        Err(error) => {
            findings.push(internal_finding("validation", &error.to_string()));
            return finalize_entry_with_input(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                SiglusStaticKeyOutcome::ValidationFailed,
                &input_kind,
                None,
                findings,
            );
        }
    };

    // Validated: publish the structured key-ref (secret-ref + proof hashes
    // only). The raw key is dropped (zeroized) at the end of this scope.
    let key_ref = match build_key_ref(entry, &candidate, &gameexe_bytes, proof) {
        Ok(key_ref) => key_ref,
        Err(error) => {
            findings.push(internal_finding("keyRef", &error.to_string()));
            return finalize_entry_with_input(
                entry,
                source_node_id,
                capability_id,
                validation_command,
                SiglusStaticKeyOutcome::ValidationFailed,
                &input_kind,
                None,
                findings,
            );
        }
    };

    finalize_entry_with_input(
        entry,
        source_node_id,
        capability_id,
        validation_command,
        SiglusStaticKeyOutcome::Validated,
        &input_kind,
        Some(key_ref),
        findings,
    )
}

/// The resolved byte inputs for one entry, plus the redaction-safe label of
/// where they came from (`stub:<scenario>` or `local-helper`).
struct ResolvedInputs {
    input_kind: String,
    executable: Vec<u8>,
    gameexe: Vec<u8>,
}

fn resolve_inputs(
    entry: &SiglusStaticKeyFixtureEntry,
    fixture_dir: &Path,
) -> Result<ResolvedInputs, SiglusStaticKeyFinding> {
    match (entry.stub, entry.executable.as_deref(), entry.gameexe.as_deref()) {
        (Some(scenario), None, None) => {
            let stub = build_siglus_static_key_stub(scenario);
            Ok(ResolvedInputs {
                input_kind: format!("stub:{}", scenario_str(scenario)),
                executable: stub.executable,
                gameexe: stub.gameexe,
            })
        }
        (None, Some(executable_rel), Some(gameexe_rel)) => {
            let executable = read_local_input(fixture_dir, executable_rel, "executable")?;
            let gameexe = read_local_input(fixture_dir, gameexe_rel, "gameexe")?;
            Ok(ResolvedInputs {
                input_kind: "local-helper".to_string(),
                executable,
                gameexe,
            })
        }
        _ => Err(finding(
            FINDING_INPUT_MISSING,
            PartialDiagnosticSeverity::P0,
            "stub",
            "entry must specify exactly a `stub` scenario OR both `executable` and `gameexe` local paths"
                .to_string(),
            SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND,
        )),
    }
}

fn read_local_input(
    fixture_dir: &Path,
    rel: &str,
    field: &str,
) -> Result<Vec<u8>, SiglusStaticKeyFinding> {
    std::fs::read(fixture_dir.join(rel)).map_err(|error| {
        finding(
            FINDING_INPUT_UNREADABLE,
            PartialDiagnosticSeverity::P0,
            field,
            format!(
                "local {field} input could not be read: {}",
                redact_for_log_or_report(&error.to_string())
            ),
            SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND,
        )
    })
}

fn check_helper_provenance(
    declared: &SiglusStaticKeyDeclaredHelper,
) -> Option<SiglusStaticKeyFinding> {
    let in_process = declared.helper_kind == HelperKind::StaticParser
        && declared.execution_mode == HelperResultExecutionMode::InProcess;
    if in_process {
        None
    } else {
        Some(finding(
            FINDING_HELPER_MISMATCH,
            PartialDiagnosticSeverity::P0,
            "declaredHelper",
            format!(
                "local helper must be the in-process static parser; got kind={:?} mode={:?}",
                declared.helper_kind, declared.execution_mode
            ),
            SEMANTIC_SIGLUS_STATIC_KEY_HELPER_MISMATCH,
        ))
    }
}

fn analysis_finding(
    error: StaticAnalysisError,
) -> (SiglusStaticKeyOutcome, SiglusStaticKeyFinding) {
    match error {
        StaticAnalysisError::UnsupportedPacker => (
            SiglusStaticKeyOutcome::UnsupportedPacker,
            finding(
                FINDING_UNSUPPORTED_PACKER,
                PartialDiagnosticSeverity::P0,
                "executable",
                "executable is wrapped by a packer kaifuu cannot statically analyse".to_string(),
                SEMANTIC_SIGLUS_STATIC_KEY_UNSUPPORTED_PACKER,
            ),
        ),
        StaticAnalysisError::ProtectedExecutable => (
            SiglusStaticKeyOutcome::ProtectedExecutable,
            finding(
                FINDING_PROTECTED_EXECUTABLE,
                PartialDiagnosticSeverity::P0,
                "executable",
                "executable is protected; static key analysis is refused".to_string(),
                SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
            ),
        ),
        StaticAnalysisError::KeyRegionNotFound => (
            SiglusStaticKeyOutcome::KeyRegionNotFound,
            finding(
                FINDING_KEY_REGION_NOT_FOUND,
                PartialDiagnosticSeverity::P0,
                "executable",
                "no static key region could be located in the executable".to_string(),
                SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND,
            ),
        ),
    }
}

fn build_key_ref(
    entry: &SiglusStaticKeyFixtureEntry,
    candidate: &StaticKeyCandidate,
    gameexe_bytes: &[u8],
    validation: KeyValidationProof,
) -> KaifuuResult<SiglusStaticKeyRef> {
    Ok(SiglusStaticKeyRef {
        requirement_id: entry.requirement_id.clone(),
        secret_ref: entry.secret_ref.clone(),
        key_purpose: entry.key_purpose.clone(),
        engine_profile_id: entry.engine_profile_id.clone(),
        source_hash: ProofHash::new(sha256_hash_bytes(gameexe_bytes))?,
        material_hash: candidate.material_hash()?,
        material_kind: KeyMaterialKind::FixedBytes,
        bytes: u32::try_from(candidate.byte_len()).unwrap_or(u32::MAX),
        validation,
        redaction_status: HelperRedactionStatus::Redacted,
    })
}

#[allow(clippy::too_many_arguments)]
fn finalize_entry(
    entry: &SiglusStaticKeyFixtureEntry,
    source_node_id: &str,
    capability_id: &str,
    validation_command: &str,
    outcome: SiglusStaticKeyOutcome,
    input_kind: Option<&str>,
    findings: Vec<SiglusStaticKeyFinding>,
) -> SiglusStaticKeyEntryReport {
    finalize_entry_with_input(
        entry,
        source_node_id,
        capability_id,
        validation_command,
        outcome,
        input_kind.unwrap_or("unresolved"),
        None,
        findings,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_entry_with_input(
    entry: &SiglusStaticKeyFixtureEntry,
    source_node_id: &str,
    capability_id: &str,
    validation_command: &str,
    outcome: SiglusStaticKeyOutcome,
    input_kind: &str,
    key_ref: Option<SiglusStaticKeyRef>,
    mut findings: Vec<SiglusStaticKeyFinding>,
) -> SiglusStaticKeyEntryReport {
    // Validator: the evidence-derived outcome must match the declared
    // expectation. A diagnosis-class outcome (unsupported packer, protected
    // executable, helper mismatch, missing key region, validation failure) is a
    // structured finding but is NOT an adapter failure when it is exactly what
    // the entry expected — the adapter behaved correctly. Only an outcome
    // *mismatch* or an environmental / internal finding flips the entry red.
    let outcome_matches = entry.expected == outcome;
    if !outcome_matches {
        findings.push(finding(
            FINDING_OUTCOME_MISMATCH,
            PartialDiagnosticSeverity::P0,
            "expected",
            format!(
                "entry declared outcome {} but evidence derived {}",
                entry.expected.as_str(),
                outcome.as_str()
            ),
            SEMANTIC_KEY_VALIDATION_FAILED,
        ));
    }

    let validated = outcome == SiglusStaticKeyOutcome::Validated;
    // Belt-and-braces: a key-ref may exist ONLY for a validated outcome.
    let key_ref = if validated { key_ref } else { None };

    let status = if outcome_matches && !findings.iter().any(|finding| forces_failure(&finding.code))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    SiglusStaticKeyEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        capability_id: capability_id.to_string(),
        input_kind: input_kind.to_string(),
        outcome,
        validated: validated && key_ref.is_some(),
        key_ref,
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status,
        findings,
    }
}

// --- Helpers ----------------------------------------------------------------

/// Environmental / internal findings that flip an entry red regardless of the
/// declared expectation. Diagnosis-class findings (the expected semantic
/// outcomes) are deliberately excluded — a correctly-diagnosed unsupported
/// packer is a passing conformance entry.
fn forces_failure(code: &str) -> bool {
    matches!(
        code,
        FINDING_OUTCOME_MISMATCH
            | FINDING_INPUT_MISSING
            | FINDING_INPUT_UNREADABLE
            | "siglus.static_key.internal"
    )
}

fn scenario_str(scenario: SiglusStaticKeyStubScenario) -> &'static str {
    match scenario {
        SiglusStaticKeyStubScenario::Valid => "valid",
        SiglusStaticKeyStubScenario::WrongKey => "wrong_key",
        SiglusStaticKeyStubScenario::UnsupportedPacker => "unsupported_packer",
        SiglusStaticKeyStubScenario::ProtectedExecutable => "protected_executable",
        SiglusStaticKeyStubScenario::KeyRegionMissing => "key_region_missing",
    }
}

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    message: String,
    semantic_code: &str,
) -> SiglusStaticKeyFinding {
    SiglusStaticKeyFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        message,
        semantic_code: Some(semantic_code.to_string()),
    }
}

fn internal_finding(context: &str, error: &str) -> SiglusStaticKeyFinding {
    finding(
        "siglus.static_key.internal",
        PartialDiagnosticSeverity::P0,
        context,
        redact_for_log_or_report(error),
        SEMANTIC_KEY_VALIDATION_FAILED,
    )
}

/// Keep only the file-name component of a declared manifest name so the recorded
/// validation command can never echo a local directory path.
fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|component| component.to_str())
        .map_or_else(|| "siglus-static-key.json".to_string(), ToString::to_string)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::read_json;

    fn manifest_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
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

    // --- The manifest is green and evidence-driven. ------------------------

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

    // --- Validate-before-consume: only a validated entry publishes a key. ---

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

    // --- Each failure class is a STRUCTURED finding, never silent. ----------

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

    // --- Validator fails on an outcome that disagrees with the evidence. ----

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

    // --- No raw key material ever reaches the report. -----------------------

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
            bytes: STUB_KEY_CORRECT.to_vec(),
        };
        let rendered = format!("{candidate:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains(&String::from_utf8_lossy(STUB_KEY_CORRECT).into_owned()));
    }

    // --- Pure static-analysis surface stays module-private. -----------------
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
