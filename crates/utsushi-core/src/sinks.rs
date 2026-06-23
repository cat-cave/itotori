//! Forward-additive placeholder for UTSUSHI-022.
//!
//! UTSUSHI-022 owns the headless text/render/audio sink surface. That
//! node will replace this empty trait with the real interface and
//! remove the `#[doc(hidden)]` shroud.
//!
//! TODO(UTSUSHI-022): replace with the real runtime sinks interface.

/// Forward-additive trait stub. Owner: UTSUSHI-022. Review date: as soon
/// as the headless sinks node lands.
#[doc(hidden)]
pub trait RuntimeSinks: Send + Sync + std::fmt::Debug {}
