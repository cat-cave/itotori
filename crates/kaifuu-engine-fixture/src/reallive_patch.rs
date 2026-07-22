use super::*;

impl RealLiveProfileDetectorAdapter {
    pub(super) fn patch_fixture(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        }
        let resolved = Self::resolve_reallive_data_dir(request.game_dir);
        let seen_path = Self::seen_txt_path(request.game_dir);
        let archive_bytes = fs::read(&seen_path)?;
        // Synthetic-magic-only fixtures (detector smoke) do not
        // present a parseable archive envelope. Return the legacy
        // unsupported-patch result so the detector contract stays observable
        // through `patch`.
        let Ok(scene_index) = kaifuu_reallive::parse_archive(&archive_bytes) else {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        };
        let variant = Self::detected_variant(state.variant);
        let patch_export_id = request.patch_export.patch_export_id.clone();
        let failed = |failures: Vec<AdapterFailure>| PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-patch", 174),
            patch_export_id: patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: kaifuu_core::sha256_hash_bytes(&archive_bytes),
            failures,
        };

        // Canonical patch-back route: rebuild
        // the v0.2 BridgeBundle per scene via `produce_bundle`, match the
        // PatchExport entries to bridge units by `bridgeUnitId`, then applies
        // the length-changing bundle through `bundle_driven::apply_translated_bundle`.
        // Gameexe.ini feeds the
        // producer's voice/asset inventory (best-effort; absent ->
        // empty).
        let gameexe_path =
            Self::gameexe_ini_path_with_resolved(request.game_dir, resolved.as_deref());
        let gameexe_bytes = fs::read(&gameexe_path).unwrap_or_default();
        let gameexe_inventory = kaifuu_reallive::parse_gameexe_inventory(&gameexe_bytes);

        // Unified extract/patch path (adapter-unify): patch rebuilds the
        // per-scene v0.2 bridge through the SAME `produce_scene_bundles`
        // walk `extract` uses, so the PatchExport's bridgeUnitIds (minted
        // by extract) match the ids re-derived here.
        let produced_scenes =
            Self::produce_scene_bundles(&archive_bytes, &scene_index, &gameexe_inventory)?;
        let mut matched_entry_ids: BTreeSet<String> = BTreeSet::new();
        let mut touched: Vec<(u16, serde_json::Value)> = Vec::new();
        // Length-CHANGING patch-back (reallive-adapter-expose-length-changing-
        // patchback): the adapter routes every matched edit straight
        // through `bundle_driven::apply_translated_bundle`, which rewrites the
        // archive offset table and recalculates jump targets so a translation
        // that grows or shrinks the Shift-JIS body round-trips byte-correct.
        // A plain length change is supported, not a failure: the Shift-JIS body may
        // grow or shrink freely within scene-packing limits. Genuinely-unencodable
        // edits (a non-Shift-JIS codepoint, a goto target left strictly inside an
        // edited body, or a scene-packing overflow) are rejected with a typed
        // `kaifuu.reallive.patchback_*` Fatal, surfaced below.
        for (scene_id, produced) in &produced_scenes {
            let mut translated_json = produced.json.clone();
            let mut scene_matched = 0usize;
            if let Some(units_json) = translated_json["units"].as_array_mut() {
                for (i, unit) in produced.bundle.units.iter().enumerate() {
                    if let Some(export_entry) = request
                        .patch_export
                        .entries
                        .iter()
                        .find(|e| e.bridge_unit_id == unit.bridge_unit_id)
                    {
                        units_json[i]["target"] = serde_json::json!({
                            "locale": request.patch_export.target_locale,
                            "text": export_entry.target_text,
                        });
                        matched_entry_ids.insert(export_entry.bridge_unit_id.clone());
                        scene_matched += 1;
                    }
                }
            }
            if scene_matched == 0 {
                continue;
            }
            // No silent partial: a touched scene must translate EVERY one
            // of its bridge units (the v0.2 TranslatedBundle contract
            // requires a target per unit).
            if scene_matched != produced.bundle.units.len() {
                return Ok(failed(vec![Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    variant,
                    REALLIVE_SEEN_TXT_PATH,
                    format!(
                        "scene {scene:04} is partially translated ({scene_matched}/{total} \
                         bridge units); the bundle-driven patch-back requires a target for \
                         every unit in a patched scene",
                        scene = scene_id,
                        total = produced.bundle.units.len()
                    ),
                    "translate every unit of the scene, or re-extract a scene-scoped bundle",
                )]));
            }
            touched.push((*scene_id, translated_json));
        }

        // Any export entry that matched no bridge unit is a stale/unknown
        // reference — surface it as a typed failure.
        let unmatched: Vec<AdapterFailure> = request
            .patch_export
            .entries
            .iter()
            .filter(|e| !matched_entry_ids.contains(&e.bridge_unit_id))
            .map(|e| {
                Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    variant,
                    e.source_unit_key.clone(),
                    "PatchExportEntry bridgeUnitId is not present in any scene's v0.2 bridge",
                    "re-extract the bridge bundle before re-applying this patch",
                )
            })
            .collect();
        if !unmatched.is_empty() {
            return Ok(failed(unmatched));
        }

        let passed = |output_hash: String| PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-patch", 174),
            patch_export_id: patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash,
            failures: vec![],
        };
        let write_output = |bytes: &[u8]| -> KaifuuResult<()> {
            let output_path =
                kaifuu_core::safe_join_relative(request.output_dir, REALLIVE_SEEN_TXT_PATH)?;
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&output_path, bytes)?;
            Ok(())
        };

        // Empty export (or one that touched no scene) is an identity
        // patch: emit the source archive unchanged.
        if touched.is_empty() {
            write_output(&archive_bytes)?;
            return Ok(passed(kaifuu_core::sha256_hash_bytes(&archive_bytes)));
        }
        // The bundle-driven driver patches one source BridgeBundle (one
        // scene) per call. Multi-scene exports are out of scope for the
        // detector fixture's patch surface.
        if touched.len() > 1 {
            return Ok(failed(vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::PatchBack,
                variant,
                REALLIVE_SEEN_TXT_PATH,
                format!(
                    "patch export spans {} scenes; the fixture patch surface applies one \
                     scene-scoped bundle per call",
                    touched.len()
                ),
                "split the export into per-scene bundles and patch each scene separately",
            )]));
        }

        let (_scene_id, translated_json) = &touched[0];
        let translated = match kaifuu_reallive::TranslatedBundleV02::from_json(translated_json) {
            Ok(translated) => translated,
            Err(err) => {
                return Ok(failed(vec![
                    Self::patchback_v02_failure_to_adapter_failure(variant, err),
                ]));
            }
        };
        match kaifuu_reallive::apply_translated_bundle(
            &archive_bytes,
            &translated,
            // The fixture patch surface applies the FULL curated bundle it is
            // handed (dialogue + any choices), so it declares the widest alpha
            // scope; a dialogue-only bundle simply has no choice units.
            &kaifuu_reallive::PatchbackOpts::shift_jis(
                kaifuu_reallive::TranslationScope::DialogueAndChoices,
            ),
        ) {
            Ok(patched) => {
                write_output(&patched)?;
                Ok(passed(kaifuu_core::sha256_hash_bytes(&patched)))
            }
            Err(err) => Ok(failed(vec![
                Self::patchback_v02_failure_to_adapter_failure(variant, err),
            ])),
        }
    }
}
