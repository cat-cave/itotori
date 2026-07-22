//! Static, audit-grade manifest declared by every engine port.
//!
//! The manifest is intentionally a value reachable as a `const` so audit
//! tooling can inspect a port's capabilities, lifecycle commitments, ABI
//! version, environment surface, and tier ceilings without executing port
//! code.

use crate::{EvidenceTier, FidelityTier, looks_like_local_path};

use super::diagnostics::{DriftKind, EnginePortError, ManifestError};

/// Capability classes an `EnginePort` may declare.
///
/// `Snapshot` and `DeterministicReplay` are **port-driven, self-verifying**
/// capabilities (as opposed to `Launch`/`Observe`/`Capture`/`Shutdown`
/// which map to runner-invoked lifecycle stages). They have no lifecycle
/// stage: a port that declares them exercises the substrate's snapshot
/// (`Snapshot`/`Inspectable`/`Restorable`) and deterministic-replay
/// (`ReplayLog`) primitives inside its OWN lifecycle and self-verifies the
/// result — e.g. `utsushi-reallive`'s port asserts snapshot/restore
/// identity at every replay tick boundary and byte-deterministic replay
/// during `launch`. Declaring one is therefore a claim the port BACKS with
/// exercised machinery, not an advertisement the runner leaves inert.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PortCapability {
    /// Required: load and prepare for observation.
    Launch,
    /// Required: drive observation emissions into the substrate sink set.
    Observe,
    /// Required: produce artifact-store-backed capture evidence.
    Capture,
    /// Required: shut down deterministically and idempotently.
    Shutdown,
    /// Optional: jump to a moment id ().
    Jump,
    /// Port-driven: the port takes and restores substrate snapshots
    /// (`Snapshot`/`Inspectable`/`Restorable`) and
    /// self-verifies round-trip identity within its own lifecycle.
    Snapshot,
    /// Port-driven: the port drives byte-deterministic input/clock replay
    /// (`ReplayLog`) and self-verifies determinism within its
    /// own lifecycle.
    DeterministicReplay,
    /// Port-driven: the port exposes deterministic replay-review evidence
    /// through the runtime-adapter bridge. The runner drives the normal
    /// launch/observe lifecycle while the port supplies its review artifact.
    ReplayReview,
}

impl PortCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Observe => "observe",
            Self::Capture => "capture",
            Self::Shutdown => "shutdown",
            Self::Jump => "jump",
            Self::Snapshot => "snapshot",
            Self::DeterministicReplay => "deterministic_replay",
            Self::ReplayReview => "replay_review",
        }
    }

    /// Lifecycle stage corresponding to this capability, if any. Reserved
    /// capabilities return `None`.
    pub fn lifecycle_stage(self) -> Option<LifecycleStage> {
        match self {
            Self::Launch => Some(LifecycleStage::Launch),
            Self::Observe => Some(LifecycleStage::Observe),
            Self::Capture => Some(LifecycleStage::Capture),
            Self::Shutdown => Some(LifecycleStage::Shutdown),
            Self::Jump => Some(LifecycleStage::Jump),
            Self::Snapshot | Self::DeterministicReplay | Self::ReplayReview => None,
        }
    }
}

/// Lifecycle stage exposed by the runner. Used in diagnostics and the
/// manifest's `required_methods`/`optional_methods` slices.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LifecycleStage {
    Launch,
    Observe,
    Capture,
    Jump,
    Shutdown,
}

impl LifecycleStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Observe => "observe",
            Self::Capture => "capture",
            Self::Jump => "jump",
            Self::Shutdown => "shutdown",
        }
    }
}

/// Required set of lifecycle methods every `EnginePort` must implement.
pub const REQUIRED_LIFECYCLE_STAGES: &[LifecycleStage] = &[
    LifecycleStage::Launch,
    LifecycleStage::Observe,
    LifecycleStage::Capture,
    LifecycleStage::Shutdown,
];

/// Optional lifecycle methods a port may declare. Currently only `Jump`.
pub const OPTIONAL_LIFECYCLE_STAGES: &[LifecycleStage] = &[LifecycleStage::Jump];

/// Audit shape declaration for an environment field. Path / LocalPath
/// Secret shapes are rejected at manifest validation time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EnvFieldShape {
    /// Boolean flag: `"1"`/`"0"`, `"true"`/`"false"` (case-insensitive).
    Flag,
    /// Stable enum value the port declares as part of its schema doc.
    Enum,
    /// Opaque non-secret token (UUID, content hash, public id).
    OpaqueToken,
    /// A filesystem path. REJECTED at validate-time. Paths must flow
    /// through the VFS or `PortRequest::artifact_root`, never env vars.
    Path,
    /// A value that `looks_like_local_path` would flag. REJECTED.
    LocalPath,
    /// Secrets, keys, tokens. REJECTED. Key material flows through the
    /// Kaifuu key/profile channel, not Utsushi env.
    Secret,
}

impl EnvFieldShape {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Flag => "flag",
            Self::Enum => "enum",
            Self::OpaqueToken => "opaque_token",
            Self::Path => "path",
            Self::LocalPath => "local_path",
            Self::Secret => "secret",
        }
    }

    pub fn is_forbidden(self) -> bool {
        matches!(self, Self::Path | Self::LocalPath | Self::Secret)
    }
}

/// Declared environment field consumed by a port through `PortRequest::env`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EnvFieldSchema {
    /// Required: variable name as the port consumes it. Must match
    /// `[A-Z][A-Z0-9_]{0,63}`.
    pub key: &'static str,

    /// Audit shape declaration; the runner validates the raw env value
    /// against this shape before exposing it to the port.
    pub shape: EnvFieldShape,

    /// Whether the field is required for `Launch` to succeed.
    pub required: bool,

    /// Short audit-grade description (committed in the manifest).
    pub purpose: &'static str,
}

impl EnvFieldSchema {
    /// Returns `Err` if the schema declares a forbidden shape or an
    /// ill-formed key.
    pub fn validate(&self) -> Result<(), EnginePortError> {
        if !is_valid_env_key(self.key) {
            return Err(EnginePortError::ManifestInvalid {
                source: ManifestError::EnvFieldKeyMalformed { key: self.key },
            });
        }
        if self.purpose.trim().is_empty() {
            return Err(EnginePortError::ManifestInvalid {
                source: ManifestError::EnvFieldPurposeMissing { key: self.key },
            });
        }
        if self.shape.is_forbidden() {
            return Err(EnginePortError::EnvSchemaForbidsPath {
                key: self.key,
                shape: self.shape,
            });
        }
        Ok(())
    }

    /// Apply the field's shape to a raw runtime value. Returns the typed
    /// rejection used by the runner.
    pub fn validate_value(&self, raw: &str) -> Result<(), EnginePortError> {
        if looks_like_local_path(raw) {
            return Err(EnginePortError::EnvUnredacted {
                key: self.key,
                rule: "looks_like_local_path",
            });
        }
        match self.shape {
            EnvFieldShape::Flag => {
                let lower = raw.to_ascii_lowercase();
                if !matches!(lower.as_str(), "0" | "1" | "true" | "false") {
                    return Err(EnginePortError::EnvUnredacted {
                        key: self.key,
                        rule: "flag_shape",
                    });
                }
                Ok(())
            }
            EnvFieldShape::Enum | EnvFieldShape::OpaqueToken => {
                if raw.is_empty() {
                    return Err(EnginePortError::EnvUnredacted {
                        key: self.key,
                        rule: "empty_value",
                    });
                }
                Ok(())
            }
            EnvFieldShape::Path | EnvFieldShape::LocalPath | EnvFieldShape::Secret => {
                Err(EnginePortError::EnvSchemaForbidsPath {
                    key: self.key,
                    shape: self.shape,
                })
            }
        }
    }
}

fn is_valid_env_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 64 {
        return false;
    }
    let bytes = key.as_bytes();
    if !(bytes[0].is_ascii_uppercase()) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// Static, audit-grade declaration of an engine port. Every port crate
/// exposes one `pub const MANIFEST: PortManifest = PortManifest {... }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortManifest {
    /// Stable, lowercased port id, e.g. `"utsushi-fixture"`
    /// `"utsushi-reallive"`, `"utsushi-rpgmaker-mv"`.
    pub id: &'static str,

    /// Human display name.
    pub name: &'static str,

    /// Port crate semantic version. Ports populate via
    /// `env!("CARGO_PKG_VERSION")`.
    pub version: &'static str,

    /// ABI version this port targets. Runner rejects values outside its
    /// supported range with `EnginePortError::AbiVersionUnsupported`.
    pub abi_version: u32,

    /// Capability set declared as supported. Capabilities not listed here
    /// fail with `EnginePortError::CapabilityUnsupported` if the runner is
    /// asked for them.
    pub capabilities: &'static [PortCapability],

    /// Lifecycle methods the port commits to implementing. Must equal
    /// `REQUIRED_LIFECYCLE_STAGES`.
    pub required_methods: &'static [LifecycleStage],

    /// Lifecycle methods declared as available beyond the required set
    /// (currently only `Jump`). A method named here that the port has not
    /// implemented fails the conformance harness.
    pub optional_methods: &'static [LifecycleStage],

    /// Declared environment fields the port consumes through
    /// `PortRequest::env`.
    pub env_schema: &'static [EnvFieldSchema],

    /// Maximum fidelity tier this port can ever claim.
    pub fidelity_tier_max: FidelityTier,

    /// Maximum evidence tier this port can ever claim. Must satisfy
    /// `<= fidelity_tier_max.evidence_ceiling()`.
    pub evidence_tier_max: EvidenceTier,

    /// Free-form, audit-visible limitations.
    pub limitations: &'static [&'static str],
}

impl PortManifest {
    /// Validate the manifest against the runner's structural rules. Does
    /// NOT check ABI version membership against the runner; that is
    /// `Runner::validate_manifest`.
    pub fn validate(&self) -> Result<(), EnginePortError> {
        if !is_valid_port_id(self.id) {
            return Err(EnginePortError::ManifestInvalid {
                source: ManifestError::IdMalformed { id: self.id },
            });
        }
        if self.name.trim().is_empty() {
            return Err(EnginePortError::ManifestInvalid {
                source: ManifestError::NameMissing,
            });
        }
        if !is_valid_semver_triple(self.version) {
            return Err(EnginePortError::ManifestInvalid {
                source: ManifestError::VersionMalformed {
                    version: self.version,
                },
            });
        }

        if !slices_equal_as_sets(self.required_methods, REQUIRED_LIFECYCLE_STAGES) {
            return Err(EnginePortError::ManifestInvalid {
                source: ManifestError::RequiredMethodsMismatch,
            });
        }

        for optional in self.optional_methods {
            if !OPTIONAL_LIFECYCLE_STAGES.contains(optional) {
                return Err(EnginePortError::ManifestInvalid {
                    source: ManifestError::OptionalMethodOutsideKnownSet { stage: *optional },
                });
            }
            if self.required_methods.contains(optional) {
                return Err(EnginePortError::ManifestInvalid {
                    source: ManifestError::OptionalAndRequiredOverlap { stage: *optional },
                });
            }
        }

        for capability in self.capabilities {
            if let Some(stage) = capability.lifecycle_stage() {
                let declared = self.required_methods.contains(&stage)
                    || self.optional_methods.contains(&stage);
                if !declared {
                    return Err(EnginePortError::ManifestCapabilityDrift {
                        capability: *capability,
                        kind: DriftKind::UnclaimedImplementation,
                    });
                }
            }
        }

        if self.evidence_tier_max > self.fidelity_tier_max.evidence_ceiling() {
            return Err(EnginePortError::ManifestInvalid {
                source: ManifestError::EvidenceTierAboveFidelityCeiling {
                    evidence: self.evidence_tier_max,
                    fidelity: self.fidelity_tier_max,
                },
            });
        }

        // Duplicate-key detection over the *entire* env_schema. A fixed-size
        // dedup buffer would silently stop recording past its capacity, so a
        // duplicate between two entries both beyond that bound would go
        // undetected and the EnvFieldDuplicate guarantee would be only
        // best-effort. Compare each key against every earlier one: env_schema
        // is a small, static, compile-time slice, so the O(n²) scan is
        // allocation-free and never truncates.
        for (index, schema) in self.env_schema.iter().enumerate() {
            schema.validate()?;
            if self.env_schema[..index]
                .iter()
                .any(|earlier| earlier.key == schema.key)
            {
                return Err(EnginePortError::ManifestInvalid {
                    source: ManifestError::EnvFieldDuplicate { key: schema.key },
                });
            }
        }

        Ok(())
    }
}

fn is_valid_port_id(id: &str) -> bool {
    if id.len() < 8 || id.len() > 64 {
        return false;
    }
    let bytes = id.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn is_valid_semver_triple(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

fn slices_equal_as_sets<T: Copy + PartialEq>(left: &[T], right: &[T]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter().all(|item| right.contains(item)) && right.iter().all(|item| left.contains(item))
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
