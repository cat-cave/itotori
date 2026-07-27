use super::*;

/// The synthetic XP3 subtype a container header structurally encodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Xp3StructuralMarker {
    Encrypted,
    Compressed,
    Unknown,
}

/// Classify the XP3 subtype a container header signals, recognizing the
/// marker ONLY at its structural position.
/// Synthetic XP3 subtype fixtures share the 5-byte `XP3\r\n` container prefix
/// with a plain archive, then write the subtype token on the single marker
/// line that immediately follows the prefix (for example
/// `XP3\r\nXP3-CRYPT\n…` or `XP3\r\nKAIFUU-XP3-ENCRYPTED`). This function only
/// inspects that structural marker line, so a marker-like string that appears
/// deeper in a member payload cannot be mistaken for a subtype signal.
/// A genuine plain XP3 begins with the full [`XP3_PLAIN_MAGIC`] (byte 5 is a
/// space, never the `X` of a subtype token) and therefore has no marker line:
/// it is always classified plain (`None`), regardless of any marker-like text
/// carried inside its members.
pub(crate) fn xp3_structural_marker(header: &[u8]) -> Option<Xp3StructuralMarker> {
    // A full-magic plain container is authoritatively plain: never scan its
    // payload for a subtype marker.
    if header.starts_with(XP3_PLAIN_MAGIC) {
        return None;
    }
    // The subtype token lives on the marker line right after the container
    // prefix; bound the scan to that single line so trailing payload bytes
    // cannot contribute an incidental match.
    let region = header.strip_prefix(b"XP3\r\n")?;
    let marker_line = match region.iter().position(|&byte| byte == b'\n') {
        Some(newline) => &region[..newline],
        None => region,
    };
    if header_contains_ascii(marker_line, "kaifuu-xp3-unknown")
        || header_contains_ascii(marker_line, "xp3-unknown-variant")
    {
        Some(Xp3StructuralMarker::Unknown)
    } else if header_contains_ascii(marker_line, "kaifuu-xp3-encrypted")
        || header_contains_ascii(marker_line, "xp3-encrypted")
        || header_contains_ascii(marker_line, "xp3-crypt")
    {
        Some(Xp3StructuralMarker::Encrypted)
    } else if header_contains_ascii(marker_line, "kaifuu-xp3-compressed")
        || header_contains_ascii(marker_line, "xp3-compressed")
    {
        Some(Xp3StructuralMarker::Compressed)
    } else {
        None
    }
}

pub(crate) fn lower_path_component(component: Option<&std::ffi::OsStr>) -> Option<String> {
    component.map(|component| component.to_string_lossy().to_ascii_lowercase())
}

pub(crate) fn read_header(path: &Path, limit: usize) -> Vec<u8> {
    let Ok(mut file) = File::open(path) else {
        return vec![];
    };
    let mut buffer = vec![0; limit];
    let Ok(read) = file.read(&mut buffer) else {
        return vec![];
    };
    buffer.truncate(read);
    buffer
}

pub(crate) fn header_contains_ascii(header: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(header)
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

pub(crate) fn has_wolf_rpg_editor_primary_evidence(extension: Option<&str>, header: &[u8]) -> bool {
    extension == Some("wolf") || header_contains_ascii(header, "WOLF RPG Editor")
}

pub(crate) fn has_orphaned_archive_subtype_marker(extension: Option<&str>, header: &[u8]) -> bool {
    let xp3_marker = header_contains_ascii(header, "kaifuu-xp3-encrypted")
        || header_contains_ascii(header, "xp3-encrypted")
        || header_contains_ascii(header, "xp3-crypt");
    let xp3_primary = extension == Some("xp3") || header.starts_with(b"XP3");

    let bgi_marker = header_contains_ascii(header, "bgi-encrypted")
        || header_contains_ascii(header, "ethornell-encrypted")
        || header_contains_ascii(header, "dsc-compressed")
        || header_contains_ascii(header, "bgi-compressed")
        || header_contains_ascii(header, "compressedbg")
        || header_contains_ascii(header, "compressed-bg");
    let bgi_primary = header_contains_ascii(header, "BURIKO ARC20");

    let wolf_marker = header_contains_ascii(header, "wolf-protected")
        || header_contains_ascii(header, "protection-key");
    let wolf_primary = has_wolf_rpg_editor_primary_evidence(extension, header);

    (xp3_marker && !xp3_primary) || (bgi_marker && !bgi_primary) || (wolf_marker && !wolf_primary)
}

pub(crate) fn is_rpg_maker_system_json(root: &Path, path: &Path) -> bool {
    let Ok(relative_path) = path.strip_prefix(root) else {
        return false;
    };
    let parts = relative_path
        .components()
        .filter_map(|component| component.as_os_str().to_str().map(str::to_ascii_lowercase))
        .collect::<Vec<_>>();
    parts.ends_with(&["data".to_string(), "system.json".to_string()])
        || parts.ends_with(&[
            "www".to_string(),
            "data".to_string(),
            "system.json".to_string(),
        ])
}

pub(crate) fn system_json_has_encryption_fields(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    value
        .get("hasEncryptedImages")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value
            .get("hasEncryptedAudio")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || value
            .get("encryptionKey")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
}

pub(crate) fn detect_kirikiri_xp3(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let xp3_extension_count = scan.extension_count("xp3");
    let xp3_header_count = scan.xp3_header_count();
    let orphaned_subtype_marker_count = scan.header_count("kaifuu-xp3-encrypted")
        + scan.header_count("xp3-encrypted")
        + scan.header_count("xp3-crypt");
    // Subtype markers are recognized only at their structural position on the
    // container marker line, so a plain XP3 whose member payload contains
    // marker-like text (e.g. an in-scenario "xp3-crypt" string) is never
    // misclassified as encrypted/compressed/unknown.
    let encrypted_marker_count = scan.xp3_structural_marker_count(Xp3StructuralMarker::Encrypted);
    let compressed_marker_count = scan.xp3_structural_marker_count(Xp3StructuralMarker::Compressed);
    let unknown_marker_count = scan.xp3_structural_marker_count(Xp3StructuralMarker::Unknown);
    let detected = xp3_extension_count > 0 || xp3_header_count > 0;
    let mut signals = if detected {
        vec![ArchiveDetectionSignal::Packed]
    } else {
        vec![]
    };
    if encrypted_marker_count > 0 {
        signals.extend([
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
            ArchiveDetectionSignal::HelperRequired,
        ]);
    }
    if compressed_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::Compressed);
    }
    if unknown_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::UnknownVariant);
    }
    archive_row(ArchiveRowInput {
        row_id: "kirikiri-xp3",
        engine_family: ArchiveEngineFamily::KiriKiriXp3,
        detected,
        detected_variant: if unknown_marker_count > 0 {
            "xp3-unknown-container"
        } else if encrypted_marker_count > 0 {
            "xp3-encrypted-archive"
        } else if compressed_marker_count > 0 {
            "xp3-compressed-archive"
        } else {
            "xp3-archive"
        },
        marker_only_unknown_variant: !detected && orphaned_subtype_marker_count > 0,
        signals,
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.xp3",
                xp3_extension_count,
                "XP3 archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "XP3 header",
                xp3_header_count,
                "XP3 archive header count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "synthetic XP3 encryption marker",
                encrypted_marker_count,
                "Synthetic encrypted XP3 fixture marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "synthetic XP3 compression marker",
                compressed_marker_count,
                "Synthetic compressed XP3 fixture marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "synthetic XP3 unknown-variant marker",
                unknown_marker_count,
                "Synthetic unknown XP3 container marker count",
            ),
        ],
        requirements: if encrypted_marker_count > 0 {
            vec![secret_requirement(
                "kirikiri-xp3-key-profile",
                "encrypted XP3 variants require local key/profile evidence before pure adapters can proceed",
                "KAIFUU_KIRIKIRI_XP3_KEY_PROFILE",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects XP3 archives and encrypted XP3 markers but does not claim XP3 extraction, decryption, or archive rebuild support in this matrix.",
    })
}

pub(crate) fn detect_siglus(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let scene_pck_count = scan.file_name_count("scene.pck");
    let gameexe_dat_count = scan.file_name_count("gameexe.dat");
    let detected = scene_pck_count > 0 || gameexe_dat_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "siglus-scene-pck",
        engine_family: ArchiveEngineFamily::Siglus,
        detected,
        detected_variant: if scene_pck_count > 0 && gameexe_dat_count > 0 {
            "scene-pck-gameexe-dat"
        } else if scene_pck_count > 0 {
            "scene-pck-without-gameexe-dat"
        } else {
            "gameexe-dat-without-scene-pck"
        },
        marker_only_unknown_variant: false,
        signals: if detected {
            vec![
                ArchiveDetectionSignal::Packed,
                ArchiveDetectionSignal::Encrypted,
                ArchiveDetectionSignal::MissingKey,
                ArchiveDetectionSignal::HelperRequired,
            ]
        } else {
            Vec::new()
        },
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileName,
                "Scene.pck",
                scene_pck_count,
                "Siglus scenario package marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileName,
                "Gameexe.dat",
                gameexe_dat_count,
                "Siglus executable metadata marker count",
            ),
        ],
        requirements: if detected {
            vec![
                file_requirement(
                    "Scene.pck",
                    scene_pck_count > 0,
                    "Siglus detection expects aggregate evidence for Scene.pck",
                ),
                file_requirement(
                    "Gameexe.dat",
                    gameexe_dat_count > 0,
                    "Siglus secondary-key workflows usually require Gameexe.dat evidence",
                ),
                secret_requirement(
                    "siglus-secondary-key",
                    "Siglus encrypted packages require a local secondary key reference",
                    "KAIFUU_SIGLUS_SECONDARY_KEY",
                ),
            ]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects Siglus package/key-requirement signals only; extraction, secondary-key discovery, and protected executable handling remain helper-gated.",
    })
}

// RealLive archive-detection matrix row.
// Clean-room provenance: all signal names are derived from publicly archived
// RealLive format documentation (Haeleth's RLDEV site) and from publicly
// observable file shape; no rlvm source expression is used. rlvm is a
// research anchor only and is not linked, vendored, or copied.
pub(crate) fn detect_reallive(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let seen_txt_count = scan.file_name_count("seen.txt");
    let seen_gan_count = scan.file_name_count("seen.gan");
    let gameexe_ini_count = scan.file_name_count("gameexe.ini");
    let g00_count = scan.extension_count("g00");
    let voice_archive_count = scan.extension_counts(&["ovk", "koe", "nwk"]);
    let pdt_count = scan.extension_count("pdt");
    let scene_pck_count = scan.file_name_count("scene.pck");
    let gameexe_dat_count = scan.file_name_count("gameexe.dat");
    let reallive_signal_total =
        seen_txt_count + seen_gan_count + gameexe_ini_count + g00_count + voice_archive_count;
    let siglus_marker_present = scene_pck_count > 0 || gameexe_dat_count > 0;
    let avg32_marker_present = pdt_count > 0;
    let positive = reallive_signal_total > 0;
    let ambiguous = positive && siglus_marker_present;
    let unsupported_avg32 = positive
        && !siglus_marker_present
        && avg32_marker_present
        && seen_txt_count > 0
        && gameexe_ini_count == 0;
    let detected = positive && !ambiguous && !unsupported_avg32;
    let detected_variant = if ambiguous {
        if scene_pck_count > 0 {
            "ambiguous-reallive-siglus-scene-pck"
        } else {
            "ambiguous-reallive-siglus-gameexe-dat"
        }
    } else if unsupported_avg32 {
        "avg32-lineage-seen-txt"
    } else if detected {
        "reallive-seen-txt-archive"
    } else {
        "not-reallive"
    };
    let signals = if detected {
        vec![ArchiveDetectionSignal::Packed]
    } else if ambiguous || unsupported_avg32 {
        vec![ArchiveDetectionSignal::UnknownVariant]
    } else {
        Vec::new()
    };
    let support_boundary = "Kaifuu detects RealLive SEEN.TXT/Gameexe.ini/Scene container signals only; extraction, Scene/SEEN decompilation, voice-archive handling, and patch-back remain outside this matrix row.";
    let mut row = archive_row(ArchiveRowInput {
        row_id: "reallive-seen-txt",
        engine_family: ArchiveEngineFamily::RealLive,
        detected,
        detected_variant,
        marker_only_unknown_variant: false,
        signals,
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileName,
                "SEEN.TXT",
                seen_txt_count,
                "RealLive SEEN.TXT scene archive marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileName,
                "SEEN.GAN",
                seen_gan_count,
                "RealLive SEEN.GAN animation archive marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileName,
                "Gameexe.ini",
                gameexe_ini_count,
                "RealLive Gameexe.ini configuration manifest marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.g00",
                g00_count,
                "RealLive .g00 image asset count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.ovk|*.koe|*.nwk",
                voice_archive_count,
                "RealLive voice archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.pdt",
                pdt_count,
                "AVG32 .PDT image asset count (corroborates AVG32 lineage when present alongside SEEN.TXT)",
            ),
        ],
        requirements: vec![],
        support_boundary,
    });
    if ambiguous {
        row.diagnostics.push(diagnostic(
            SemanticErrorCode::AmbiguousEngineVariant,
            ArchiveDetectionSignal::UnknownVariant,
            Some(Capability::Detection),
            "RealLive detector requires unambiguous RealLive evidence; co-presence of Siglus markers (Scene.pck/Gameexe.dat) blocks identification.",
            "audit the input directory; remove or relocate cross-engine markers, or report the layout as a new engine variant",
        ));
    }
    if unsupported_avg32 {
        row.diagnostics.push(diagnostic(
            SemanticErrorCode::UnsupportedEngineVariant,
            ArchiveDetectionSignal::UnknownVariant,
            Some(Capability::Detection),
            "RealLive detector does not claim AVG32 lineage support; AVG32-shaped SEEN.TXT inputs are out of scope.",
            "add an AVG32-specific detector (separate node) before localizing this title",
        ));
    }
    row.normalize();
    row
}

pub(crate) fn detect_rpg_maker_mv_mz(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let encrypted_asset_count = scan.extension_counts(RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES);
    let plain_asset_count = scan.extension_counts(RPG_MAKER_MV_MZ_PLAIN_SUFFIXES);
    let unknown_suffix_count = scan.extension_counts(RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES);
    let system_json_count = scan.rpg_maker_system_json_encryption_fields;
    let known_key_requirement = encrypted_asset_count > 0 || system_json_count > 0;
    let detected = known_key_requirement || unknown_suffix_count > 0;
    let mut signals = Vec::new();
    if known_key_requirement {
        signals.extend([
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
        ]);
    }
    if unknown_suffix_count > 0 {
        signals.push(ArchiveDetectionSignal::UnknownVariant);
    }
    archive_row(ArchiveRowInput {
        row_id: "rpg-maker-mv-mz-encrypted-assets",
        engine_family: ArchiveEngineFamily::RpgMakerMvMz,
        detected,
        detected_variant: if known_key_requirement && unknown_suffix_count > 0 {
            "mv_or_mz_with_unknown_suffix"
        } else if unknown_suffix_count > 0 {
            "unknown_suffix"
        } else {
            "mv_or_mz"
        },
        marker_only_unknown_variant: false,
        signals,
        surfaces: rpg_maker_mv_mz_surfaces(scan),
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN,
                encrypted_asset_count,
                "RPG Maker MV/MZ encrypted asset extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                RPG_MAKER_MV_MZ_PLAIN_SUFFIX_PATTERN,
                plain_asset_count,
                "RPG Maker MV/MZ plain image/audio asset extension count; does not imply encrypted asset handling",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                RPG_MAKER_MV_MZ_UNKNOWN_SUFFIX_PATTERN,
                unknown_suffix_count,
                "RPG Maker-like encrypted asset suffixes without a known codec/key mapping",
            ),
            evidence(
                ArchiveEvidenceType::MetadataField,
                "data/System.json encryption fields",
                system_json_count,
                "System.json encryption flags or key-field presence count; key values are never serialized",
            ),
        ],
        requirements: if known_key_requirement {
            vec![secret_requirement(
                "rpg-maker-mv-mz-asset-key",
                "encrypted RPG Maker MV/MZ assets require a local asset key reference",
                "KAIFUU_RPG_MAKER_ASSET_KEY",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects RPG Maker MV/MZ encrypted asset signals; JSON text patching and encrypted media restoration are separate adapter claims.",
    })
}
