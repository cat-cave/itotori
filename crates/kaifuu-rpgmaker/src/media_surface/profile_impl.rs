use super::*;

impl MediaLocalizationRole {
    /// All roles in canonical order.
    #[must_use]
    pub fn all() -> [Self; 4] {
        [
            Self::TextBearingImage,
            Self::UiTexture,
            Self::AudioSongMetadata,
            Self::InventoryOnly,
        ]
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TextBearingImage => "text_bearing_image",
            Self::UiTexture => "ui_texture",
            Self::AudioSongMetadata => "audio_song_metadata",
            Self::InventoryOnly => "inventory_only",
        }
    }

    /// True iff this role is a candidate localization surface (i.e. it may need
    /// localization). Inventory-only assets return `false`.
    #[must_use]
    pub fn is_localization_surface(self) -> bool {
        !matches!(self, Self::InventoryOnly)
    }

    /// The media capability a role must carry. Song-metadata roles are audio;
    /// image/texture roles are image; inventory-only can be either, so it has
    /// no fixed capability.
    #[must_use]
    pub fn required_capability(self) -> Option<MediaCapability> {
        match self {
            Self::TextBearingImage | Self::UiTexture => Some(MediaCapability::Image),
            Self::AudioSongMetadata => Some(MediaCapability::Audio),
            Self::InventoryOnly => None,
        }
    }
}

impl std::fmt::Display for MediaLocalizationRole {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl MediaSurfaceProfile {
    /// The canonical RPG Maker MV/MZ default profile.
    /// Title screens and pictures render arbitrary (often text-bearing) art;
    /// the `system` subtree holds window/UI graphics; `bgm`/`me` are songs whose
    /// Ogg VORBIS comment metadata may be localizable. Sprites, faces,
    /// tilesets, parallaxes, battlebacks, animations, ambience (`bgs`), and
    /// sound effects (`se`) are inventory-only.
    #[must_use]
    pub fn rpg_maker() -> Self {
        use MediaLocalizationRole::{
            AudioSongMetadata, InventoryOnly, TextBearingImage, UiTexture,
        };
        let rule = |subtree: &str, role| MediaSurfaceRule {
            subtree: subtree.to_string(),
            role,
        };
        Self {
            profile_id: "rpg_maker/mv_mz/media_surface_default_v1".to_string(),
            rules: vec![
                // Text-bearing images.
                rule("img/titles1", TextBearingImage),
                rule("img/titles2", TextBearingImage),
                rule("img/pictures", TextBearingImage),
                // UI textures.
                rule("img/system", UiTexture),
                // Song metadata.
                rule("audio/bgm", AudioSongMetadata),
                rule("audio/me", AudioSongMetadata),
                // Explicit inventory-only subtrees (documented, not silent).
                rule("img/characters", InventoryOnly),
                rule("img/faces", InventoryOnly),
                rule("img/sv_actors", InventoryOnly),
                rule("img/sv_enemies", InventoryOnly),
                rule("img/enemies", InventoryOnly),
                rule("img/tilesets", InventoryOnly),
                rule("img/parallaxes", InventoryOnly),
                rule("img/battlebacks1", InventoryOnly),
                rule("img/battlebacks2", InventoryOnly),
                rule("img/animations", InventoryOnly),
                rule("audio/bgs", InventoryOnly),
                rule("audio/se", InventoryOnly),
            ],
        }
    }

    /// Classify an asset's relative path to a localization role. Path matching
    /// is case-insensitive and `\\`-normalized; an unmatched path is
    /// [`MediaLocalizationRole::InventoryOnly`].
    #[must_use]
    pub fn classify(&self, relative_path: &str) -> MediaLocalizationRole {
        let normalized = relative_path.replace('\\', "/").to_ascii_lowercase();
        for rule in &self.rules {
            let needle = rule.subtree.to_ascii_lowercase();
            if path_contains_subtree(&normalized, &needle) {
                return rule.role;
            }
        }
        MediaLocalizationRole::InventoryOnly
    }
}

/// True iff `subtree` (a `/`-joined fragment) appears as a whole segment run in
/// `path` (also `/`-joined, already lowercased). Prevents `img/system`
/// matching `img/systematic`.
fn path_contains_subtree(path: &str, subtree: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let needle: Vec<&str> = subtree.split('/').filter(|s| !s.is_empty()).collect();
    if needle.is_empty() || needle.len() > segments.len() {
        return false;
    }
    segments
        .windows(needle.len())
        .any(|window| window == needle.as_slice())
}

impl PatchBackMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReEncryptSameKey => "re_encrypt_same_key",
            Self::HeldPendingKey => "held_pending_key",
            Self::ByteIdenticalPassthrough => "byte_identical_passthrough",
        }
    }
}

impl MediaSurfaceError {
    /// The stable machine code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedSuffix { .. } => "kaifuu.rpgmaker.k059.unsupported_suffix",
            Self::NotALocalizationSurface { .. } => "kaifuu.rpgmaker.k059.not_a_surface",
            Self::KeyAbsent => "kaifuu.rpgmaker.k059.key_absent",
            Self::CapabilityDiff { .. } => "kaifuu.rpgmaker.k059.capability_diff",
            Self::ReplacementNotMedia { .. } => "kaifuu.rpgmaker.k059.replacement_not_media",
            Self::MalformedAsset { .. } => "kaifuu.rpgmaker.k059.malformed_asset",
            Self::WrongKey { .. } => "kaifuu.rpgmaker.k059.wrong_key",
        }
    }

    /// Classify a failure as a declared-profile regression (a bug) vs an
    /// expected out-of-profile capability error — acceptance item 4.
    /// `role` is the asset's localization role, `key_available` whether a key
    /// was resolvable. A `WrongKey` / `MalformedAsset` on a profiled surface
    /// WITH a key present is a regression (the declared profile should have
    /// decrypted it); everything else is an expected capability error.
    #[must_use]
    pub fn classify(&self, role: MediaLocalizationRole, key_available: bool) -> FailureClass {
        match self {
            Self::WrongKey { .. } | Self::MalformedAsset { .. }
                if role.is_localization_surface() && key_available =>
            {
                FailureClass::DeclaredProfileRegression
            }
            _ => FailureClass::OutOfProfileCapabilityError,
        }
    }
}
