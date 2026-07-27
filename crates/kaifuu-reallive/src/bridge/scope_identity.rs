use serde_json::{Value, json};

use super::{ArchiveScope, sha256_canonical};

pub(super) fn source_scope_json(
    scope: &ArchiveScope,
    archive_hash: &str,
    scene_ids: &[u16],
    unit_count: usize,
) -> Value {
    let unit_range = match scope {
        ArchiveScope::UnitRange {
            start,
            end_exclusive,
        } => json!({ "start": start, "endExclusive": end_exclusive }),
        _ => Value::Null,
    };
    json!({
        "kind": scope.kind(),
        "sourceArchiveHash": archive_hash,
        "sceneIds": scene_ids,
        "unitRange": unit_range,
        "unitCount": unit_count,
    })
}

pub(super) fn scoped_bundle_hash(
    archive_hash: &str,
    scope: &ArchiveScope,
    scene_ids: &[u16],
    unit_count: usize,
) -> String {
    if matches!(scope, ArchiveScope::WholeArchive) {
        return archive_hash.to_string();
    }
    let range = match scope {
        ArchiveScope::UnitRange {
            start,
            end_exclusive,
        } => format!("{start}:{end_exclusive}"),
        _ => "all".to_string(),
    };
    sha256_canonical(
        format!(
            "reallive-run-scope-v1|{archive_hash}|{}|{}|{range}|{unit_count}",
            scope.kind(),
            scene_ids
                .iter()
                .map(u16::to_string)
                .collect::<Vec<_>>()
                .join(","),
        )
        .as_bytes(),
    )
}
