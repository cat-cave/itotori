#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_record_validates_and_covers_all_roles() {
        let record = MvMzReadinessRecord::canonical();
        assert_eq!(record.engine_family, "rpg_maker_mv_mz");
        assert_eq!(record.variant, "mv_or_mz");
        assert_eq!(record.capability, CapabilityLevel::Inventory);
        assert_eq!(record.json_text_surfaces.len(), 6);
        assert!(record.identity.is_identity());
        // Every role is present exactly once.
        for role in MvMzSurfaceRole::all() {
            assert_eq!(
                record
                    .json_text_surfaces
                    .iter()
                    .filter(|s| s.role == role)
                    .count(),
                1,
                "role {role:?} present once"
            );
        }
        record.validate().expect("canonical record is consistent");
    }

    #[test]
    fn identity_container_has_no_crypto_leg() {
        let identity = IdentityContainer::json_text();
        assert_eq!(identity.crypto, CryptoTransform::NullKey);
        assert_eq!(identity.codec, CodecTransform::JsonText);
        assert!(!is_media_codec(identity.codec));
        assert!(identity.is_identity());
    }

    #[test]
    fn encrypted_media_diagnostics_are_all_unsupported() {
        let record = MvMzReadinessRecord::canonical();
        assert!(!record.encrypted_media_diagnostics.is_empty());
        for diagnostic in &record.encrypted_media_diagnostics {
            assert!(!diagnostic.extractable, "{}", diagnostic.diagnostic_id);
            assert!(!diagnostic.patchable, "{}", diagnostic.diagnostic_id);
            assert!(is_media_codec(diagnostic.codec));
            assert_ne!(diagnostic.crypto, CryptoTransform::NullKey);
        }
    }

    #[test]
    fn validate_rejects_json_text_surface_with_media_codec() {
        let mut record = MvMzReadinessRecord::canonical();
        record.json_text_surfaces[0].codec = CodecTransform::PngImage;
        let violations = record.validate().expect_err("media codec must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::JsonTextSurfaceClaimsMediaCodec { .. }
        )));
    }

    #[test]
    fn validate_rejects_extractable_or_patchable_encrypted_media() {
        let mut record = MvMzReadinessRecord::canonical();
        record.encrypted_media_diagnostics[0].extractable = true;
        record.encrypted_media_diagnostics[1].patchable = true;
        let violations = record.validate().expect_err("must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::EncryptedMediaMarkedExtractable { .. }
        )));
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::EncryptedMediaMarkedPatchable { .. }
        )));
    }

    #[test]
    fn validate_rejects_identity_container_with_crypto() {
        let mut record = MvMzReadinessRecord::canonical();
        record.identity.crypto = CryptoTransform::RpgMakerAssetXor;
        let violations = record.validate().expect_err("crypto leg must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::IdentityContainerNotIdentity { .. }
        )));
    }

    #[test]
    fn validate_rejects_capability_above_inventory() {
        let mut record = MvMzReadinessRecord::canonical();
        record.capability = CapabilityLevel::Extract;
        record.json_text_surfaces[0].capability = CapabilityLevel::Patch;
        let violations = record.validate().expect_err("must fail");
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, MvMzReadinessViolation::CapabilityAboveInventory { .. }))
        );
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::JsonTextSurfaceAboveInventory { .. }
        )));
    }

    #[test]
    fn fixture_profiles_reference_known_surface_ids() {
        let record = MvMzReadinessRecord::canonical();
        let known: std::collections::BTreeSet<&str> = record
            .json_text_surfaces
            .iter()
            .map(|s| s.surface_id.as_str())
            .collect();
        assert_eq!(record.fixture_profiles.len(), 4);
        for profile in &record.fixture_profiles {
            assert!(!profile.surface_ids.is_empty());
            for surface_id in &profile.surface_ids {
                assert!(known.contains(surface_id.as_str()), "{surface_id}");
            }
        }
    }

    #[test]
    fn validate_rejects_profile_referencing_unknown_surface() {
        let mut record = MvMzReadinessRecord::canonical();
        record.fixture_profiles[0]
            .surface_ids
            .push("mv_mz/json_text/nonexistent".to_string());
        let violations = record.validate().expect_err("unknown surface must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzReadinessViolation::FixtureProfileUnknownSurface { .. }
        )));
    }

    #[test]
    fn negative_fixture_keeps_encrypted_media_outside_json_text() {
        let negative = MvMzNegativeFixture::encrypted_media_only();
        assert!(negative.proves_encrypted_media_outside_json_text());
        assert!(negative.record.json_text_surfaces.is_empty());
        negative
            .record
            .validate()
            .expect("encrypted-media-only record is internally consistent");
    }

    #[test]
    fn negative_fixture_tampered_claim_is_mechanically_rejected() {
        let negative = MvMzNegativeFixture::encrypted_media_only();
        let tampered = negative.tampered_claims_encrypted_media();
        let violations = tampered
            .validate()
            .expect_err("tampered extractable/patchable claim must fail validation");
        // Both flips, across all three diagnostics, surface as violations.
        let extractable = violations
            .iter()
            .filter(|v| {
                matches!(
                    v,
                    MvMzReadinessViolation::EncryptedMediaMarkedExtractable { .. }
                )
            })
            .count();
        let patchable = violations
            .iter()
            .filter(|v| {
                matches!(
                    v,
                    MvMzReadinessViolation::EncryptedMediaMarkedPatchable { .. }
                )
            })
            .count();
        assert_eq!(extractable, 3);
        assert_eq!(patchable, 3);
    }

    #[test]
    fn fixture_manifest_is_deterministic_and_public() {
        let a = mv_mz_fixture_manifest();
        let b = mv_mz_fixture_manifest();
        assert_eq!(a, b, "manifest must be deterministic");
        assert_eq!(a.fixture_id, MV_MZ_FIXTURE_ID);
        assert!(!a.files.is_empty());
        // Sorted by relative path; every file carries a sha256 + byte count.
        let mut sorted = a.files.clone();
        sorted.sort_by(|x, y| x.relative_path.cmp(&y.relative_path));
        assert_eq!(a.files, sorted);
        for file in &a.files {
            assert!(file.content_sha256.starts_with("sha256:"));
            assert!(file.byte_count > 0);
            // No retail/private/encrypted leakage in the manifest paths.
            let path = &file.relative_path;
            assert!(!path.contains(".."), "no parent escapes: {path}");
            assert!(!path.starts_with('/'), "no absolute paths: {path}");
            for encrypted in [".rpgmvp", ".rpgmvm", ".rpgmvo", ".rpgmvu", ".png_", ".m4a_"] {
                assert!(!path.ends_with(encrypted), "no encrypted asset: {path}");
            }
            for binary in [".png", ".jpg", ".jpeg", ".m4a", ".ogg", ".webp"] {
                assert!(!path.ends_with(binary), "no media/screenshot asset: {path}");
            }
        }
    }

    #[test]
    fn generated_tree_matches_manifest_and_detects_as_rpg_maker() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest =
            generate_mv_mz_fixture_tree(tmp.path()).expect("fixture generation succeeds");
        assert_eq!(manifest, mv_mz_fixture_manifest());

        // Files exist on disk with the manifested byte counts and hashes.
        for file in &manifest.files {
            let on_disk = tmp.path().join(&file.relative_path);
            let bytes = std::fs::read(&on_disk).expect("written file");
            assert_eq!(bytes.len() as u64, file.byte_count);
            assert_eq!(sha256_hash_bytes(&bytes), file.content_sha256);
        }

        // The synthetic tree is identified as RPG Maker MV/MZ by the shared
        // archive detector (System.json encryption fields), so downstream
        // slices can reuse engine identification on a public tree.
        let www = tmp.path().join("www");
        let detection = crate::ArchiveDetectionReport::scan(&www);
        assert!(
            detection.rows.iter().any(|row| {
                row.engine_family == crate::ArchiveEngineFamily::RpgMakerMvMz && row.detected
            }),
            "public fixture tree must detect as RPG Maker MV/MZ"
        );

        // No encrypted asset bytes were ever written.
        for entry in walkdir(tmp.path()) {
            let name = entry.to_string_lossy().to_string();
            for encrypted in [".rpgmvp", ".rpgmvm", ".rpgmvo", ".rpgmvu", ".png_", ".m4a_"] {
                assert!(
                    !name.ends_with(encrypted),
                    "no encrypted asset on disk: {name}"
                );
            }
        }
    }

    /// Minimal recursive file walk for the no-encrypted-asset disk assertion.
    fn walkdir(root: &Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path);
                }
            }
        }
        out
    }

    #[test]
    fn record_and_manifest_round_trip_through_stable_json() {
        let record = MvMzReadinessRecord::canonical();
        let json = record.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: MvMzReadinessRecord = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, record);

        let manifest = mv_mz_fixture_manifest();
        let mjson = manifest.stable_json().expect("stable json");
        let mparsed: MvMzFixtureManifest = serde_json::from_str(&mjson).expect("round trip");
        assert_eq!(mparsed, manifest);
    }
}

