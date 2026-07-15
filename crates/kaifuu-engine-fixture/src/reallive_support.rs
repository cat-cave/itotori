use super::*;

impl RealLiveProfileDetectorAdapter {
    fn xor2_validation_failure() -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::KeyValidationFailed,
                REALLIVE_DETECTOR_ADAPTER_ID,
                "kaifuu.reallive.xor2.validation_failed",
            )
            .engine("reallive")
            .asset_ref(REALLIVE_XOR2_VALIDATION_ASSET_REF)
            .required_capability(Capability::CryptoAccess)
            .remediation("retry only after validation"),
        )
    }

    pub(crate) fn parser_failure(
        variant: &str,
        diagnostic_code: &str,
        message: &str,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::UnsupportedLayeredTransform,
                REALLIVE_DETECTOR_ADAPTER_ID,
                format!("RealLive parser rejected SEEN.TXT: {diagnostic_code}: {message}"),
            )
            .engine("reallive")
            .detected_variant(variant)
            .asset_ref(REALLIVE_SEEN_TXT_PATH)
            .required_capability(Capability::CodecAccess)
            .remediation(
                "audit SEEN.TXT bytes against the envelope shape and re-run extract",
            ),
        )
    }

    pub(crate) fn preflight_failures(
        &self,
        patch_export: &kaifuu_core::PatchExport,
        variant: &str,
        scenes: &[kaifuu_reallive::Scene],
    ) -> Vec<AdapterFailure> {
        let mut failures = Vec::new();
        for entry in &patch_export.entries {
            // Locate the slot.
            let mut found_slot = None;
            for scene in scenes {
                for slot in &scene.strings {
                    if slot.slot_id.as_str() == entry.source_unit_key {
                        found_slot = Some(slot);
                        break;
                    }
                }
                if found_slot.is_some() {
                    break;
                }
            }
            if found_slot.is_none() {
                failures.push(Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    variant,
                    &entry.source_unit_key,
                    "PatchExportEntry sourceUnitKey is not present in the parsed Scene/SEEN AST",
                    "re-extract the bridge bundle before re-applying this patch",
                ));
                continue;
            }
            // Check the target is Shift-JIS-representable. Length is NOT
            // budgeted here: the bundle-driven patch path is length-changing
            // (offset table rewritten + jump targets recalculated), so a
            // translation that grows or shrinks the body is a supported edit,
            // not a preflight failure. Only a genuinely-unencodable target
            // (a codepoint outside Shift-JIS) is rejected at preflight.
            match kaifuu_reallive::encode_shift_jis_slot(&entry.target_text) {
                Ok(_encoded) => {}
                Err(err) => {
                    failures.push(Self::unsupported_failure(
                        SemanticErrorCode::UnsupportedLayeredTransform,
                        Capability::PatchBack,
                        variant,
                        &entry.source_unit_key,
                        format!("Shift-JIS encode failure: {err}"),
                        "replace characters outside Shift-JIS with mappable substitutes",
                    ));
                }
            }
        }
        failures
    }

    pub(crate) fn patchback_v02_failure_to_adapter_failure(
        variant: &str,
        err: kaifuu_reallive::PatchbackError,
    ) -> AdapterFailure {
        // The v0.2 `PatchbackError` Display already carries its stable
        // `kaifuu.reallive.patchback_*` code, so the message is the
        // single source of the diagnostic code.
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::UnsupportedLayeredTransform,
                REALLIVE_DETECTOR_ADAPTER_ID,
                format!("patch-back rejected: {err}"),
            )
            .engine("reallive")
            .detected_variant(variant)
            .asset_ref(REALLIVE_SEEN_TXT_PATH)
            .required_capability(Capability::PatchBack)
            .remediation(
                "review the translated bundle against the bundle-driven patch-back contract \
                 (kaifuu.reallive.patchback_* semantic codes)",
            ),
        )
    }

    // Shared extract/patch scene-walk (adapter-unify): parse each scene's
    // `SceneHeader`, AVG32-decompress its bytecode, decrypt any archive-wide
    // `xor_2` segment, and project it into a v0.2 `BridgeBundle` via
    // `bridge::produce_bundle`. Both `extract` and `patch` drive off this ONE
    // path, so the deterministic bridgeUnitIds a PatchExport is keyed on
    // (from `extract`) are exactly the ids `produce_bundle` re-derives during
    // `patch` — no id-scheme divergence.
    // A scene whose header does not parse, whose compressed range runs past
    // the blob, whose bytecode fails to decompress, or that carries no
    // translatable text unit is skipped (it has no v0.2 bridge units and is
    // carried verbatim by the repacker).
    pub(crate) fn produce_scene_bundles(
        archive_bytes: &[u8],
        scene_index: &kaifuu_reallive::RealLiveSceneIndex,
        gameexe_inventory: &kaifuu_reallive::GameexeInventoryReport,
    ) -> KaifuuResult<Vec<(u16, kaifuu_reallive::ProducedBundle)>> {
        let mut bundles = Vec::new();
        let mut decompressed_archive =
            kaifuu_reallive::decompress_archive_scenes(archive_bytes, scene_index);
        let xor2_report =
            kaifuu_reallive::recover_and_decrypt_archive(&mut decompressed_archive.scenes);
        if xor2_report.scenes_eligible > 0 && !xor2_report.validated {
            return Err(Self::diagnostic_error(Self::xor2_validation_failure()));
        }
        for entry in &scene_index.entries {
            let blob = &archive_bytes[entry.byte_offset as usize
                ..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
            let Ok(header) = kaifuu_reallive::SceneHeader::parse(blob) else {
                continue;
            };
            if kaifuu_reallive::compiler_version_uses_xor2(header.compiler_version)
                && !xor2_report.validated
            {
                continue;
            };
            let Some(decompressed_index) = decompressed_archive.position_of(entry.scene_id) else {
                continue;
            };
            let decompressed = &decompressed_archive.scenes[decompressed_index].bytecode;
            let opts = kaifuu_reallive::BridgeOpts {
                game_id: REALLIVE_GAME_ID,
                game_version: "1.0.0",
                source_profile_id: REALLIVE_PROFILE_ID,
                source_locale: "ja-JP",
                extractor_name: "kaifuu-reallive-bridge",
                extractor_version: "0.1.0",
                scene_kidoku_count: header.kidoku_count,
            };
            let Ok(produced) = kaifuu_reallive::produce_bundle(
                entry.scene_id,
                blob,
                decompressed,
                gameexe_inventory,
                &opts,
            ) else {
                continue;
            };
            bundles.push((entry.scene_id, produced));
        }
        Ok(bundles)
    }

    // Project a validated v0.2 localization unit onto the v0.1
    // `kaifuu_core::BridgeUnit` the `ExtractionResult.bridge` contract
    // carries. The `bridgeUnitId` / `sourceUnitKey` / `sourceHash` are the
    // deterministic values `produce_bundle` minted, so a PatchExport keyed
    // on them resolves against the same producer during `patch`.
    pub(crate) fn bridge_unit_from_v02(unit: &kaifuu_core::LocalizationUnitV02) -> BridgeUnit {
        let speaker = unit
            .speaker
            .as_ref()
            .and_then(|speaker| speaker.raw_speaker_text.clone())
            .unwrap_or_default();
        let protected_spans = unit
            .spans
            .iter()
            .map(Self::protected_span_from_v02)
            .collect();
        BridgeUnit {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            occurrence_id: unit.occurrence_id.clone(),
            source_hash: unit.source_hash.clone(),
            source_locale: unit.source_locale.clone(),
            source_text: unit.source_text.clone(),
            speaker,
            text_surface: unit.surface_kind.clone(),
            protected_spans,
            patch_ref: PatchRef {
                asset_id: "reallive-seen-txt".to_string(),
                write_mode: "replace".to_string(),
                source_unit_key: unit.source_unit_key.clone(),
            },
        }
    }

    fn protected_span_from_v02(span: &kaifuu_core::BridgeSpanV02) -> ProtectedSpan {
        let mut mapped = ProtectedSpan::new(
            span.span_kind.clone(),
            span.raw.clone(),
            span.start_byte,
            span.end_byte,
            span.preserve_mode.clone(),
        );
        mapped.parsed_name = span
            .parsed_name
            .as_ref()
            .and_then(|value| value.as_str())
            .map(str::to_string);
        mapped
    }
}

// Case-insensitive direct-child lookup.
// The lookup mirrors the existing `ArchiveDetectionScan.file_name_count`
// case-insensitive pattern. Returns the resolved path on a hit so callers
// can read its bytes; returns None if no direct child matches the lowercase
// name. Used only against `game_dir` (no recursion); RealLive top-level
// markers are always at the game root per Haeleth's public documentation.
pub(crate) fn case_insensitive_find(dir: &Path, name: &str) -> Option<std::path::PathBuf> {
    let target = name.to_ascii_lowercase();
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        if let Some(entry_name) = entry.file_name().to_str()
            && entry_name.to_ascii_lowercase() == target
        {
            return Some(entry.path());
        }
    }
    None
}

// walks the effective RealLive data dir (the resolved
// REALLIVEDATA subdir or, when no marker was found, the game root) up
// to two directory levels deep to count corroborating extensions and
// the AVG32 disqualifier. The depth-2 bound captures Sweetie HD's
// observed layout (`<REALLIVEDATA>/g00/*.g00`,
// `<REALLIVEDATA>/koe/*.koe`, etc.) without descending into save /
// debug subtrees that ship with some retail installers. See
// `docs/audits/real-bytes-validation-2026-06-24.md` §2.1 for the
// `find <REALLIVEDATA> -maxdepth 2` reference command that fixed the
// 2,450 `.g00` / 139 `.koe` corpus counts.
pub(crate) fn reallive_extension_counts(dir: &Path) -> (u64, u64, u64) {
    let mut g00_count: u64 = 0;
    let mut voice_archive_count: u64 = 0;
    let mut pdt_count: u64 = 0;
    walk_reallive_extension_dir(
        dir,
        2,
        0,
        &mut g00_count,
        &mut voice_archive_count,
        &mut pdt_count,
    );
    (g00_count, voice_archive_count, pdt_count)
}

fn walk_reallive_extension_dir(
    dir: &Path,
    max_depth: usize,
    current_depth: usize,
    g00_count: &mut u64,
    voice_archive_count: &mut u64,
    pdt_count: &mut u64,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if current_depth < max_depth {
                walk_reallive_extension_dir(
                    &path,
                    max_depth,
                    current_depth + 1,
                    g00_count,
                    voice_archive_count,
                    pdt_count,
                );
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(extension) = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
        else {
            continue;
        };
        match extension.as_str() {
            "g00" => *g00_count += 1,
            "ovk" | "koe" | "nwk" => *voice_archive_count += 1,
            "pdt" => *pdt_count += 1,
            _ => {}
        }
    }
}

// Generic real-shape SEEN.TXT envelope check.
// Derivation: every RealLive title since AVG32 stores SEEN.TXT as a fixed
// 10,000-slot directory of (u32_le offset, u32_le size) pairs at file
// offset 0. Each slot is 8 bytes; an unused slot is zeroed. See
// `docs/research/reallive-engine.md` §C and the Sweetie HD verification
// in `docs/audits/real-bytes-validation-2026-06-24.md` §2.8.
// We accept any file that is at least 80,000 bytes long (the fixed
// directory), contains at least one non-zero slot, and whose every
// non-zero slot resolves to a payload range inside the file. We do not
// parse scene bytecode.
pub(crate) fn reallive_seen_txt_envelope_ok(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let file_len = metadata.len();
    if file_len < kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    match kaifuu_reallive::parse_archive(&bytes) {
        Ok(index) => !index.entries.is_empty(),
        Err(_) => false,
    }
}

// Read up to 64 KiB of Gameexe.ini and check for the documented
// RealLive-specific ASCII key prefixes. The detector intentionally only
// looks at ASCII prefixes; full Gameexe parsing (including Shift-JIS
// values) is a concern.
pub(crate) fn reallive_gameexe_ini_key_hits(path: &Path) -> GameexeIniKeyHits {
    let Ok(bytes) = fs::read(path) else {
        return GameexeIniKeyHits::default();
    };
    let limit = std::cmp::min(bytes.len(), 64 * 1024);
    let slice = &bytes[..limit];
    let text = String::from_utf8_lossy(slice);
    let mut hits = GameexeIniKeyHits::default();
    for raw_line in text.lines() {
        let line = raw_line.trim_start();
        if !line.starts_with('#') {
            continue;
        }
        // Uppercase the key portion only (before '=' or whitespace) for
        // robustness, then match the RealLive Gameexe.ini key prefixes that
        // are positive engine evidence. These prefixes are documented on
        // Haeleth's RLDEV site (https://dev.haeleth.net/rldev.shtml) and
        // observable in any RealLive title's Gameexe.ini; none are copied
        // from rlvm source. This match is the single source of truth.
        let key_end = line
            .find(|c: char| c == '=' || c.is_whitespace())
            .unwrap_or(line.len());
        let key = line[..key_end].to_ascii_uppercase();
        if key == "#GAMEEXE_VERSION" {
            hits.gameexe_version = true;
        } else if key == "#REGNAME" {
            hits.regname = true;
        } else if key.starts_with("#G00") {
            hits.g00_key = true;
        } else if key.starts_with("#KOE") {
            hits.koe_key = true;
        } else if key.starts_with("#SEEN") {
            hits.seen_key = true;
        }
    }
    hits
}

pub(crate) fn gameexe_ini_detail(exists: bool, keys: GameexeIniKeyHits) -> String {
    if !exists {
        return "Gameexe.ini missing".to_string();
    }
    if !keys.any() {
        return "Gameexe.ini present but no RealLive-specific keys matched".to_string();
    }
    let mut matched = Vec::new();
    if keys.gameexe_version {
        matched.push("#GAMEEXE_VERSION");
    }
    if keys.regname {
        matched.push("#REGNAME");
    }
    if keys.g00_key {
        matched.push("#G00*");
    }
    if keys.koe_key {
        matched.push("#KOE*");
    }
    if keys.seen_key {
        matched.push("#SEEN*");
    }
    format!("Gameexe.ini RealLive keys matched: {}", matched.join(", "))
}
