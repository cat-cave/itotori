//! - profiled Wolf encrypted archive extract + patch.
//!   This module composes the existing Wolf pieces into a data-driven profiled
//!   archive/protection-key workflow:
//! - container + crypto: [`crate::wolf_encrypted_smoke`]
//!   pack/decrypt using [`crate::wolf_encrypted_smoke::WolfEncryptedArchiveKey`]
//!   (zeroize-on-drop, `Debug` redacted);
//! - text surface: [`crate::wolf_adapter`] Shift-JIS text-table
//!   codec and patch coordinates; and
//! - key/helper evidence: a concrete [`SecretRef`] and, for helper-gated
//!   profiles, a [`crate::HelperResult`] bound to that EXACT ref.
//!   A claimed profile that cannot extract + patch is a compatibility BUG:
//!   [`WolfProfiledProductionError::ClaimedProfileFailed`]. Unclaimed profiles are
//!   explicit out-of-scope rows. All fixtures are synthetic.

mod run;
include!("wolf_profiled_production_parts/001.rs");
include!("wolf_profiled_production_parts/002.rs");
