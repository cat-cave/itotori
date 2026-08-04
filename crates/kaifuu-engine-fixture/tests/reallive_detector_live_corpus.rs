//! Redacted live-corpus calibration for the RealLive detector.
//!
//! The test exercises only the adapter's Rust API. It emits title labels and
//! boolean structural signals; it never prints paths, hashes, or corpus bytes.

use std::path::PathBuf;

use kaifuu_core::{DetectRequest, DetectionResult, EngineAdapter, EvidenceStatus};
use kaifuu_engine_fixture::RealLiveProfileDetectorAdapter;

#[derive(Debug)]
struct CorpusRoot {
    label: String,
    path: PathBuf,
}

#[derive(Debug)]
struct SignalSummary {
    seen_txt_envelope: bool,
    gameexe_ini_keys: bool,
    g00_assets: bool,
    voice_archives: bool,
    avg32_pdt_assets: bool,
    siglus_scene_pck: bool,
    siglus_gameexe_dat: bool,
}

impl SignalSummary {
    fn from_detection(detection: &DetectionResult) -> Self {
        let matched = |kind| {
            detection
                .evidence
                .iter()
                .any(|evidence| evidence.kind == kind && evidence.status == EvidenceStatus::Matched)
        };
        let invalid = |kind| {
            detection
                .evidence
                .iter()
                .any(|evidence| evidence.kind == kind && evidence.status == EvidenceStatus::Invalid)
        };

        Self {
            seen_txt_envelope: matched("reallive_seen_txt_envelope"),
            gameexe_ini_keys: matched("reallive_gameexe_ini_keys"),
            g00_assets: matched("reallive_g00_extension_count"),
            voice_archives: matched("reallive_voice_archive_count"),
            avg32_pdt_assets: invalid("avg32_cross_check_pdt_count"),
            siglus_scene_pck: invalid("siglus_cross_check_scene_pck"),
            siglus_gameexe_dat: invalid("siglus_cross_check_gameexe_dat"),
        }
    }

    fn redacted_line(&self, label: &str, detected: bool) -> String {
        format!(
            "title_label={label}; detected={detected}; seen_txt_envelope={}; gameexe_ini_keys={}; g00_assets={}; voice_archives={}; avg32_pdt_assets={}; siglus_scene_pck={}; siglus_gameexe_dat={}",
            self.seen_txt_envelope,
            self.gameexe_ini_keys,
            self.g00_assets,
            self.voice_archives,
            self.avg32_pdt_assets,
            self.siglus_scene_pck,
            self.siglus_gameexe_dat,
        )
    }
}

fn configured_corpora() -> Vec<CorpusRoot> {
    ["reallive/1/encrypted", "reallive/2/plain"]
        .into_iter()
        .map(|identity| {
            let path = corpus_registry::resolve_identity(identity).unwrap_or_else(|reason| {
                panic!("real-bytes proof not established: {identity}: {reason}")
            });
            assert!(
                path.is_dir(),
                "real-bytes proof not established: {identity} directory is unavailable"
            );
            CorpusRoot {
                label: identity.to_string(),
                path,
            }
        })
        .collect()
}

#[test]
fn detects_configured_real_corpora_with_redacted_signal_evidence() {
    let corpora = configured_corpora();

    let adapter = RealLiveProfileDetectorAdapter;
    for corpus in corpora {
        let detection = adapter
            .detect(DetectRequest {
                game_dir: &corpus.path,
            })
            .expect("readable configured corpus must return a detector result");
        let signals = SignalSummary::from_detection(&detection);
        let evidence = signals.redacted_line(&corpus.label, detection.detected);
        eprintln!("RealLive detector calibration: {evidence}");
        assert!(
            detection.detected,
            "RealLive detector must accept the configured corpus ({evidence})"
        );
    }
}
