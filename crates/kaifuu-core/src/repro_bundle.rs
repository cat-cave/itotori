//! Redacted compatibility REPRODUCTION BUNDLE schema + validator.
//! A reproduction bundle is the shareable, PUBLIC artifact that lets a third
//! party re-derive kaifuu's compatibility results WITHOUT any private corpora.
//! It carries the [`ClaimedSupportTuple`]s (exact shape — engine
//! family, variant, container, crypto, codec, surface, patch-back mode,
//! fixture/profile id, secret-requirement ids, diagnostics, claim + evidence
//! chain), plus a set of top-level **reproduction proofs** (fixture id +
//! [`ProofHash`]) that pin the expected public-fixture result for each claimed
//! tuple. Given the bundle, anyone can run the named public fixtures and check
//! their output against the proof hashes — no retail bytes, no raw keys, no
//! screenshots, no prompt logs, no story text, no private paths ever cross the
//! boundary.
//! # The two mechanical guarantees
//! 1. **Reject-on-private (acceptance 2).** [`validate_repro_bundle`] walks
//!    every free-text-bearing string field of the bundle and rejects the six
//!    private-asset classes — [`PrivateAssetClass::RawKey`],
//!    [`PrivateAssetClass::PrivatePath`], [`PrivateAssetClass::RetailBytes`],
//!    [`PrivateAssetClass::Screenshot`], [`PrivateAssetClass::PromptLog`],
//!    [`PrivateAssetClass::StoryText`]. Each rejection is a structured
//!    [`PrivateAssetViolation`] that NAMES the bundle id, the tuple id (when the
//!    offending string lives inside an embedded tuple), and the field that
//!    failed (acceptance 4). The violation carries only the class + a redacted
//!    message — never the offending value.
//! 2. **Self-sufficiency (acceptance 3).** The proof hashes + fixture ids must
//!    be enough to reproduce the public-fixture results with no private-corpus
//!    reference: every reproduction proof must resolve to an embedded tuple, and
//!    every embedded tuple must be backed by at least one reproduction proof.
//!    Anything less is a typed [`ReproductionGap`] and the bundle is not
//!    self-sufficient.
//!    Secret material and proof hashes are carried through the STRONGLY-TYPED
//!    [`SecretRef`] / [`ProofHash`] wrappers (which reject raw material at
//!    deserialize time), so the private-asset scan only needs to police the plain
//!    string fields where smuggling is otherwise possible.

#[cfg(test)]
#[path = "repro_bundle_tests.rs"]
mod tests;
include!("repro_bundle_parts/001.rs");
include!("repro_bundle_parts/002.rs");
