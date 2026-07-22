use super::*;

// JSON bundle assembly

pub(super) fn build_bundle_json(
    scene_id: u16,
    scene_bytes: &[u8],
    units: &[ProtoUnit],
    opts: &BridgeOpts<'_>,
) -> Result<Value, BridgeProduceError> {
    let bundle_namespace = scene_bundle_namespace(opts.game_id, opts.source_profile_id, scene_id);
    let scene_blob_hash = sha256_canonical(scene_bytes);
    let revision_id = deterministic_uuid7(&bundle_namespace, "scene-revision");

    let asset_id = deterministic_uuid7(&bundle_namespace, "scene-asset");
    let asset_key = format!("reallive:scene-{scene_id:04}");

    let bridge_id = deterministic_uuid7(&bundle_namespace, "bundle");
    let source_profile_revision_id =
        deterministic_uuid7(&bundle_namespace, "source-profile-revision");
    let source_profile_hash = sha256_canonical(opts.source_profile_id.as_bytes());

    let assets = json!([
        {
            "assetId": asset_id,
            "assetKey": asset_key,
            "assetKind": "script",
            "sourceHash": scene_blob_hash,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_blob_hash,
            },
            "path": format!("REALLIVEDATA/Seen.txt#scene-{scene_id:04}"),
        }
    ]);

    let units_json: Vec<Value> = units
        .iter()
        .map(|unit| {
            build_unit_json(
                scene_id,
                &asset_id,
                &asset_key,
                &revision_id,
                &scene_blob_hash,
                &bundle_namespace,
                opts,
                unit,
            )
        })
        .collect::<Result<Vec<Value>, BridgeProduceError>>()?;

    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION_V02,
        "bridgeId": bridge_id,
        "sourceGame": {
            "gameId": opts.game_id,
            "gameVersion": opts.game_version,
            "sourceProfileId": opts.source_profile_id,
            "sourceProfileRevision": {
                "revisionId": source_profile_revision_id,
                "revisionKind": "content_hash",
                "value": source_profile_hash,
            },
        },
        "sourceBundleHash": scene_blob_hash,
        "sourceBundleRevision": {
            "revisionId": revision_id,
            "revisionKind": "content_hash",
            "value": scene_blob_hash,
        },
        "sourceLocale": opts.source_locale,
        "hashStrategy": {
            "sourceProfile": {
                "scope": "source_profile",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceBundle": {
                "scope": "source_bundle",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceAsset": {
                "scope": "source_asset",
                "algorithm": "sha256",
                "normalization": "bytes",
            },
            "sourceUnit": {
                "scope": "source_unit",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
                "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
            },
            "patchExport": {
                "scope": "patch_export",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "deltaPackage": {
                "scope": "delta_package",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
        },
        "extractor": {
            "name": opts.extractor_name,
            "version": opts.extractor_version,
        },
        "assets": assets,
        "units": units_json,
        "policyRecords": [],
    }))
}

pub(super) fn build_whole_seen_bundle_json(
    seen_bytes: &[u8],
    scenes: &[SceneBundleParts<'_>],
    opts: &BridgeOpts<'_>,
) -> Result<Value, BridgeProduceError> {
    let bundle_namespace = format!(
        "reallive-bridge:game-id={}:source-profile-id={}:whole-seen",
        opts.game_id, opts.source_profile_id
    );
    let seen_hash = sha256_canonical(seen_bytes);
    let bridge_id = deterministic_uuid7(&bundle_namespace, "bundle");
    let seen_revision_id = deterministic_uuid7(&bundle_namespace, "seen-revision");
    let source_profile_revision_id =
        deterministic_uuid7(&bundle_namespace, "source-profile-revision");
    let source_profile_hash = sha256_canonical(opts.source_profile_id.as_bytes());

    let mut assets = Vec::new();
    let mut units_json = Vec::new();
    for scene in scenes {
        let scene_namespace = format!(
            "reallive-bridge:game-id={}:source-profile-id={}:scene={:04}",
            opts.game_id, opts.source_profile_id, scene.scene_id
        );
        let scene_blob_hash = sha256_canonical(scene.scene_bytes);
        let revision_id = deterministic_uuid7(&scene_namespace, "scene-revision");
        let asset_id = deterministic_uuid7(&scene_namespace, "scene-asset");
        let asset_key = format!("reallive:scene-{:04}", scene.scene_id);

        assets.push(json!({
            "assetId": asset_id,
            "assetKey": asset_key,
            "assetKind": "script",
            "sourceHash": scene_blob_hash,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_blob_hash,
            },
            "path": format!("REALLIVEDATA/Seen.txt#scene-{:04}", scene.scene_id),
        }));

        for unit in &scene.units {
            units_json.push(build_unit_json(
                scene.scene_id,
                &asset_id,
                &asset_key,
                &revision_id,
                &scene_blob_hash,
                &scene_namespace,
                opts,
                unit,
            )?);
        }
    }

    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION_V02,
        "bridgeId": bridge_id,
        "sourceGame": {
            "gameId": opts.game_id,
            "gameVersion": opts.game_version,
            "sourceProfileId": opts.source_profile_id,
            "sourceProfileRevision": {
                "revisionId": source_profile_revision_id,
                "revisionKind": "content_hash",
                "value": source_profile_hash,
            },
        },
        "sourceBundleHash": seen_hash,
        "sourceBundleRevision": {
            "revisionId": seen_revision_id,
            "revisionKind": "content_hash",
            "value": seen_hash,
        },
        "sourceLocale": opts.source_locale,
        "hashStrategy": {
            "sourceProfile": {
                "scope": "source_profile",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceBundle": {
                "scope": "source_bundle",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "sourceAsset": {
                "scope": "source_asset",
                "algorithm": "sha256",
                "normalization": "bytes",
            },
            "sourceUnit": {
                "scope": "source_unit",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
                "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
            },
            "patchExport": {
                "scope": "patch_export",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
            "deltaPackage": {
                "scope": "delta_package",
                "algorithm": "sha256",
                "normalization": "utf8-lf-json-stable-v1",
            },
        },
        "extractor": {
            "name": opts.extractor_name,
            "version": opts.extractor_version,
        },
        "assets": assets,
        "units": units_json,
        "policyRecords": [],
    }))
}

// reason: cohesive bridge-unit JSON builder over distinct wire fields; a params struct would relocate the arity without clarity.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_unit_json(
    scene_id: u16,
    asset_id: &str,
    asset_key: &str,
    revision_id: &str,
    scene_blob_hash: &str,
    namespace: &str,
    opts: &BridgeOpts<'_>,
    unit: &ProtoUnit,
) -> Result<Value, BridgeProduceError> {
    let source_text = format!("{}{}", unit.control_prefix, unit.decoded_text);
    let bridge_unit_id = deterministic_uuid7(namespace, &format!("unit-{}", unit.occurrence_index));
    let surface_id = deterministic_uuid7(namespace, &format!("surface-{}", unit.occurrence_index));
    let source_unit_key = format!(
        "reallive:scene-{scene_id:04}#{occ:04}",
        occ = unit.occurrence_index
    );
    let occurrence_id = format!("scene-{scene_id:04}-occ-{:04}", unit.occurrence_index);

    let source_hash = sha256_canonical(source_text.as_bytes());

    let mut spans_json: Vec<Value> = Vec::new();
    for (idx, span) in unit.spans.iter().enumerate() {
        // Validate the span byte range matches the wrapped source text. A
        // failure is a producer regression (an off-by-one in the span
        // arithmetic, or a span that no longer covers its protected
        // region), NOT something to silently drop: dropping it would lose
        // the `preserveMode=exact` guard and let a translate+patchback
        // pass rewrite a protected `#FACE(...)` / `【NAMAE】` region. Surface
        // a typed error per the 100%-fidelity contract.
        if span.end_byte as usize > source_text.len() {
            return Err(BridgeProduceError::ProtectedSpanInvalid {
                scene_id,
                occurrence_index: unit.occurrence_index,
                span_index: idx,
                parsed_name: span.parsed_name,
                start_byte: span.start_byte,
                end_byte: span.end_byte,
                reason: format!("end_byte exceeds sourceText length {}", source_text.len()),
            });
        }
        let actual = &source_text.as_bytes()[span.start_byte as usize..span.end_byte as usize];
        if actual != span.raw.as_bytes() {
            return Err(BridgeProduceError::ProtectedSpanInvalid {
                scene_id,
                occurrence_index: unit.occurrence_index,
                span_index: idx,
                parsed_name: span.parsed_name,
                start_byte: span.start_byte,
                end_byte: span.end_byte,
                reason: format!(
                    "byte range covers {} but span.raw is {}",
                    RedactedContentSummary::from_bytes(actual),
                    RedactedContentSummary::from_text(&span.raw),
                ),
            });
        }
        let mut span_json = json!({
            "spanId": deterministic_uuid7(namespace, &format!("span-{}-{}", unit.occurrence_index, idx)),
            "spanKind": "control_markup",
            "raw": span.raw,
            "startByte": span.start_byte,
            "endByte": span.end_byte,
            "preserveMode": "exact",
            "parsedName": span.parsed_name,
        });
        // This flag mirrors `REALLIVE_OUT_OF_BAND_MARKER_OPEN` in patchback:
        // the extractor knows which synthetic spans are re-emitted structurally.
        if span.out_of_band {
            span_json["outOfBand"] = json!(true);
        }
        spans_json.push(span_json);
    }

    // `range` is a DECOMPRESSED-bytecode-stream interval — the only
    // honest per-unit coordinate, since a unit has no fixed offset
    // inside the LZSS-compressed scene blob. We must NOT add the scene's
    // compressed file offset here: a unit whose decompressed offset
    // exceeds its scene's compressed `byte_len` would then resolve into
    // a later scene during patchback. The owning scene is recovered from
    // `containerKey` / `sourceUnitKey` (its scene id), not from this
    // range.
    let unit_decompressed_start = unit.decompressed_byte_offset;
    let unit_decompressed_end =
        unit_decompressed_start.saturating_add(unit.decompressed_byte_len.max(1));

    let source_location = json!({
        "containerKey": format!("reallive:scene-{scene_id:04}"),
        "entryPath": [
            "scene",
            format!("{scene_id:04}"),
            "units",
            format!("{:04}", unit.occurrence_index),
        ],
        "range": {
            "startByte": unit_decompressed_start,
            "endByte": unit_decompressed_end,
        },
    });

    let speaker = build_speaker_json(namespace, &unit.resolution);

    let context = match unit.surface_kind {
        "choice_label" => {
            let group = unit.choice_group_index.unwrap_or(0);
            let option = unit.choice_option_index.unwrap_or(0);
            json!({
                "choice": {
                    "choiceGroupId": deterministic_uuid7(
                        namespace,
                        &format!("choice-group-{group}")
                    ),
                    "choiceId": deterministic_uuid7(
                        namespace,
                        &format!("choice-{group}-{option}")
                    ),
                    "optionIndex": option,
                },
                "route": {
                    "sceneKey": format!("scene-{scene_id:04}"),
                    "position": format!("choice-{group}-{option}"),
                },
            })
        }
        _ => json!({
            "route": {
                "sceneKey": format!("scene-{scene_id:04}"),
                "position": format!("line-{:04}", unit.occurrence_index),
            },
        }),
    };

    let mut runtime_expectation = json!({
        "expectationKind": "trace_text",
        "traceKey": occurrence_id.clone(),
    });
    if let (Some(archive_id), Some(sample_id)) = (&unit.voice_archive_id, unit.voice_sample_id) {
        runtime_expectation = json!({
            "expectationKind": "trace_text",
            "traceKey": format!("{occurrence_id}#voice={archive_id}:{sample_id}"),
        });
    }

    Ok(json!({
        "bridgeUnitId": bridge_unit_id,
        "surfaceId": surface_id,
        "surfaceKind": unit.surface_kind,
        "sourceUnitKey": source_unit_key,
        "occurrenceId": occurrence_id,
        "sourceLocale": opts.source_locale,
        "sourceText": source_text,
        "sourceHash": source_hash,
        "sourceRevision": {
            "revisionId": revision_id,
            "revisionKind": "content_hash",
            "value": scene_blob_hash,
        },
        "sourceAssetRef": {
            "assetId": asset_id,
            "assetKey": asset_key,
        },
        "sourceLocation": source_location,
        "speaker": speaker,
        "context": context,
        "spans": spans_json,
        "patchRef": {
            "assetId": asset_id,
            "writeMode": "replace",
            "sourceUnitKey": source_unit_key,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_blob_hash,
            },
        },
        "runtimeExpectation": runtime_expectation,
    }))
}

/// Build the v0.2 speaker object for one line from its typed resolution.
/// A resolved name is emitted as `known` (reader sees the real name) or
/// `reader_unknown` (reader sees a mask) — NEVER mislabelled as
/// `parser_unknown`, which is reserved for genuinely-unresolved speakers.
/// The `textColor` (RGB) and `revealState` keys are additive extensions:
/// both are derived from real Gameexe data (never a default) and are
/// tolerated by the v0.2 validators (no `deny_unknown_fields`). The
/// reader-safe label is `displayName` for a revealed speaker and
/// `readerLabel` for a concealed one, so a reader-facing surface never has
/// to show a spoiler identity.
fn build_speaker_json(namespace: &str, resolution: &SpeakerResolution) -> Value {
    match resolution {
        SpeakerResolution::Revealed {
            display_name,
            canonical_ref,
            color,
        } => {
            let mut speaker = json!({
                "knowledgeState": "known",
                "speakerId": deterministic_speaker_id(namespace, canonical_ref),
                "displayName": display_name,
                "canonicalNameRef": canonical_ref,
                "revealState": "revealed",
            });
            if let Some([r, g, b]) = color {
                speaker["textColor"] = json!([r, g, b]);
            }
            speaker
        }
        SpeakerResolution::Concealed {
            display_name,
            reader_label,
            canonical_ref,
            color,
        } => {
            let mut speaker = json!({
                "knowledgeState": "reader_unknown",
                "speakerId": deterministic_speaker_id(namespace, canonical_ref),
                "displayName": display_name,
                "readerLabel": reader_label,
                "canonicalNameRef": canonical_ref,
                "revealState": "concealed",
            });
            if let Some([r, g, b]) = color {
                speaker["textColor"] = json!([r, g, b]);
            }
            speaker
        }
        SpeakerResolution::ParserUnknown { raw, evidence } => json!({
            "knowledgeState": "parser_unknown",
            "rawSpeakerText": raw,
            "evidence": evidence,
        }),
        SpeakerResolution::NotApplicable => json!({ "knowledgeState": "not_applicable" }),
    }
}
