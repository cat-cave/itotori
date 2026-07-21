use std::collections::BTreeSet;

use kaifuu_core::HelperDiagnosticCode;

const CORE_SOURCE: &str = include_str!("../src/lib.rs");
const KEY_DISCOVERY_DOC: &str = include_str!("../../../docs/kaifuu-key-discovery.md");
const ENUM_DECLARATION: &str = "pub enum HelperDiagnosticCode {";
const DOC_BLOCK_START: &str = "<!-- HELPER-RESULT-DIAGNOSTIC-ENUM:START -->";
const DOC_BLOCK_END: &str = "<!-- HELPER-RESULT-DIAGNOSTIC-ENUM:END -->";

#[test]
fn helper_result_diagnostic_docs_match_the_public_enum() {
    let enum_names = enum_diagnostic_names();
    let documented_names = documented_diagnostic_names();

    assert_eq!(
        documented_names, enum_names,
        "{DOC_BLOCK_START} must list exactly the snake_case values of {ENUM_DECLARATION}"
    );

    for name in &enum_names {
        let public_value = serde_json::Value::String(name.clone());
        let diagnostic = serde_json::from_value::<HelperDiagnosticCode>(public_value.clone())
            .unwrap_or_else(|error| panic!("{name} is not accepted by the public schema: {error}"));
        assert_eq!(
            serde_json::to_value(diagnostic).expect("diagnostic serializes"),
            public_value,
            "{name} must preserve its public-schema spelling"
        );
    }
}

fn enum_diagnostic_names() -> BTreeSet<String> {
    let (_, after_declaration) = CORE_SOURCE
        .split_once(ENUM_DECLARATION)
        .expect("HelperDiagnosticCode enum declaration exists");
    let (enum_body, _) = after_declaration
        .split_once("\n}")
        .expect("HelperDiagnosticCode enum has a closing brace");

    let names = enum_body
        .lines()
        .filter_map(|line| line.trim().strip_suffix(','))
        .filter(|line| is_pascal_case_identifier(line))
        .map(pascal_case_to_snake_case)
        .collect::<BTreeSet<_>>();

    assert!(
        !names.is_empty(),
        "HelperDiagnosticCode enum must not be empty"
    );
    names
}

fn documented_diagnostic_names() -> BTreeSet<String> {
    let (_, after_start) = KEY_DISCOVERY_DOC
        .split_once(DOC_BLOCK_START)
        .expect("key-discovery docs contain the diagnostic start marker");
    let (block, _) = after_start
        .split_once(DOC_BLOCK_END)
        .expect("key-discovery docs contain the diagnostic end marker");

    let listed_names = block
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- `"))
        .filter_map(|line| line.strip_suffix('`'))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let names = listed_names.iter().cloned().collect::<BTreeSet<_>>();

    assert!(!names.is_empty(), "diagnostic docs list must not be empty");
    assert_eq!(
        names.len(),
        listed_names.len(),
        "diagnostic docs list must not contain duplicate names"
    );
    names
}

fn is_pascal_case_identifier(value: &str) -> bool {
    value.chars().next().is_some_and(char::is_uppercase)
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn pascal_case_to_snake_case(value: &str) -> String {
    let mut snake_case = String::with_capacity(value.len() + 4);
    for (index, character) in value.chars().enumerate() {
        if character.is_uppercase() {
            if index > 0 {
                snake_case.push('_');
            }
            snake_case.extend(character.to_lowercase());
        } else {
            snake_case.push(character);
        }
    }
    snake_case
}
