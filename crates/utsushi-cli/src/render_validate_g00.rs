//! On-disk G00 asset package used by the RealLive render validator.

use std::fs;
use std::path::{Path, PathBuf};

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
        g00_path(&self.g00_dir, stem)
    }
}

/// Resolve one authored G00 basename under Siglus/RealLive's ASCII-case-
/// insensitive filename rule. A miss remains the requested direct path so the
/// caller emits its normal missing-asset diagnostic rather than substituting.
pub(crate) fn g00_path(g00_dir: &Path, stem: &str) -> PathBuf {
    let direct = g00_dir.join(stem);
    if direct.exists() {
        return direct;
    }
    fs::read_dir(g00_dir)
        .ok()
        .and_then(|entries| {
            entries.filter_map(Result::ok).find_map(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(stem))
                    .then_some(entry.path())
            })
        })
        .unwrap_or(direct)
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

#[cfg(test)]
mod tests {
    use super::g00_path;

    #[test]
    fn resolves_authored_g00_name_with_ascii_case_fold() {
        let directory = tempfile::tempdir().expect("temporary G00 directory");
        let actual = directory.path().join("BG01A01.g00");
        std::fs::write(&actual, b"real G00 bytes").expect("write G00 fixture");

        assert_eq!(
            g00_path(directory.path(), "bg01a01.g00"),
            actual,
            "removing the case-folded lookup loses the authored asset and must not fall back to a fabricated layer"
        );
    }
}
