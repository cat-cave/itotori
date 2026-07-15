use super::{ReferencePort, build_default_sink_set};

use utsushi_core::{
    CapabilityReason, CaptureOutcome, EnginePort, EnginePortError, EnvFieldSchema, EnvFieldShape,
    EvidenceTier, FidelityTier, PortCapability, PortManifest, PortRequest, PortShutdownOutcome,
    REQUIRED_LIFECYCLE_STAGES, SinkSet,
};

/// Missing-observe port: returns CapabilityUnsupported from `observe`
/// which the conformance harness must surface as a lifecycle failure.
pub(crate) struct MissingObservePort {
    launched: bool,
    shut_down: bool,
    sink_set: SinkSet,
}

impl MissingObservePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-nobs",
        name: "Synthetic Missing-Observe Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };

    pub(crate) fn new() -> Self {
        let (_text, _frame, _audio, sink_set) = build_default_sink_set();
        Self {
            launched: false,
            shut_down: false,
            sink_set,
        }
    }
}

impl EnginePort for MissingObservePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        self.launched = true;
        Ok(())
    }

    fn observe(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Err(EnginePortError::CapabilityUnsupported {
            capability: PortCapability::Observe,
            reason: CapabilityReason::DefaultUnimplemented,
        })
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, _request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        Err(EnginePortError::CapabilityUnsupported {
            capability: PortCapability::Capture,
            reason: CapabilityReason::DefaultUnimplemented,
        })
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            Ok(PortShutdownOutcome::already_shut_down())
        } else {
            self.shut_down = true;
            Ok(PortShutdownOutcome::clean())
        }
    }
}

/// Port whose `shutdown` is NOT idempotent: it reports `Clean` on every
/// call instead of `Clean -> AlreadyShutDown`. The conformance harness
/// must reject it with the typed `EnginePortError::ShutdownNotIdempotent`
/// (previously the harness accepted `AlreadyShutDown | Clean` for the
/// second call, so this drift passed silently).
pub(crate) struct NonIdempotentShutdownPort(ReferencePort);

impl NonIdempotentShutdownPort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-nonidempotent",
        name: "Synthetic Non-Idempotent-Shutdown Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &["Synthetic test-only port with deliberately non-idempotent shutdown."],
    };

    pub(crate) fn new() -> Self {
        Self(ReferencePort::new())
    }
}

impl EnginePort for NonIdempotentShutdownPort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        self.0.launch(request)
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        self.0.observe(request)
    }

    fn sink_set(&self) -> &SinkSet {
        self.0.sink_set()
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        self.0.capture(request)
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        // Always reports Clean — never signals AlreadyShutDown on a
        // repeat call, violating the documented idempotence rule.
        Ok(PortShutdownOutcome::clean())
    }
}

/// Manifest declaring abi_version = 99. Used to assert the runner
/// rejects ports it cannot drive.
pub(crate) const UNSUPPORTED_ABI_MANIFEST: PortManifest = PortManifest {
    id: "utsushi-synthetic-badabi",
    name: "Unsupported ABI Port",
    version: "0.0.0",
    abi_version: 99,
    capabilities: &[
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
    ],
    required_methods: REQUIRED_LIFECYCLE_STAGES,
    optional_methods: &[],
    env_schema: &[],
    fidelity_tier_max: FidelityTier::LayoutProbe,
    evidence_tier_max: EvidenceTier::E2,
    limitations: &[],
};

/// Port declaring a forbidden env shape in its manifest.
pub(crate) const ENV_PATH_FORBIDDEN_MANIFEST: PortManifest = PortManifest {
    id: "utsushi-synthetic-envpath",
    name: "Env Path Forbidden Port",
    version: "0.0.0",
    abi_version: 1,
    capabilities: &[
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
    ],
    required_methods: REQUIRED_LIFECYCLE_STAGES,
    optional_methods: &[],
    env_schema: &[EnvFieldSchema {
        key: "UTSUSHI_PORT_DIR",
        shape: EnvFieldShape::Path,
        required: false,
        purpose: "tries to read a directory path via env",
    }],
    fidelity_tier_max: FidelityTier::LayoutProbe,
    evidence_tier_max: EvidenceTier::E2,
    limitations: &[],
};

/// Port that declares a single `OpaqueToken` env field. The harness
/// supplies a runtime value matching `looks_like_local_path` to confirm
/// the runner rejects it at launch time.
pub(crate) struct UnredactedEnvRuntimePort {
    sink_set: SinkSet,
}

impl UnredactedEnvRuntimePort {
    const MANIFEST: PortManifest = PortManifest {
        id: "utsushi-synthetic-envrun",
        name: "Unredacted Env Runtime Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[EnvFieldSchema {
            key: "UTSUSHI_RUN_TOKEN",
            shape: EnvFieldShape::OpaqueToken,
            required: true,
            purpose: "runtime token; runner must reject local-path-shaped values",
        }],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    };

    pub(crate) fn new() -> Self {
        let (_text, _frame, _audio, sink_set) = build_default_sink_set();
        Self { sink_set }
    }
}

impl EnginePort for UnredactedEnvRuntimePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Ok(())
    }

    fn observe(&mut self, _request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, _request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        Ok(CaptureOutcome::new(
            "artifacts/utsushi/runtime/x/conformance-reports/x.json",
        ))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        Ok(PortShutdownOutcome::clean())
    }
}
