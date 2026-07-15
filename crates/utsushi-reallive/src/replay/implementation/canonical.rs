use super::*;

impl ReplayLog {
    /// Serialise to byte-deterministic JSON: sorted keys at every
    /// level, no floats, byte arrays as lowercase-hex strings.
    ///
    /// The serialisation is the canonical surface a downstream consumer
    /// hashes / diffs. Acceptance criterion #1 — two runs against the
    /// same Seen.txt produce identical output here.
    pub fn to_deterministic_json(&self) -> Result<String, ReplayError> {
        let value = self.to_canonical_value();
        // `serde_json::to_string_pretty` writes object keys in
        // insertion order, so the canonical builder below must insert
        // keys in sorted order to guarantee determinism. The pretty
        // formatter pins indentation at 2 spaces, which is stable
        // across serde_json versions.
        let mut out = Vec::with_capacity(1024);
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
        let mut ser = serde_json::Serializer::with_formatter(&mut out, formatter);
        value
            .serialize(&mut ser)
            .map_err(|err| ReplayError::SerializeFailure {
                reason: err.to_string(),
            })?;
        String::from_utf8(out).map_err(|err| ReplayError::SerializeFailure {
            reason: format!("non-utf8 in serialised JSON: {err}"),
        })
    }

    /// Number of [`ReplayEvent::TextLine`] events recorded. Acceptance
    /// criterion #0 — the real-bytes Sweetie HD scene-1 run produces
    /// `text_line_count() >= 1`.
    pub fn text_line_count(&self) -> usize {
        self.events
            .iter()
            .filter(|event| matches!(event, ReplayEvent::TextLine { .. }))
            .count()
    }

    /// Number of [`ReplayEvent::UnknownOpcode`] events. Used by the
    /// real-bytes test to report the fail-soft warning density.
    pub fn unknown_opcode_count(&self) -> usize {
        self.events
            .iter()
            .filter(|event| matches!(event, ReplayEvent::UnknownOpcode { .. }))
            .count()
    }

    /// Sorted, de-duplicated list of every `(module_type, module_id
    /// opcode)` the replay could not dispatch (each recorded as a
    /// [`ReplayEvent::UnknownOpcode`]). The full-scene acceptance test
    /// asserts this is EMPTY — an unknown opcode is a HARD failure of the
    /// traversal, never a silent fail-soft advance.
    pub fn unknown_opcode_keys(&self) -> Vec<(u8, u8, u16)> {
        let mut keys: Vec<(u8, u8, u16)> = self
            .events
            .iter()
            .filter_map(|event| match event {
                ReplayEvent::UnknownOpcode {
                    module_type,
                    module_id,
                    opcode,
                    ..
                } => Some((*module_type, *module_id, *opcode)),
                _ => None,
            })
            .collect();
        keys.sort_unstable();
        keys.dedup();
        keys
    }

    /// Number of commands that resolved only through the catalog fallback.
    pub fn catalog_fallback_count(&self) -> usize {
        self.events
            .iter()
            .filter(|event| matches!(event, ReplayEvent::CatalogFallback { .. }))
            .count()
    }

    /// Sorted, de-duplicated catalog fallback tuples observed on this replay.
    pub fn catalog_fallback_keys(&self) -> Vec<(u8, u8, u16)> {
        let mut keys: Vec<(u8, u8, u16)> = self
            .events
            .iter()
            .filter_map(|event| match event {
                ReplayEvent::CatalogFallback {
                    module_type,
                    module_id,
                    opcode,
                    ..
                } => Some((*module_type, *module_id, *opcode)),
                _ => None,
            })
            .collect();
        keys.sort_unstable();
        keys.dedup();
        keys
    }

    /// First non-empty Shift-JIS-decoded body, or `None` if no TextLine
    /// produced a non-empty decode. The real-bytes test prints this as
    /// the alpha-defining evidence.
    pub fn first_text_line_utf8(&self) -> Option<&str> {
        for event in &self.events {
            if let ReplayEvent::TextLine { body_utf8, .. } = event
                && !body_utf8.is_empty()
            {
                return Some(body_utf8);
            }
        }
        None
    }

    /// Build a [`serde_json::Value`] with sorted keys and hex byte
    /// arrays. Centralised so the deterministic-JSON path and the
    /// snapshot-round-trip path agree on the canonical shape.
    fn to_canonical_value(&self) -> serde_json::Value {
        let mut events = Vec::with_capacity(self.events.len());
        for event in &self.events {
            events.push(event_to_canonical_value(event));
        }
        let outcome_value = outcome_to_canonical_value(&self.final_outcome);
        let mut map = serde_json::Map::new();
        // Insert in sorted order so the BTreeMap-like layout is
        // preserved by serde_json::Map (which is order-preserving).
        map.insert("events".to_string(), serde_json::Value::Array(events));
        map.insert("finalOutcome".to_string(), outcome_value);
        map.insert(
            "schemaVersion".to_string(),
            serde_json::Value::String(self.schema_version.clone()),
        );
        map.insert(
            "sceneId".to_string(),
            serde_json::Value::Number(self.scene_id.into()),
        );
        serde_json::Value::Object(sort_map_keys(map))
    }
}

pub(super) fn event_to_canonical_value(event: &ReplayEvent) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    match event {
        ReplayEvent::TextLine {
            byte_offset_in_scene,
            body_shift_jis,
            body_utf8,
            speaker,
            color,
        } => {
            map.insert(
                "bodyShiftJisHex".to_string(),
                serde_json::Value::String(bytes_to_hex(body_shift_jis)),
            );
            map.insert(
                "bodyUtf8".to_string(),
                serde_json::Value::String(body_utf8.clone()),
            );
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            if let Some(color) = color {
                map.insert(
                    "color".to_string(),
                    serde_json::Value::Array(
                        color
                            .iter()
                            .map(|channel| serde_json::Value::Number((*channel).into()))
                            .collect(),
                    ),
                );
            }
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("text_line".to_string()),
            );
            if let Some(speaker) = speaker {
                map.insert(
                    "speaker".to_string(),
                    serde_json::Value::String(speaker.clone()),
                );
            }
        }
        ReplayEvent::Pause {
            byte_offset_in_scene,
        } => {
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("pause".to_string()),
            );
        }
        ReplayEvent::UnknownOpcode {
            byte_offset_in_scene,
            module_type,
            module_id,
            opcode,
        } => {
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("unknown_opcode".to_string()),
            );
            map.insert(
                "moduleId".to_string(),
                serde_json::Value::Number((*module_id).into()),
            );
            map.insert(
                "moduleType".to_string(),
                serde_json::Value::Number((*module_type).into()),
            );
            map.insert(
                "opcode".to_string(),
                serde_json::Value::Number((*opcode).into()),
            );
        }
        ReplayEvent::CatalogFallback {
            byte_offset_in_scene,
            module_type,
            module_id,
            opcode,
        } => {
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("catalog_fallback".to_string()),
            );
            map.insert(
                "moduleId".to_string(),
                serde_json::Value::Number((*module_id).into()),
            );
            map.insert(
                "moduleType".to_string(),
                serde_json::Value::Number((*module_type).into()),
            );
            map.insert(
                "opcode".to_string(),
                serde_json::Value::Number((*opcode).into()),
            );
        }
        ReplayEvent::Tick { count } => {
            map.insert(
                "count".to_string(),
                serde_json::Value::Number((*count).into()),
            );
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("tick".to_string()),
            );
        }
    }
    serde_json::Value::Object(sort_map_keys(map))
}

fn outcome_to_canonical_value(outcome: &ReplayOutcome) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    match outcome {
        ReplayOutcome::FirstPauseReached { events } => {
            map.insert(
                "events".to_string(),
                serde_json::Value::Number((*events).into()),
            );
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String("first_pause_reached".to_string()),
            );
        }
        ReplayOutcome::BudgetExhausted { events } => {
            map.insert(
                "events".to_string(),
                serde_json::Value::Number((*events).into()),
            );
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String("budget_exhausted".to_string()),
            );
        }
        ReplayOutcome::EndOfScene { events } => {
            map.insert(
                "events".to_string(),
                serde_json::Value::Number((*events).into()),
            );
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String("end_of_scene".to_string()),
            );
        }
        ReplayOutcome::FatalDiagnostic {
            code,
            byte_offset_in_scene,
        } => {
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            map.insert("code".to_string(), serde_json::Value::String(code.clone()));
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String("fatal_diagnostic".to_string()),
            );
        }
    }
    serde_json::Value::Object(sort_map_keys(map))
}

fn sort_map_keys(
    map: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut entries: Vec<(String, serde_json::Value)> = map.into_iter().collect();
    entries.sort_by(|(a, _), (b, _)| a.cmp(b));
    let mut out = serde_json::Map::with_capacity(entries.len());
    for (key, value) in entries {
        out.insert(key, value);
    }
    out
}

pub(super) fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0F));
    }
    out
}

fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => '?',
    }
}
