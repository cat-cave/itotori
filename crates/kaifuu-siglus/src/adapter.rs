//! pure Siglus extraction + patching adapter for profiled
//! `Scene.pck` / `Gameexe.dat` variants.
//! This module is the **pure adapter** layer: it EXTRACTS and PATCHES profiled
//! Siglus containers and it OWNS the filesystem write for patch-back, but it
//! does **not** discover keys. The distinction from the known-key
//! smoke ([`crate::known_key_smoke`]) is the seam:
//! - the smoke resolves its own (synthetic) key internally — a self-contained
//!   demonstration;
//! - the adapter is *handed* an already-resolved [`ResolvedSiglusKey`]: a
//!   structured secret-ref + a [`KeyValidationProof`] + the raw material the
//!   key-discovery layer (static-key / secret store) produced. The
//!   adapter **re-validates the proof against the material before consuming it**
//!   (validate-before-consume) and never persists, logs, or serializes the raw
//!   bytes.
//! # What this adapter proves (all on profiled fixtures)
//! - **Extract** profiled `Scene` / `Gameexe` text + metadata with a resolved key.
//! - **Identity round-trip** — re-emit an unedited container **byte-identical**
//!   to the input.
//! - **Translated round-trip** — apply translated edits so the in-scope units
//!   decode to the new text AND every out-of-scope byte survives identical.
//! - **Patch + verify** to disk: atomic write, and — crucially —
//!   **reject-before-write**. Every failure class (unsupported/protected variant,
//!   key-proof mismatch, in-profile verify failure, or a reject-on-secret
//!   finding) returns `Err` with **no output file written**.
//! - **Reject-on-secret** — before any write the output bytes + the redacted
//!   report are deep-scanned; a raw key or decrypted-text leak fails loud.
//! # Honest scope / real-bytes gap
//! Like the smoke, the profiled format here is the narrow constant-key-XOR,
//! UTF-16LE, uncompressed-within-profile container — NOT the real
//! constant-256-XOR-table + per-game second-layer strip and proprietary-LZSS
//! codec (those remain the proprietary-LZSS skeleton). Out-of-profile
//! compression / magic is a typed capability error, never a silent pass. No real retail Siglus
//! `Scene.pck` / `Gameexe.dat` bytes are available in the vault/scratch as of
//! this node, so validation is on profiled synthetic fixtures; the real-bytes
//! gap is documented in `docs/kaifuu-siglus-pure-adapter-capability.md`.

include!("adapter_parts/001.rs");
include!("adapter_parts/002.rs");
include!("adapter_parts/003.rs");
