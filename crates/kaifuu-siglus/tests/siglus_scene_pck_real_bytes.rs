//! Env-gated real-bytes proof for the full `Scene.pck` **payload** decode.
//!
//! Copyrighted title bytes stay outside this repository, so the two game roots
//! are supplied via environment variables. Each root holds both
//! `SiglusEngine.exe` and `Scene.pck`. When either root is absent the test
//! reports a skip and succeeds; when both are present it proves the full
//! per-scene payload decode end-to-end.
//!
//! Both target titles set `extra_key_use`: their scene payloads are masked with
//! a per-game 16-byte second-layer key. That key is the **exe-angou** key, now
//! recovered in-process from `SiglusEngine.exe` bytes by
//! [`recover_exe_angou_key`] (a static PE scan — no Wine, no execution; see the
//! companion `siglus_exe_angou_key_real_bytes` proof). Wiring the recovered key
//! into [`decode_scene_pack`] decodes every scene through the documented
//! `exe-key XOR -> constant scene-table XOR -> LZSS` pipeline. This test proves:
//!   1. every scene decodes to a non-empty payload (karetoshi = 298 scenes,
//!      gamekoi = 278 scenes), the histogram accounts for every one, and the
//!      sanitized report carries only counts / sizes / sha256 prefixes / the
//!      key's secret-ref + one-way commitment — never raw scene or key bytes;
//!   2. a **wrong** key fails scene 0 with the typed `compressed_size_mismatch`
//!      diagnostic (a wrong cipher/key), not garbage or a partial decode; and
//!   3. a **missing** key fails scene 0 with the typed `second_layer_key_required`
//!      diagnostic — both gates fire BEFORE any decompressed byte is produced.
//!
//! Set the env var to either the game directory or a path inside it.

use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    SceneDecodeError, SiglusSecondLayerKey, SiglusSecondLayerMaterial, decode_scene_chunk,
    decode_scene_pack, parse_scene_pck, recover_exe_angou_key,
};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

/// The two owned titles' expected scene counts (order-independent across the
/// two env vars). karetoshi packs 298 scenes, gamekoi 278.
const EXPECTED_SCENE_COUNTS: [usize; 2] = [298, 278];

/// Resolve a game root env var to `(SiglusEngine.exe, Scene.pck)` paths, or a
/// clean skip when the var is unset / the files are absent.
fn title_paths(variable: &str) -> Option<(PathBuf, PathBuf)> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus Scene.pck real bytes: {variable} is unset");
        None
    })?;
    let root = PathBuf::from(value);
    // Accept either the game directory or a direct file inside it.
    let dir = if root.is_dir() {
        root
    } else {
        root.parent().map(Path::to_path_buf).unwrap_or(root)
    };
    let exe = dir.join("SiglusEngine.exe");
    let scene = dir.join("Scene.pck");
    if exe.is_file() && scene.is_file() {
        Some((exe, scene))
    } else {
        eprintln!(
            "SKIP siglus Scene.pck real bytes: {variable} has no SiglusEngine.exe + Scene.pck \
             under {}",
            dir.display()
        );
        None
    }
}

/// Decode one real title's `Scene.pck` with its recovered exe-angou key and
/// prove the full-payload acceptance shape. Returns the scene count so the
/// caller can pin the {298, 278} set order-independently.
fn exercise_title(exe_path: &Path, scene_path: &Path, label: &str) -> usize {
    let exe_bytes = std::fs::read(exe_path).expect("read real SiglusEngine.exe");
    let scene_bytes = std::fs::read(scene_path).expect("read real Scene.pck");

    // (0) Recover the per-game second-layer (exe-angou) key in-process — never a
    // raw literal, always the encapsulated redacting/zeroizing material.
    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/exe-angou"));
    let recovery = recover_exe_angou_key(&exe_bytes, &key_ref)
        .unwrap_or_else(|error| panic!("{label}: exe-angou key recovery failed: {error}"));

    // Container reader: the full SceneList is recovered from real bytes.
    let index = parse_scene_pck(&scene_bytes).expect("real Scene.pck envelope parses");
    assert!(
        index.extra_key_use,
        "{label}: target title is expected to set extra_key_use"
    );
    let scene_count = index.entries.len();

    // (1) Full payload decode WITH the recovered key: every scene decodes.
    let report = decode_scene_pack(&scene_bytes, Some(recovery.material()))
        .expect("real Scene.pck decode report builds");
    eprintln!(
        "REAL {label}: scenes={} decoded={} failed={} histogram={:?}",
        report.scene_count, report.decoded_count, report.failed_count, report.size_histogram
    );
    assert_eq!(report.scene_count, scene_count);
    assert!(report.extra_key_use);
    assert!(
        report.fully_decoded(),
        "{label}: expected every scene to decode, got {} failures: {:?}",
        report.failed_count,
        report.failures
    );
    assert_eq!(report.decoded_count, scene_count);
    assert_eq!(report.failed_count, 0);
    assert!(report.failures.is_empty());
    assert_eq!(report.scene_digests.len(), scene_count);

    // Every decoded payload is non-empty and the histogram accounts for all of
    // them (bucket counts sum to the scene count) — sizes only, no bytes.
    assert!(
        report
            .scene_digests
            .iter()
            .all(|digest| digest.decompressed_len > 0),
        "{label}: a scene decoded to an empty payload"
    );
    let histogram_total: usize = report.size_histogram.values().copied().sum();
    assert_eq!(
        histogram_total, scene_count,
        "{label}: histogram buckets ({histogram_total}) do not account for every scene"
    );

    // The report attests WHICH key was used via a one-way commitment + secret-ref
    // — never the raw key bytes.
    assert_eq!(
        report.second_layer_secret_ref.as_deref(),
        Some(key_ref.secret_ref())
    );
    assert!(report.second_layer_key_sha256_prefix.is_some());

    // The serialized report must not leak the recovered key's commitment as raw
    // bytes; only sanitized digests. (A full no-raw-bytes contract is proven by
    // the synthetic `siglus_scene_pck_no_leak` test.)
    let json = serde_json::to_string(&report).expect("report serializes");
    assert!(
        json.contains(&report.second_layer_key_sha256_prefix.clone().unwrap()),
        "{label}: report should carry the key commitment prefix"
    );

    // (2) Wrong key fails scene 0 with the typed compressed_size mismatch, BEFORE
    // any output — a deliberately-wrong 16-byte key, not the recovered one.
    let first = &index.entries[0];
    let start = first.byte_offset as usize;
    let chunk = &scene_bytes[start..start + first.byte_len as usize];
    let wrong = SiglusSecondLayerMaterial::resolve(
        &SiglusSecondLayerKey::from_secret_ref("secret://test/wrong-scene-key"),
        vec![0xA5u8; 16],
    )
    .expect("16-byte wrong key resolves");
    let wrong_err = decode_scene_chunk(first.scene_id, chunk, index.extra_key_use, Some(&wrong))
        .expect_err("wrong key must fail");
    assert!(
        matches!(wrong_err, SceneDecodeError::CompressedSizeMismatch { .. }),
        "{label}: wrong key should trip the compressed_size guard, got {wrong_err}"
    );

    // (3) Missing key fails scene 0 with the typed key-required diagnostic.
    let missing_err = decode_scene_chunk(first.scene_id, chunk, index.extra_key_use, None)
        .expect_err("missing key must fail");
    assert!(
        matches!(missing_err, SceneDecodeError::SecondLayerKeyRequired { .. }),
        "{label}: missing key should be the typed key-required gate, got {missing_err}"
    );

    // The right key decodes scene 0 to a non-empty payload (the positive control
    // for the two negatives above).
    let decoded = decode_scene_chunk(
        first.scene_id,
        chunk,
        index.extra_key_use,
        Some(recovery.material()),
    )
    .expect("right key decodes scene 0");
    assert!(
        !decoded.is_empty(),
        "{label}: scene 0 decoded to an empty payload"
    );

    eprintln!(
        "REAL {label}: full payload decode OK ({scene_count} scenes); wrong-key and missing-key \
         both gated with typed diagnostics before output"
    );
    scene_count
}

#[test]
fn two_real_siglus_scene_packs_decode_full_payloads() {
    let Some((first_exe, first_scene)) = title_paths(FIRST_TITLE_ENV) else {
        return;
    };
    let Some((second_exe, second_scene)) = title_paths(SECOND_TITLE_ENV) else {
        return;
    };
    let first_count = exercise_title(&first_exe, &first_scene, "siglus-title-one");
    let second_count = exercise_title(&second_exe, &second_scene, "siglus-title-two");

    // Both owned titles' payloads decode fully, at their known scene counts
    // (order-independent across the two env vars).
    let mut observed = [first_count, second_count];
    let mut expected = EXPECTED_SCENE_COUNTS;
    observed.sort_unstable();
    expected.sort_unstable();
    assert_eq!(
        observed, expected,
        "expected the two owned titles' scene counts {EXPECTED_SCENE_COUNTS:?}, got {observed:?}"
    );
}
