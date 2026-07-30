use super::*;

// 7.7 verify_fixture_hashes helper.

struct InMemoryStore {
    by_id: std::collections::HashMap<String, Vec<u8>>,
}

impl InMemoryStore {
    fn new() -> Self {
        Self {
            by_id: std::collections::HashMap::new(),
        }
    }

    fn with(mut self, id: &str, bytes: &[u8]) -> Self {
        self.by_id.insert(id.to_string(), bytes.to_vec());
        self
    }
}

impl FixtureStore for InMemoryStore {
    fn read(&self, id: &str) -> Result<Vec<u8>, FixtureStoreError> {
        self.by_id
            .get(id)
            .cloned()
            .ok_or_else(|| FixtureStoreError {
                fixture_id: id.to_string(),
                message: "not in store".to_string(),
            })
    }
}

#[test]
fn verify_fixture_hashes_returns_ok_for_byte_for_byte_match() {
    let mut map = baseline_map();
    let bytes = b"some fixture bytes";
    let expected = sha256_hex(bytes);
    map.subsystems[0].fixture_ref.hash = expected;
    map.subsystems[0].fixture_ref.byte_count = bytes.len() as u64;
    let store = InMemoryStore::new().with(&map.subsystems[0].fixture_ref.id, bytes);
    verify_fixture_hashes(&map, &store).expect("hashes match");
}

#[test]
fn verify_fixture_hashes_returns_mismatch_when_store_bytes_diverge_from_declared_hash() {
    let mut map = baseline_map();
    let declared_bytes = b"declared";
    let observed_bytes = b"divergent";
    map.subsystems[0].fixture_ref.hash = sha256_hex(declared_bytes);
    map.subsystems[0].fixture_ref.byte_count = declared_bytes.len() as u64;
    let store = InMemoryStore::new().with(&map.subsystems[0].fixture_ref.id, observed_bytes);
    let mismatches = verify_fixture_hashes(&map, &store).expect_err("must mismatch");
    assert_eq!(mismatches.len(), 1);
    assert_eq!(mismatches[0].declared_hash, sha256_hex(declared_bytes));
    assert_eq!(mismatches[0].observed_hash, sha256_hex(observed_bytes));
}

// 7.8 Engine-neutrality discipline.

#[test]
fn schema_serialization_contains_no_engine_specific_field_names() {
    let banned = [
        "xp3_",
        "kag_",
        "rgss3_",
        "tjs_",
        "seen_",
        "gameexe_",
        "scene_pck_",
        "pixi_",
        "nwjs_",
        "unity_",
    ];
    let families = [
        EngineFamily::RealLive,
        EngineFamily::RpgmakerMv,
        EngineFamily::KirikiriKag,
        EngineFamily::Siglus,
        EngineFamily::Rgss3,
        EngineFamily::Unity,
    ];
    for family in families {
        let mut map = baseline_map();
        map.engine_family = family;
        if matches!(family, EngineFamily::Other) {
            map.engine_family_notes = Some("note".to_string());
        }
        let value = serde_json::to_value(&map).expect("serialize");
        let field_names = collect_field_names(&value);
        for banned_substr in banned {
            for name in &field_names {
                assert!(
                    !name.to_ascii_lowercase().contains(banned_substr),
                    "field name {name} contains engine-specific token {banned_substr} for family {family:?}"
                );
            }
        }
    }
}

fn collect_field_names(value: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    walk(value, &mut out);
    out
}

fn walk(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                out.push(k.clone());
                walk(v, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                walk(item, out);
            }
        }
        _ => {}
    }
}

// JSON fixture corpus parity tests.
