//! Test-only admission guard for staging recovered `xor_2` bytecode.
//!
//! A successful recovery is usable only after every eligible scene was
//! decrypted. The fixed error deliberately carries no report fields: those
//! fields describe a private corpus and must not leak through test output.

use std::fmt;

use kaifuu_reallive::{
    XOR2_SEGMENT_LENGTH, XOR2_SEGMENT_OFFSET, Xor2DecScene, Xor2Report, recover_and_decrypt_archive,
};

/// Stable, sanitized refusal emitted when an eligible xor2 corpus is not
/// completely ready for staging.
pub const XOR2_NOT_READY: &str = "kaifuu.reallive.xor2_validation_failed";

/// Error returned by [`require_xor2_ready`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Xor2NotReady;

impl fmt::Display for Xor2NotReady {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(XOR2_NOT_READY)
    }
}

impl std::error::Error for Xor2NotReady {}

/// Require a recoverable xor2 corpus to be fully decrypted before staging it.
///
/// A corpus with no eligible scenes needs no cipher staging. Every eligible
/// corpus must have both a validated recovery and one in-place decrypt for
/// every eligible scene. The returned error is intentionally fixed and does
/// not expose report counts, findings, hashes, or corpus details.
pub fn require_xor2_ready(report: &Xor2Report) -> Result<(), Xor2NotReady> {
    if report.scenes_eligible == 0
        || (report.validated && report.scenes_decrypted == report.scenes_eligible)
    {
        Ok(())
    } else {
        Err(Xor2NotReady)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLANTED_KEY: [u8; 16] = [
        0x97, 0x02, 0xcb, 0x5a, 0x83, 0x0f, 0x5e, 0x30, 0xa7, 0x66, 0xe5, 0x37, 0x62, 0x3f, 0x9a,
        0xdc,
    ];

    fn clean_scene(triples: usize) -> Vec<u8> {
        let mut bytecode = Vec::with_capacity(triples * 3);
        for _ in 0..triples {
            bytecode.extend_from_slice(&[0x0a, 0x00, 0x00]);
        }
        bytecode
    }

    fn stage_xor2(bytecode: &mut [u8]) {
        for offset in 0..XOR2_SEGMENT_LENGTH {
            let Some(byte) = bytecode.get_mut(XOR2_SEGMENT_OFFSET + offset) else {
                break;
            };
            *byte ^= PLANTED_KEY[offset % PLANTED_KEY.len()];
        }
    }

    #[test]
    fn actual_clean_eligible_recovery_is_accepted() {
        let mut scenes: Vec<Xor2DecScene> = (0..6)
            .map(|index| {
                let mut bytecode = clean_scene(220 + index * 7);
                stage_xor2(&mut bytecode);
                Xor2DecScene {
                    compiler_version: 110002,
                    bytecode,
                }
            })
            .collect();

        let report = recover_and_decrypt_archive(&mut scenes);
        assert!(report.validated);
        assert_eq!(report.scenes_decrypted, report.scenes_eligible);
        assert!(require_xor2_ready(&report).is_ok());
    }

    #[test]
    fn noneligible_recovery_is_accepted() {
        let mut scenes = vec![Xor2DecScene {
            compiler_version: 10002,
            bytecode: clean_scene(220),
        }];

        let report = recover_and_decrypt_archive(&mut scenes);
        assert_eq!(report.scenes_eligible, 0);
        assert!(require_xor2_ready(&report).is_ok());
    }

    #[test]
    fn malformed_eligible_recovery_is_rejected_without_report_leakage() {
        let mut scenes: Vec<Xor2DecScene> = (0..3)
            .map(|scene| Xor2DecScene {
                compiler_version: 110002,
                bytecode: (0..600u32)
                    .map(|offset| {
                        ((offset.wrapping_mul(2_654_435_761).wrapping_add(scene * 7)) >> 13) as u8
                    })
                    .collect(),
            })
            .collect();

        let report = recover_and_decrypt_archive(&mut scenes);
        assert!(report.scenes_eligible > 0);
        assert!(!report.validated);
        let error = require_xor2_ready(&report).expect_err("malformed eligible corpus is refused");
        assert_eq!(error.to_string(), XOR2_NOT_READY);
        assert!(
            report
                .finding
                .as_deref()
                .is_none_or(|finding| !error.to_string().contains(finding)),
            "the stable staging error must not contain a recovery finding"
        );
        assert!(
            !error
                .to_string()
                .contains(&report.scenes_eligible.to_string()),
            "the stable staging error must not contain report counts"
        );
    }

    #[test]
    fn validated_partial_report_is_rejected() {
        let report = Xor2Report {
            segment_offset: XOR2_SEGMENT_OFFSET,
            segment_length: XOR2_SEGMENT_LENGTH,
            key_len: PLANTED_KEY.len(),
            scenes_total: 2,
            scenes_eligible: 2,
            baseline_clean: 0,
            after_clean: 2,
            scenes_decrypted: 1,
            validated: true,
            key_sha256: Some("not-a-secret".to_owned()),
            finding: None,
        };

        assert_eq!(
            require_xor2_ready(&report)
                .expect_err("a partial in-place decrypt is not stageable")
                .to_string(),
            XOR2_NOT_READY
        );
    }
}
