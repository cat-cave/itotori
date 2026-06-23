//! Deterministic JSON serialization for [`super::ReferenceTrace`].
//!
//! The recorder's audit-focus claim is byte-identical output across runs and
//! across serde-json minor versions. This module enforces that claim through
//! a post-walk `Value` rebuild: every JSON object is re-emitted as a
//! `BTreeMap`-backed object before bytes are emitted. Arrays preserve order
//! (text events and replay events are inherently sequential).
//!
//! The bytes emitter uses `serde_json::ser::CompactFormatter` so whitespace
//! is reproducible across serde-json minor versions.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, ser::CompactFormatter};

use super::trace::ReferenceTrace;

/// Serialize a [`ReferenceTrace`] to deterministic JSON bytes.
///
/// The implementation:
///
/// 1. Goes through `serde_json::to_value` first so we work with a
///    structured intermediate.
/// 2. Walks the intermediate and re-emits every `Object` map through a
///    `BTreeMap` so the emitted key order is sorted (independent of
///    `serde_json::Map`'s default backing type).
/// 3. Writes the sorted form through `CompactFormatter`.
///
/// Two consecutive calls on the same trace are byte-identical. Two
/// independent recorders that observed the same events in the same order
/// produce byte-identical output (modulo the canonicalisation already
/// performed by [`super::InMemoryReferenceRecorder::finalize`]).
pub fn deterministic_json_bytes(trace: &ReferenceTrace) -> Vec<u8> {
    let value = serde_json::to_value(trace)
        .expect("ReferenceTrace serializes through serde_json::Value without error");
    let canonical = canonicalise(value);
    serialize_canonical(&canonical)
}

/// Recursive post-walk that rebuilds every JSON object as a `BTreeMap`.
fn canonicalise(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (key, child) in map {
                sorted.insert(key, canonicalise(child));
            }
            // Reconstruct serde_json::Map from the sorted BTreeMap. The
            // iteration order of BTreeMap is sorted; serde_json::Map
            // preserves insertion order under its default feature set, so
            // re-inserting from a sorted iterator pins the emit order.
            let mut out = serde_json::Map::new();
            for (key, child) in sorted {
                out.insert(key, child);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalise).collect()),
        other => other,
    }
}

/// Emit the canonical `Value` through a `CompactFormatter`.
fn serialize_canonical(value: &Value) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut serializer = serde_json::ser::Serializer::with_formatter(&mut buffer, CompactFormatter);
    value
        .serialize(&mut serializer)
        .expect("canonical Value serializes without error");
    buffer
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonicalise_sorts_object_keys() {
        let value = json!({
            "z": 1,
            "a": 2,
            "m": 3,
        });
        let canonical = canonicalise(value);
        let bytes = serialize_canonical(&canonical);
        let text = String::from_utf8(bytes).unwrap();
        // BTreeMap-sorted: a, m, z
        let a_pos = text.find("\"a\"").unwrap();
        let m_pos = text.find("\"m\"").unwrap();
        let z_pos = text.find("\"z\"").unwrap();
        assert!(a_pos < m_pos && m_pos < z_pos);
    }

    #[test]
    fn canonicalise_preserves_array_order() {
        let value = json!([3, 1, 2]);
        let canonical = canonicalise(value);
        let bytes = serialize_canonical(&canonical);
        assert_eq!(String::from_utf8(bytes).unwrap(), "[3,1,2]");
    }

    #[test]
    fn canonicalise_recurses_into_nested_objects() {
        let value = json!({
            "outer": {
                "z": 1,
                "a": 2,
            },
        });
        let canonical = canonicalise(value);
        let bytes = serialize_canonical(&canonical);
        let text = String::from_utf8(bytes).unwrap();
        let a_pos = text.find("\"a\"").unwrap();
        let z_pos = text.find("\"z\"").unwrap();
        assert!(a_pos < z_pos);
    }
}
