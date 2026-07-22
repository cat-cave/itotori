use super::*;

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD)"]
fn patch_render_composes_patchback_and_render_on_real_bytes() {
    let Some(seen_path) = real_corpus::seen_txt_path() else {
        real_corpus::require_real_bytes("patch_render_composes_patchback_and_render_on_real_bytes");
        return;
    };
    let gameexe_path = real_corpus::gameexe_ini_path().expect("Gameexe.ini path");
    // The g00 asset directory lives under REALLIVEDATA next to Seen.txt; the
    // command discovers `g00/` under `--game-dir` on its own.
    let game_dir = seen_path.parent().expect("Seen.txt parent").to_path_buf();

    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    let gameexe_bytes = fs::read(&gameexe_path).expect("read Gameexe.ini");

    // 1. Build the translated script (v0.2 bundle) and write it to scratch.
    let bundle_json = build_translated_bundle_json(&seen_bytes, &gameexe_bytes);

    let work_dir = std::env::temp_dir().join(format!(
        "utsushi-cli-patch-render-{}-{}",
        std::process::id(),
        DIALOGUE_SCENE_ID
    ));
    let _ = fs::remove_dir_all(&work_dir);
    fs::create_dir_all(&work_dir).expect("create work dir");
    let bundle_path = work_dir.join("translated-bundle.json");
    fs::write(&bundle_path, &bundle_json).expect("write translated bundle");

    // Output paths — ALL under the (uncommitted) work dir: the patched
    // Seen.txt (game-derived bytes), the public + private PNG artifact roots
    // and the JSON evidence report.
    let patched_seen = work_dir.join("patched").join("Seen.txt");
    let artifact_root = work_dir.join("artifacts");
    let private_root = work_dir.join("private-render");
    let evidence_path = work_dir.join("evidence.json");

    // 2. Drive the actual composed `patch-render` binary. Config-parameterized:
    //    engine + real data-root paths + scene + scope + redaction, no
    //    hard-coded game path anywhere in the shipped command.
    let output = Command::new(cli_bin())
        .args([
            "patch-render",
            "--engine",
            "reallive",
            "--seen",
            &seen_path.display().to_string(),
            "--translated-bundle",
            &bundle_path.display().to_string(),
            "--scene",
            &DIALOGUE_SCENE_ID.to_string(),
            "--gameexe",
            &gameexe_path.display().to_string(),
            "--game-dir",
            &game_dir.display().to_string(),
            "--patched-seen-output",
            &patched_seen.display().to_string(),
            "--artifact-root",
            &artifact_root.display().to_string(),
            "--private-artifact-root",
            &private_root.display().to_string(),
            "--scope",
            "dialogue",
            "--redaction",
            "on",
            "--expect-text-contains",
            EXPECT_CONTAINS,
            "--message-index",
            "0",
            "--run-id",
            "patch-render-real-bytes",
            "--output",
            &evidence_path.display().to_string(),
        ])
        .output()
        .expect("spawn utsushi-cli patch-render");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("patch-render stdout:\n{stdout}");
    if !output.status.success() {
        panic!(
            "patch-render failed (status {:?}):\n{stderr}",
            output.status.code()
        );
    }
    assert!(
        stdout.contains("utsushi.reallive.patch_render_ok"),
        "composed command must print the patch_render_ok diagnostic; got:\n{stdout}"
    );

    // 3a. The PATCHED Seen.txt exists and differs from the source (the
    //     translation was really spliced in).
    let patched_bytes = fs::read(&patched_seen).expect("patched Seen.txt written");
    assert!(
        !patched_bytes.is_empty(),
        "patched Seen.txt must carry the archive bytes"
    );
    assert_ne!(
        patched_bytes, seen_bytes,
        "patched Seen.txt must differ from the source (the translation must be spliced in)"
    );
    // The patched archive must still re-parse with the same scene shape.
    let reparsed = parse_archive(&patched_bytes).expect("patched Seen.txt re-parses");
    assert_eq!(
        reparsed.entries.len(),
        parse_archive(&seen_bytes).unwrap().entries.len(),
        "patched archive must preserve the source scene-directory shape"
    );

    // 3b. The REDACTED public PNG exists on disk (a real localized frame), and
    //     the private full-fidelity PNG exists in the gitignored private tree.
    let public_pngs = find_pngs(&artifact_root);
    assert!(
        !public_pngs.is_empty(),
        "the composed command must emit a redacted public PNG under {}",
        artifact_root.display()
    );
    let private_pngs = find_pngs(&private_root);
    assert!(
        !private_pngs.is_empty(),
        "the composed command must emit a private full-fidelity PNG under {}",
        private_root.display()
    );

    // 3c. The JSON evidence report: patch half + render half, redaction-clean.
    let evidence: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&evidence_path).expect("read evidence.json"))
            .expect("evidence.json parses");
    let evidence_raw = fs::read_to_string(&evidence_path).expect("read evidence.json text");

    assert_eq!(evidence["command"], "patch-render");
    assert_eq!(evidence["engine"], "reallive");
    assert_eq!(evidence["sceneId"], DIALOGUE_SCENE_ID);
    assert_eq!(evidence["scope"], "dialogue");

    // Patch half: source vs patched hashes differ; a non-zero unit count.
    let patch = &evidence["patch"];
    let source_sha = patch["sourceSeenSha256"]
        .as_str()
        .expect("sourceSeenSha256");
    let patched_sha = patch["patchedSeenSha256"]
        .as_str()
        .expect("patchedSeenSha256");
    assert_ne!(
        source_sha, patched_sha,
        "patch evidence must record distinct source/patched Seen.txt hashes"
    );
    assert!(
        patch["translatedUnitCount"].as_u64().unwrap_or(0) > 0,
        "patch evidence must record a non-zero translated unit count"
    );

    // Render half: E2, redaction on, the rendered message carries the
    // TRANSLATED text (containsExpected == true), through the real pipeline.
    let render = &evidence["render"];
    assert_eq!(render["evidenceTier"], "E2");
    assert_eq!(render["redaction"], "on");
    assert_eq!(
        render["containsExpected"], true,
        "the rendered message must carry the translated text the config asked for"
    );
    assert_eq!(render["renderedLineCount"], 1);
    assert!(
        render["textlineCount"].as_u64().unwrap_or(0) > 0,
        "render evidence must record the observed play-order message count"
    );
    assert!(
        render["artifactId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "render evidence must carry the frame artifact id"
    );

    // Redaction-clean: the committable JSON leaks NO absolute filesystem path
    // and NO raw translated text — only ids / sha256 / counts.
    assert!(
        !evidence_raw.contains(&work_dir.display().to_string()),
        "evidence JSON must not leak the operator's work-dir path"
    );
    assert!(
        !evidence_raw.contains(EXPECT_CONTAINS),
        "evidence JSON must not embed the raw translated text (redaction-clean)"
    );

    eprintln!(
        "patch-render OK: scene {DIALOGUE_SCENE_ID} source_seen={} patched_seen={} bytes, \
         translated_units={}, public_pngs={}, private_pngs={}, render_tier={}, contains_expected={}",
        seen_bytes.len(),
        patched_bytes.len(),
        patch["translatedUnitCount"],
        public_pngs.len(),
        private_pngs.len(),
        render["evidenceTier"],
        render["containsExpected"],
    );

    // Frames stay uncommitted: clean up the scratch work dir.
    let _ = fs::remove_dir_all(&work_dir);
}
