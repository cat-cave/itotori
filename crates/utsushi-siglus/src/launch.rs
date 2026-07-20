//! Siglus launch hydration through the substrate asset-package facade.
//!
//! This module owns no game policy. It opens the standard engine containers
//! from the package supplied by the runtime request, decodes them through the
//! Kaifuu Siglus format boundary, and retains only an engine-generic index of
//! decoded scene moments. No host filesystem path, process, or title profile
//! participates in the launch path.

use std::sync::Arc;

use kaifuu_siglus::{
    SiglusSecondLayerKey, SiglusSecondLayerMaterial, decode_gameexe_dat, decode_scene_pack,
    parse_scene_pck, read_gameexe_header, recover_exe_angou_key,
};
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetMetadata, AssetPackage, CaseRule, EnginePortError, LifecycleStage,
    MomentId, PackageDescriptor, PackageKind, PackageSource, PortRequest, RuntimeVfs, VfsResult,
};

const SCENE_PACK_LOGICAL_PATH: &str = "Scene.pck";
const GAMEEXE_LOGICAL_PATH: &str = "Gameexe.dat";
const ENGINE_EXECUTABLE_LOGICAL_PATH: &str = "SiglusEngine.exe";
const EXE_ANGOU_KEY_REF: &str = "secret://utsushi/siglus/exe-angou";

/// One decoded scene represented as a stable, port-defined review moment.
///
/// The moment intentionally retains structural identifiers and decoded byte
/// length only. Packed names and decoded bytes can contain game content, so
/// they are neither retained nor exposed by the runtime port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiglusSceneMoment {
    /// Stable moment address for this packed scene.
    pub id: MomentId,
    /// SceneList position, retained for deterministic ordering.
    pub scene_id: u32,
    /// Length of the successfully decoded scene payload.
    pub decoded_byte_len: usize,
}

/// Launch-time index for a fully decoded Siglus scene package.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiglusSceneMomentIndex {
    moments: Vec<SiglusSceneMoment>,
    gameexe_entry_count: usize,
}

impl SiglusSceneMomentIndex {
    /// Number of decoded scenes in the package.
    pub fn scene_count(&self) -> usize {
        self.moments.len()
    }

    /// Number of review moments currently exposed by the trace-only port.
    /// There is one deterministic entry moment per decoded scene.
    pub fn moment_count(&self) -> usize {
        self.moments.len()
    }

    /// Decoded scene moments in `SceneList` order.
    pub fn moments(&self) -> &[SiglusSceneMoment] {
        &self.moments
    }

    /// Parsed configuration-entry count. Values are intentionally not kept.
    pub fn gameexe_entry_count(&self) -> usize {
        self.gameexe_entry_count
    }
}

/// `RuntimeVfs` adapted to the narrower `AssetPackage` facade expected by the
/// port context. Every operation delegates to the request-owned VFS; this
/// adapter never gains a host-path capability.
#[derive(Clone)]
pub(crate) struct RequestAssetPackage {
    vfs: Arc<dyn RuntimeVfs>,
    descriptor: PackageDescriptor,
}

impl RequestAssetPackage {
    pub(crate) fn new(vfs: Arc<dyn RuntimeVfs>) -> Self {
        let descriptor = vfs
            .packages()
            .into_iter()
            .next()
            .unwrap_or(PackageDescriptor {
                id: "runtime-vfs".to_string(),
                kind: PackageKind::Composite,
                case_rule: CaseRule::Sensitive,
                source: PackageSource::PublicName("runtime-vfs".to_string()),
                revision: None,
            });
        Self { vfs, descriptor }
    }
}

impl std::fmt::Debug for RequestAssetPackage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RequestAssetPackage")
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

impl AssetPackage for RequestAssetPackage {
    fn id(&self) -> &str {
        &self.descriptor.id
    }

    fn descriptor(&self) -> PackageDescriptor {
        self.descriptor.clone()
    }

    fn case_rule(&self) -> CaseRule {
        self.descriptor.case_rule
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        self.vfs.resolve(logical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        self.vfs.exists(id)
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        self.vfs.stat(id)
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        self.vfs.open(id)
    }

    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        self.vfs.list(prefix)
    }
}

/// Decode the launch containers from `package` and construct the trace-only
/// scene/moment index. Every scene must decode; a partial index is never
/// installed as a successful launch.
pub(crate) fn hydrate_scene_moment_index(
    package: &dyn AssetPackage,
    request: &PortRequest<'_>,
) -> Result<SiglusSceneMomentIndex, EnginePortError> {
    let scene_bytes = open_required_asset(package, SCENE_PACK_LOGICAL_PATH)?;
    let gameexe_bytes = open_required_asset(package, GAMEEXE_LOGICAL_PATH)?;
    let scene_index = parse_scene_pck(scene_bytes.as_ref())
        .map_err(|error| launch_error(format!("Scene.pck index decode failed: {error}")))?;
    let gameexe_header = read_gameexe_header(gameexe_bytes.as_ref())
        .map_err(|error| launch_error(format!("Gameexe.dat header decode failed: {error}")))?;

    let needs_key = scene_index.extra_key_use || gameexe_header.exe_angou_mode != 0;
    let key_material = if needs_key {
        let executable = open_required_asset(package, ENGINE_EXECUTABLE_LOGICAL_PATH)?;
        let key_ref = SiglusSecondLayerKey::from_secret_ref(EXE_ANGOU_KEY_REF);
        Some(
            recover_exe_angou_key(executable.as_ref(), &key_ref).map_err(|error| {
                launch_error(format!("SiglusEngine.exe key recovery failed: {error}"))
            })?,
        )
    } else {
        None
    };

    let gameexe_key = (gameexe_header.exe_angou_mode != 0)
        .then(|| {
            key_material
                .as_ref()
                .map(kaifuu_siglus::ExeAngouKeyRecovery::material)
        })
        .flatten();
    let gameexe = decode_gameexe_dat(gameexe_bytes.as_ref(), gameexe_key)
        .map_err(|error| launch_error(format!("Gameexe.dat decode failed: {error}")))?;

    let scene_key: Option<&SiglusSecondLayerMaterial> = scene_index
        .extra_key_use
        .then(|| {
            key_material
                .as_ref()
                .map(kaifuu_siglus::ExeAngouKeyRecovery::material)
        })
        .flatten();
    let decoded = decode_scene_pack(scene_bytes.as_ref(), scene_key)
        .map_err(|error| launch_error(format!("Scene.pck payload decode failed: {error}")))?;
    if !decoded.fully_decoded() || decoded.scene_count != scene_index.entries.len() {
        return Err(launch_error(format!(
            "Scene.pck decoded {}/{} scenes; launch requires a complete scene index",
            decoded.decoded_count, decoded.scene_count
        )));
    }

    let mut moments = Vec::with_capacity(decoded.scene_digests.len());
    for (entry, digest) in scene_index.entries.iter().zip(&decoded.scene_digests) {
        request.cancellation.check(LifecycleStage::Launch)?;
        moments.push(SiglusSceneMoment {
            id: MomentId::new(entry.scene_id_str()),
            scene_id: entry.scene_id,
            decoded_byte_len: digest.decompressed_len,
        });
    }

    Ok(SiglusSceneMomentIndex {
        moments,
        gameexe_entry_count: gameexe.entries.len(),
    })
}

fn open_required_asset(
    package: &dyn AssetPackage,
    logical: &'static str,
) -> Result<AssetBytes, EnginePortError> {
    let id = package.resolve(logical).map_err(|error| {
        launch_error(format!(
            "required asset {logical} resolution failed: {error}"
        ))
    })?;
    package
        .open(&id)
        .map_err(|error| launch_error(format!("required asset {logical} open failed: {error}")))
}

fn launch_error(message: impl Into<String>) -> EnginePortError {
    EnginePortError::Lifecycle {
        stage: LifecycleStage::Launch,
        message: message.into(),
        source: None,
    }
}
