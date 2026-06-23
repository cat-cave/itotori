//! Forward-additive placeholder for UTSUSHI-021.
//!
//! UTSUSHI-021 owns the deterministic input/clock + replay log surface.
//! That node will replace this empty trait with the real interface and
//! remove the `#[doc(hidden)]` shroud. Until then, this stub exists so
//! [`crate::RuntimeRequest::replay_log`] has a typed slot and additive
//! merges between UTSUSHI-021 and UTSUSHI-103 do not need to widen the
//! struct again.
//!
//! TODO(UTSUSHI-021): replace with the real replay log interface.

/// Forward-additive trait stub. Owner: UTSUSHI-021. Review date: as soon
/// as the deterministic input/clock node lands.
#[doc(hidden)]
pub trait ReplayLogHandle: Send + Sync + std::fmt::Debug {}
