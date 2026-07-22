use super::*;

impl FixtureAdapter {
    pub(super) fn parse_fixture_markup_spans(text: &str) -> KaifuuResult<Vec<ProtectedSpan>> {
        let mut spans = Vec::new();
        let mut index = 0;
        while index < text.len() {
            let parsed = match text.as_bytes()[index] {
                b'{' => Some(Self::parse_braced_placeholder(text, index)),
                b'<' => Some(Self::parse_angle_markup(text, index)),
                b'\\' => Self::parse_backslash_markup(text, index),
                _ => None,
            };
            if let Some((span, next_index)) = parsed {
                spans.push(span);
                index = next_index;
                continue;
            }
            let next_char = text[index..]
                .chars()
                .next()
                .ok_or("fixture parser index must point at a UTF-8 character")?;
            index += next_char.len_utf8();
        }
        Ok(spans)
    }

    pub(super) fn parse_braced_placeholder(text: &str, start: usize) -> (ProtectedSpan, usize) {
        let content_start = start + 1;
        let Some(relative_end) = text[content_start..].find('}') else {
            let raw = &text[start..];
            return (
                ProtectedSpan::control_markup(
                    raw,
                    start as u64,
                    text.len() as u64,
                    "unknown_unclosed_placeholder",
                    vec![],
                ),
                text.len(),
            );
        };
        let content_end = content_start + relative_end;
        let end = content_end + 1;
        let raw = &text[start..end];
        let name = &text[content_start..content_end];
        let span = if Self::is_fixture_placeholder_name(name) {
            ProtectedSpan::variable_placeholder(raw, start as u64, end as u64, name)
        } else {
            ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                "unknown_placeholder",
                vec![name.to_string()],
            )
        };
        (span, end)
    }

    pub(super) fn is_fixture_placeholder_name(name: &str) -> bool {
        !name.is_empty()
            && name.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'_' | b'-' | b'.' | b':' | b'[' | b']')
            })
    }

    pub(super) fn parse_angle_markup(text: &str, start: usize) -> (ProtectedSpan, usize) {
        let content_start = start + 1;
        let Some(relative_end) = text[content_start..].find('>') else {
            let raw = &text[start..];
            return (
                ProtectedSpan::control_markup(
                    raw,
                    start as u64,
                    text.len() as u64,
                    "unknown_unclosed_tag",
                    vec![],
                ),
                text.len(),
            );
        };
        let content_end = content_start + relative_end;
        let end = content_end + 1;
        if let Some(span) = Self::parse_ruby_markup(text, start, content_start, content_end, end) {
            return (span, end);
        }
        (
            Self::parse_control_tag(text, start, content_start, content_end, end),
            end,
        )
    }

    pub(super) fn parse_ruby_markup(
        text: &str,
        start: usize,
        content_start: usize,
        content_end: usize,
        end: usize,
    ) -> Option<ProtectedSpan> {
        let content = &text[content_start..content_end];
        let equals_index = content.find('=')?;
        let name = content[..equals_index].trim();
        if !matches!(name, "ruby" | "furigana") {
            return None;
        }
        let values_start = content_start + equals_index + 1;
        let values = &text[values_start..content_end];
        let separator_index = values.find('|')?;
        let base_start = values_start;
        let base_end = values_start + separator_index;
        let annotation_start = base_end + 1;
        let annotation_end = content_end;
        let annotation_text = &text[annotation_start..annotation_end];
        let raw = &text[start..end];
        let mut span = ProtectedSpan::new(
            "ruby_annotation",
            raw,
            start as u64,
            end as u64,
            "locale_policy",
        );
        span.parsed_name = Some(name.to_string());
        span.arguments = Some(vec![
            text[base_start..base_end].to_string(),
            annotation_text.to_string(),
        ]);
        span.base_start_byte = Some(base_start as u64);
        span.base_end_byte = Some(base_end as u64);
        span.annotation_start_byte = Some(annotation_start as u64);
        span.annotation_end_byte = Some(annotation_end as u64);
        span.annotation_text = Some(annotation_text.to_string());
        span.display_mode = Some(name.to_string());
        Some(span)
    }

    pub(super) fn parse_control_tag(
        text: &str,
        start: usize,
        content_start: usize,
        content_end: usize,
        end: usize,
    ) -> ProtectedSpan {
        let content = text[content_start..content_end].trim();
        let raw = &text[start..end];
        let (parsed_name, arguments) = Self::control_tag_metadata(content);
        ProtectedSpan::control_markup(raw, start as u64, end as u64, parsed_name, arguments)
    }

    pub(super) fn control_tag_metadata(content: &str) -> (String, Vec<String>) {
        if content.is_empty() {
            return ("unknown_empty_tag".to_string(), vec![]);
        }
        if let Some(closing) = content.strip_prefix('/') {
            let name = Self::normalize_fixture_markup_name(closing);
            return (name, vec!["close".to_string()]);
        }
        let separator = content
            .char_indices()
            .find(|(_, character)| matches!(character, '=' | ':' | ' ' | '\t'));
        let Some((separator_index, separator_char)) = separator else {
            return (Self::normalize_fixture_markup_name(content), vec![]);
        };
        let name = Self::normalize_fixture_markup_name(&content[..separator_index]);
        let argument_text = content[separator_index + separator_char.len_utf8()..].trim();
        let arguments = if argument_text.is_empty() {
            vec![]
        } else {
            argument_text
                .split([',', '|'])
                .map(str::trim)
                .filter(|argument| !argument.is_empty())
                .map(str::to_string)
                .collect()
        };
        (name, arguments)
    }

    pub(super) fn normalize_fixture_markup_name(name: &str) -> String {
        let name = name.trim();
        if name.is_empty() {
            "unknown_markup".to_string()
        } else {
            name.to_ascii_lowercase()
        }
    }

    pub(super) fn parse_backslash_markup(
        text: &str,
        start: usize,
    ) -> Option<(ProtectedSpan, usize)> {
        let after_slash = start + 1;
        let Some(next) = text[after_slash..].chars().next() else {
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_trailing_backslash",
                vec![],
            ));
        };
        if matches!(next, '.' | '|' | '!') {
            let end = after_slash + next.len_utf8();
            return Some((
                ProtectedSpan::control_markup(
                    &text[start..end],
                    start as u64,
                    end as u64,
                    "wait",
                    vec![next.to_string()],
                ),
                end,
            ));
        }
        if !next.is_ascii_alphabetic() {
            return Some(Self::parse_symbol_backslash_markup(
                text,
                start,
                after_slash,
                next,
            ));
        }
        let code_end = text[after_slash..]
            .char_indices()
            .take_while(|(_, character)| character.is_ascii_alphabetic())
            .last()
            .map(|(index, character)| after_slash + index + character.len_utf8())?;
        if !text[code_end..].starts_with('[') {
            let code = &text[after_slash..code_end];
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                code_end,
                Self::normalize_fixture_markup_name(code),
                vec!["missing_bracket".to_string()],
            ));
        }
        let argument_start = code_end + 1;
        let Some(relative_end) = text[argument_start..].find(']') else {
            let code = &text[after_slash..code_end];
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_unclosed_backslash_command",
                vec![code.to_string()],
            ));
        };
        let argument_end = argument_start + relative_end;
        let end = argument_end + 1;
        let code = &text[after_slash..code_end];
        let argument = &text[argument_start..argument_end];
        let raw = &text[start..end];
        let upper_code = code.to_ascii_uppercase();
        let mut span = match upper_code.as_str() {
            "N" | "NAME" => ProtectedSpan::variable_placeholder(
                raw,
                start as u64,
                end as u64,
                format!("name[{argument}]"),
            ),
            "V" | "VAR" => ProtectedSpan::variable_placeholder(
                raw,
                start as u64,
                end as u64,
                format!("variable[{argument}]"),
            ),
            "C" | "COLOR" => ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                "color",
                vec![argument.to_string()],
            ),
            _ => ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                Self::normalize_fixture_markup_name(code),
                vec![argument.to_string()],
            ),
        };
        span.parsed_name = Some(match upper_code.as_str() {
            "N" | "NAME" => "name_variable".to_string(),
            "V" | "VAR" => "runtime_variable".to_string(),
            "C" | "COLOR" => "color".to_string(),
            _ => Self::normalize_fixture_markup_name(code),
        });
        span.arguments = Some(vec![argument.to_string()]);
        Some((span, end))
    }

    pub(super) fn parse_symbol_backslash_markup(
        text: &str,
        start: usize,
        after_slash: usize,
        command: char,
    ) -> (ProtectedSpan, usize) {
        let command_end = after_slash + command.len_utf8();
        if text[command_end..].starts_with('[') {
            let argument_start = command_end + 1;
            if let Some(relative_end) = text[argument_start..].find(']') {
                let argument_end = argument_start + relative_end;
                let end = argument_end + 1;
                return Self::unknown_backslash_markup(
                    text,
                    start,
                    end,
                    "unknown_backslash_command",
                    vec![
                        command.to_string(),
                        text[argument_start..argument_end].to_string(),
                    ],
                );
            }
            return Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_unclosed_backslash_command",
                vec![command.to_string()],
            );
        }

        Self::unknown_backslash_markup(
            text,
            start,
            command_end,
            "unknown_backslash_command",
            vec![command.to_string()],
        )
    }

    pub(super) fn unknown_backslash_markup(
        text: &str,
        start: usize,
        end: usize,
        parsed_name: impl Into<String>,
        arguments: Vec<String>,
    ) -> (ProtectedSpan, usize) {
        (
            ProtectedSpan::control_markup(
                &text[start..end],
                start as u64,
                end as u64,
                parsed_name,
                arguments,
            ),
            end,
        )
    }
}
