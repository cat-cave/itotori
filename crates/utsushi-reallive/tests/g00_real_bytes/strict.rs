use super::coherence::{content_err_kind, metadata_err_kind};
use super::*;

fn assert_strict_validator_accepts_clean_decodes(title: &str, g00_dir: &PathBuf) {
    let entries = fs::read_dir(g00_dir).unwrap_or_else(|err| {
        panic!(
            "failed to walk {title} g00 dir {}: {err}",
            g00_dir.display()
        )
    });

    let mut total = 0usize;
    let mut decode_err = 0usize;
    let mut clean = 0usize;
    let mut warned = 0usize;
    // Informational: how the strict validator treats the decoder's
    // already-flagged (warned) files. Not asserted — strict may reject these.
    let mut validate_ok_on_warned = 0usize;
    let mut validate_err_on_warned = 0usize;
    // The load-bearing failures: files the decoder decoded CLEANLY but the
    // strict validator / probe rejected. Any entry here is a real false
    // rejection, not a proof gap.
    let mut clean_rejections: Vec<(String, &'static str)> = Vec::new();
    let mut probe_rejections: Vec<(String, &'static str)> = Vec::new();

    for entry in entries {
        let path = entry.expect("DirEntry").path();
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("g00"))
        {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        total += 1;
        let Ok((_image, warnings)) = decode_g00(&bytes) else {
            decode_err += 1;
            continue;
        };
        if !warnings.is_empty() {
            warned += 1;
            match validate_g00_lzss_content(&bytes) {
                Ok(_) => validate_ok_on_warned += 1,
                Err(_) => validate_err_on_warned += 1,
            }
            continue;
        }
        clean += 1;
        // Core invariant: a cleanly-decoded real file must not be rejected by
        // the strict content validator.
        if let Err(err) = validate_g00_lzss_content(&bytes) {
            clean_rejections.push((
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                content_err_kind(&err),
            ));
        }
        // Probe pattern 0 must likewise accept a cleanly-decoded file.
        if let Err(err) = probe_g00_pattern_geometry(&bytes, 0) {
            probe_rejections.push((
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                metadata_err_kind(&err),
            ));
        }
    }

    eprintln!(
        "{title} strict-validator vs decoder: total={total} decode_err={decode_err} \
         clean={clean} warned={warned} (warned→validate_ok={validate_ok_on_warned} \
         validate_err={validate_err_on_warned}) clean_rejections={} probe_rejections={}",
        clean_rejections.len(),
        probe_rejections.len(),
    );

    assert!(
        clean > 0,
        "{title}: expected at least one cleanly-decoded g00 file"
    );

    // Build a discriminant histogram + a small sample for any failure message.
    let summarize = |label: &str, rejects: &[(String, &'static str)]| -> String {
        let mut counts: std::collections::BTreeMap<&'static str, usize> =
            std::collections::BTreeMap::new();
        for (_, kind) in rejects {
            *counts.entry(kind).or_default() += 1;
        }
        let sample: Vec<String> = rejects
            .iter()
            .take(10)
            .map(|(name, kind)| format!("{name} → {kind}"))
            .collect();
        format!(
            "{title}: {label} strict validator false-rejected {} of {clean} cleanly-decoded \
             files — histogram={counts:?}; sample={sample:?}. These are real files the tolerant \
             decoder accepts with zero warnings; do NOT weaken the validator to force a pass — \
             this is a real correctness finding.",
            rejects.len(),
        )
    };

    assert!(
        clean_rejections.is_empty(),
        "{}",
        summarize("validate_g00_lzss_content", &clean_rejections),
    );
    assert!(
        probe_rejections.is_empty(),
        "{}",
        summarize("probe_g00_pattern_geometry", &probe_rejections),
    );
}

#[test]
fn g00_strict_validator_accepts_real_corpus_both_titles() {
    let mut ran = false;
    for need in [real_corpus::PRIMARY, real_corpus::SECONDARY] {
        if let Some(dir) = real_corpus::g00_dir_for(need) {
            ran = true;
            assert_strict_validator_accepts_clean_decodes(need.engine, &dir);
        }
    }
    if !ran {
        real_corpus::require_real_bytes(
            "utsushi-reallive g00 strict-validator vs decoder (needs reallive/1/encrypted or reallive/2/plain)",
        );
    }
}
