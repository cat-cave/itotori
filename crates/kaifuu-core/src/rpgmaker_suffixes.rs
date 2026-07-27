use super::*;

pub(crate) const RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES: &[&str] = &[
    "rpgmvp", "rpgmvm", "rpgmvo", "rpgmvu", "png_", "m4a_", "ogg_",
];
pub(crate) const RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN: &str =
    "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.rpgmvu|*.png_|*.m4a_|*.ogg_";
pub(crate) const RPG_MAKER_MV_MZ_PLAIN_SUFFIXES: &[&str] = &["png", "m4a", "ogg"];
pub(crate) const RPG_MAKER_MV_MZ_PLAIN_SUFFIX_PATTERN: &str = "*.png|*.m4a|*.ogg";
pub(crate) const RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES: &[&str] = &["webp_"];
pub(crate) const RPG_MAKER_MV_MZ_UNKNOWN_SUFFIX_PATTERN: &str = "*.webp_";

pub(crate) struct RpgMakerSuffixProfile {
    suffix: &'static str,
    fixture_id: &'static str,
    variant: &'static str,
    surface: &'static str,
    crypto: CryptoTransform,
    codec: CodecTransform,
    key_required: bool,
    unknown_crypto: bool,
}

pub(crate) const RPG_MAKER_MV_MZ_SUFFIX_PROFILES: &[RpgMakerSuffixProfile] = &[
    RpgMakerSuffixProfile {
        suffix: "rpgmvp",
        fixture_id: "kaifuu-rpgmaker-mv-image-rpgmvp",
        variant: "mv_or_mz",
        surface: "image_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::PngImage,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "rpgmvm",
        fixture_id: "kaifuu-rpgmaker-mv-audio-rpgmvm",
        variant: "mv_or_mz",
        surface: "audio_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::M4aAudio,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "rpgmvo",
        fixture_id: "kaifuu-rpgmaker-mv-audio-rpgmvo",
        variant: "mv_or_mz",
        surface: "audio_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::OggAudio,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "png_",
        fixture_id: "kaifuu-rpgmaker-mz-image-png_",
        variant: "mv_or_mz",
        surface: "image_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::PngImage,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "m4a_",
        fixture_id: "kaifuu-rpgmaker-mz-audio-m4a_",
        variant: "mv_or_mz",
        surface: "audio_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::M4aAudio,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "ogg_",
        fixture_id: "kaifuu-rpgmaker-mz-audio-ogg_",
        variant: "mv_or_mz",
        surface: "audio_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::OggAudio,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "png",
        fixture_id: "kaifuu-rpgmaker-plain-image-png",
        variant: "plain_asset",
        surface: "image_asset",
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::PngImage,
        key_required: false,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "m4a",
        fixture_id: "kaifuu-rpgmaker-plain-audio-m4a",
        variant: "plain_asset",
        surface: "audio_asset",
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::M4aAudio,
        key_required: false,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "ogg",
        fixture_id: "kaifuu-rpgmaker-plain-audio-ogg",
        variant: "plain_asset",
        surface: "audio_asset",
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::OggAudio,
        key_required: false,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "rpgmvu",
        fixture_id: "kaifuu-rpgmaker-mv-video-rpgmvu",
        variant: "mv_or_mz",
        surface: "video_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::Unknown,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "webp_",
        fixture_id: "kaifuu-rpgmaker-unknown-webp_",
        variant: "unknown_suffix",
        surface: "unknown_asset",
        crypto: CryptoTransform::Unknown,
        codec: CodecTransform::Unknown,
        key_required: false,
        unknown_crypto: true,
    },
];

pub(crate) fn rpg_maker_mv_mz_surfaces(
    scan: &ArchiveDetectionScan,
) -> Vec<ArchiveDetectionSurface> {
    RPG_MAKER_MV_MZ_SUFFIX_PROFILES
        .iter()
        .filter_map(|profile| {
            let count = scan.extension_count(profile.suffix);
            if count == 0 {
                return None;
            }
            let key_requirement_refs = if profile.key_required {
                vec!["rpg-maker-mv-mz-asset-key".to_string()]
            } else {
                vec![]
            };
            Some(ArchiveDetectionSurface {
                fixture_id: profile.fixture_id.to_string(),
                engine_family: "rpg_maker_mv_mz".to_string(),
                variant: profile.variant.to_string(),
                container: ContainerTransform::ProjectAsset,
                crypto: profile.crypto,
                codec: profile.codec,
                surface: profile.surface.to_string(),
                count,
                key_requirement_refs,
                diagnostics: rpg_maker_surface_diagnostics(profile),
            })
        })
        .collect()
}

pub(crate) fn rpg_maker_surface_diagnostics(
    profile: &RpgMakerSuffixProfile,
) -> Vec<DetectionDiagnostic> {
    if profile.unknown_crypto {
        vec![
            diagnostic(
                SemanticErrorCode::UnknownEngineVariant,
                ArchiveDetectionSignal::UnknownVariant,
                Some(Capability::Detection),
                "RPG Maker-like asset suffix has no profiled MV/MZ codec or key mapping.",
                "add a public fixture profile before assigning key requirements",
            ),
            diagnostic(
                SemanticErrorCode::MissingCryptoCapability,
                ArchiveDetectionSignal::UnknownVariant,
                Some(Capability::CryptoAccess),
                "RPG Maker-like asset suffix has no profiled MV/MZ codec or key mapping.",
                "do not request key material until the suffix crypto profile is known",
            ),
        ]
    } else if profile.key_required {
        vec![
            diagnostic(
                SemanticErrorCode::UnsupportedVariantEncrypted,
                ArchiveDetectionSignal::Encrypted,
                Some(Capability::EncryptedInput),
                "RPG Maker MV/MZ encrypted asset suffix detection is not decryption support.",
                "provide a supported key profile only after an adapter explicitly supports encrypted media extraction",
            ),
            diagnostic(
                SemanticErrorCode::MissingKeyMaterial,
                ArchiveDetectionSignal::MissingKey,
                Some(Capability::KeyProfile),
                "RPG Maker MV/MZ encrypted asset suffix maps to the asset-key requirement.",
                "resolve local key material through a secret ref; do not persist raw keys",
            ),
        ]
    } else {
        vec![]
    }
}
