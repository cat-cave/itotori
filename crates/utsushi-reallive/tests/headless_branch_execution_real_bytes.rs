//! Real-bytes acceptance for `reallive-utsushi-headless-branch-execution`.
//!
//! Drives a full scene of BOTH titles (Sweetie HD + Kanon) to its NATURAL
//! TERMINUS by EXECUTING real RealLive control flow — Jump / Subroutine
//! FarCall FOLLOWED across the multi-scene store, NOT linear-walked — using
//! a deterministic headless input-provider ([`HeadlessInputScheduler`]
//! policy = always the first choice) to advance past pause / wait-for-click
//! yields and to resolve choices.
//!
//! # What "natural terminus" means here
//!
//! A RealLive scene ends either by running off its bytecode / halting
//! ([`BranchTerminus::EndOfScene`]) or, for a scene that is itself a
//! subroutine (entered by a parent via `farcall`), by executing its
//! top-level `ret` / `rtl` ([`BranchTerminus::ReturnedToCaller`] when driven
//! STANDALONE with an empty call stack). Both are natural termini: the scene
//! ran its real control flow to completion. A standalone-driven subroutine
//! scene typically reaches `ReturnedToCaller`; an ENTRY scene driven with the
//! deterministic event-flag model (see `headless_entry_scene_*` below) runs
//! its full opening and reaches `EndOfScene`.
//!
//! # Acceptance asserted
//!  1. A deterministic headless input-provider advances past waits + selects
//!     choices (documented AlwaysFirst policy; determinism asserted).
//!  2. For BOTH titles, a full scene drives to its natural terminus by
//!     EXECUTING real control flow (transfers > 0, incl. subroutine/far
//!     calls + returns), with ZERO fail-soft Unknown skips and ZERO
//!     SceneNotFound on the executed path.
//!  3. Cross-scene Jump/FarCall is FOLLOWED across the store (≥1 scene
//!     visits >1 scene).
//!  4. Byte-deterministic (two runs → identical report) + snapshot/restore
//!     identity at every tick boundary.
//!  5. Branch-following is DISTINCT from the retained linear-walk
//!     cataloguing registrar (same scene: linear-walk → EndOfScene with zero
//!     transfer state; branch-following → executed transfers > 0).
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE
//! (no opt-out; these `#[ignore]`-d suites run only in the periodic
//! ground-truth oracle, `just real-bytes-oracle`, where corpora are staged).
//! Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon>
//! cargo test -p utsushi-reallive --test headless_branch_execution_real_bytes
//! -- --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;
#[path = "support/xor2_staging.rs"]
mod xor2_staging;
include!("headless_branch_execution_real_bytes_parts/001.rs");
include!("headless_branch_execution_real_bytes_parts/002.rs");
