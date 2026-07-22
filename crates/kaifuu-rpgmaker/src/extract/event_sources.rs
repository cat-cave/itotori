use super::*;

/// Walk a parsed `Map*.json` value.
pub fn walk_map(acc: &mut ExtractAcc, file: &str, map: &Value) {
    if let Some(display) = map.get("displayName").and_then(Value::as_str)
        && !display.is_empty()
    {
        acc.push_text_unit(
            file,
            vec!["displayName".to_string()],
            SurfaceKind::UiLabel { ui_area: "hud" },
            display,
            None,
        );
    }
    let Some(events) = map.get("events").and_then(Value::as_array) else {
        return;
    };
    for (event_index, event) in events.iter().enumerate() {
        let Some(pages) = event.get("pages").and_then(Value::as_array) else {
            continue;
        };
        for (page_index, page) in pages.iter().enumerate() {
            let Some(list) = page.get("list").and_then(Value::as_array) else {
                continue;
            };
            let base = vec![
                "events".to_string(),
                event_index.to_string(),
                "pages".to_string(),
                page_index.to_string(),
                "list".to_string(),
            ];
            walk_command_list(acc, file, base, list);
        }
    }
}

/// Walk a parsed `CommonEvents.json` value.
pub fn walk_common_events(acc: &mut ExtractAcc, file: &str, common_events: &Value) {
    let Some(array) = common_events.as_array() else {
        return;
    };
    for (index, entry) in array.iter().enumerate() {
        let Some(list) = entry.get("list").and_then(Value::as_array) else {
            continue;
        };
        let base = vec![index.to_string(), "list".to_string()];
        walk_command_list(acc, file, base, list);
    }
}

/// Walk a parsed `Troops.json` value.
pub fn walk_troops(acc: &mut ExtractAcc, file: &str, troops: &Value) {
    let Some(array) = troops.as_array() else {
        return;
    };
    for (troop_index, troop) in array.iter().enumerate() {
        let Some(pages) = troop.get("pages").and_then(Value::as_array) else {
            continue;
        };
        for (page_index, page) in pages.iter().enumerate() {
            let Some(list) = page.get("list").and_then(Value::as_array) else {
                continue;
            };
            let base = vec![
                troop_index.to_string(),
                "pages".to_string(),
                page_index.to_string(),
                "list".to_string(),
            ];
            walk_command_list(acc, file, base, list);
        }
    }
}
