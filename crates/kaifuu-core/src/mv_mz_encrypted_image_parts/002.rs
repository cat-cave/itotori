#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzEncryptedImageFixtureEntry {
    pub entry_id: String,
    pub requirement_id: String,
    /// Structured secret-ref for the asset key. Never raw key material.
    pub secret_ref: SecretRef,
    /// The named image surface this entry targets (surface provenance).
    pub surface: MvMzImageSurface,
    /// The declared surface codec. The path accepts `png_image` only; an audio
    /// or JSON codec is an `unsupported_surface`.
    pub surface_codec: CodecTransform,
    pub scenario: MvMzEncryptedImageScenario,
    pub expected: MvMzEncryptedImageOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageReport {
    pub schema_version: String,
    pub path_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub path: MvMzEncryptedImagePath,
    pub status: OperationStatus,
    pub entries: Vec<MvMzEncryptedImageEntryReport>,
}

impl MvMzEncryptedImageReport {
    pub fn entry(&self, entry_id: &str) -> Option<&MvMzEncryptedImageEntryReport> {
        self.entries.iter().find(|entry| entry.entry_id == entry_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            path_id: redact_for_log_or_report(&self.path_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            path: self.path.clone(),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(MvMzEncryptedImageEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub path_id: String,
    pub surface_id: String,
    pub scenario: MvMzEncryptedImageScenario,
    pub outcome: MvMzEncryptedImageOutcome,
    /// `true` only when the asset decrypted to a valid PNG AND re-encrypted
    /// byte-correctly.
    pub round_tripped: bool,
    /// The round-trip proof, present **only** when `round_tripped`. `None` means
    /// no re-encrypted patch artifact was produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<MvMzImageRoundTripProof>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
    pub findings: Vec<MvMzEncryptedImageFinding>,
}

impl MvMzEncryptedImageEntryReport {
    /// The byte-correct round-trip proof an adapter may consume **iff** the
    /// entry passed and round-tripped. Anything else returns `None`, so a
    /// caller physically cannot consume a patch artifact for a failed entry.
    pub fn consumable_proof(&self) -> Option<&MvMzImageRoundTripProof> {
        if self.round_tripped && self.status == OperationStatus::Passed {
            self.proof.as_ref()
        } else {
            None
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            entry_id: redact_for_log_or_report(&self.entry_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            path_id: redact_for_log_or_report(&self.path_id),
            surface_id: redact_for_log_or_report(&self.surface_id),
            scenario: self.scenario,
            outcome: self.outcome,
            round_tripped: self.round_tripped,
            proof: self
                .proof
                .as_ref()
                .map(MvMzImageRoundTripProof::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(MvMzEncryptedImageFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The byte-correct round-trip proof. Carries hashes / counts / a secret-ref
/// only — never the key bytes, never the decrypted image bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzImageRoundTripProof {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub surface_id: String,
    /// sha256 of the original encrypted asset bytes.
    pub encrypted_source_hash: ProofHash,
    /// sha256 of the decrypted plaintext PNG bytes.
    pub decrypted_plaintext_hash: ProofHash,
    /// sha256 of the re-encrypted asset bytes.
    pub reencrypted_hash: ProofHash,
    /// `true` iff `reencrypted_hash == encrypted_source_hash` (byte-correct).
    pub byte_correct_round_trip: bool,
    /// One-way sha256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    /// Proof method + hash. `proof_hash` is the byte-correct re-encrypted hash.
    pub validation: KeyValidationProof,
    pub redaction_status: crate::HelperRedactionStatus,
}

impl MvMzImageRoundTripProof {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            surface_id: redact_for_log_or_report(&self.surface_id),
            encrypted_source_hash: self.encrypted_source_hash.clone(),
            decrypted_plaintext_hash: self.decrypted_plaintext_hash.clone(),
            reencrypted_hash: self.reencrypted_hash.clone(),
            byte_correct_round_trip: self.byte_correct_round_trip,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            validation: self.validation.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl MvMzEncryptedImageFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::read_json;

    fn manifest_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/rpgmaker")
    }

    fn load_fixture() -> MvMzEncryptedImageFixture {
        read_json(&manifest_dir().join("encrypted-image.json"))
            .expect("encrypted-image manifest must parse")
    }

    fn run(fixture: &MvMzEncryptedImageFixture) -> MvMzEncryptedImageReport {
        run_mv_mz_encrypted_image(MvMzEncryptedImageRequest {
            fixture,
            fixture_file_name: "encrypted-image.json",
        })
        .expect("run must not error internally")
    }

    fn entry_mut<'a>(
        fixture: &'a mut MvMzEncryptedImageFixture,
        entry_id: &str,
    ) -> &'a mut MvMzEncryptedImageFixtureEntry {
        fixture
            .entries
            .iter_mut()
            .find(|entry| entry.entry_id == entry_id)
            .expect("entry must exist")
    }

    fn has_finding(report: &MvMzEncryptedImageReport, entry_id: &str, code: &str) -> bool {
        report
            .entry(entry_id)
            .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
    }

    #[test]
    fn canonical_path_declares_and_validates_every_leg() {
        let path = MvMzEncryptedImagePath::canonical().unwrap();
        assert_eq!(path.engine_family, "rpg_maker_mv_mz");
        assert_eq!(path.variant, "mv_or_mz");
        assert_eq!(path.container, ContainerTransform::ProjectAsset);
        assert_eq!(path.codec, CodecTransform::PngImage);
        assert_eq!(
            path.crypto_profile.crypto,
            CryptoTransform::RpgMakerAssetXor
        );
        assert_eq!(path.patch_back, PatchBackTransform::ReplaceAsset);
        assert_eq!(
            path.secret_requirement_ids,
            vec![MV_MZ_ENCRYPTED_IMAGE_REQUIREMENT_ID.to_string()]
        );
        assert_eq!(path.image_surfaces.len(), 5);
        assert!(!path.diagnostics.is_empty());
        assert_eq!(path.fixture_id, MV_MZ_ENCRYPTED_IMAGE_FIXTURE_ID);
        path.validate().expect("canonical path is consistent");
    }

    #[test]
    fn validate_rejects_non_image_codec_and_wrong_legs() {
        let mut path = MvMzEncryptedImagePath::canonical().unwrap();
        path.codec = CodecTransform::M4aAudio;
        path.patch_back = PatchBackTransform::RewriteJson;
        path.image_surfaces[0].codec = CodecTransform::OggAudio;
        let violations = path.validate().expect_err("must fail");
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, MvMzEncryptedImagePathViolation::WrongCodec { .. }))
        );
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedImagePathViolation::PatchBackNotReplaceAsset { .. }
        )));
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedImagePathViolation::ImageSurfaceClaimsNonImageCodec { .. }
        )));
    }

    #[test]
    fn decrypt_re_encrypt_is_byte_correct_round_trip() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let encrypted = encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT);
        // The encrypted asset carries the RPGMV header magic.
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
        );
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &key).expect("decrypts");
        assert_eq!(plaintext, SYNTHETIC_PNG, "decrypt recovers the PNG exactly");
        assert!(is_png(&plaintext));
        let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
        assert_eq!(
            reencrypted, encrypted,
            "re-encrypt reproduces the source bytes (byte-correct)"
        );
        assert_eq!(
            sha256_hash_bytes(&reencrypted),
            sha256_hash_bytes(&encrypted)
        );
    }

    #[test]
    fn wrong_key_decrypt_does_not_yield_a_png() {
        let encrypted = encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT);
        let wrong = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_WRONG);
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &wrong).expect("strips header");
        assert!(!is_png(&plaintext), "wrong key must not recover the PNG");
    }

    #[test]
    fn malformed_header_is_a_variant_error() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        assert_eq!(
            decrypt_rpgmaker_asset(SYNTHETIC_PNG, &key).err(),
            Some(MvMzImageVariantError::MissingHeaderMagic)
        );
        assert_eq!(
            decrypt_rpgmaker_asset(b"RPGMV", &key).err(),
            Some(MvMzImageVariantError::TooShort)
        );
    }

    #[test]
    fn fixture_matrix_passes_and_records_path() {
        let report = run(&load_fixture());
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert!(!report.source_node_id.is_empty());
        report.path.validate().expect("path is consistent");
        for entry in &report.entries {
            assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
            assert!(!entry.source_node_id.is_empty());
            assert!(
                entry
                    .validation_command
                    .starts_with("kaifuu rpgmaker encrypted-image --fixture")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    #[test]
    fn valid_entry_round_trips_with_matching_hashes() {
        let report = run(&load_fixture());
        let entry = report.entry("image-valid-pictures").unwrap();
        assert_eq!(entry.outcome, MvMzEncryptedImageOutcome::RoundTripped);
        assert!(entry.round_tripped);
        let proof = entry
            .consumable_proof()
            .expect("round-tripped is consumable");
        assert!(proof.byte_correct_round_trip);
        // Byte-correct: the re-encrypted hash equals the encrypted source hash.
        assert_eq!(
            proof.reencrypted_hash.as_str(),
            proof.encrypted_source_hash.as_str()
        );
        // The decrypted plaintext is exactly the synthetic PNG.
        assert_eq!(
            proof.decrypted_plaintext_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_PNG)
        );
        assert_eq!(
            proof.validation.method,
            KeyValidationMethod::FixtureRoundTripProof
        );
        assert_eq!(proof.key_bytes, RPGMAKER_IMAGE_XOR_PREFIX_LEN as u32);
    }

    #[test]
    fn failing_entries_publish_no_patch_artifact() {
        let report = run(&load_fixture());
        for (entry_id, outcome, code) in [
            (
                "image-wrong-key",
                MvMzEncryptedImageOutcome::WrongKey,
                FINDING_WRONG_KEY,
            ),
            (
                "image-missing-key",
                MvMzEncryptedImageOutcome::MissingKey,
                FINDING_MISSING_KEY,
            ),
            (
                "image-unsupported-surface-audio",
                MvMzEncryptedImageOutcome::UnsupportedSurface,
                FINDING_UNSUPPORTED_SURFACE,
            ),
            (
                "image-unsupported-variant",
                MvMzEncryptedImageOutcome::UnsupportedVariant,
                FINDING_UNSUPPORTED_VARIANT,
            ),
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(entry.outcome, outcome, "{entry_id}");
            assert!(!entry.round_tripped, "{entry_id} must not round-trip");
            assert!(entry.proof.is_none(), "{entry_id} must publish no proof");
            assert!(
                entry.consumable_proof().is_none(),
                "{entry_id} must not be consumable"
            );
            assert!(has_finding(&report, entry_id, code), "{entry_id} finding");
            // The structured finding carries a semantic code.
            let finding = report
                .entry(entry_id)
                .unwrap()
                .findings
                .iter()
                .find(|finding| finding.code == code)
                .unwrap();
            assert!(finding.semantic_code.is_some(), "{entry_id} semantic code");
        }
    }

    #[test]
    fn validator_fails_on_outcome_mismatch() {
        let mut fixture = load_fixture();
        entry_mut(&mut fixture, "image-wrong-key").expected =
            MvMzEncryptedImageOutcome::RoundTripped;
        let report = run(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "image-wrong-key",
            FINDING_OUTCOME_MISMATCH
        ));
    }

    #[test]
    fn report_never_carries_raw_key_material() {
        use std::fmt::Write as _;
        let report = run(&load_fixture());
        let json = report.stable_json().expect("stable json");
        let key_text = String::from_utf8_lossy(SYNTHETIC_KEY_CORRECT);
        assert!(!json.contains(key_text.as_ref()), "raw key leaked");
        let key_hex: String = SYNTHETIC_KEY_CORRECT
            .iter()
            .fold(String::new(), |mut acc, byte| {
                let _ = write!(acc, "{byte:02x}");
                acc
            });
        assert!(!json.contains(&key_hex), "raw key hex leaked");

        // The proof carries a one-way commitment + count, not the key.
        let proof = report
            .entry("image-valid-pictures")
            .unwrap()
            .proof
            .as_ref()
            .unwrap();
        assert_eq!(proof.key_bytes as usize, SYNTHETIC_KEY_CORRECT.len());
        assert_eq!(
            proof.key_material_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_KEY_CORRECT)
        );
    }

    #[test]
    fn key_debug_is_redacted_and_zeroized() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let rendered = format!("{key:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains(&String::from_utf8_lossy(SYNTHETIC_KEY_CORRECT).into_owned()));
    }

    #[test]
    fn report_round_trips_through_stable_json() {
        let report = run(&load_fixture());
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: MvMzEncryptedImageReport = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, report.redacted_for_report());
    }
}

