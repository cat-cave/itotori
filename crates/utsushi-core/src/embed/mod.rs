//! WASM embed ABI capability surface (UTSUSHI-024).
//!
//! Engine-neutral capability declaration for browser / WASM embeds of an
//! Utsushi controlled-playback session. The capability list is the canonical
//! answer to "what observable surface does this embed expose?" — a
//! pre-declared, append-only typed enum ([`EmbedCapabilityId`]) paired with a
//! support status and an evidence-tier ceiling ([`EmbedCapability`]).
//!
//! The capability surface is consumed by the reference recorder
//! (`crate::recorder`), which records an [`EmbedCapability`] snapshot in
//! [`sort_capabilities`] order at finalize time.
//!
//! Capability ids are an append-only typed enum. New variants are added at
//! the end of [`EmbedCapabilityId`]; ordering is stable on both
//! `(EmbedCapabilityId as u8, EmbedCapabilityId::as_str())` so a numeric
//! reshuffle preserves lexicographic order. Capability-validation failures
//! surface as a typed [`EmbedError`].

pub mod capability;
pub mod diagnostics;

pub use capability::{
    EMBED_MAX_CAPABILITIES, EmbedCapability, EmbedCapabilityId, EmbedCapabilityStatus,
    sort_capabilities, validate_capability_list,
};
pub use diagnostics::EmbedError;
