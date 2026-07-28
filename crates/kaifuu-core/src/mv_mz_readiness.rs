//! RPG Maker MV/MZ JSON-text readiness record + public fixture generator
//! This module is the **declaration substrate** the later MV/MZ slices
//! (map / database / plugin-profile,..112) consume. It pins
//! exactly which `www/data/*.json` surfaces the adapter is ready to
//! *inventory* as JSON text, and — mechanically separate from that — it
//! records that the engine's encrypted image/audio media is **not**
//! extractable or patchable by this node.
//! # Two mechanically-distinct evidence channels
//! 1. [`MvMzJsonTextSurface`] — a JSON-text surface the adapter inventories.
//!    Every such surface flows through an [`IdentityContainer`]: a plain
//!    project directory, UTF-8 JSON-text codec, JSON-pointer addressing,
//!    in-place JSON rewrite on patch-back. There is **no** cryptographic leg
//!    (`crypto == NullKey`) and the codec is never a media codec.
//! 2. [`EncryptedMediaDiagnostic`] — an encrypted `*.rpgmvp` / `*.rpgmvm` /
//!    `*.rpgmvo` media surface. Each one is hard-pinned `extractable = false`
//!    and `patchable = false` with a media codec and a non-identity crypto
//!    leg.
//!    The distinction is **not prose**. [`MvMzReadinessRecord::validate`]
//!    returns structured [`MvMzReadinessViolation`]s — never `Ok` — if a
//!    JSON-text surface ever claims a media codec or a crypto transform, or if
//!    an encrypted-media diagnostic is ever marked extractable or patchable.
//!    Downstream slices and ALPHA-004's capability matrix gate on `validate`.
//! # Fixtures are public + deterministic
//! [`mv_mz_fixture_manifest`] / [`generate_mv_mz_fixture_tree`] emit only
//! synthetic public JSON (`System.json`, `Map001.json`, `CommonEvents.json`,
//! database files) plus a manifest of ids / relative paths / SHA-256 content
//! hashes / byte counts. No retail bytes, no private paths, no screenshots,
//! and **no encrypted asset bytes** are ever written — the encrypted-media
//! channel is metadata (globs / kinds / ids) only.

include!("mv_mz_readiness_parts/001.rs");
include!("mv_mz_readiness_parts/002.rs");
include!("mv_mz_readiness_parts/003.rs");
