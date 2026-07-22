use super::*;

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

    pub(super) fn from_wire(flag: u8) -> Option<Self> {
        match flag {
            COMPRESSION_UNCOMPRESSED => Some(Self::Uncompressed),
            COMPRESSION_LZSS => Some(Self::Lzss),
            _ => None,
        }
    }
}

/// The runtime-profile key posture a fixture declares. This is what makes the
/// five classes distinguishable: `NoKeyRequired` vs `ZeroKeyResolved` differ in
/// whether a key is *referenced at all*, and `RequiredUnresolved`
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
    /// the five classes. `MalformedContainer` is a fixture-integrity failure
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
    /// Provenance node id stamped into generated reports.
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
    /// Provenance node id stamped on every admission claim.
    pub const SOURCE_NODE_ID: &'static str = RUNTIME_PROFILE_BOUNDARY_SOURCE_NODE_ID;

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
/// `helper-required` / `out-of-profile`) returns
/// `Err(`[`RuntimeBoundaryDiagnostic`]`)` — and, crucially, **never constructs a
/// [`RuntimeEvidenceClaim`]**. The container parse-boundary (magic
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

    // --- Key boundary SECOND: resolve the declared key posture. Required
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
