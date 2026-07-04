//! UTSUSHI-035 — Siglus `Scene.pck` / `Gameexe.dat` **runtime-profile boundary
//! fixtures** + classifier.
//!
//! The [`crate`]-root `UtsushiSiglusPort` is a substrate-facade scaffold: it
//! renders nothing yet. Before a real Siglus runtime can claim *any* rendered
//! evidence it must clear a **runtime-profile boundary** — the container has to
//! parse inside the supported profile, and the profile's key requirement has to
//! be satisfiable **in-process** (no shell-out, no external helper). This module
//! lands the boundary layer that gates that claim, and the synthetic fixtures
//! that distinguish the five boundary classes.
//!
//! # The five boundary classes
//!
//! | class            | fixture posture                                    | outcome                          |
//! |------------------|----------------------------------------------------|----------------------------------|
//! | [`no-key`]       | profile declares no key requirement (plaintext)    | **admitted** — claim may be built |
//! | [`zero-key`]     | key required, resolves in-process to the zero key  | **admitted** — claim may be built |
//! | [`required-key`] | key required, no in-process material, no helper    | **rejected** — typed diagnostic  |
//! | [`helper-req.`]  | key required, only an external helper could resolve| **rejected** — typed diagnostic  |
//! | [`out-of-prof.`] | container encoding/compression outside the profile | **rejected** — typed diagnostic  |
//!
//! [`no-key`]: RuntimeBoundaryClass::NoKey
//! [`zero-key`]: RuntimeBoundaryClass::ZeroKey
//! [`required-key`]: RuntimeBoundaryClass::RequiredKey
//! [`helper-req.`]: RuntimeBoundaryClass::HelperRequired
//! [`out-of-prof.`]: RuntimeBoundaryClass::OutOfProfile
//!
//! # Three load-bearing invariants
//!
//! 1. **Reject-before-claim.** A boundary failure (required-key /
//!    helper-required / out-of-profile) short-circuits *before* any
//!    runtime-evidence claim is constructed. This is enforced at the type
//!    level: the only constructor of [`RuntimeEvidenceClaim`] is
//!    [`RuntimeEvidenceClaim::from_admission`], and the only constructor of
//!    [`RuntimeProfileAdmission`] is [`classify_runtime_profile`], which
//!    returns `Err(`[`RuntimeBoundaryDiagnostic`]`)` on every rejected class.
//!    You cannot name a claim without first holding an admission, and you
//!    cannot hold an admission without having cleared the boundary.
//! 2. **Secret-refs only.** Every serialized runtime report (both the admitted
//!    claim and the rejection diagnostic) refers to key material *only* through
//!    a [`SecretRef`] plus a one-way [`ProofHash`]. Raw key bytes live only
//!    inside the module-private, zeroize-on-drop, `Debug`-redacting
//!    [`RuntimeKeyMaterial`] holder and never cross a serialization boundary.
//! 3. **Synthetic bytes.** The fixtures are clearly-fake in-process
//!    `Scene.pck` / `Gameexe.dat` containers built from module constants. No
//!    retail bytes, and no retail key: the zero-key fixture's key *is* the
//!    all-zero identity key, authored here.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use utsushi_core::EvidenceTier;
use utsushi_core::port::impl_map::sha256_hex;
use utsushi_core::substrate::reject_unredacted_local_paths;

/// Schema version of the runtime-profile boundary fixture + report pair.
pub const RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION: &str = "0.1.0";

/// Stable capability id every runtime-profile boundary report carries.
pub const RUNTIME_PROFILE_BOUNDARY_CAPABILITY_ID: &str = "utsushi-siglus-runtime-profile-boundary";

/// The blunt support boundary surfaced in every report. Deliberately explicit
/// that clearing the boundary is *admission to attempt rendering*, not a claim
/// that a full Siglus frame was rendered (the runtime VM is still the crate's
/// scaffold).
pub const RUNTIME_PROFILE_BOUNDARY_SUPPORT_BOUNDARY: &str = "Utsushi Siglus runtime-profile boundary classifies a synthetic Scene.pck/Gameexe.dat runtime profile into exactly one of five boundary classes (no-key, zero-key, required-key, helper-required, out-of-profile). Clearing the boundary (no-key/zero-key) is ADMISSION to attempt rendering with an in-process-resolvable key; it is NOT a claim that a Siglus frame was rendered (the runtime VM is the crate scaffold). A boundary failure (required-key/helper-required/out-of-profile) is rejected with a typed diagnostic BEFORE any runtime-evidence claim is constructed. Key material is referenced only through local secret-refs + one-way proof hashes; raw key bytes are never logged, serialized, or written.";

// --- Synthetic container format (NO retail bytes) ---------------------------
//
// A narrow, self-describing runtime-profile container. The header is plaintext
// so the boundary can walk the directory before touching any key. Only the
// per-record payloads carry (optionally key-masked) text.
//
//   Scene.pck:   <14B magic><u8 compressionFlag><u32 sceneId><u32 unitCount>
//                unitCount * { <u32 payloadLen><payload bytes> }
//   Gameexe.dat: <14B magic><u8 compressionFlag><u32 entryCount>
//                entryCount * { <u32 payloadLen><payload bytes> }

const SCENE_PCK_MAGIC: &[u8; 14] = b"USIG-SCN-RTPRO";
const GAMEEXE_DAT_MAGIC: &[u8; 14] = b"USIG-GXE-RTPRO";

/// On-wire compression flag: uncompressed (the only in-profile case).
const COMPRESSION_UNCOMPRESSED: u8 = 0;
/// On-wire compression flag: proprietary Siglus LZSS — **out of profile** for
/// the boundary layer (the real codec is a KAIFUU skeleton).
const COMPRESSION_LZSS: u8 = 1;

/// Synthetic scene id the fixtures emit.
const FIXTURE_SCENE_ID: u32 = 35;

/// Clearly-synthetic Scene.pck dialogue units (authored here, not extracted).
const FIXTURE_SCENE_UNITS: &[&str] = &[
    "[synthetic-siglus-runtime-unit-0]",
    "[synthetic-siglus-runtime-unit-1]",
];

/// Clearly-synthetic Gameexe.dat key/value config lines.
const FIXTURE_GAMEEXE_ENTRIES: &[(&str, &str)] = &[
    ("#SCENE.000.NAME", "[synthetic-scene-0]"),
    ("#WINDOW.000.NAME", "[synthetic-window-0]"),
];

/// The all-zero identity key the zero-key fixture is gated by. This is the one
/// place raw "key" bytes exist; they never leave [`RuntimeKeyMaterial`]. XOR
/// with a zero key is the identity transform — a present-but-degenerate key,
/// distinct from the no-key case which references no key at all.
const ZERO_KEY_LEN: usize = 16;

// --- Secret reference -------------------------------------------------------

/// A structured, **local** secret reference. Runtime reports name key material
/// only through this — never raw bytes. Mirrors the KAIFUU `SecretRef`
/// discipline: a `scheme:name` string in a local-secret scheme, carrying no raw
/// key material, no local path, no whitespace, no traversal, no null bytes.
///
/// Serializes as its string form. `Debug` is redacted so an accidental
/// `{:?}` never prints the (non-secret, but still access-controlled) ref.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretRef(String);

impl SecretRef {
    /// Validate + construct. Returns `Err` with a stable message if the value
    /// is not a well-formed local secret reference.
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if is_valid_secret_ref(&value) {
            Ok(Self(value))
        } else {
            Err(
                "secretRef must use a local secret-ref scheme and must not contain raw key \
                 material, local paths, whitespace, parent traversal, or null bytes"
                    .to_string(),
            )
        }
    }

    /// Borrow the underlying `scheme:name` string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretRef {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("SecretRef")
            .field(&"<secret-ref>")
            .finish()
    }
}

impl std::fmt::Display for SecretRef {
    // A secret-ref is a *reference* to key material, not the material itself
    // (the validator forbids raw key bytes / paths in the name), so it is safe
    // to surface in a typed diagnostic message.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for SecretRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

/// The known-good runtime-profile secret-ref scheme prefixes.
const SECRET_REF_SCHEMES: &[&str] = &["local-secret", "os-keychain", "secret-manager", "prompt"];

fn is_valid_secret_ref(value: &str) -> bool {
    let Some((scheme, name)) = value.split_once(':') else {
        return false;
    };
    if !SECRET_REF_SCHEMES.contains(&scheme) {
        return false;
    }
    if name.is_empty()
        || name.trim() != name
        || name.contains('\0')
        || name.contains('\\')
        || name.contains('/')
        || name.contains("..")
    {
        return false;
    }
    // A secret-ref *name* must never itself look like a local path (defence in
    // depth on top of the report-wide redaction sweep).
    if utsushi_core::looks_like_local_path(value) {
        return false;
    }
    name.chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

// --- One-way proof hash -----------------------------------------------------

/// A one-way, 64-char lowercase-hex sha256 commitment. Used to reference key
/// material and container bytes in reports *without* carrying the bytes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofHash(String);

impl ProofHash {
    /// Commit to `bytes` with a sha256 hex digest.
    pub fn commit(bytes: &[u8]) -> Self {
        Self(sha256_hex(bytes))
    }

    /// Borrow the hex digest.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ProofHash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("ProofHash").field(&self.0).finish()
    }
}

// --- Module-private key holder ----------------------------------------------

/// Resolved runtime key bytes. Raw material is module-private, never
/// serialized, redacted in `Debug`, and zeroized on drop. Nothing public
/// returns or logs these bytes; the only outward-facing surfaces are a byte
/// length and a one-way [`ProofHash`] commitment.
struct RuntimeKeyMaterial {
    bytes: Vec<u8>,
}

impl RuntimeKeyMaterial {
    fn from_resolved_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    fn commitment(&self) -> ProofHash {
        ProofHash::commit(&self.bytes)
    }

    /// Reject-on-secret probe: does the raw key appear as a contiguous window
    /// inside `haystack`? Returns only a boolean — never the bytes.
    fn appears_in(&self, haystack: &[u8]) -> bool {
        if self.bytes.is_empty() || self.bytes.len() > haystack.len() {
            return false;
        }
        haystack
            .windows(self.bytes.len())
            .any(|window| window == self.bytes)
    }
}

impl Drop for RuntimeKeyMaterial {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

impl std::fmt::Debug for RuntimeKeyMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeKeyMaterial")
            .field("bytes", &"[REDACTED:utsushi.secret_redacted]")
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

// --- Profile description ----------------------------------------------------

/// In-profile text encoding. Siglus text is UTF-16LE; the profile is explicit
/// (no silent default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum RuntimeEncoding {
    /// UTF-16LE — the only in-profile encoding.
    Utf16Le,
}

/// Declared (or observed) container compression.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum RuntimeCompression {
    /// Uncompressed-within-profile — the only case the boundary admits.
    Uncompressed,
    /// Proprietary Siglus LZSS — explicitly **out of profile** at this layer.
    Lzss,
}

impl RuntimeCompression {
    /// Stable lowercase label for reports/diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uncompressed => "uncompressed",
            Self::Lzss => "lzss",
        }
    }

    fn from_wire(flag: u8) -> Option<Self> {
        match flag {
            COMPRESSION_UNCOMPRESSED => Some(Self::Uncompressed),
            COMPRESSION_LZSS => Some(Self::Lzss),
            _ => None,
        }
    }
}

/// The runtime-profile key posture a fixture declares. This is what makes the
/// five classes distinguishable: `NoKeyRequired` vs `ZeroKeyResolved` differ in
/// whether a key is *referenced at all*, and `RequiredUnresolved` /
/// `HelperRequired` differ in *why* the referenced key cannot be resolved
/// in-process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum RuntimeKeyPosture {
    /// The profile requires no key: the container is plaintext-in-profile and
    /// the runtime boundary is cleared with no secret material at all.
    NoKeyRequired,
    /// The profile references a key that resolves in-process to the all-zero
    /// identity key. A present-but-degenerate key: distinct from `NoKeyRequired`
    /// because a [`SecretRef`] IS carried and committed.
    ZeroKeyResolved {
        /// The local secret-ref the (zero) key is published under.
        secret_ref: SecretRef,
    },
    /// The profile requires a key, but no in-process material is available and
    /// no helper is declared. A hard boundary failure.
    RequiredUnresolved {
        /// The local secret-ref that could not be resolved.
        secret_ref: SecretRef,
    },
    /// The profile requires a key that only an **external helper** could
    /// resolve. The runtime never shells out, so this is a boundary failure —
    /// the diagnostic names the helper the operator would have to provision.
    HelperRequired {
        /// The local secret-ref the key is published under.
        secret_ref: SecretRef,
        /// Stable id of the helper the operator must provision out-of-band.
        helper_id: String,
    },
}

/// Where a fixture's container bytes come from. Synthetic in-process builders
/// only for the committed CI fixtures — there is no retail-file source here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum RuntimeContainerSource {
    /// Build the in-profile synthetic container in-process.
    SyntheticInProfile,
    /// Build the synthetic container flagged with an out-of-profile
    /// compression (used only by the out-of-profile fixture).
    SyntheticOutOfProfile,
}

/// A complete runtime-profile boundary fixture: the Scene.pck + Gameexe.dat
/// container sources, the declared encoding/compression, and the key posture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProfileFixture {
    /// Schema version.
    pub schema_version: String,
    /// Stable per-fixture profile id.
    pub profile_id: String,
    /// Declared in-profile text encoding.
    pub encoding: RuntimeEncoding,
    /// Declared in-profile compression.
    pub compression: RuntimeCompression,
    /// The key posture that drives the boundary classification.
    pub key_posture: RuntimeKeyPosture,
    /// Where the `Scene.pck` bytes come from.
    pub scene_source: RuntimeContainerSource,
    /// Where the `Gameexe.dat` bytes come from.
    pub gameexe_source: RuntimeContainerSource,
}

// --- Boundary class + diagnostics -------------------------------------------

/// Exactly one of the five runtime-profile boundary classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeBoundaryClass {
    /// Admitted: no key required (plaintext in-profile).
    NoKey,
    /// Admitted: key required, resolved in-process to the zero identity key.
    ZeroKey,
    /// Rejected: key required, not resolvable in-process, no helper.
    RequiredKey,
    /// Rejected: key required, only an external helper could resolve it.
    HelperRequired,
    /// Rejected: container encoding/compression outside the supported profile.
    OutOfProfile,
}

impl RuntimeBoundaryClass {
    /// Stable kebab-case label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoKey => "no-key",
            Self::ZeroKey => "zero-key",
            Self::RequiredKey => "required-key",
            Self::HelperRequired => "helper-required",
            Self::OutOfProfile => "out-of-profile",
        }
    }

    /// Whether this class clears the boundary (a runtime-evidence claim may be
    /// built) or is rejected before any claim.
    pub fn is_admitted(self) -> bool {
        matches!(self, Self::NoKey | Self::ZeroKey)
    }
}

/// Typed, secret-ref-only diagnostic for a rejected boundary class. Every
/// variant carries the stable [`RuntimeBoundaryClass`] it rejects under and a
/// secret-ref (never key bytes). A [`RuntimeBoundaryDiagnostic`] is proof that
/// **no** [`RuntimeEvidenceClaim`] was emitted for this profile.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "code")]
pub enum RuntimeBoundaryDiagnostic {
    /// A key is required but no in-process material is available and no helper
    /// is declared.
    #[error(
        "utsushi.siglus.runtime_profile.required_key_unresolved: profile {profile_id} requires a \
         key ({secret_ref}) that is not resolvable in-process; no runtime-evidence claim emitted"
    )]
    RequiredKeyUnresolved {
        /// Profile whose boundary failed.
        profile_id: String,
        /// The unresolved secret-ref (never the key bytes).
        secret_ref: SecretRef,
    },
    /// A key is required that only an external helper could resolve. The runtime
    /// never shells out.
    #[error(
        "utsushi.siglus.runtime_profile.helper_required: profile {profile_id} requires helper \
         {helper_id} to resolve key {secret_ref}; the runtime never shells out; no \
         runtime-evidence claim emitted"
    )]
    HelperRequired {
        /// Profile whose boundary failed.
        profile_id: String,
        /// The secret-ref the helper would resolve (never the key bytes).
        secret_ref: SecretRef,
        /// The helper the operator must provision out-of-band.
        helper_id: String,
    },
    /// The container is outside the supported runtime profile (bad magic or an
    /// out-of-profile compression). Detected at parse time, before key
    /// handling.
    #[error(
        "utsushi.siglus.runtime_profile.out_of_profile: profile {profile_id} container \
         {container} is out of profile ({detail}); no runtime-evidence claim emitted"
    )]
    OutOfProfile {
        /// Profile whose boundary failed.
        profile_id: String,
        /// Which container (`Scene.pck` / `Gameexe.dat`) was out of profile.
        container: String,
        /// Human detail (observed compression / magic mismatch).
        detail: String,
    },
    /// The synthetic container was structurally malformed (truncated / bad
    /// magic on a source that should be in-profile). Kept distinct from
    /// `OutOfProfile` so a fixture-authoring bug is never mistaken for a
    /// legitimate boundary class.
    #[error(
        "utsushi.siglus.runtime_profile.malformed_container: profile {profile_id} container \
         {container} is malformed ({detail})"
    )]
    MalformedContainer {
        /// Profile whose container was malformed.
        profile_id: String,
        /// Which container was malformed.
        container: String,
        /// Human detail.
        detail: String,
    },
}

impl RuntimeBoundaryDiagnostic {
    /// The boundary class this diagnostic rejects under, if it maps to one of
    /// the five classes. `MalformedContainer` is a fixture-integrity failure,
    /// not a boundary class, so it returns `None`.
    pub fn boundary_class(&self) -> Option<RuntimeBoundaryClass> {
        match self {
            Self::RequiredKeyUnresolved { .. } => Some(RuntimeBoundaryClass::RequiredKey),
            Self::HelperRequired { .. } => Some(RuntimeBoundaryClass::HelperRequired),
            Self::OutOfProfile { .. } => Some(RuntimeBoundaryClass::OutOfProfile),
            Self::MalformedContainer { .. } => None,
        }
    }

    /// Serialize to stable, redaction-swept JSON (secret-refs only, no key
    /// bytes, no local paths). This is the committable rejection evidence.
    pub fn stable_json(&self) -> Result<String, String> {
        stable_redacted_json(self)
    }
}

// --- Admission (only produced by clearing the boundary) ---------------------

/// A byte-length + one-way commitment summary of a parsed container. Carries no
/// payload text and no key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDigest {
    /// Which container (`Scene.pck` / `Gameexe.dat`).
    pub container: String,
    /// Number of records (scene units / gameexe entries) parsed.
    pub record_count: u32,
    /// Total container byte length.
    pub byte_len: u32,
    /// One-way commitment to the raw container bytes.
    pub content_hash: ProofHash,
}

/// A cleared runtime-profile boundary. **The only constructor is
/// [`classify_runtime_profile`]**, which returns this only for the admitted
/// classes ([`RuntimeBoundaryClass::NoKey`] / [`RuntimeBoundaryClass::ZeroKey`]).
/// Holding one is proof the boundary was cleared; it is the sole key that
/// unlocks [`RuntimeEvidenceClaim::from_admission`].
///
/// The struct fields are private so an admission can never be forged from
/// outside this module.
#[derive(Debug)]
pub struct RuntimeProfileAdmission {
    profile_id: String,
    class: RuntimeBoundaryClass,
    encoding: RuntimeEncoding,
    compression: RuntimeCompression,
    scene: ContainerDigest,
    gameexe: ContainerDigest,
    /// Present only for the zero-key class: the secret-ref + one-way key
    /// commitment. `None` for the no-key class.
    key_ref: Option<(SecretRef, ProofHash, u32)>,
}

impl RuntimeProfileAdmission {
    /// The boundary class that was cleared (always `NoKey` or `ZeroKey`).
    pub fn class(&self) -> RuntimeBoundaryClass {
        self.class
    }

    /// The profile id.
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }
}

/// The runtime-evidence claim emitted **after** the boundary is cleared. It
/// records that the runtime profile was admitted and that rendering may be
/// attempted with an in-process-resolvable key. It references key material only
/// through a [`SecretRef`] + [`ProofHash`] — never raw bytes.
///
/// This is *admission* evidence, not a rendered-frame claim: the crate's
/// runtime VM is still the scaffold. The `evidence_tier` is therefore capped at
/// [`EvidenceTier::E1`] (deterministic, non-visual).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvidenceClaim {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// The spec-DAG node id this claim is authored for.
    pub source_node_id: String,
    /// The profile id.
    pub profile_id: String,
    /// The cleared boundary class (`no-key` / `zero-key`).
    pub boundary_class: RuntimeBoundaryClass,
    /// Declared in-profile encoding.
    pub encoding: RuntimeEncoding,
    /// Declared in-profile compression.
    pub compression: RuntimeCompression,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// Scene.pck digest.
    pub scene: ContainerDigest,
    /// Gameexe.dat digest.
    pub gameexe: ContainerDigest,
    /// The key reference, present only for the zero-key class. Carries the
    /// secret-ref + one-way key commitment + byte length — never the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_reference: Option<RuntimeKeyReference>,
    /// The evidence tier this admission claim is capped at.
    pub evidence_tier: EvidenceTier,
}

/// The key reference carried by an admitted zero-key claim: a secret-ref + a
/// one-way commitment + byte length. Never the key bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeKeyReference {
    /// The local secret-ref the key is published under.
    pub secret_ref: SecretRef,
    /// One-way sha256 commitment to the resolved key bytes.
    pub key_commitment: ProofHash,
    /// Resolved key byte length.
    pub key_byte_len: u32,
}

impl RuntimeEvidenceClaim {
    /// The spec-DAG node id stamped on every admission claim.
    pub const SOURCE_NODE_ID: &'static str = "UTSUSHI-035";

    /// Build the runtime-evidence claim from a cleared boundary admission. This
    /// is the **only** constructor, and it consumes the admission — so a claim
    /// can only exist downstream of a boundary that was actually cleared.
    pub fn from_admission(admission: RuntimeProfileAdmission) -> Self {
        let key_reference = admission
            .key_ref
            .map(
                |(secret_ref, key_commitment, key_byte_len)| RuntimeKeyReference {
                    secret_ref,
                    key_commitment,
                    key_byte_len,
                },
            );
        Self {
            schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
            capability_id: RUNTIME_PROFILE_BOUNDARY_CAPABILITY_ID.to_string(),
            source_node_id: Self::SOURCE_NODE_ID.to_string(),
            profile_id: admission.profile_id,
            boundary_class: admission.class,
            encoding: admission.encoding,
            compression: admission.compression,
            support_boundary: RUNTIME_PROFILE_BOUNDARY_SUPPORT_BOUNDARY.to_string(),
            scene: admission.scene,
            gameexe: admission.gameexe,
            key_reference,
            // Admission evidence is deterministic and non-visual: E1 ceiling.
            evidence_tier: EvidenceTier::E1,
        }
    }

    /// Serialize to stable, redaction-swept JSON (secret-refs only, no key
    /// bytes, no local paths). This is the committable admission evidence.
    pub fn stable_json(&self) -> Result<String, String> {
        stable_redacted_json(self)
    }
}

// --- The classifier (the boundary gate) -------------------------------------

/// Classify a runtime-profile fixture into exactly one of the five boundary
/// classes.
///
/// On an **admitted** class (`no-key` / `zero-key`) returns
/// `Ok(`[`RuntimeProfileAdmission`]`)`. On a **rejected** class (`required-key`
/// / `helper-required` / `out-of-profile`) returns
/// `Err(`[`RuntimeBoundaryDiagnostic`]`)` — and, crucially, **never constructs a
/// [`RuntimeEvidenceClaim`]**. The container parse-boundary (magic +
/// compression) is checked first, so an out-of-profile container is rejected
/// before any key handling; the key posture is resolved second.
pub fn classify_runtime_profile(
    fixture: &RuntimeProfileFixture,
) -> Result<RuntimeProfileAdmission, RuntimeBoundaryDiagnostic> {
    let profile_id = fixture.profile_id.clone();

    // --- Parser boundary FIRST: parse both containers within the profile. A
    // failure here (bad magic / out-of-profile compression) rejects before any
    // key material is resolved and before any runtime-evidence claim.
    let scene_bytes = build_scene_container(&fixture.scene_source);
    let gameexe_bytes = build_gameexe_container(&fixture.gameexe_source);

    let scene = parse_container(
        &profile_id,
        "Scene.pck",
        SCENE_PCK_MAGIC,
        fixture.compression,
        &scene_bytes,
    )?;
    let gameexe = parse_container(
        &profile_id,
        "Gameexe.dat",
        GAMEEXE_DAT_MAGIC,
        fixture.compression,
        &gameexe_bytes,
    )?;

    // --- Key boundary SECOND: resolve the declared key posture. Required /
    // helper-required reject here, still before any claim.
    match &fixture.key_posture {
        RuntimeKeyPosture::NoKeyRequired => Ok(RuntimeProfileAdmission {
            profile_id,
            class: RuntimeBoundaryClass::NoKey,
            encoding: fixture.encoding,
            compression: fixture.compression,
            scene,
            gameexe,
            key_ref: None,
        }),
        RuntimeKeyPosture::ZeroKeyResolved { secret_ref } => {
            // Resolve the (zero) key in-process; it never leaves the holder.
            let key = RuntimeKeyMaterial::from_resolved_bytes(vec![0u8; ZERO_KEY_LEN]);
            // Reject-on-secret: the resolved key must not appear verbatim in any
            // container we are about to commit a digest for. (Vacuous for the
            // zero key, but the discipline is enforced uniformly.)
            debug_assert!(
                !key.appears_in(&scene_bytes) || key.byte_len() == 0,
                "zero-key admission must not leak raw key bytes into a committed digest",
            );
            let commitment = key.commitment();
            let byte_len = u32::try_from(key.byte_len()).unwrap_or(u32::MAX);
            Ok(RuntimeProfileAdmission {
                profile_id,
                class: RuntimeBoundaryClass::ZeroKey,
                encoding: fixture.encoding,
                compression: fixture.compression,
                scene,
                gameexe,
                key_ref: Some((secret_ref.clone(), commitment, byte_len)),
            })
        }
        RuntimeKeyPosture::RequiredUnresolved { secret_ref } => {
            Err(RuntimeBoundaryDiagnostic::RequiredKeyUnresolved {
                profile_id,
                secret_ref: secret_ref.clone(),
            })
        }
        RuntimeKeyPosture::HelperRequired {
            secret_ref,
            helper_id,
        } => Err(RuntimeBoundaryDiagnostic::HelperRequired {
            profile_id,
            secret_ref: secret_ref.clone(),
            helper_id: helper_id.clone(),
        }),
    }
}

/// Convenience: classify + (on admission) build the runtime-evidence claim.
/// This is the reject-before-claim path in one call — the `?` short-circuits on
/// a boundary failure so the claim is never reached.
pub fn admit_runtime_profile(
    fixture: &RuntimeProfileFixture,
) -> Result<RuntimeEvidenceClaim, RuntimeBoundaryDiagnostic> {
    let admission = classify_runtime_profile(fixture)?;
    Ok(RuntimeEvidenceClaim::from_admission(admission))
}

// --- Container parsing ------------------------------------------------------

fn parse_container(
    profile_id: &str,
    container: &'static str,
    magic: &[u8; 14],
    declared: RuntimeCompression,
    bytes: &[u8],
) -> Result<ContainerDigest, RuntimeBoundaryDiagnostic> {
    let mut reader = Reader::new(bytes);

    // Magic.
    let observed_magic = reader.take(magic.len()).map_err(|detail| {
        RuntimeBoundaryDiagnostic::MalformedContainer {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail,
        }
    })?;
    if observed_magic != magic {
        return Err(RuntimeBoundaryDiagnostic::OutOfProfile {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail: "container magic does not match the supported runtime profile".to_string(),
        });
    }

    // Compression flag — the parser-boundary check that classifies out-of-profile.
    let flag = reader
        .u8()
        .map_err(|detail| RuntimeBoundaryDiagnostic::MalformedContainer {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail,
        })?;
    let observed = RuntimeCompression::from_wire(flag).ok_or_else(|| {
        RuntimeBoundaryDiagnostic::OutOfProfile {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail: format!("unknown compression flag {flag}"),
        }
    })?;
    if observed != RuntimeCompression::Uncompressed || observed != declared {
        return Err(RuntimeBoundaryDiagnostic::OutOfProfile {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail: format!(
                "compression {} is out of profile (declared {})",
                observed.as_str(),
                declared.as_str()
            ),
        });
    }

    // Record directory (scene: skip sceneId; both: u32 count + length-prefixed
    // records). We only need the record count + total byte length + a content
    // hash for the digest — no payload text enters the report.
    let malformed = |detail: String| RuntimeBoundaryDiagnostic::MalformedContainer {
        profile_id: profile_id.to_string(),
        container: container.to_string(),
        detail,
    };
    if container == "Scene.pck" {
        // Consume the sceneId scalar that Gameexe.dat does not carry.
        reader.u32().map_err(&malformed)?;
    }
    let record_count = reader.u32().map_err(&malformed)?;
    for _ in 0..record_count {
        let payload_len = reader.u32().map_err(&malformed)? as usize;
        reader.take(payload_len).map_err(&malformed)?;
    }

    Ok(ContainerDigest {
        container: container.to_string(),
        record_count,
        byte_len: u32::try_from(bytes.len()).unwrap_or(u32::MAX),
        content_hash: ProofHash::commit(bytes),
    })
}

// --- Synthetic fixture builders ---------------------------------------------

fn build_scene_container(source: &RuntimeContainerSource) -> Vec<u8> {
    match source {
        RuntimeContainerSource::SyntheticInProfile => {
            let records: Vec<Vec<u8>> = FIXTURE_SCENE_UNITS
                .iter()
                .map(|text| utf16le_encode(text))
                .collect();
            build_record_container(
                SCENE_PCK_MAGIC,
                COMPRESSION_UNCOMPRESSED,
                Some(FIXTURE_SCENE_ID),
                &records,
            )
        }
        RuntimeContainerSource::SyntheticOutOfProfile => {
            build_out_of_profile_container(SCENE_PCK_MAGIC)
        }
    }
}

fn build_gameexe_container(source: &RuntimeContainerSource) -> Vec<u8> {
    match source {
        RuntimeContainerSource::SyntheticInProfile => {
            let mut records: Vec<Vec<u8>> = Vec::with_capacity(FIXTURE_GAMEEXE_ENTRIES.len() * 2);
            for (key, value) in FIXTURE_GAMEEXE_ENTRIES {
                records.push(utf16le_encode(key));
                records.push(utf16le_encode(value));
            }
            build_record_container(GAMEEXE_DAT_MAGIC, COMPRESSION_UNCOMPRESSED, None, &records)
        }
        RuntimeContainerSource::SyntheticOutOfProfile => {
            build_out_of_profile_container(GAMEEXE_DAT_MAGIC)
        }
    }
}

fn build_record_container(
    magic: &[u8; 14],
    compression_flag: u8,
    scene_id: Option<u32>,
    records: &[Vec<u8>],
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(magic);
    bytes.push(compression_flag);
    if let Some(scene_id) = scene_id {
        bytes.extend_from_slice(&scene_id.to_le_bytes());
    }
    bytes.extend_from_slice(
        &u32::try_from(records.len())
            .expect("fixture record count fits in u32")
            .to_le_bytes(),
    );
    for record in records {
        bytes.extend_from_slice(
            &u32::try_from(record.len())
                .expect("record length fits in u32")
                .to_le_bytes(),
        );
        bytes.extend_from_slice(record);
    }
    bytes
}

/// A container flagged with the out-of-profile proprietary-LZSS compression.
/// The body is deliberately opaque: the boundary refuses it at the compression
/// flag, before any decode, so no fabricated LZSS stream exists here.
fn build_out_of_profile_container(magic: &[u8; 14]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(magic);
    bytes.push(COMPRESSION_LZSS);
    bytes.extend_from_slice(b"...out-of-profile-lzss-body-not-decoded...");
    bytes
}

fn utf16le_encode(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

// --- Byte reader ------------------------------------------------------------

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| format!("length overflow at byte {}", self.position))?;
        let slice = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| format!("truncated at byte {} (needed {count} more)", self.position))?;
        self.position = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

// --- Redaction-swept serialization ------------------------------------------

/// Serialize a value to compact JSON and run the substrate's local-path
/// redaction sweep over the serialized form. Returns the JSON string on success
/// or a stable error string on a serialization / redaction failure.
fn stable_redacted_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json_value = serde_json::to_value(value)
        .map_err(|error| format!("runtime-profile report serialization failed: {error}"))?;
    reject_unredacted_local_paths("", &json_value)
        .map_err(|error| format!("runtime-profile report failed redaction sweep: {error}"))?;
    serde_json::to_string(&json_value)
        .map_err(|error| format!("runtime-profile report re-serialization failed: {error}"))
}

// --- Canonical fixture builders (the five committed boundary classes) --------

/// A local secret-ref used by the keyed fixtures. `unwrap` is safe: the literal
/// is a valid dotted local-secret name.
fn fixture_secret_ref(name: &str) -> SecretRef {
    SecretRef::new(format!("local-secret:{name}")).expect("fixture secret-ref literal is valid")
}

/// The **no-key** fixture: plaintext in-profile, no key referenced. Admitted.
pub fn fixture_no_key() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-no-key".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        key_posture: RuntimeKeyPosture::NoKeyRequired,
        scene_source: RuntimeContainerSource::SyntheticInProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// The **zero-key** fixture: key referenced, resolves in-process to the zero
/// identity key. Admitted, carries a secret-ref.
pub fn fixture_zero_key() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-zero-key".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        key_posture: RuntimeKeyPosture::ZeroKeyResolved {
            secret_ref: fixture_secret_ref("siglus.runtime.zero-key.v1"),
        },
        scene_source: RuntimeContainerSource::SyntheticInProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// The **required-key** fixture: key required, not resolvable in-process, no
/// helper. Rejected before any claim.
pub fn fixture_required_key() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-required-key".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        key_posture: RuntimeKeyPosture::RequiredUnresolved {
            secret_ref: fixture_secret_ref("siglus.runtime.required-key.v1"),
        },
        scene_source: RuntimeContainerSource::SyntheticInProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// The **helper-required** fixture: key required, only an external helper could
/// resolve it. Rejected before any claim (the runtime never shells out).
pub fn fixture_helper_required() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-helper-required".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        key_posture: RuntimeKeyPosture::HelperRequired {
            secret_ref: fixture_secret_ref("siglus.runtime.helper-required.v1"),
            helper_id: "siglus-keyring-helper".to_string(),
        },
        scene_source: RuntimeContainerSource::SyntheticInProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// The **out-of-profile** fixture: the Scene.pck container is flagged with the
/// proprietary-LZSS compression, outside the supported runtime profile.
/// Rejected at the parser boundary, before any key handling or claim.
pub fn fixture_out_of_profile() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-out-of-profile".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        // The key posture is irrelevant: the container parse-boundary rejects
        // first. Declaring a would-be-admissible no-key posture makes the
        // reject-before-key ordering observable.
        key_posture: RuntimeKeyPosture::NoKeyRequired,
        scene_source: RuntimeContainerSource::SyntheticOutOfProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// All five canonical fixtures paired with the boundary class each must
/// classify to. Used by the boundary conformance test.
pub fn canonical_boundary_fixtures() -> Vec<(RuntimeBoundaryClass, RuntimeProfileFixture)> {
    vec![
        (RuntimeBoundaryClass::NoKey, fixture_no_key()),
        (RuntimeBoundaryClass::ZeroKey, fixture_zero_key()),
        (RuntimeBoundaryClass::RequiredKey, fixture_required_key()),
        (
            RuntimeBoundaryClass::HelperRequired,
            fixture_helper_required(),
        ),
        (RuntimeBoundaryClass::OutOfProfile, fixture_out_of_profile()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_ref_rejects_raw_paths_and_bad_schemes() {
        assert!(SecretRef::new("local-secret:siglus.key.v1").is_ok());
        assert!(SecretRef::new("plain-text-key").is_err());
        assert!(SecretRef::new("local-secret:/home/user/key").is_err());
        assert!(SecretRef::new("local-secret:../escape").is_err());
        assert!(SecretRef::new("bogus-scheme:name").is_err());
    }

    #[test]
    fn key_material_debug_is_redacted_and_zeroizes() {
        let key = RuntimeKeyMaterial::from_resolved_bytes(vec![1, 2, 3, 4]);
        let debug = format!("{key:?}");
        assert!(
            debug.contains("REDACTED"),
            "key Debug must be redacted: {debug}"
        );
        assert!(
            !debug.contains(", 2, 3"),
            "key Debug must not print bytes: {debug}"
        );
    }

    #[test]
    fn out_of_profile_rejects_before_key_resolution() {
        // The out-of-profile fixture declares a NoKeyRequired posture that would
        // otherwise admit; the container boundary must reject it first.
        let fixture = fixture_out_of_profile();
        let error = classify_runtime_profile(&fixture).expect_err("must reject");
        assert_eq!(
            error.boundary_class(),
            Some(RuntimeBoundaryClass::OutOfProfile)
        );
    }
}
