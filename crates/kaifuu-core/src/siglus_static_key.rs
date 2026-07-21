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
use crate::{
    HelperCapabilityLevel, HelperExecutionFilesystemAccess, HelperKind, HelperRedactionStatus,
    HelperResultExecutionMode, KaifuuResult, KeyMaterialKind, KeyValidationProof, OperationStatus,
    PartialDiagnosticSeverity, ProofHash, SecretRef, redact_for_log_or_report, stable_json,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
mod analysis;
mod discovery;
use analysis::{
    StaticAnalysisError, StaticKeyCandidate, analyze_siglus_executable,
    validate_candidate_against_gameexe, xor_cycled,
};
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
/// facts of the helper and whether this discovery run reached candidate
/// validation.
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
    /// `true` when this discovery run reached candidate validation before a
    /// key could be consumed.
    pub validate_before_consume: bool,
    pub redaction_status: String,
    pub support_boundary: String,
}

impl SiglusStaticKeyCapability {
    /// The in-process static-key helper capability observed during one run.
    pub fn in_process(
        capability_id: &str,
        engine_family: &str,
        validate_before_consume: bool,
    ) -> Self {
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
            validate_before_consume,
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
#[path = "siglus_static_key_tests.rs"]
mod tests;
