//! Wolf RPG Editor ADAPTER: core text tables extract + patch
//! through the layered container → crypto → codec → patch-back pipeline.
//! This node is an ADAPTER built as a COMPOSITION over the existing Wolf
//! substrate — it reimplements NONE of the crypto or detection:
//! - **Container + crypto (layer 1+2)** — reuses the encrypted-archive
//!   substrate ([`crate::wolf_encrypted_smoke`]): the Wolf-like container is
//!   packed/unpacked by [`pack_encrypted_archive`] / [`decrypt_archive_members`],
//!   the fixture-only XOR crypto key is resolved BY REF through
//!   [`WolfEncryptedFixtureSecretResolver`], and the raw key lives only inside the
//!   zeroize-on-drop [`WolfEncryptedArchiveKey`]. The adapter drives the SAME
//!   layer — a decrypted member's payload just carries a binary text table
//!   instead of a text file. This is the "cite smoke evidence before
//!   broad support claims" gate made mechanical.
//! - **Codec (layer 3)** — this node adds the Wolf text-table codec: a binary
//!   string-table layout (record/field cells addressed by (offset,len) into a
//!   Shift-JIS string blob) that [`decode_wolf_text_table`] extracts into text
//!   cells and [`encode_wolf_text_table`] reconstructs. Patching a cell to a
//!   different byte length rewrites every downstream string offset — a real
//!   binary-layout change (the "String table reconstruction" audit focus).
//! - **Patch-back (layer 4)** — a configurable patch engine applies a LIST of
//!   [`WolfTextPatchRequest`]s by (table, record, field) coordinate, re-encodes
//!   the affected tables, and repacks/re-encrypts through the same container+
//!   crypto layer. The round-trip verifies the patched text is present and every
//!   unchanged table is byte-identical.
//! # Gating: detector + helper boundary decide support (never a per-game branch)
//! Every run first combines the protection detector
//! ([`run_wolf_protection_detector`]) and the helper boundary
//! ([`run_wolf_helper_boundary`]) over the fixture's embedded evidence:
//! - the detector must classify the container `protected` (a concrete static-key
//!   requirement), and
//! - the helper boundary must report `key_resolved` (the key resolved locally by
//!   ref).
//!   Only then does the adapter extract + patch. Any other posture (an unknown or
//!   unsupported protection variant, a missing key, a helper-gated key) is an
//!   UNSUPPORTED outcome that emits a semantic capability diagnostic carrying the
//!   claimed-support tuple context — never a panic, never a silent drop, and never
//!   an extract/patch attempt.
//! # Engine-general (Wolf = data, no per-game branch)
//! A [`WolfTextTableAdapterFixture`] is pure DATA: the detector record, the
//! keyRef-bound helper-boundary profile, the synthetic text tables, and the
//! patch requests. The runner has no per-game branch; every Wolf game is a
//! data-driven fixture.
//! # Evidence is synthetic, redacted, ref-only
//! Fixtures carry NO retail bytes and NO raw key material. The key is resolved by
//! ref and never emitted; every emitted [`WolfTextTableAdapterReport`] carries
//! only ids, refs, byte counts, coordinates, and one-way sha256 hashes — never
//! the decoded table text, the raw key, or a local path.

mod run;
#[cfg(test)]
#[path = "wolf_adapter_tests.rs"]
mod tests;
include!("wolf_adapter_parts/001.rs");
include!("wolf_adapter_parts/002.rs");
