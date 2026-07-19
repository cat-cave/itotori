//! Redacted live-corpus calibration for the RealLive detector.
//!
//! The test exercises only the adapter's Rust API. It emits title labels and
//! boolean structural signals; it never prints paths, hashes, or corpus bytes.

use std::path::PathBuf;

use kaifuu_core::{DetectRequest, DetectionResult, EngineAdapter, EvidenceStatus};
use kaifuu_engine_fixture::RealLiveProfileDetectorAdapter;

const CORPORA_ENV: &str = "ITOTORI_REALLIVE_DETECTOR_CORPORA";

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

fn configured_corpora() -> Option<Vec<CorpusRoot>> {
    let configured = std::env::var(CORPORA_ENV).ok()?;
    let mut corpora = Vec::new();
    for item in configured.split(';').filter(|item| !item.is_empty()) {
        let (label, path) = item.split_once('=')?;
        if label.is_empty() || path.is_empty() {
            return None;
        }
        corpora.push(CorpusRoot {
            label: label.to_string(),
            path: PathBuf::from(path),
        });
    }
    (!corpora.is_empty()).then_some(corpora)
}

#[test]
fn detects_configured_real_corpora_with_redacted_signal_evidence() {
    let Some(corpora) = configured_corpora() else {
        eprintln!("SKIP: {CORPORA_ENV} is unset or malformed");
        return;
    };
    if corpora.iter().any(|corpus| !corpus.path.is_dir()) {
        eprintln!("SKIP: a configured RealLive corpus directory is unavailable");
        return;
    }

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
