use super::*;

fn reference_report() -> AssetOcrReport {
    run_asset_ocr(AssetOcrRequest {
        asset_bytes: &render_reference_title_card(),
        asset_name: "title-card.png",
    })
    .expect("reference title card decodes")
}

#[test]
fn committed_public_fixture_png_matches_renderer_bytes() {
    // The public fixture PNG is byte-pinned to `render_reference_title_card`.
    // Set KAIFUU_026_REGEN=1 to (re)write it after an intentional change.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/public/ocr-ui/title-card.png");
    let rendered = render_reference_title_card();
    if std::env::var_os("KAIFUU_026_REGEN").is_some() {
        std::fs::write(&path, &rendered).expect("regen png");
    }
    let committed = std::fs::read(&path).expect("committed fixture png");
    assert_eq!(
        committed, rendered,
        "committed OCR fixture PNG drifted from the renderer; regen with KAIFUU_026_REGEN=1"
    );
}

#[test]
fn png_round_trips_through_the_stored_codec() {
    let png = render_reference_title_card();
    let image = decode_grayscale_png(&png).expect("decode");
    assert_eq!(image.width, 50);
    assert_eq!(image.height, 43);
    // Re-encoding the decoded pixels is byte-identical (determinism).
    let reencoded = encode_grayscale_png(image.width, image.height, &image.pixels);
    assert_eq!(reencoded, png);
}

#[test]
fn detects_five_regions_in_scan_order() {
    let report = reference_report();
    let ids: Vec<&str> = report
        .text_regions
        .iter()
        .map(|region| region.region_id.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "region-0001",
            "region-0002",
            "region-0003",
            "region-0004",
            "region-0005"
        ]
    );
}

#[test]
fn confident_regions_recover_exact_text() {
    let report = reference_report();
    let recovered: Vec<String> = report
        .confident_regions()
        .map(|region| region.recognition.recovered_text.clone().unwrap())
        .collect();
    assert_eq!(recovered, ["NEW", "GAME", "LOAD"]);
    for region in report.confident_regions() {
        assert!(!region.recognition.is_uncertain);
        assert_eq!(region.recognition.confidence, OcrConfidence::High);
        // A confident region is NEVER surfaced as a finding.
        assert!(report.finding(&region.region_id).is_none());
    }
}

#[test]
fn uncertain_ocr_becomes_a_finding_not_truth() {
    // The corrupted "LOAD" (region-0004) is a plausible read, but because it
    // is not an EXACT glyph match the region must NOT assert recovered text;
    // instead it is a finding whose candidate is explicitly evidence-only.
    let report = reference_report();
    let region = report
        .text_regions
        .iter()
        .find(|region| region.region_id == "region-0004")
        .expect("corrupted region present");
    assert!(
        region.recognition.recovered_text.is_none(),
        "uncertain OCR must not be asserted as recovered text"
    );
    assert!(region.recognition.is_uncertain);

    let finding = report
        .finding("region-0004")
        .expect("uncertain region is surfaced as a finding");
    assert_eq!(finding.code, "uncertain_text_region");
    assert_eq!(finding.severity, PartialDiagnosticSeverity::P2);
    // The candidate carries provenance + confidence (its "source") and is a
    // labelled candidate — never promoted to recovered_text / truth.
    assert_eq!(finding.source.candidate_text.as_deref(), Some("LOAD"));
    assert!(finding.source.confidence_score > 0.0);
    assert_eq!(finding.source.provenance.width, region.provenance.width);

    // The confident "LOAD" (region-0003) proves the SAME text CAN be truth
    // when the read is exact — so the difference is confidence, not vocab.
    let confident = report
        .text_regions
        .iter()
        .find(|region| region.region_id == "region-0003")
        .unwrap();
    assert_eq!(
        confident.recognition.recovered_text.as_deref(),
        Some("LOAD")
    );
    assert!(report.finding("region-0003").is_none());
}

#[test]
fn noise_block_is_an_unrecognized_finding() {
    let report = reference_report();
    let finding = report
        .finding("region-0005")
        .expect("noise block is a finding");
    assert_eq!(finding.code, "unrecognized_region");
    assert!(finding.source.candidate_text.is_none());
    assert_eq!(finding.source.confidence, OcrConfidence::Low);
}

#[test]
fn regions_and_glyph_cells_carry_stable_content_hashes() {
    let report = reference_report();
    for region in &report.text_regions {
        assert!(region.content_hash.as_str().starts_with("sha256:"));
        assert_eq!(
            region.provenance.asset_content_hash,
            report.asset.content_hash
        );
        for cell in &region.recognition.glyph_cells {
            assert!(cell.content_hash.as_str().starts_with("sha256:"));
            assert_eq!(cell.width, GLYPH_W);
            assert_eq!(cell.height, GLYPH_H);
        }
    }
    // Determinism: two runs produce byte-identical JSON.
    let a = reference_report().stable_json().unwrap();
    let b = reference_report().stable_json().unwrap();
    assert_eq!(a, b);
}

#[test]
fn finding_count_matches_uncertain_regions() {
    let report = reference_report();
    let uncertain = report
        .text_regions
        .iter()
        .filter(|region| region.recognition.is_uncertain)
        .count();
    assert_eq!(report.findings.len(), uncertain);
    assert_eq!(report.findings.len(), 2);
}
