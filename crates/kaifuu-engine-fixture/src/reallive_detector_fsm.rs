//! Pure, clean-room decision table for RealLive structural detection.
//!
//! This module consumes only presence and validity booleans already derived
//! from local filesystem structure. It neither parses scene content nor calls
//! an external implementation.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RealLiveFixtureVariant {
    CompleteSyntheticTriple,
    PositiveLiveLayout,
    AmbiguousSiglusOverlap,
    UnsupportedAvg32Lineage,
    UnknownEngineVariant,
    NotRealLive,
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct GameexeIniKeyHits {
    pub(crate) gameexe_version: bool,
    pub(crate) regname: bool,
    pub(crate) g00_key: bool,
    pub(crate) koe_key: bool,
    pub(crate) seen_key: bool,
}

impl GameexeIniKeyHits {
    pub(crate) fn any(self) -> bool {
        self.gameexe_version || self.regname || self.g00_key || self.koe_key || self.seen_key
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RealLiveFsmSignals {
    pub(crate) seen_txt_exists: bool,
    pub(crate) seen_txt_envelope_ok: bool,
    pub(crate) seen_txt_synthetic_magic: bool,
    pub(crate) seen_gan_exists: bool,
    pub(crate) gameexe_ini_exists: bool,
    pub(crate) gameexe_ini_synthetic_magic: bool,
    pub(crate) gameexe_ini_keys: GameexeIniKeyHits,
    pub(crate) g00_count: u64,
    pub(crate) voice_archive_count: u64,
    pub(crate) siglus_scene_pck_present: bool,
    pub(crate) siglus_gameexe_dat_present: bool,
    pub(crate) avg32_pdt_count: u64,
}

impl RealLiveFsmSignals {
    pub(crate) fn resolve(self) -> RealLiveFixtureVariant {
        let any_reallive_marker = self.seen_txt_exists
            || self.seen_gan_exists
            || self.gameexe_ini_exists
            || self.g00_count > 0
            || self.voice_archive_count > 0;
        if !any_reallive_marker {
            return RealLiveFixtureVariant::NotRealLive;
        }
        if self.siglus_scene_pck_present || self.siglus_gameexe_dat_present {
            return RealLiveFixtureVariant::AmbiguousSiglusOverlap;
        }
        if self.seen_txt_synthetic_magic && self.gameexe_ini_synthetic_magic {
            return RealLiveFixtureVariant::CompleteSyntheticTriple;
        }

        // The shared AVG32/RealLive file lineage makes `.PDT` alone an
        // insufficient negative. A valid RealLive SEEN envelope plus a
        // documented Gameexe key is stronger direct evidence, even when
        // `.PDT` assets coexist. The no-key `.PDT` shape remains AVG32.
        if self.seen_txt_exists
            && self.seen_txt_envelope_ok
            && self.gameexe_ini_exists
            && self.gameexe_ini_keys.any()
        {
            return RealLiveFixtureVariant::PositiveLiveLayout;
        }
        if self.seen_txt_exists
            && self.seen_txt_envelope_ok
            && self.avg32_pdt_count > 0
            && !self.gameexe_ini_keys.any()
        {
            return RealLiveFixtureVariant::UnsupportedAvg32Lineage;
        }
        RealLiveFixtureVariant::UnknownEngineVariant
    }
}

#[cfg(test)]
mod tests {
    use super::{GameexeIniKeyHits, RealLiveFixtureVariant, RealLiveFsmSignals};

    fn real_signals() -> RealLiveFsmSignals {
        RealLiveFsmSignals {
            seen_txt_exists: true,
            seen_txt_envelope_ok: true,
            seen_txt_synthetic_magic: false,
            seen_gan_exists: false,
            gameexe_ini_exists: true,
            gameexe_ini_synthetic_magic: false,
            gameexe_ini_keys: GameexeIniKeyHits {
                regname: true,
                ..GameexeIniKeyHits::default()
            },
            g00_count: 1,
            voice_archive_count: 0,
            siglus_scene_pck_present: false,
            siglus_gameexe_dat_present: false,
            avg32_pdt_count: 0,
        }
    }

    #[test]
    fn accepts_valid_reallive_signals_when_pdt_assets_coexist() {
        let mut signals = real_signals();
        signals.avg32_pdt_count = 1;

        assert_eq!(
            signals.resolve(),
            RealLiveFixtureVariant::PositiveLiveLayout
        );
    }

    #[test]
    fn classifies_pdt_layout_without_reallive_keys_as_avg32() {
        let mut signals = real_signals();
        signals.gameexe_ini_keys = GameexeIniKeyHits::default();
        signals.avg32_pdt_count = 1;

        assert_eq!(
            signals.resolve(),
            RealLiveFixtureVariant::UnsupportedAvg32Lineage
        );
    }

    #[test]
    fn keeps_siglus_overlap_ambiguous_when_reallive_signals_are_valid() {
        let mut signals = real_signals();
        signals.siglus_scene_pck_present = true;

        assert_eq!(
            signals.resolve(),
            RealLiveFixtureVariant::AmbiguousSiglusOverlap
        );
    }
}
