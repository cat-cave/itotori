//! Stable semantic diagnostics for the WASM embed ABI substrate.
//!
//! The embed module ships exactly one surface today: the capability-list
//! declaration + validation in [`super::capability`]. Every variant in
//! [`EmbedError`] is constructed by that surface — there is no dead
//! taxonomy advertising envelope / snapshot-ref / redaction behaviour the
//! module does not implement. Each variant carries a stable
//! `utsushi.embed.*` semantic code and a `codes::ALL` registry so a
//! downstream conformance allowed-code validator cannot silently drop a
//! variant. The audit-focus item for this module is "no silent
//! best-effort": every capability-list validation failure surfaces as a
//! typed [`EmbedError`] variant.

use std::fmt;

use super::capability::EmbedCapabilityId;

/// Stable Utsushi embed semantic codes.
pub mod codes {
    pub const INVALID_CAPABILITY: &str = "utsushi.embed.invalid_capability";
    pub const DUPLICATE_CAPABILITY: &str = "utsushi.embed.duplicate_capability";
    pub const UNSORTED_CAPABILITIES: &str = "utsushi.embed.unsorted_capabilities";
    pub const CAPABILITIES_TOO_LARGE: &str = "utsushi.embed.capabilities_too_large";

    /// Full set of stable Utsushi embed semantic codes. Conformance schemas
    /// that gate runtime diagnostics by allowed-code list include each of
    /// these.
    pub const ALL: &[&str] = &[
        INVALID_CAPABILITY,
        DUPLICATE_CAPABILITY,
        UNSORTED_CAPABILITIES,
        CAPABILITIES_TOO_LARGE,
    ];
}

/// Diagnostic variants emitted by the embed ABI substrate's capability-list
/// surface. Each variant is constructed by [`super::capability`] and is a
/// stable conformance signal; the substrate never silently best-efforts a
/// capability-list validation failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmbedError {
    /// `EmbedCapability` validation failed (e.g. supported without ceiling,
    /// partial without limitations).
    InvalidCapability {
        capability_id: EmbedCapabilityId,
        reason: String,
    },

    /// Duplicate capability id in the declaration list.
    DuplicateCapability { capability_id: EmbedCapabilityId },

    /// Capability list is unsorted.
    UnsortedCapabilities,

    /// Capability list exceeded `EMBED_MAX_CAPABILITIES`.
    CapabilitiesTooLarge { observed: usize, ceiling: usize },
}

impl EmbedError {
    /// Stable `utsushi.embed.*` semantic code for this variant.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::InvalidCapability { .. } => codes::INVALID_CAPABILITY,
            Self::DuplicateCapability { .. } => codes::DUPLICATE_CAPABILITY,
            Self::UnsortedCapabilities => codes::UNSORTED_CAPABILITIES,
            Self::CapabilitiesTooLarge { .. } => codes::CAPABILITIES_TOO_LARGE,
        }
    }
}

impl fmt::Display for EmbedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::InvalidCapability {
                capability_id,
                reason,
            } => write!(
                formatter,
                "{code}: capability_id={} reason={reason}",
                capability_id.as_str()
            ),
            Self::DuplicateCapability { capability_id } => write!(
                formatter,
                "{code}: capability_id={}",
                capability_id.as_str()
            ),
            Self::UnsortedCapabilities => {
                write!(formatter, "{code}: capability list must be sorted by id")
            }
            Self::CapabilitiesTooLarge { observed, ceiling } => {
                write!(formatter, "{code}: observed={observed} ceiling={ceiling}")
            }
        }
    }
}

impl std::error::Error for EmbedError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn variants() -> Vec<EmbedError> {
        vec![
            EmbedError::InvalidCapability {
                capability_id: EmbedCapabilityId::Snapshot,
                reason: "supported without ceiling".to_string(),
            },
            EmbedError::DuplicateCapability {
                capability_id: EmbedCapabilityId::State,
            },
            EmbedError::UnsortedCapabilities,
            EmbedError::CapabilitiesTooLarge {
                observed: 99,
                ceiling: 32,
            },
        ]
    }

    #[test]
    fn every_embed_error_variant_returns_a_code_in_codes_all() {
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        for variant in variants() {
            let code = variant.semantic_code();
            assert!(
                all.contains(code),
                "code {code} missing from codes::ALL (variant {variant:?})"
            );
        }
        assert_eq!(
            all.len(),
            codes::ALL.len(),
            "codes::ALL must not contain duplicates"
        );
    }

    #[test]
    fn embed_error_display_does_not_leak_host_paths() {
        for variant in variants() {
            let rendered = variant.to_string();
            for forbidden in ["/home/", "/tmp/", "/Users/", "/var/folders/", "file://"] {
                assert!(
                    !rendered.contains(forbidden),
                    "rendered={rendered} contained forbidden substring {forbidden}"
                );
            }
        }
    }

    #[test]
    fn embed_error_implements_std_error() {
        fn assert_std_error<E: std::error::Error + Send + Sync + 'static>(_: &E) {}
        let error = EmbedError::UnsortedCapabilities;
        assert_std_error(&error);
    }

    #[test]
    fn codes_all_starts_with_utsushi_embed_prefix() {
        for code in codes::ALL {
            assert!(
                code.starts_with("utsushi.embed."),
                "code {code} must use the utsushi.embed.* prefix"
            );
        }
    }
}
