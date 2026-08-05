//! Selected Softpal source-unit keys read from the shared bridge artifact.

use std::collections::BTreeSet;
use std::error::Error;
use std::path::Path;

use serde_json::Value;

pub(super) fn selected_source_unit_keys(path: &Path) -> Result<BTreeSet<String>, Box<dyn Error>> {
    let bytes = std::fs::read(path).map_err(|error| {
        format!(
            "utsushi.structure.softpal.read_bridge: {}: {error}",
            path.display()
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "utsushi.structure.softpal.parse_bridge: {}: {error}",
            path.display()
        )
    })?;
    let units = value["units"].as_array().ok_or_else(|| {
        "utsushi.structure.softpal.bridge_shape: bridge units must be an array".to_string()
    })?;

    let mut keys = BTreeSet::new();
    for (index, unit) in units.iter().enumerate() {
        let key = unit["sourceUnitKey"].as_str().ok_or_else(|| {
            format!(
                "utsushi.structure.softpal.bridge_unit[{index}]: sourceUnitKey must be a string"
            )
        })?;
        validate_source_unit_key(key)
            .map_err(|error| format!("utsushi.structure.softpal.bridge_unit[{index}]: {error}"))?;
        if !keys.insert(key.to_owned()) {
            return Err(format!(
                "utsushi.structure.softpal.bridge_unit[{index}]: duplicate sourceUnitKey {key:?}"
            )
            .into());
        }
    }
    Ok(keys)
}

fn validate_source_unit_key(key: &str) -> Result<(), String> {
    let Some(record_offset) = key
        .strip_prefix("softpal:dialogue:")
        .or_else(|| key.strip_prefix("softpal:choice:"))
    else {
        return Err(format!(
            "sourceUnitKey {key:?} is not a Softpal TEXT.DAT record key"
        ));
    };
    record_offset
        .parse::<u32>()
        .map_err(|_| format!("sourceUnitKey {key:?} has a non-u32 TEXT.DAT record offset"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn reads_only_valid_softpal_bridge_keys() {
        let root = TempDir::new().expect("temporary bridge directory");
        let bridge = root.path().join("bridge.json");
        fs::write(
            &bridge,
            r#"{"units":[{"sourceUnitKey":"softpal:dialogue:16"},{"sourceUnitKey":"softpal:choice:40"}]}"#,
        )
        .expect("write bridge");

        assert_eq!(
            selected_source_unit_keys(&bridge).expect("valid bridge keys"),
            BTreeSet::from([
                "softpal:choice:40".to_owned(),
                "softpal:dialogue:16".to_owned()
            ])
        );
    }

    #[test]
    fn rejects_a_bridge_key_from_another_format() {
        let root = TempDir::new().expect("temporary bridge directory");
        let bridge = root.path().join("bridge.json");
        fs::write(
            &bridge,
            r#"{"units":[{"sourceUnitKey":"foreign:scene:1"}]}"#,
        )
        .expect("write bridge");

        let error = selected_source_unit_keys(&bridge).expect_err("foreign key is refused");
        assert!(
            error
                .to_string()
                .contains("not a Softpal TEXT.DAT record key")
        );
    }
}
