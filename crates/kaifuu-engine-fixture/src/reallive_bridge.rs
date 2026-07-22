use super::*;

impl RealLiveProfileDetectorAdapter {
    pub(super) fn xor2_validation_failure() -> AdapterFailure {
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

    pub(super) fn parser_failure(
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
                "audit SEEN.TXT bytes against the supported envelope shape and re-run extract",
            ),
        )
    }

    pub(super) fn preflight_failures(
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

    pub(super) fn patchback_v02_failure_to_adapter_failure(
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
    pub(super) fn produce_scene_bundles(
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
    pub(super) fn bridge_unit_from_v02(unit: &kaifuu_core::LocalizationUnitV02) -> BridgeUnit {
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

    pub(super) fn protected_span_from_v02(span: &kaifuu_core::BridgeSpanV02) -> ProtectedSpan {
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
