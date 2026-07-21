//! WASM embed ABI capability surface ().
//!
//! Engine-neutral capability declaration for browser / WASM embeds of an
//! Utsushi controlled-playback session. The capability list is the canonical
//! answer to "what observable surface does this embed expose?" — a
//! pre-declared, append-only typed enum ([`EmbedCapabilityId`]) paired with a
//! support status and an evidence-tier ceiling ([`EmbedCapability`]).
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
