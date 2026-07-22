use super::*;

impl RealLiveProfileDetectorAdapter {
    pub(super) fn adapter_capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText],
            supported_patch_back: vec![PatchBackTransform::Identity],
            support_boundary: Some("identify/profile generation reads SEEN.TXT envelope bytes, Gameexe.ini ASCII prefixes, top-level marker counts, and source hashes".to_string()),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![
                SurfaceTransform::Identity,
                SurfaceTransform::ArchiveEntry,
                SurfaceTransform::BinaryOffset,
            ],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::Archive],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText, CodecTransform::BytecodeDecompile],
            supported_patch_back: vec![PatchBackTransform::Identity],
            support_boundary: Some("Scene/SEEN + Gameexe.ini bridge inventory plus bounded asset reference catalogue (.g00 / .koe / .ovk / .nwk)".to_string()),
        };
        let extract = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Extraction],
            supported_surfaces: vec![SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::Archive],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText, CodecTransform::BytecodeDecompile],
            supported_patch_back: vec![
                PatchBackTransform::Identity,
                PatchBackTransform::ReplaceFile,
                PatchBackTransform::RecompileBytecode,
            ],
            support_boundary: Some("Scene/SEEN bridge unit extraction with stable scene-slot ids (length-changing bundle-driven patch-back at the Patch contract)".to_string()),
        };
        let patch = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Patching, Capability::PatchBack],
            supported_surfaces: vec![SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::Archive],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText, CodecTransform::BytecodeDecompile],
            supported_patch_back: vec![PatchBackTransform::RecompileBytecode],
            support_boundary: Some(
                "Length-changing slot replacement: bundle-driven patch-back rewrites the offset table and recalculates jump targets, so a translation that grows or shrinks the Shift-JIS body round-trips byte-correct. Genuinely-unencodable edits (a non-Shift-JIS codepoint, a goto target left strictly inside an edited body, or a scene-packing overflow) are rejected with the typed kaifuu.reallive.patchback_* Fatal."
                    .to_string(),
            ),
        };
        AdapterCapabilities::new(
            REALLIVE_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::supported(Capability::Verification),
                CapabilityReport::supported(Capability::ContainerAccess),
                CapabilityReport::supported(Capability::CodecAccess),
                CapabilityReport::supported(Capability::PatchBack),
                CapabilityReport::limited(
                    Capability::Patching,
                    "length-changing Scene/SEEN text-slot replacement (offset table rewritten + jump targets recalculated) applied through the bundle-driven driver; limited to one scene-scoped bundle per call and to the configured text scope (dialogue/speaker/choice), not image-overlaid .g00 text",
                ),
                CapabilityReport::limited(
                    Capability::AssetTextPatching,
                    "Scene/SEEN dialogue/speaker/choice slots only; image-overlaid text inside .g00 is not in scope",
                ),
                CapabilityReport::limited(
                    Capability::LineParityPatching,
                    "patch-back is per-slot, not per-line; the line-parity contract is not claimed at this slice",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "RealLive voice archive obfuscation handling is outside this slice",
                ),
                CapabilityReport::unsupported(
                    Capability::KeyProfile,
                    "alpha-vertical RealLive titles do not require user-provided keys; encrypted variants are a separate node",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to the runtime adapter, not this slice",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted SEEN.TXT is outside this adapter slice",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to RealLive at this slice",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed for RealLive fixtures",
                ),
            ],
            AdapterCapabilityMatrix::new(
                REALLIVE_DETECTOR_ADAPTER_ID,
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::partial(vec![
                    "the scene parser covers text slots but not all asset surfaces"
                        .to_string(),
                    "image-overlaid text inside .g00 is not in scope".to_string(),
                ]),
                // Field PR #2 intent: expose real patch through the typed matrix.
                // On current main this is length-changing single-scene patch-back
                // , not merely length-preserving slot edits.
                CapabilityLevelStatus::partial(vec![
                    "length-changing Scene/SEEN text-slot replacement (offset table rewritten + jump targets recalculated) via the bundle-driven driver; one scene-scoped bundle per call".to_string(),
                    "multi-scene archive-rebuild patch path is not claimed; image-overlaid .g00 and non-text assets are not patched".to_string(),
                ]),
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract,
            patch,
        })
    }
}
