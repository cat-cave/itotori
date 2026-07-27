//! On-disk G00 asset package used by the RealLive render validator.

use std::fs;
use std::path::PathBuf;

use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};

/// Resolves `g00/<STEM>.g00` against a real on-disk G00 directory.
///
/// The one-shot CLI deliberately reads just requested assets rather than
/// indexing the game tree, which can also contain large `koe/` and `wav/`
/// directories. RealLive's G00 names are ASCII-case-insensitive, so a direct
/// path miss falls back to an ASCII-case-folded directory lookup.
#[derive(Debug)]
pub(crate) struct OnDiskG00Package {
    g00_dir: PathBuf,
}

impl OnDiskG00Package {
    pub(crate) fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }

    fn host_path(&self, id: &AssetId) -> PathBuf {
        let logical = id.path();
        let stem = logical.strip_prefix("g00/").unwrap_or(logical);
        let direct = self.g00_dir.join(stem);
        if direct.exists() {
            return direct;
        }
        fs::read_dir(&self.g00_dir)
            .ok()
            .and_then(|entries| {
                entries.filter_map(Result::ok).find_map(|entry| {
                    let name = entry.file_name();
                    name.to_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(stem))
                        .then_some(entry.path())
                })
            })
            .unwrap_or(direct)
    }
}

impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "render-validate-on-disk-g00"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id().to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::InsensitiveAscii,
            source: PackageSource::PublicName(self.id().to_string()),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::InsensitiveAscii
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        Ok(self.host_path(id).exists())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let meta = fs::metadata(self.host_path(id))
            .map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(meta.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let bytes =
            fs::read(self.host_path(id)).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}
