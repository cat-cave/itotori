use super::*;
use kaifuu_core::MvMzAssetKey;
use kaifuu_core::mv_mz_encrypted_audio::{OGG_SIGNATURE, SYNTHETIC_OGG};
use kaifuu_core::mv_mz_encrypted_image::{PNG_SIGNATURE, SYNTHETIC_PNG};

const KEY: &[u8; 16] = b"ITOTORIFIXTUREK0";

fn key_hex() -> String {
    let mut out = String::new();
    for byte in KEY {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap());
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap());
    }
    out
}

fn enc_image() -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_PNG, &MvMzAssetKey::from_bytes(KEY))
}

fn enc_audio() -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_OGG, &MvMzAssetKey::from_bytes(KEY))
}

#[test]
fn profile_classifies_subtrees_to_roles() {
    let p = MediaSurfaceProfile::rpg_maker();
    assert_eq!(
        p.classify("www/img/pictures/title.rpgmvp"),
        MediaLocalizationRole::TextBearingImage
    );
    assert_eq!(
        p.classify("www/img/titles1/logo.png_"),
        MediaLocalizationRole::TextBearingImage
    );
    assert_eq!(
        p.classify("www/img/system/Window.rpgmvp"),
        MediaLocalizationRole::UiTexture
    );
    assert_eq!(
        p.classify("www/audio/bgm/Theme.rpgmvo"),
        MediaLocalizationRole::AudioSongMetadata
    );
    assert_eq!(
        p.classify("www/img/characters/Actor1.rpgmvp"),
        MediaLocalizationRole::InventoryOnly
    );
    assert_eq!(
        p.classify("www/audio/se/Cursor.ogg_"),
        MediaLocalizationRole::InventoryOnly
    );
    // Unmatched subtree -> inventory-only (safe default).
    assert_eq!(
        p.classify("www/img/unknownsub/x.rpgmvp"),
        MediaLocalizationRole::InventoryOnly
    );
}

#[test]
fn subtree_match_is_whole_segment() {
    let p = MediaSurfaceProfile::rpg_maker();
    // `img/system` must NOT match `img/systematic`.
    assert_eq!(
        p.classify("www/img/systematic/x.rpgmvp"),
        MediaLocalizationRole::InventoryOnly
    );
}

#[test]
fn text_bearing_image_decrypts_and_is_a_surface() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_image();
    let surface = build_media_surface(
        &p,
        "www/img/pictures/title.rpgmvp",
        &enc,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
    )
    .unwrap();
    assert_eq!(surface.role, MediaLocalizationRole::TextBearingImage);
    assert!(surface.is_localization_surface);
    assert!(surface.decrypt_state.is_decrypted());
    assert_eq!(
        surface.decision.patch_back_mode,
        PatchBackMode::ReEncryptSameKey
    );
    assert!(surface.decision.is_candidate_surface);
    assert!(surface.decision.plaintext_available);
}

#[test]
fn audio_song_metadata_is_a_surface() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_audio();
    let surface = build_media_surface(
        &p,
        "www/audio/bgm/Theme.rpgmvo",
        &enc,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
    )
    .unwrap();
    assert_eq!(surface.role, MediaLocalizationRole::AudioSongMetadata);
    assert_eq!(surface.capability, MediaCapability::Audio);
    assert!(surface.is_localization_surface);
    assert!(surface.decrypt_state.is_decrypted());
}

#[test]
fn inventory_only_asset_is_not_a_surface_and_passes_through() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_image();
    let surface = build_media_surface(
        &p,
        "www/img/characters/Actor1.rpgmvp",
        &enc,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
    )
    .unwrap();
    assert_eq!(surface.role, MediaLocalizationRole::InventoryOnly);
    assert!(!surface.is_localization_surface);
    assert_eq!(
        surface.decision.patch_back_mode,
        PatchBackMode::ByteIdenticalPassthrough
    );
}

#[test]
fn key_absent_is_represented_not_a_crash() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_image();
    let surface = build_media_surface(
        &p,
        "www/img/pictures/title.rpgmvp",
        &enc,
        &MvMzKeySource::None,
    )
    .unwrap();
    // The asset is REPRESENTED without decrypting.
    assert_eq!(surface.decrypt_state, MediaDecryptState::EncryptedKeyAbsent);
    assert!(!surface.decision.plaintext_available);
    assert_eq!(
        surface.decision.patch_back_mode,
        PatchBackMode::HeldPendingKey
    );
    // But it is still a candidate surface (its role says so).
    assert!(surface.is_localization_surface);
    // The encrypted bytes are still committed.
    assert_eq!(surface.encrypted_sha256, sha256_hash_bytes(&enc));
}

#[test]
fn unsupported_suffix_is_a_typed_error() {
    let p = MediaSurfaceProfile::rpg_maker();
    let err = build_media_surface(
        &p,
        "www/movies/opening.webm",
        b"not-media",
        &MvMzKeySource::None,
    )
    .unwrap_err();
    assert!(matches!(err, MediaSurfaceError::UnsupportedSuffix { .. }));
    assert_eq!(err.code(), "kaifuu.rpgmaker.k059.unsupported_suffix");
    assert_eq!(
        err.classify(MediaLocalizationRole::InventoryOnly, false),
        FailureClass::OutOfProfileCapabilityError
    );
}

#[test]
fn replacement_round_trip_is_byte_correct() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_image();
    let surface = build_media_surface(
        &p,
        "www/img/pictures/title.rpgmvp",
        &enc,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
    )
    .unwrap();
    // A real replacement image.
    let mut replacement = PNG_SIGNATURE.to_vec();
    replacement.extend_from_slice(b"k059-localized-title-card-0001");
    let plan = plan_replacement(
        &surface,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        &enc,
        &replacement,
    )
    .unwrap();
    assert!(plan.proof.decrypt_matches_replacement);
    assert!(plan.proof.differs_from_original);
    assert!(plan.proof.identity_byte_preserving);
    // decrypt(encrypt(x)) == x
    let re = decrypt_rpgmaker_asset(&plan.patched_asset, &MvMzAssetKey::from_bytes(KEY)).unwrap();
    assert_eq!(re, replacement);
}

#[test]
fn unchanged_replacement_is_byte_identical() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_image();
    let surface = build_media_surface(
        &p,
        "www/img/pictures/title.rpgmvp",
        &enc,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
    )
    .unwrap();
    // Re-supply the ORIGINAL plaintext as the "replacement".
    let plan = plan_replacement(
        &surface,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        &enc,
        SYNTHETIC_PNG,
    )
    .unwrap();
    assert!(
        !plan.proof.differs_from_original,
        "unchanged must be byte-identical"
    );
    assert_eq!(plan.patched_asset, enc);
}

#[test]
fn inventory_only_replacement_is_refused() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_image();
    let surface = build_media_surface(
        &p,
        "www/img/characters/Actor1.rpgmvp",
        &enc,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
    )
    .unwrap();
    let err = plan_replacement(
        &surface,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        &enc,
        SYNTHETIC_PNG,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        MediaSurfaceError::NotALocalizationSurface { .. }
    ));
}

#[test]
fn key_absent_replacement_is_refused() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_image();
    let surface = build_media_surface(
        &p,
        "www/img/pictures/title.rpgmvp",
        &enc,
        &MvMzKeySource::None,
    )
    .unwrap();
    let err = plan_replacement(&surface, &MvMzKeySource::None, &enc, SYNTHETIC_PNG).unwrap_err();
    assert_eq!(err, MediaSurfaceError::KeyAbsent);
}

#[test]
fn capability_mismatch_replacement_is_refused() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc = enc_audio();
    let surface = build_media_surface(
        &p,
        "www/audio/bgm/Theme.rpgmvo",
        &enc,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
    )
    .unwrap();
    // An image blob patched over an audio asset -> not audio media.
    let mut image = PNG_SIGNATURE.to_vec();
    image.extend_from_slice(b"wrong-kind");
    let err = plan_replacement(
        &surface,
        &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        &enc,
        &image,
    )
    .unwrap_err();
    assert!(matches!(err, MediaSurfaceError::ReplacementNotMedia { .. }));
    // Sanity: a proper Ogg replacement is accepted.
    let mut ogg = OGG_SIGNATURE.to_vec();
    ogg.extend_from_slice(b"k059-localized-song-meta");
    assert!(
        plan_replacement(
            &surface,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
            &enc,
            &ogg,
        )
        .is_ok()
    );
}

#[test]
fn wrong_key_on_profiled_surface_is_a_declared_profile_regression() {
    let err = MediaSurfaceError::WrongKey {
        capability: MediaCapability::Image,
    };
    // Profiled surface + key available -> a bug/regression, not a feature request.
    assert_eq!(
        err.classify(MediaLocalizationRole::TextBearingImage, true),
        FailureClass::DeclaredProfileRegression
    );
    // Inventory-only or no key -> an expected capability error.
    assert_eq!(
        err.classify(MediaLocalizationRole::InventoryOnly, true),
        FailureClass::OutOfProfileCapabilityError
    );
}

#[test]
fn manifest_counts_surfaces_and_redacts_paths() {
    let p = MediaSurfaceProfile::rpg_maker();
    let enc_img = enc_image();
    let enc_aud = enc_audio();
    let ks = MvMzKeySource::SystemJsonEncryptionKey(key_hex());
    let surfaces = vec![
        build_media_surface(&p, "www/img/pictures/a.rpgmvp", &enc_img, &ks).unwrap(),
        build_media_surface(&p, "www/audio/bgm/b.rpgmvo", &enc_aud, &ks).unwrap(),
        build_media_surface(&p, "www/img/characters/c.rpgmvp", &enc_img, &ks).unwrap(),
    ];
    let manifest = MediaSurfaceManifest::new(&p, surfaces);
    assert_eq!(manifest.localization_surface_count, 2);
    assert_eq!(manifest.inventory_only_count, 1);
    assert_eq!(manifest.decisions().len(), 3);
    let json = manifest.stable_json().unwrap();
    // Report-safe: roles + sha256 commitments present, but NEVER the key
    // hex and NEVER decrypted media bytes. (Structural paths are kept, as in
    // the media inventory.)
    assert!(json.contains("text_bearing_image"));
    assert!(json.contains(&sha256_hash_bytes(&enc_img)));
    assert!(!json.contains(&key_hex()));
    assert!(!json.contains("ITOTORIFIXTUREK0"));
}
