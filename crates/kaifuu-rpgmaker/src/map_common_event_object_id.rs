use serde_json::Value;

/// Read the object's `id` field (fallback to the array `index`).
pub(super) fn object_id(entry: &Value, index: usize) -> i64 {
    entry
        .get("id")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| i64::try_from(index).unwrap_or(i64::MAX))
}
