use super::*;

pub(crate) fn detect_wolf_rpg_editor(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let wolf_archive_count = scan.extension_count("wolf");
    let wolf_magic_count = scan.wolf_rpg_editor_header_count();
    let protected_marker_count =
        scan.header_count("wolf-protected") + scan.header_count("protection-key");
    let detected = wolf_archive_count > 0 || wolf_magic_count > 0;
    let mut signals = if detected {
        vec![
            ArchiveDetectionSignal::Packed,
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
            ArchiveDetectionSignal::HelperRequired,
        ]
    } else {
        vec![]
    };
    if protected_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::Protected);
    }
    archive_row(ArchiveRowInput {
        row_id: "wolf-rpg-editor-archives",
        engine_family: ArchiveEngineFamily::WolfRpgEditor,
        detected,
        detected_variant: if protected_marker_count > 0 {
            "wolf-protected-archive"
        } else {
            "wolf-archive"
        },
        marker_only_unknown_variant: !detected && protected_marker_count > 0,
        signals,
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.wolf",
                wolf_archive_count,
                "Wolf RPG Editor archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "WOLF header",
                wolf_magic_count,
                "Wolf archive/header marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "Wolf protection marker",
                protected_marker_count,
                "Synthetic Wolf protection-key marker count",
            ),
        ],
        requirements: if detected {
            vec![secret_requirement(
                "wolf-rpg-editor-archive-key",
                "Wolf RPG Editor protected archives require local key/helper evidence",
                "KAIFUU_WOLF_ARCHIVE_KEY",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects Wolf RPG Editor archive and protection signals; archive decryption, binary database parsing, and rebuilds remain unsupported here.",
    })
}

pub(crate) fn detect_bgi_ethornell(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let arc_extension_count = scan.extension_count("arc");
    let buriko_header_count = scan.header_count("BURIKO ARC20");
    let encrypted_marker_count =
        scan.header_count("bgi-encrypted") + scan.header_count("ethornell-encrypted");
    let compressed_marker_count = scan.header_count("dsc-compressed")
        + scan.header_count("bgi-compressed")
        + scan.header_count("compressedbg")
        + scan.header_count("compressed-bg");
    let layered_marker_count =
        scan.header_count("compressedbg") + scan.header_count("compressed-bg");
    let detected = buriko_header_count > 0;
    let mut signals = if detected {
        vec![
            ArchiveDetectionSignal::Packed,
            ArchiveDetectionSignal::UnknownVariant,
        ]
    } else {
        vec![]
    };
    if encrypted_marker_count > 0 {
        // Encrypted BGI/Ethornell (BSE) markers prove the container is
        // encrypted, but Kaifuu claims no decryptor. Emit BOTH the
        // encrypted-variant signal AND the missing-crypto-capability signal so
        // the live detector agrees with the detector fixtures
        // (BSE profile => unsupported_variant.encrypted + missing_capability.crypto).
        signals.push(ArchiveDetectionSignal::Encrypted);
        signals.push(ArchiveDetectionSignal::CryptoUnsupported);
    }
    if compressed_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::Compressed);
    }
    if layered_marker_count > 0 {
        // CompressedBG is a layered container/codec/surface transform; Kaifuu
        // recognizes it but does not unwrap it. Emit the layered-transform
        // signal so the live detector agrees with the fixtures
        // (CompressedBG profile => unsupported_layered_transform).
        signals.push(ArchiveDetectionSignal::LayeredTransform);
    }
    let detected_variant = if layered_marker_count > 0 {
        "buriko-arc20-compressed-bg-layered-transform"
    } else if compressed_marker_count > 0 {
        "buriko-arc20-dsc-compressed-container"
    } else if encrypted_marker_count > 0 {
        "buriko-arc20-encrypted-container"
    } else {
        "buriko-arc20-container"
    };
    archive_row(ArchiveRowInput {
        row_id: "bgi-ethornell-containers",
        engine_family: ArchiveEngineFamily::BgiEthornell,
        detected,
        detected_variant,
        marker_only_unknown_variant: !detected
            && (encrypted_marker_count > 0
                || compressed_marker_count > 0
                || layered_marker_count > 0),
        signals,
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.arc",
                arc_extension_count,
                "Generic .arc extension count; BGI classification requires BURIKO header evidence",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BURIKO ARC20 header",
                buriko_header_count,
                "BGI/Ethornell archive header count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BGI encrypted container marker",
                encrypted_marker_count,
                "Synthetic BGI/Ethornell encrypted-container marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BGI compressed container marker",
                compressed_marker_count,
                "Synthetic BGI/Ethornell compressed-container marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BGI layered transform marker",
                layered_marker_count,
                "Synthetic BGI/Ethornell layered-transform marker count",
            ),
        ],
        requirements: vec![],
        support_boundary: "Kaifuu detects BGI/Ethornell container headers; script decoding, encrypted/compressed/layered container handling, and repacking are not claimed by this matrix.",
    })
}

pub(crate) fn detect_renpy(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let rpa_count = scan.extension_count("rpa");
    let rpyc_count = scan.extension_count("rpyc");
    let detected = rpa_count > 0 || rpyc_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "renpy-packed-inputs",
        engine_family: ArchiveEngineFamily::Renpy,
        detected,
        detected_variant: if rpa_count > 0 && rpyc_count > 0 {
            "rpa-archive-and-rpyc-compiled-script"
        } else if rpa_count > 0 {
            "rpa-archive"
        } else {
            "rpyc-compiled-script"
        },
        marker_only_unknown_variant: false,
        signals: if detected {
            vec![ArchiveDetectionSignal::Packed]
        } else {
            Vec::new()
        },
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.rpa",
                rpa_count,
                "Ren'Py archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.rpyc",
                rpyc_count,
                "Ren'Py compiled script extension count",
            ),
        ],
        requirements: vec![],
        support_boundary: "Kaifuu detects Ren'Py packed or compiled inputs; plaintext .rpy handling, archive unpacking, and decompilation are separate support claims.",
    })
}

pub(crate) fn detect_unknown_archive_variant(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let unknown_count = scan
        .extension_counts(&["pak", "bundle", "bin"])
        .saturating_add(
            scan.extension_count("dat")
                .saturating_sub(scan.file_name_count("gameexe.dat")),
        )
        .saturating_add(
            scan.extension_count("pck")
                .saturating_sub(scan.file_name_count("scene.pck")),
        )
        .saturating_add(
            scan.extension_count("arc")
                .saturating_sub(scan.header_count("BURIKO ARC20")),
        )
        .saturating_add(scan.orphaned_subtype_marker_count);
    let detected = unknown_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "unknown-archive-variant",
        engine_family: ArchiveEngineFamily::Unknown,
        detected,
        detected_variant: "unprofiled-archive-like-input",
        marker_only_unknown_variant: false,
        signals: if detected {
            vec![ArchiveDetectionSignal::UnknownVariant]
        } else {
            Vec::new()
        },
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::AggregateCount,
                "*.pak|*.bundle|*.bin|unprofiled *.dat|*.pck|*.arc",
                unknown_count.saturating_sub(scan.orphaned_subtype_marker_count),
                "Archive-like files not covered by a profiled detector row",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "orphaned encrypted/protected subtype marker",
                scan.orphaned_subtype_marker_count,
                "Subtype marker evidence without a matching profiled archive/container primary signal",
            ),
        ],
        requirements: vec![],
        support_boundary: "Kaifuu records unknown archive-like inputs as aggregate evidence only; no engine, extraction, or patching support is inferred.",
    })
}

pub(crate) struct ArchiveRowInput {
    pub(crate) row_id: &'static str,
    pub(crate) engine_family: ArchiveEngineFamily,
    pub(crate) detected: bool,
    pub(crate) detected_variant: &'static str,
    pub(crate) marker_only_unknown_variant: bool,
    pub(crate) signals: Vec<ArchiveDetectionSignal>,
    pub(crate) surfaces: Vec<ArchiveDetectionSurface>,
    pub(crate) evidence: Vec<ArchiveDetectionEvidence>,
    pub(crate) requirements: Vec<ProfileRequirement>,
    pub(crate) support_boundary: &'static str,
}

pub(crate) fn archive_row(input: ArchiveRowInput) -> ArchiveDetectionRow {
    let signals = if input.detected {
        input.signals
    } else if input.marker_only_unknown_variant {
        vec![ArchiveDetectionSignal::UnknownVariant]
    } else {
        vec![]
    };
    let requirements = if input.detected {
        input.requirements
    } else {
        vec![]
    };
    let surfaces = if input.detected {
        input.surfaces
    } else {
        vec![]
    };
    let diagnostics = diagnostics_for_signals(&signals, input.support_boundary);
    let capabilities = capabilities_for_archive_row(input.detected, &signals);
    ArchiveDetectionRow {
        row_id: input.row_id.to_string(),
        engine_family: input.engine_family,
        detected: input.detected,
        detected_variant: if input.detected {
            input.detected_variant.to_string()
        } else {
            NON_DETECTED_ARCHIVE_VARIANT.to_string()
        },
        signals,
        surfaces,
        evidence: input.evidence,
        requirements,
        diagnostics,
        capabilities,
        support_boundary: input.support_boundary.to_string(),
    }
}

pub(crate) fn evidence(
    evidence_type: ArchiveEvidenceType,
    pattern: impl Into<String>,
    count: u64,
    detail: impl Into<String>,
) -> ArchiveDetectionEvidence {
    ArchiveDetectionEvidence {
        evidence_type,
        pattern: pattern.into(),
        status: if count > 0 {
            EvidenceStatus::Matched
        } else {
            EvidenceStatus::Missing
        },
        count,
        detail: detail.into(),
    }
}

pub(crate) fn secret_requirement(
    key: impl Into<String>,
    description: impl Into<String>,
    placeholder: impl Into<String>,
) -> ProfileRequirement {
    ProfileRequirement {
        category: RequirementCategory::SecretKey,
        key: key.into(),
        status: RequirementStatus::Missing,
        description: description.into(),
        placeholder: Some(placeholder.into()),
        secret: true,
    }
}

pub(crate) fn file_requirement(
    key: impl Into<String>,
    satisfied: bool,
    description: impl Into<String>,
) -> ProfileRequirement {
    ProfileRequirement {
        category: RequirementCategory::File,
        key: key.into(),
        status: if satisfied {
            RequirementStatus::Satisfied
        } else {
            RequirementStatus::Missing
        },
        description: description.into(),
        placeholder: None,
        secret: false,
    }
}

pub(crate) fn capabilities_for_archive_row(
    detected: bool,
    signals: &[ArchiveDetectionSignal],
) -> Vec<CapabilityReport> {
    let mut capabilities = vec![CapabilityReport::supported(Capability::Detection)];
    if detected {
        capabilities.extend([
            CapabilityReport::unsupported(
                Capability::Extraction,
                "archive/encryption matrix detection is not an extraction support claim",
            ),
            CapabilityReport::unsupported(
                Capability::Patching,
                "archive/encryption matrix detection does not rebuild, decrypt, or patch containers",
            ),
        ]);
    }
    if signals.contains(&ArchiveDetectionSignal::Encrypted) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::EncryptedInput,
            "encrypted input was detected, but decryption support is not claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::CryptoUnsupported) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::CryptoAccess,
            "encrypted input was recognized, but no reusable crypto capability is claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::Compressed) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::CodecAccess,
            "compressed archive payloads were detected, but decompression support is not claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::LayeredTransform) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::ContainerAccess,
            "a layered container/codec/surface transform was detected, but unwrapping it is not claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::MissingKey)
        || signals.contains(&ArchiveDetectionSignal::HelperRequired)
    {
        capabilities.push(CapabilityReport::requires_user_input(
            Capability::KeyProfile,
            "recognized protected inputs require local secret refs or helper evidence before future pure adapter work can proceed",
        ));
    }
    capabilities
}

pub(crate) fn diagnostics_for_signals(
    signals: &[ArchiveDetectionSignal],
    support_boundary: &str,
) -> Vec<DetectionDiagnostic> {
    let mut diagnostics = Vec::new();
    for signal in signals {
        match signal {
            ArchiveDetectionSignal::Compressed => diagnostics.push(diagnostic(
                SemanticErrorCode::MissingCodecCapability,
                ArchiveDetectionSignal::Compressed,
                Some(Capability::CodecAccess),
                support_boundary,
                "use an already extracted plaintext source or add a profiled decompression adapter before claiming support",
            )),
            ArchiveDetectionSignal::Encrypted => diagnostics.push(diagnostic(
                SemanticErrorCode::UnsupportedVariantEncrypted,
                ArchiveDetectionSignal::Encrypted,
                Some(Capability::EncryptedInput),
                support_boundary,
                "provide a supported key profile only after an adapter explicitly supports this encrypted variant",
            )),
            ArchiveDetectionSignal::CryptoUnsupported => diagnostics.push(diagnostic(
                SemanticErrorCode::MissingCryptoCapability,
                ArchiveDetectionSignal::CryptoUnsupported,
                Some(Capability::CryptoAccess),
                support_boundary,
                "do not request key material until a decrypting adapter claims this crypto profile; the marker proves detection only",
            )),
            ArchiveDetectionSignal::LayeredTransform => diagnostics.push(diagnostic(
                SemanticErrorCode::UnsupportedLayeredTransform,
                ArchiveDetectionSignal::LayeredTransform,
                Some(Capability::ContainerAccess),
                support_boundary,
                "use already-unwrapped plaintext sources or wait for an adapter that claims this layered container/codec/surface transform",
            )),
            ArchiveDetectionSignal::Packed => diagnostics.push(diagnostic(
                SemanticErrorCode::UnsupportedVariantPacked,
                ArchiveDetectionSignal::Packed,
                Some(Capability::Extraction),
                support_boundary,
                "use already extracted/plaintext sources or wait for an adapter that claims this container",
            )),
            ArchiveDetectionSignal::Protected => diagnostics.push(diagnostic(
                SemanticErrorCode::ProtectedExecutableUnsupported,
                ArchiveDetectionSignal::Protected,
                Some(Capability::KeyProfile),
                support_boundary,
                "use a local helper workflow that reports redacted protection evidence",
            )),
            ArchiveDetectionSignal::MissingKey => diagnostics.push(diagnostic(
                SemanticErrorCode::MissingKeyMaterial,
                ArchiveDetectionSignal::MissingKey,
                Some(Capability::KeyProfile),
                support_boundary,
                "resolve local key material through a secret ref; do not persist raw keys",
            )),
            ArchiveDetectionSignal::HelperRequired => diagnostics.push(diagnostic(
                SemanticErrorCode::HelperUnavailable,
                ArchiveDetectionSignal::HelperRequired,
                Some(Capability::KeyProfile),
                support_boundary,
                "run an explicitly enabled local helper or provide validated local key evidence",
            )),
            ArchiveDetectionSignal::UnknownVariant => diagnostics.push(diagnostic(
                SemanticErrorCode::UnknownEngineVariant,
                ArchiveDetectionSignal::UnknownVariant,
                Some(Capability::Detection),
                support_boundary,
                "add a synthetic public detector fixture or private-local aggregate evidence before claiming support",
            )),
        }
    }
    diagnostics
}

pub(crate) fn diagnostic(
    code: SemanticErrorCode,
    signal: ArchiveDetectionSignal,
    required_capability: Option<Capability>,
    support_boundary: impl Into<String>,
    remediation: impl Into<String>,
) -> DetectionDiagnostic {
    DetectionDiagnostic {
        code,
        signal,
        required_capability,
        support_boundary: support_boundary.into(),
        remediation: Some(remediation.into()),
    }
}
