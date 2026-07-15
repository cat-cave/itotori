//! real-bytes integration test for the Gameexe.ini key-family
//! classifier. Exercises the classifier against every staged RealLive
//! corpus and asserts DETERMINISTIC COMPLETENESS: **zero** lines fall
//! through to `Unknown` on real bytes.
//! **No relaxed floor (substrate law).** An earlier revision permitted up
//! to 10% (≤135 lines) to remain `Unknown` and still pass — exactly the
//! numeric-tolerance shape the strict-proof / 100%-decompilation law
//! forbids, because it masks incomplete classification. That floor is
//! deleted. The classifier now recognises every key/line-form present in
//! the staged corpora, so the assertion is `unknown == 0` for each corpus
//! (a new unrecognised key hard-fails). No enumerated known-unclassified
//! manifest is needed: the staged evidence contains no genuinely opaque
//! key (the last hold-out, Kanon's `#DLL.NNN` extension-DLL slot binding,
//! is now a typed `Dll` family).
//! **Multi-game validation.** Per project law an engine-family parser
//! validates against ≥2 real corpora. This test iterates over every
//! staged corpus (`ITOTORI_REAL_GAME_ROOT` = Sweetie HD 1.6.x, plus
//! `ITOTORI_REAL_GAME_ROOT_2` = Kanon 1.2.6.x when staged) and enforces
//! zero-unknown on each. The Sweetie-HD-specific total-count envelope and
//! per-family floors additionally anchor the dominant families.
//! Env-gating, STRICT: this test reads bytes only when
//! `ITOTORI_REAL_GAME_ROOT` is set; otherwise an absent corpus is an
//! unconditional HARD FAILURE (no opt-out). It runs only in the periodic
//! ground-truth oracle (`just real-bytes-oracle`), where the corpus is staged.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::HashMap;
use std::fs;

use kaifuu_core::RedactedContentSummary;
use kaifuu_reallive::{GameexeKeyFamily, GameexeKeyTreatment, parse_gameexe_inventory};

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn classifies_every_staged_gameexe_ini_to_zero_unknown() {
    // STRICT gate: corpus-1 (Sweetie HD) must be staged. An absent
    // primary corpus is an unconditional hard failure (no silent pass).
    if real_corpus::corpus_1().is_none() {
        real_corpus::require_real_bytes("Gameexe.ini zero-unknown real-bytes test");
        return;
    }

    // Validate every staged corpus (Sweetie HD, plus Kanon when
    // ITOTORI_REAL_GAME_ROOT_2 is set). Each must reach zero-unknown.
    let corpora = real_corpus::corpora();
    for corpus in &corpora {
        let ini_path = corpus.gameexe_ini().unwrap_or_else(|| {
            panic!(
                "corpus {} ({}) has no Gameexe.ini under either the modern \
                 REALLIVEDATA/ or the flat root layout",
                corpus.label,
                corpus.root.display()
            )
        });
        let bytes = fs::read(&ini_path)
            .unwrap_or_else(|err| panic!("failed to read {}: {err}", ini_path.display()));
        let report = parse_gameexe_inventory(&bytes);

        let mut family_counts: HashMap<&'static str, usize> = HashMap::new();
        let mut treatment_counts: HashMap<&'static str, usize> = HashMap::new();
        for entry in &report.entries {
            *family_counts
                .entry(family_label(&entry.family))
                .or_insert(0) += 1;
            *treatment_counts
                .entry(treatment_label(entry.treatment))
                .or_insert(0) += 1;
        }
        let total = report.entries.len();
        let unknown = *treatment_counts.get("unknown").unwrap_or(&0);

        // Dump the breakdown to stderr so an auditor can verify the
        // zero-unknown claim from `cargo test -- --nocapture` output.
        eprintln!(
            "\n=== KAIFUU-190 {label} Gameexe.ini classification breakdown ===\n\
             path:              {path}\n\
             total entries:     {total}\n\
             bridge_unit:       {bu}\n\
             asset_reference:   {ar}\n\
             config:            {cf}\n\
             unknown:           {un}\n\
             warnings emitted:  {wn}",
            label = corpus.label,
            path = ini_path.display(),
            bu = treatment_counts.get("bridge_unit").copied().unwrap_or(0),
            ar = treatment_counts
                .get("asset_reference")
                .copied()
                .unwrap_or(0),
            cf = treatment_counts.get("config").copied().unwrap_or(0),
            un = unknown,
            wn = report.warnings.len(),
        );
        let mut family_vec: Vec<(&&str, &usize)> = family_counts.iter().collect();
        family_vec.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        eprintln!("--- per-family counts (descending) ---");
        for (family, count) in &family_vec {
            eprintln!("  {family:<32} {count:>5}");
        }

        // Deterministic-completeness assertion (NO numeric tolerance):
        // every real Gameexe.ini line must classify into a typed family.
        // A new unrecognised key surfaces here as a non-zero `unknown`
        // and hard-fails, listing the offending keys.
        if unknown != 0 {
            let unknown_keys: Vec<String> = report
                .entries
                .iter()
                .filter(|e| treatment_label(e.treatment) == "unknown")
                .map(|e| {
                    format!(
                        "{} (line {})",
                        RedactedContentSummary::from_text(&e.key),
                        e.line_number
                    )
                })
                .collect();
            panic!(
                "corpus {} ({}) must classify EVERY Gameexe.ini key (substrate law: \
                 no relaxed floor); got {unknown} unknown of {total}: {unknown_keys:?}",
                corpus.label,
                ini_path.display(),
            );
        }

        // No-silent-unknown invariant: warnings are emitted only for
        // Unknown entries, so with zero unknowns there are zero warnings.
        assert_eq!(
            report.warnings.len(),
            0,
            "corpus {} ({}) reached zero-unknown but emitted {} warnings; \
             warnings must pair 1:1 with Unknown entries",
            corpus.label,
            ini_path.display(),
            report.warnings.len(),
        );

        // Sweetie-HD-specific total envelope + per-family floors anchor
        // the dominant families for the primary corpus.
        if corpus.label == "corpus-1" {
            assert_sweetie_hd_family_shape(total, &family_counts, &treatment_counts);
        }
    }
}

/// Sweetie-HD-specific shape anchors: total-count envelope and the
/// dominant per-family / per-treatment floors documented at
/// `docs/research/reallive-engine.md` §B. Kept scoped to corpus-1 because
/// these counts are title-specific.
fn assert_sweetie_hd_family_shape(
    total: usize,
    family_counts: &HashMap<&'static str, usize>,
    treatment_counts: &HashMap<&'static str, usize>,
) {
    // Total-key envelope. The documented count is 1,345 lines (the
    // research doc anchors §A's Gameexe.ini at 51,800 bytes / 1,345
    // lines). We allow 1,300..=1,400 to absorb any later parser-
    // tweak drift without losing the bound.
    assert!(
        (1300..=1400).contains(&total),
        "Sweetie HD Gameexe.ini should yield 1300..=1400 entries; got {total}"
    );

    // Specific-family presence + count floors. These exercise the
    // dominant Sweetie HD families documented at
    // `docs/research/reallive-engine.md` §B.
    assert_family_count(family_counts, "FolderName", 13);
    assert_family_count(family_counts, "Object", 7);
    assert_family_count(family_counts, "ObjectMax", 1);
    assert_family_count(family_counts, "Waku", 200);
    assert_family_count(family_counts, "Window", 300);
    assert_family_count(family_counts, "Syscom", 70);
    assert_family_count(family_counts, "SelBtn", 60);
    assert_family_count(family_counts, "BtnObj", 90);
    assert_family_count(family_counts, "SysBtn", 50);
    assert_family_count(family_counts, "Namae", 11);
    assert_family_count(family_counts, "KoeOnOff", 6);
    assert_family_count(family_counts, "ColorTable", 30);
    assert_family_count(family_counts, "DsTrack", 28);
    assert_family_count(family_counts, "PcmVolMod", 16);
    assert_family_count(family_counts, "FullScreenMessageBack", 25);
    assert_family_count(family_counts, "Hint", 12);
    assert_family_count(family_counts, "MouseActionCall", 3);
    assert_family_count(family_counts, "Sel", 60);
    assert_family_count(family_counts, "Shake", 3);
    assert_family_count(family_counts, "SoundEffect", 4);
    assert_family_count(family_counts, "Caption", 1);
    assert_family_count(family_counts, "RegName", 1);
    assert_family_count(family_counts, "ScreenSizeMod", 1);
    assert_family_count(family_counts, "CancelCall", 2);
    assert_family_count(family_counts, "LoadCall", 2);
    assert_family_count(family_counts, "SystemCall", 6);

    // BridgeUnit floor: at least the `#CAPTION`, `#NAMAE` ×11,
    // `#KOEONOFF` ×6, `#SYSCOM` ×70+, `#SAVE_NODATA`, `#VERSION_STR`,
    // `#SAVEMESSAGE_*_STR`, `#LOADMESSAGE_*_STR` and friends —
    // comfortably ≥ 50.
    let bridge_units = treatment_counts.get("bridge_unit").copied().unwrap_or(0);
    assert!(
        bridge_units >= 50,
        "BridgeUnit floor missed: got {bridge_units}, expected ≥50 (CAPTION + NAMAE + KOEONOFF + \
         SYSCOM + SAVE_*_STR + …)"
    );

    // AssetReference floor: at least 13 `#FOLDNAME.*` + 1 `#REGNAME`
    // + 1 `#DISKMARK` + 4 `#SE.*` + 1 `#DSTRACK` + 1
    // `#CGTABLE_FILENAME` = 21 minimum (we have 28 `#DSTRACK` per
    // family count, so the real floor is far higher; the ≥20 assertion
    // is intentionally loose to allow per-title variance).
    let asset_refs = treatment_counts
        .get("asset_reference")
        .copied()
        .unwrap_or(0);
    assert!(
        asset_refs >= 20,
        "AssetReference floor missed: got {asset_refs}, expected ≥20 \
         (FOLDNAME + REGNAME + DISKMARK + SE + DSTRACK + CGTABLE_FILENAME + …)"
    );
}

fn assert_family_count(counts: &HashMap<&'static str, usize>, family: &'static str, floor: usize) {
    let got = counts.get(family).copied().unwrap_or(0);
    assert!(
        got >= floor,
        "family {family} count {got} below floor {floor}; \
         observed counts: {counts:?}"
    );
}

fn treatment_label(treatment: GameexeKeyTreatment) -> &'static str {
    match treatment {
        GameexeKeyTreatment::BridgeUnit => "bridge_unit",
        GameexeKeyTreatment::AssetReference => "asset_reference",
        GameexeKeyTreatment::Config => "config",
        GameexeKeyTreatment::Unknown => "unknown",
    }
}

fn family_label(family: &GameexeKeyFamily) -> &'static str {
    match family {
        GameexeKeyFamily::Caption => "Caption",
        GameexeKeyFamily::Subtitle => "Subtitle",
        GameexeKeyFamily::RegName => "RegName",
        GameexeKeyFamily::DiskMark => "DiskMark",
        GameexeKeyFamily::VersionStr => "VersionStr",
        GameexeKeyFamily::ScreenSizeMod => "ScreenSizeMod",
        GameexeKeyFamily::EngineBootstrap => "EngineBootstrap",
        GameexeKeyFamily::Debug => "Debug",
        GameexeKeyFamily::SeenEntry => "SeenEntry",
        GameexeKeyFamily::CancelCall => "CancelCall",
        GameexeKeyFamily::SystemCall { .. } => "SystemCall",
        GameexeKeyFamily::LoadCall => "LoadCall",
        GameexeKeyFamily::ExAfterCall => "ExAfterCall",
        GameexeKeyFamily::MouseActionCall { .. } => "MouseActionCall",
        GameexeKeyFamily::WbCall { .. } => "WbCall",
        GameexeKeyFamily::FolderName { .. } => "FolderName",
        GameexeKeyFamily::Save { .. } => "Save",
        GameexeKeyFamily::SaveNoData => "SaveNoData",
        GameexeKeyFamily::SaveLoadMessage { .. } => "SaveLoadMessage",
        GameexeKeyFamily::Namae => "Namae",
        GameexeKeyFamily::Name { .. } => "Name",
        GameexeKeyFamily::LocalName { .. } => "LocalName",
        GameexeKeyFamily::KoeOnOff { .. } => "KoeOnOff",
        GameexeKeyFamily::KoeConfig { .. } => "KoeConfig",
        GameexeKeyFamily::KoeReplayIcon { .. } => "KoeReplayIcon",
        GameexeKeyFamily::Syscom { .. } => "Syscom",
        GameexeKeyFamily::SyscomConfig { .. } => "SyscomConfig",
        GameexeKeyFamily::Waku { .. } => "Waku",
        GameexeKeyFamily::Window { .. } => "Window",
        GameexeKeyFamily::WindowConfig { .. } => "WindowConfig",
        GameexeKeyFamily::MessageBackWindow { .. } => "MessageBackWindow",
        GameexeKeyFamily::MessageBackConfig { .. } => "MessageBackConfig",
        GameexeKeyFamily::FullScreenMessageBack { .. } => "FullScreenMessageBack",
        GameexeKeyFamily::FullScreenMessageBackConfig { .. } => "FullScreenMessageBackConfig",
        GameexeKeyFamily::SelBtn { .. } => "SelBtn",
        GameexeKeyFamily::Sel { .. } => "Sel",
        GameexeKeyFamily::SelConfig { .. } => "SelConfig",
        GameexeKeyFamily::BtnObj { .. } => "BtnObj",
        GameexeKeyFamily::SysBtn { .. } => "SysBtn",
        GameexeKeyFamily::SysBtnConfig { .. } => "SysBtnConfig",
        GameexeKeyFamily::MouseCursor { .. } => "MouseCursor",
        GameexeKeyFamily::MouseCursorRegion { .. } => "MouseCursorRegion",
        GameexeKeyFamily::MouseConfig { .. } => "MouseConfig",
        GameexeKeyFamily::Object { .. } => "Object",
        GameexeKeyFamily::ObjectMax => "ObjectMax",
        GameexeKeyFamily::ObjDisp { .. } => "ObjDisp",
        GameexeKeyFamily::Init { .. } => "Init",
        GameexeKeyFamily::BgmConfig { .. } => "BgmConfig",
        GameexeKeyFamily::SoundEffect { .. } => "SoundEffect",
        GameexeKeyFamily::SoundDefault => "SoundDefault",
        GameexeKeyFamily::DsTrack => "DsTrack",
        GameexeKeyFamily::PcmVolMod { .. } => "PcmVolMod",
        GameexeKeyFamily::SerialPdt { .. } => "SerialPdt",
        GameexeKeyFamily::Dll { .. } => "Dll",
        GameexeKeyFamily::Shake { .. } => "Shake",
        GameexeKeyFamily::ShakeZoom { .. } => "ShakeZoom",
        GameexeKeyFamily::QuarterViewSize => "QuarterViewSize",
        GameexeKeyFamily::HaikeiChr { .. } => "HaikeiChr",
        GameexeKeyFamily::Hint { .. } => "Hint",
        GameexeKeyFamily::ColorTable { .. } => "ColorTable",
        GameexeKeyFamily::Mask { .. } => "Mask",
        GameexeKeyFamily::CgTable { .. } => "CgTable",
        GameexeKeyFamily::ReadJump { .. } => "ReadJump",
        GameexeKeyFamily::KeyWait { .. } => "KeyWait",
        GameexeKeyFamily::MessageKeyWait { .. } => "MessageKeyWait",
        GameexeKeyFamily::FontConfig { .. } => "FontConfig",
        GameexeKeyFamily::Cursor { .. } => "Cursor",
        GameexeKeyFamily::UiMessageStr { .. } => "UiMessageStr",
        GameexeKeyFamily::CddaSetup { .. } => "CddaSetup",
        GameexeKeyFamily::G00Family => "G00Family",
        GameexeKeyFamily::KoePack => "KoePack",
        GameexeKeyFamily::SeenAsset => "SeenAsset",
        GameexeKeyFamily::NwkOvk => "NwkOvk",
        GameexeKeyFamily::GameexeVersion => "GameexeVersion",
        GameexeKeyFamily::Unknown { .. } => "Unknown",
    }
}
