//! Softpal `verify`: re-decode the resolved scripts and assert the
//! decode-integrity bar (0 dangling pointers, every dialogue line + present
//! speaker resolved to a `TEXT.DAT` record boundary).

use kaifuu_core::sha256_hash_bytes;
use kaifuu_softpal::{ScriptScan, TextDat};

use super::*;

impl SoftpalProfileDetectorAdapter {
    /// Re-decode the resolved scripts and assert the decode-integrity bar
    /// (0 dangling pointers, every dialogue line + present speaker resolved).
    pub(crate) fn run_verify(
        &self,
        request: VerifyRequest<'_>,
    ) -> KaifuuResult<VerificationResult> {
        let scripts = Self::resolve_scripts(request.game_dir)?;
        let scan =
            ScriptScan::parse(&scripts.script).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.script.parse: {err}").into()
            })?;
        let textdat =
            TextDat::parse(&scripts.textdat).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.textdat.parse: {err}").into()
            })?;
        let disassembly = scan.resolve(&textdat);
        let dangling = disassembly.dangling_pointer_count();
        let unresolved_dialogue = disassembly.unresolved_dialogue_text_count();
        let unresolved_speaker = disassembly.unresolved_speaker_count();
        let mut failures = Vec::new();
        if dangling > 0 || unresolved_dialogue > 0 || unresolved_speaker > 0 {
            failures.push(Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::Verification,
                "softpal",
                scripts.source_ref.clone(),
                format!(
                    "decode-integrity check failed: {dangling} dangling pointer(s), \
                     {unresolved_dialogue} unresolved dialogue line(s), \
                     {unresolved_speaker} unresolved speaker name(s)"
                ),
                "re-extract from an intact Softpal title; the disassembler expects 0 on real bytes",
            ));
        }
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-verify", 12),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            output_hash: sha256_hash_bytes(&scripts.script),
            failures,
        })
    }
}
