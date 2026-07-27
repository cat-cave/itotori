use super::*;

pub fn write_json<T>(path: &Path, value: &T) -> KaifuuResult<()>
where
    T: Serialize,
{
    atomic_write_text(path, &stable_json(value)?)
}

pub fn stable_json<T>(value: &T) -> KaifuuResult<String>
where
    T: Serialize,
{
    let pretty = serde_json::to_string_pretty(value)?;
    Ok(format!("{}\n", compact_primitive_json_arrays(&pretty)))
}

pub(crate) fn compact_primitive_json_arrays(pretty: &str) -> String {
    let lines = pretty.lines().collect::<Vec<_>>();
    let mut formatted = Vec::with_capacity(lines.len());
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        if let Some(compacted) = compact_primitive_json_array(&lines, index) {
            formatted.push(compacted.line);
            index = compacted.next_index;
        } else {
            formatted.push(line.to_string());
            index += 1;
        }
    }

    formatted.join("\n")
}

pub(crate) struct CompactedJsonArray {
    line: String,
    next_index: usize,
}

pub(crate) fn compact_primitive_json_array(
    lines: &[&str],
    start_index: usize,
) -> Option<CompactedJsonArray> {
    let line = lines[start_index];
    let trimmed = line.trim_end();
    if trimmed == "[" || !trimmed.ends_with('[') {
        return None;
    }
    let open_index = line.rfind('[')?;
    let prefix = &line[..open_index];
    let mut items = Vec::new();
    let mut index = start_index + 1;

    while let Some(candidate) = lines.get(index) {
        let trimmed_candidate = candidate.trim();
        if trimmed_candidate == "]" || trimmed_candidate == "]," {
            if items.is_empty() {
                return None;
            }
            let trailing_comma = if trimmed_candidate.ends_with(',') {
                ","
            } else {
                ""
            };
            return Some(CompactedJsonArray {
                line: format!("{prefix}[{}]{trailing_comma}", items.join(", ")),
                next_index: index + 1,
            });
        }

        let item = trimmed_candidate
            .strip_suffix(',')
            .unwrap_or(trimmed_candidate);
        let parsed: Value = match serde_json::from_str(item) {
            Ok(value) => value,
            Err(_) => return None,
        };
        if !is_primitive_json_value(&parsed) {
            return None;
        }
        items.push(item.to_string());
        index += 1;
    }

    None
}

pub(crate) fn is_primitive_json_value(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

pub fn read_json<T>(path: &Path) -> KaifuuResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}
