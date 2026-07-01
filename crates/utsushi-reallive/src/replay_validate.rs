//! UTSUSHI-227 — patched-Seen.txt replay-and-verify smoke.
//!
//! Library half of the alpha-defining "verifiable patch landed" gate.
//! Drives [`crate::replay::replay_scene`] against a (patched) Seen.txt
//! path, walks the captured [`ReplayLog`] for [`ReplayEvent::TextLine`]
//! events, and reports — as a typed [`ReplayValidation`] — whether the
//! expected substring appears in **any** TextLine body (either the
//! UTF-8 decode the substrate sink produced or a fresh
//! `encoding_rs::SHIFT_JIS` decode of the raw bytes).
//!
//! # Posture
//!
//! - **No silent fallbacks.** Missing TextLine → `Ok(NoMatch { ... })`,
//!   not `Ok(())`. Driver-level failures (read, parse, decode) surface
//!   as the named [`crate::ReplayError`] variants the caller already
//!   handles.
//! - **Deterministic.** The validator does NOT mutate the underlying
//!   [`ReplayLog`]; two invocations against the same Seen.txt produce
//!   the same `ReplayValidation` value AND byte-equal
//!   `to_deterministic_json` output (preserved from UTSUSHI-220's
//!   invariant).
//! - **Substring contract.** A TextLine matches when:
//!     1. its `body_utf8` field contains the substring verbatim, OR
//!     2. an `encoding_rs::SHIFT_JIS` decode of `body_shift_jis`
//!        contains the substring.
//!
//!   Case (2) catches the KAIFUU-211 path where the patchback wrote
//!   Shift-JIS bytes that the substrate sink's decode pass may have
//!   coalesced or partially flushed — the raw bytes are the
//!   byte-stable evidence.
//! - **Regression-sentinel contract.** The caller (test author) is
//!   responsible for choosing a substring that does not appear in the
//!   ORIGINAL unpatched copy. This module does not enforce that — the
//!   integration test does, by running the validator on both copies
//!   and asserting the original returns `NoMatch`. The contract is
//!   documented in `utsushi-cli replay-validate --help`.
//!
//! # Public surface
//!
//! - [`ReplayValidation`] — typed match/no-match outcome with sampling
//!   detail for the no-match path.
//! - [`validate_replay_contains`] — the path-based driver function used
//!   by the integration test and command-line wrapper.
//! - [`validate_log_contains`] — used by `utsushi-cli replay-validate`
//!   to share the match/no-match logic with tests.

use std::path::Path;

use crate::replay::{ReplayError, ReplayEvent, ReplayLog, ReplayOpts, replay_scene};

/// Maximum number of TextLine bodies sampled into the `NoMatch` arm's
/// `sample_bodies` field. Bounded so a no-match log on a long scene
/// does not produce a multi-megabyte diagnostic payload.
pub const NO_MATCH_SAMPLE_BODIES_CAP: usize = 8;

/// Maximum byte length of an individual sample body in the `NoMatch`
/// arm. The caller can request the full ReplayLog through the generic
/// CLI's `--print-replay-log` flag; this cap keeps the printable
/// diagnostic terse without truncating evidence.
pub const NO_MATCH_SAMPLE_BODY_BYTE_CAP: usize = 256;

/// Typed result of [`validate_replay_contains`].
///
/// - [`ReplayValidation::Matched`] carries the index (into
///   [`ReplayLog::events`]) of the matching event and the body that
///   carried the substring. The body is the UTF-8 form (either
///   `body_utf8` directly or the Shift-JIS-redecoded form, whichever
///   matched) so a diagnostic printer can echo it verbatim.
/// - [`ReplayValidation::NoMatch`] carries the total count of TextLine
///   events observed plus a bounded sample of their bodies. The sample
///   is deterministic (first N bodies, truncated at
///   [`NO_MATCH_SAMPLE_BODY_BYTE_CAP`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayValidation {
    /// At least one TextLine event's body contained the expected
    /// substring.
    Matched {
        /// Index of the matching event in [`ReplayLog::events`].
        matching_event_index: usize,
        /// The body the substring was found in (UTF-8 form).
        body_utf8: String,
    },
    /// No TextLine event's body contained the expected substring.
    NoMatch {
        /// Number of [`ReplayEvent::TextLine`] events the log contained.
        textline_count: u32,
        /// Deterministic, bounded sample of TextLine bodies for the
        /// no-match diagnostic. Capped at [`NO_MATCH_SAMPLE_BODIES_CAP`]
        /// entries, each truncated to
        /// [`NO_MATCH_SAMPLE_BODY_BYTE_CAP`] bytes.
        sample_bodies: Vec<String>,
    },
}

impl ReplayValidation {
    /// Convenience predicate for CLI exit-code paths.
    pub fn matched(&self) -> bool {
        matches!(self, ReplayValidation::Matched { .. })
    }
}

/// Drive [`replay_scene`] against `seen_path`, then check whether any
/// captured [`ReplayEvent::TextLine`] body contains `expected_substring`.
///
/// The two substring-check arms are:
///
/// 1. `body_utf8.contains(expected_substring)` — the substrate sink's
///    UTF-8 form.
/// 2. `encoding_rs::SHIFT_JIS.decode(body_shift_jis).contains(expected_substring)`
///    — a fresh Shift-JIS decode of the raw bytes captured alongside
///    the UTF-8 form. This is the byte-stable evidence path.
///
/// A match on either arm yields [`ReplayValidation::Matched`]; if no
/// TextLine satisfies either arm, the function returns
/// [`ReplayValidation::NoMatch`] with the count + bounded sample.
///
/// Returns [`ReplayError`] only when the underlying driver fails (read,
/// parse, decode). A scene that emits zero TextLine events is NOT an
/// error — it is the canonical no-match input and surfaces as
/// `Ok(NoMatch { textline_count: 0, sample_bodies: vec![] })`.
pub fn validate_replay_contains(
    seen_path: &Path,
    scene_id: u16,
    expected_substring: &str,
) -> Result<ReplayValidation, ReplayError> {
    let opts = ReplayOpts::default();
    let log = replay_scene(seen_path, scene_id, &opts)?;
    Ok(validate_log_contains(&log, expected_substring))
}

/// Same as [`validate_replay_contains`] but operates on a pre-captured
/// [`ReplayLog`]. Centralised so the integration test can validate a
/// log produced via [`crate::replay::replay_scene_bytes`] (synthetic
/// path) without re-driving the VM.
pub fn validate_log_contains(log: &ReplayLog, expected_substring: &str) -> ReplayValidation {
    let mut textline_count: u32 = 0;
    let mut sample_bodies: Vec<String> = Vec::new();
    for (event_index, event) in log.events.iter().enumerate() {
        let ReplayEvent::TextLine {
            body_shift_jis,
            body_utf8,
            ..
        } = event
        else {
            continue;
        };
        textline_count = textline_count.saturating_add(1);

        if body_utf8.contains(expected_substring) {
            return ReplayValidation::Matched {
                matching_event_index: event_index,
                body_utf8: body_utf8.clone(),
            };
        }
        // Re-decode the raw Shift-JIS bytes through encoding_rs. This
        // catches the case where the substrate sink's flush path
        // produced a body whose UTF-8 form differs from a fresh
        // Shift-JIS decode (e.g. partial flush, mid-pair coalescing).
        let (redecoded, _encoding, _had_errors) = encoding_rs::SHIFT_JIS.decode(body_shift_jis);
        if redecoded.contains(expected_substring) {
            return ReplayValidation::Matched {
                matching_event_index: event_index,
                body_utf8: redecoded.into_owned(),
            };
        }

        if sample_bodies.len() < NO_MATCH_SAMPLE_BODIES_CAP {
            sample_bodies.push(truncate_for_sample(body_utf8));
        }
    }

    ReplayValidation::NoMatch {
        textline_count,
        sample_bodies,
    }
}

/// Truncate a body to [`NO_MATCH_SAMPLE_BODY_BYTE_CAP`] bytes, snapping
/// to a UTF-8 character boundary so the diagnostic stays valid UTF-8.
fn truncate_for_sample(body: &str) -> String {
    if body.len() <= NO_MATCH_SAMPLE_BODY_BYTE_CAP {
        return body.to_string();
    }
    // Find the largest char boundary at or below the cap.
    let mut boundary = NO_MATCH_SAMPLE_BODY_BYTE_CAP;
    while boundary > 0 && !body.is_char_boundary(boundary) {
        boundary -= 1;
    }
    body[..boundary].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::{REPLAY_LOG_SCHEMA_VERSION, ReplayLog, ReplayOutcome};

    fn log_with_text_lines(bodies: &[(&[u8], &str)]) -> ReplayLog {
        let events = bodies
            .iter()
            .enumerate()
            .map(|(index, (shift_jis, utf8))| ReplayEvent::TextLine {
                byte_offset_in_scene: index as u32,
                body_shift_jis: shift_jis.to_vec(),
                body_utf8: (*utf8).to_string(),
            })
            .collect();
        ReplayLog {
            schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
            scene_id: 1,
            events,
            final_outcome: ReplayOutcome::EndOfScene {
                events: bodies.len() as u32,
            },
        }
    }

    #[test]
    fn empty_log_returns_no_match_with_zero_count() {
        let log = ReplayLog {
            schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
            scene_id: 1,
            events: vec![],
            final_outcome: ReplayOutcome::EndOfScene { events: 0 },
        };
        let result = validate_log_contains(&log, "STELLA-ALPHA-227-EN-US");
        match result {
            ReplayValidation::NoMatch {
                textline_count,
                sample_bodies,
            } => {
                assert_eq!(textline_count, 0);
                assert!(sample_bodies.is_empty());
            }
            other @ ReplayValidation::Matched { .. } => {
                panic!("expected NoMatch on empty log, got {other:?}")
            }
        }
    }

    #[test]
    fn substring_present_in_body_utf8_returns_matched() {
        let log = log_with_text_lines(&[(b"\x82\xa0", "「STELLA-ALPHA-227-EN-US」")]);
        let result = validate_log_contains(&log, "STELLA-ALPHA-227-EN-US");
        match result {
            ReplayValidation::Matched {
                matching_event_index,
                body_utf8,
            } => {
                assert_eq!(matching_event_index, 0);
                assert!(body_utf8.contains("STELLA-ALPHA-227-EN-US"));
            }
            other @ ReplayValidation::NoMatch { .. } => panic!("expected Matched, got {other:?}"),
        }
    }

    #[test]
    fn substring_only_in_shift_jis_redecode_returns_matched() {
        // body_utf8 is empty (substrate sink produced no flushed line),
        // but body_shift_jis decodes to the sentinel. This is the
        // alpha-defining "byte-stable evidence" arm.
        let sjis_payload = encoding_rs::SHIFT_JIS
            .encode("「STELLA-ALPHA-227-EN-US」")
            .0
            .into_owned();
        let log = ReplayLog {
            schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
            scene_id: 1,
            events: vec![ReplayEvent::TextLine {
                byte_offset_in_scene: 0,
                body_shift_jis: sjis_payload,
                body_utf8: String::new(),
            }],
            final_outcome: ReplayOutcome::EndOfScene { events: 1 },
        };
        let result = validate_log_contains(&log, "STELLA-ALPHA-227-EN-US");
        assert!(result.matched(), "must match via SJIS redecode arm");
    }

    #[test]
    fn substring_absent_from_all_bodies_returns_no_match_with_samples() {
        let log = log_with_text_lines(&[
            (b"\x82\xa0", "あ"),
            (b"\x82\xa2", "い"),
            (b"\x82\xa4", "う"),
        ]);
        let result = validate_log_contains(&log, "STELLA-ALPHA-227-EN-US");
        match result {
            ReplayValidation::NoMatch {
                textline_count,
                sample_bodies,
            } => {
                assert_eq!(textline_count, 3);
                assert_eq!(sample_bodies.len(), 3);
                assert!(sample_bodies.iter().any(|body| body == "あ"));
            }
            other @ ReplayValidation::Matched { .. } => panic!("expected NoMatch, got {other:?}"),
        }
    }

    #[test]
    fn no_match_sample_is_capped_and_truncated() {
        // Build 20 events whose bodies exceed the per-sample byte cap.
        let large_body = "x".repeat(NO_MATCH_SAMPLE_BODY_BYTE_CAP + 64);
        let events: Vec<ReplayEvent> = (0..20)
            .map(|index| ReplayEvent::TextLine {
                byte_offset_in_scene: index as u32,
                body_shift_jis: vec![0x82, 0xa0],
                body_utf8: large_body.clone(),
            })
            .collect();
        let log = ReplayLog {
            schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
            scene_id: 1,
            events,
            final_outcome: ReplayOutcome::EndOfScene { events: 20 },
        };
        let result = validate_log_contains(&log, "MISSING-SUBSTRING");
        match result {
            ReplayValidation::NoMatch {
                textline_count,
                sample_bodies,
            } => {
                assert_eq!(textline_count, 20);
                assert_eq!(sample_bodies.len(), NO_MATCH_SAMPLE_BODIES_CAP);
                for body in &sample_bodies {
                    assert!(body.len() <= NO_MATCH_SAMPLE_BODY_BYTE_CAP);
                }
            }
            other @ ReplayValidation::Matched { .. } => panic!("expected NoMatch, got {other:?}"),
        }
    }

    #[test]
    fn truncate_snaps_to_utf8_boundary() {
        // 'あ' is 3 bytes in UTF-8. A cap of 1 must produce empty.
        let body = "あい";
        // Override the cap by manually invoking the helper with a tiny
        // body that exceeds the public cap.
        let huge = "あ".repeat(NO_MATCH_SAMPLE_BODY_BYTE_CAP);
        let truncated = truncate_for_sample(&huge);
        assert!(truncated.len() <= NO_MATCH_SAMPLE_BODY_BYTE_CAP);
        // Round-trips as valid UTF-8 (Rust requires it; the call would
        // panic on slice if not).
        let _ = truncated.chars().count();
        // Short body: untouched.
        assert_eq!(truncate_for_sample(body), body);
    }
}
