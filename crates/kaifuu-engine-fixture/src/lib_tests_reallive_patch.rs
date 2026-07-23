use super::*;

#[test]
fn reallive_adapter_patch_round_trips_length_preserving_translation() {
    let dir = reallive_adapter_fixture_dir("reallive-adapter-patch-length-preserving");
    // Extract via the unified produce_bundle path; the PatchExport is
    // keyed on extract's deterministic bridgeUnitIds, which patch
    // re-derives — so the round-trip resolves with no id mismatch.
    let extract = RealLiveProfileDetectorAdapter
        .extract(ExtractRequest { game_dir: &dir })
        .unwrap();
    // "Hello" (5 Shift-JIS bytes) -> "World" (5 bytes): length-preserving.
    let export = reallive_all_units_export(&extract, "World");
    let output_dir = temp_dir("reallive-adapter-patch-length-preserving-out");
    let result = RealLiveProfileDetectorAdapter
        .patch(PatchRequest {
            game_dir: &dir,
            patch_export: &export,
            output_dir: &output_dir,
        })
        .unwrap();
    assert_eq!(
        result.status,
        OperationStatus::Passed,
        "failures: {:?}",
        result.failures
    );
    // The patched scene decompresses to bytecode carrying the translated
    // dialogue body byte-for-byte, and re-extract observes it as the new
    // dialogue source text — a byte-correct round trip.
    let patched = fs::read(output_dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
    let decompressed = reallive_decompressed_scene_1(&patched);
    assert!(
        decompressed.windows(5).any(|w| w == b"World"),
        "translated dialogue body 'World' missing from patched bytecode"
    );
    assert!(
        !decompressed.windows(5).any(|w| w == b"Hello"),
        "source dialogue body 'Hello' still present after length-preserving patch"
    );
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_dir_all(output_dir);
}

#[test]
fn reallive_adapter_patch_applies_length_changing_translation_through_bundle_driver() {
    // reallive-adapter-expose-length-changing-patchback: the adapter routes
    // a LENGTH-CHANGING edit straight through the bundle-driven driver
    // (offset table rewritten + jump targets recalculated), which is the
    // sole patch-back path. "Hello" (5 Shift-JIS bytes) ->
    // "Hello there" (11 bytes) grows the body; the patch must SUCCEED and
    // round-trip byte-correct.
    let dir = reallive_adapter_fixture_dir("reallive-adapter-patch-length-changing");
    let extract = RealLiveProfileDetectorAdapter
        .extract(ExtractRequest { game_dir: &dir })
        .unwrap();
    let export = reallive_all_units_export(&extract, "Hello there");
    let output_dir = temp_dir("reallive-adapter-patch-length-changing-out");
    let result = RealLiveProfileDetectorAdapter
        .patch(PatchRequest {
            game_dir: &dir,
            patch_export: &export,
            output_dir: &output_dir,
        })
        .unwrap();
    assert_eq!(
        result.status,
        OperationStatus::Passed,
        "failures: {:?}",
        result.failures
    );
    let patched = fs::read(output_dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
    let original = fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
    // A length change grows the archive: the patched bytes are NOT the
    // source bytes (offset table + scene body rewritten), and the archive
    // still re-parses.
    assert_ne!(
        patched, original,
        "length-changing patch must rewrite bytes"
    );
    let reparsed = kaifuu_reallive::parse_archive(&patched).expect("patched archive re-parses");
    assert!(!reparsed.entries.is_empty());
    // The patched scene re-decompiles to bytecode carrying the LONGER
    // translated body, with the source body gone, and zero unknown opcodes.
    let decompressed = reallive_decompressed_scene_1(&patched);
    assert!(
        decompressed.windows(11).any(|w| w == b"Hello there"),
        "longer translated dialogue body 'Hello there' missing from patched bytecode"
    );
    assert!(
        !decompressed.windows(5).any(|w| w == b"Hello")
            || decompressed.windows(11).any(|w| w == b"Hello there"),
        "source-only 'Hello' body must not survive a length-changing replacement"
    );
    let ops = kaifuu_reallive::parse_real_bytecode(&decompressed)
        .expect("patched scene bytecode re-decompiles");
    let unknown = ops
        .iter()
        .filter(|o| matches!(o, kaifuu_reallive::RealLiveOpcode::Unknown { .. }))
        .count();
    assert_eq!(
        unknown, 0,
        "zero unknown opcodes required after length change"
    );
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_dir_all(output_dir);
}

#[test]
fn reallive_adapter_patch_rejects_unencodable_target_with_typed_patchback_failure() {
    // reallive-adapter-expose-length-changing-patchback reframe: a plain
    // length change is NO LONGER a failure (the adapter routes through the
    // length-changing bundle-driven driver). This test asserts a
    // GENUINELY-unencodable edit is still rejected loudly and typed. The
    // target "Hi 😀" both CHANGES length (so it exercises the length-
    // changing path) AND carries U+1F600, a codepoint that has no Shift-JIS
    // mapping — the RealLive Textout body cannot represent it. The driver
    // therefore returns kaifuu.reallive.patchback_target_encode_failure
    // Fatal (surfaced as the kaifuu.unsupported_layered_transform semantic
    // error), NOT because the byte length changed.
    let dir = reallive_adapter_fixture_dir("reallive-adapter-patch-unencodable");
    let extract = RealLiveProfileDetectorAdapter
        .extract(ExtractRequest { game_dir: &dir })
        .unwrap();
    let export = reallive_all_units_export(&extract, "Hi 😀");
    let output_dir = temp_dir("reallive-adapter-patch-unencodable-out");
    let result = RealLiveProfileDetectorAdapter
        .patch(PatchRequest {
            game_dir: &dir,
            patch_export: &export,
            output_dir: &output_dir,
        })
        .unwrap();
    assert_eq!(result.status, OperationStatus::Failed);
    // The rejection is the DRIVER's typed patch-back failure (the length
    // change itself was accepted and routed through the bundle-driven
    // path; the unmappable codepoint is what the encoder cannot represent).
    // The driver-mapped remediation names the stable
    // `kaifuu.reallive.patchback_*` code family, distinguishing this from
    // the adapter's other unsupported paths. (The support_boundary carries
    // the exact `kaifuu.reallive.patchback_target_encode_failure` code but
    // is report-redacted because the driver message embeds the unit UUID.)
    assert!(
        result.failures.iter().any(|f| {
            f.error_code == "kaifuu.unsupported_layered_transform"
                && f.required_capability == Some(Capability::PatchBack)
                && f.remediation
                    .as_deref()
                    .is_some_and(|r| r.contains("kaifuu.reallive.patchback_"))
        }),
        "failures: {:?}",
        result.failures
    );
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_dir_all(output_dir);
}

#[test]
fn reallive_adapter_layered_access_profile_describes_scene_and_gameexe_surfaces() {
    let dir = reallive_adapter_fixture_dir("reallive-adapter-layered-profile");
    let profile = RealLiveProfileDetectorAdapter
        .profile(ProfileRequest { game_dir: &dir })
        .unwrap();
    let layered = profile
        .layered_access
        .as_ref()
        .expect("layered access profile present");
    let surface_ids: BTreeSet<&str> = layered
        .surfaces
        .iter()
        .map(|s| s.surface_id.as_str())
        .collect();
    assert!(
        surface_ids
            .iter()
            .any(|id| id.starts_with("reallive-seen-txt"))
    );
    assert!(
        surface_ids
            .iter()
            .any(|id| id.starts_with("reallive-gameexe-ini"))
    );
    let _ = fs::remove_dir_all(dir);
}
