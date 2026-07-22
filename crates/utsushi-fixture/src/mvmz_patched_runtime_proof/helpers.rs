use super::*;

/// One strict-proof check result.
pub(super) struct Check {
    pub(super) id: &'static str,
    pub(super) passed: bool,
    pub(super) detail: String,
}

impl Check {
    pub(super) fn to_json(&self) -> Value {
        json!({
            "checkId": self.id,
            "status": if self.passed { "pass" } else { "fail" },
            "mandatory": true,
            "detail": self.detail,
        })
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// The observation-hook events of a trace, or an empty slice.
fn observation_events(trace: &Value) -> &[Value] {
    trace
        .get("observationHookEvents")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

/// The bridge `sourceUnitKey` an observation event links to (its first bridge
/// ref), if any.
fn event_source_unit_key(event: &Value) -> Option<&str> {
    event
        .get("bridgeRefs")
        .and_then(Value::as_array)
        .and_then(|refs| refs.first())
        .and_then(|bridge| bridge.get("sourceUnitKey"))
        .and_then(Value::as_str)
}

/// Collect every observed (unit key -> translated string) pair from a patched
/// trace: dialogue text keyed by its bridge unit, and choice prompt + each
/// option label keyed by their own bridge units. This is the canonical patched
/// output the `PatchResult.outputHash` attests to.
pub(super) fn observed_translated_units(trace: &Value) -> BTreeMap<String, String> {
    let mut units = BTreeMap::new();
    for event in observation_events(trace) {
        let payload = event.get("payload").unwrap_or(&Value::Null);
        match event.get("eventKind").and_then(Value::as_str) {
            Some("text") => {
                if let (Some(key), Some(text)) = (
                    event_source_unit_key(event),
                    payload.get("text").and_then(Value::as_str),
                ) && !text.is_empty()
                {
                    units.insert(key.to_string(), text.to_string());
                }
            }
            Some("choice") => {
                if let (Some(key), Some(prompt)) = (
                    event_source_unit_key(event),
                    payload.get("prompt").and_then(Value::as_str),
                ) && !prompt.is_empty()
                {
                    units.insert(key.to_string(), prompt.to_string());
                }
                if let Some(options) = payload.get("options").and_then(Value::as_array) {
                    for option in options {
                        if let (Some(key), Some(label)) = (
                            option
                                .get("bridgeRef")
                                .and_then(|bridge| bridge.get("sourceUnitKey"))
                                .and_then(Value::as_str),
                            option.get("label").and_then(Value::as_str),
                        ) && !label.is_empty()
                        {
                            units.insert(key.to_string(), label.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    units
}

/// The canonical `sha256:<hex>` hash over the observed translated units. Keys
/// are BTree-sorted, so the hash is a deterministic function of the patched
/// output content alone. The committed `PatchResult.outputHash` is this exact
/// value over the intended translation, so the observation reproduces it iff it
/// rendered that patch.
pub fn canonical_patched_output_hash(units: &BTreeMap<String, String>) -> String {
    let pairs: Vec<[&str; 2]> = units
        .iter()
        .map(|(key, value)| [key.as_str(), value.as_str()])
        .collect();
    // BTreeMap iteration is already sorted; serialize as a canonical array of
    // [unitKey, translatedText] pairs.
    let bytes = serde_json::to_vec(&pairs).unwrap_or_default();
    format!("sha256:{}", sha256_hex(&bytes))
}

/// The bridge unit ids the alpha () proof recorded as observed.
pub(super) fn alpha_proof_bridge_units(alpha: &Value) -> Vec<String> {
    alpha
        .get("observation")
        .and_then(|observation| observation.get("observedBridgeUnitIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The bridge unit ids the patched trace observed (top-level event links).
pub(super) fn patched_trace_bridge_units(trace: &Value) -> Vec<String> {
    observation_events(trace)
        .iter()
        .filter_map(|event| {
            event
                .get("bridgeRefs")
                .and_then(Value::as_array)
                .and_then(|refs| refs.first())
                .and_then(|bridge| bridge.get("bridgeUnitId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}
