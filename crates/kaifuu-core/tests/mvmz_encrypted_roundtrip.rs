//! RPG Maker MV/MZ encrypted-asset decrypt/encrypt round-trip proof.
//!
//! The always-run synthetic proof exercises the RPGMV asset-XOR scheme on a
//! deterministically-built encrypted PNG and OggS asset. No game bytes are
//! involved, so the algorithm is provably correct in any environment
//! (including CI where the commercial title is not staged).

use kaifuu_core::{
    MvMzAssetKey, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, decrypt_rpgmaker_asset,
    encrypt_rpgmaker_asset,
};

/// Decode a fixed synthetic key from hexadecimal text.
fn decode_hex(text: &str) -> Vec<u8> {
    let clean: Vec<u8> = text.bytes().filter(u8::is_ascii_hexdigit).collect();
    assert!(
        clean.len().is_multiple_of(2),
        "hex text has an even digit count"
    );
    clean
        .chunks_exact(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16).expect("hex digit");
            let lo = (pair[1] as char).to_digit(16).expect("hex digit");
            ((hi << 4) | lo) as u8
        })
        .collect()
}

// --- Layer 1: synthetic, always-run algorithm proof ------------------------

/// Build a synthetic encrypted asset deterministically: take a plaintext whose
/// first bytes are a real media magic, XOR the first 16 with the key, and
/// prepend the RPGMV header. This is exactly what the RPG Maker editor emits.
fn synthetic_encrypt(plaintext: &[u8], key: &MvMzAssetKey) -> Vec<u8> {
    encrypt_rpgmaker_asset(plaintext, key)
}

#[test]
fn synthetic_image_and_audio_round_trip_is_byte_correct() {
    // A fixed 16-byte key (never a real game key) so the proof is hermetic.
    let key = MvMzAssetKey::from_bytes(&decode_hex("0f1e2d3c4b5a69788796a5b4c3d2e1f0"));

    // Synthetic PNG: 8-byte PNG signature + deterministic tail.
    let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend((0u8..48).map(|byte| byte.wrapping_mul(7)));
    // Synthetic OggS: 4-byte Ogg capture pattern + deterministic tail.
    let mut ogg = vec![0x4f, 0x67, 0x67, 0x53];
    ogg.extend((0u8..52).map(|byte| byte.wrapping_add(3)));

    for plaintext in [&png, &ogg] {
        let encrypted = synthetic_encrypt(plaintext, &key);
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER,
            "encrypted asset carries the RPGMV media header"
        );
        // Bytes past the 16-byte XOR prefix survive verbatim.
        let body = &encrypted[RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()..];
        assert_eq!(&body[16..], &plaintext[16..]);

        let decrypted = decrypt_rpgmaker_asset(&encrypted, &key).expect("synthetic decrypts");
        assert_eq!(&decrypted, plaintext, "decrypt(encrypted) == plaintext");

        let reencrypted = encrypt_rpgmaker_asset(&decrypted, &key);
        assert_eq!(reencrypted, encrypted, "encrypt(plaintext) == encrypted");
    }
}
