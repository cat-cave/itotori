use super::*;

use crate::{
    ProtectedSpanMapping, STRING_RELOCATION_INVALID_SOURCE_BYTES,
    STRING_RELOCATION_OVERLAPPING_WRITES, STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH,
    STRING_RELOCATION_UNRESOLVED_REFERENCE, STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
    STRING_SLOT_INVALID_ENCODING, STRING_SLOT_OVERFLOW, STRING_SLOT_PROTECTED_SPAN_MUTATION,
    STRING_SLOT_TERMINATOR_LOSS,
};

fn fixture(name: &str) -> Value {
    serde_json::from_str(match name {
        "utf8" => include_str!("../../fixtures/offset-map/utf8.json"),
        "shift_jis" => include_str!("../../fixtures/offset-map/shift-jis.json"),
        "binary_table" => include_str!("../../fixtures/offset-map/binary-table.json"),
        "sliced_buffer" => include_str!("../../fixtures/offset-map/sliced-buffer.json"),
        _ => unreachable!(),
    })
    .unwrap()
}

fn string_slot_fixture(name: &str) -> Value {
    serde_json::from_str(match name {
        "utf8_fixed" => include_str!("../../fixtures/encoded-string-slot/utf8-fixed.json"),
        "utf8_null" => {
            include_str!("../../fixtures/encoded-string-slot/utf8-null-terminated.json")
        }
        "shift_jis_fixed" => {
            include_str!("../../fixtures/encoded-string-slot/shift-jis-fixed.json")
        }
        "shift_jis_null" => {
            include_str!("../../fixtures/encoded-string-slot/shift-jis-null-terminated.json")
        }
        "protected_token" => {
            include_str!("../../fixtures/encoded-string-slot/protected-token.json")
        }
        "protected_token_duplicate" => {
            include_str!("../../fixtures/encoded-string-slot/protected-token-duplicate.json")
        }
        "protected_token_duplicate_collapsed" => include_str!(
            "../../fixtures/encoded-string-slot/protected-token-duplicate-collapsed.json"
        ),
        "protected_token_duplicate_missing" => include_str!(
            "../../fixtures/encoded-string-slot/protected-token-duplicate-missing.json"
        ),
        "protected_token_duplicate_extra" => {
            include_str!("../../fixtures/encoded-string-slot/protected-token-duplicate-extra.json")
        }
        _ => unreachable!(),
    })
    .unwrap()
}

fn string_relocation_fixture(name: &str) -> Value {
    serde_json::from_str(match name {
        "pointer_table" => include_str!("../../fixtures/string-relocation/pointer-table.json"),
        "index_table" => include_str!("../../fixtures/string-relocation/index-table.json"),
        "pointer_table_wrong_target" => {
            include_str!("../../fixtures/string-relocation/pointer-table-wrong-target.json")
        }
        "index_table_wrong_target" => {
            include_str!("../../fixtures/string-relocation/index-table-wrong-target.json")
        }
        _ => unreachable!(),
    })
    .unwrap()
}

fn typed_string_relocation_fixture(name: &str) -> (StringTableRebuildRequest, String) {
    let mut value = string_relocation_fixture(name);
    let expected = value
        .as_object_mut()
        .unwrap()
        .remove("expectedOutputBytesHex")
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    (serde_json::from_value(value).unwrap(), expected)
}

fn invalid_string_relocation_fixture(name: &str) -> StringTableRebuildRequest {
    serde_json::from_value(string_relocation_fixture(name)).unwrap()
}

fn run_string_slot_fixture(name: &str) -> EncodedStringSlotPreflightReport {
    let value = string_slot_fixture(name);
    let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();
    let mappings = value["protectedSpanMappings"]
        .as_array()
        .map(|mappings| {
            mappings
                .iter()
                .cloned()
                .map(serde_json::from_value)
                .collect::<Result<Vec<ProtectedSpanMapping>, _>>()
        })
        .transpose()
        .unwrap()
        .unwrap_or_default();
    let current_slot_bytes = value["currentSlotBytesHex"]
        .as_str()
        .map(parse_hex_bytes)
        .transpose()
        .unwrap();
    slot.preflight(
        value["targetText"].as_str().unwrap(),
        &mappings,
        current_slot_bytes.as_deref(),
    )
}

fn typed_fixture(name: &str) -> OffsetMap {
    let value = fixture(name);
    let validation = validate_offset_map_value(&value);
    assert_eq!(validation.status, OperationStatus::Passed, "{validation:?}");
    serde_json::from_value(value).unwrap()
}

mod encoded_string_slot;
mod offset_map;
mod string_relocation;
