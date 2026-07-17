use encoding_rs::SHIFT_JIS;

use super::{
    BGI_BACKLOG_FUNCTION, BGI_CODE_TERMINATOR, BGI_FILE_TYPE, BGI_HEADER_ADDITIONAL_SIZE_OFFSET,
    BGI_HEADER_BASE_SIZE, BGI_HEADER_MAGIC, BGI_RUBY_FUNCTION, BGI_STRING_TYPE, BGI_TEXT_FUNCTION,
    BgiBytecodeParseError, BgiBytecodeReferenceConfig, BgiBytecodeStringReference,
    BgiBytecodeTextSurface, BgiBytecodeVariant, parse_error,
};

pub(super) fn parse_bgi_bytecode(
    bytes: &[u8],
    variant: BgiBytecodeVariant,
) -> Result<Vec<BgiBytecodeStringReference>, BgiBytecodeParseError> {
    let code_start = code_start_for_variant(bytes, variant)?;
    let code_end = find_code_end(bytes, code_start)?;
    let code = &bytes[code_start..code_end];
    if !code.len().is_multiple_of(4) {
        return Err(parse_error(
            "truncated_code_dword",
            "bytecode",
            "BGI code section length must be a multiple of four bytes",
        ));
    }
    let code_size = u32::try_from(code.len()).map_err(|_| {
        parse_error(
            "code_size_overflow",
            "bytecode",
            "BGI code section exceeds the 32-bit code-size-relative pointer range",
        )
    })?;
    let text_start = code_end;
    let text = &bytes[text_start..];
    let config = variant.config();
    let variant_id = match variant {
        BgiBytecodeVariant::Header => "header",
        BgiBytecodeVariant::NoHeader => "no_header",
    };

    let mut references = Vec::new();
    let mut counters = BgiReferenceCounters::default();
    let mut pos = 4usize;
    while pos < code.len() {
        let r#type = read_u32_le(code, pos - 4).ok_or_else(|| {
            parse_error(
                "truncated_code_dword",
                format!("bytecode@0x{:x}", code_start + pos - 4),
                "BGI string-reference type dword is truncated",
            )
        })?;
        if r#type != BGI_STRING_TYPE && r#type != BGI_FILE_TYPE {
            pos += 4;
            continue;
        }

        let field = format!("bytecode@0x{:x}", code_start + pos);
        let text_surface = classify_reference(r#type, code, pos, config);
        let candidate_is_contextual = text_surface != BgiBytecodeTextSurface::Other;
        let pointer = match read_u32_le(code, pos) {
            Some(pointer) => pointer,
            None if candidate_is_contextual => {
                return Err(parse_error(
                    "truncated_code_dword",
                    field,
                    "BGI string-reference pointer dword is truncated",
                ));
            }
            None => {
                pos += 4;
                continue;
            }
        };
        let Some(text_relative) = pointer.checked_sub(code_size) else {
            if candidate_is_contextual {
                return Err(parse_error(
                    "string_pointer_out_of_bounds",
                    field,
                    "BGI string-reference pointer lands before the text section",
                ));
            }
            pos += 4;
            continue;
        };
        let text_relative = text_relative as usize;
        if text_relative >= text.len() {
            if candidate_is_contextual {
                return Err(parse_error(
                    "string_pointer_out_of_bounds",
                    field,
                    "BGI string-reference pointer lands beyond the text section",
                ));
            }
            pos += 4;
            continue;
        }

        let Some(string_end_relative) = text[text_relative..].iter().position(|byte| *byte == 0)
        else {
            if candidate_is_contextual {
                return Err(parse_error(
                    "unterminated_string",
                    field,
                    "BGI string-reference target is not NUL-terminated",
                ));
            }
            pos += 4;
            continue;
        };
        let string_bytes = &text[text_relative..text_relative + string_end_relative];
        let (decoded, _, had_errors) = SHIFT_JIS.decode(string_bytes);
        if had_errors {
            if candidate_is_contextual {
                return Err(parse_error(
                    "invalid_shift_jis",
                    field,
                    "BGI string-reference target is not valid Shift-JIS",
                ));
            }
            pos += 4;
            continue;
        }

        let index = counters.next(text_surface);
        let string_start = text_start + text_relative;
        let string_end = string_start + string_end_relative;
        references.push(BgiBytecodeStringReference {
            reference_id: format!("bgi.{variant_id}.{}.{index:03}", text_surface.id_fragment()),
            text_surface,
            parser_opcode: text_surface.parser_opcode().to_string(),
            pointer_offset_byte: (code_start + pos) as u64,
            pointer_value: pointer,
            string_start_byte: string_start as u64,
            string_end_byte: string_end as u64,
            terminator_byte: string_end as u64,
            decoded_text: decoded.into_owned(),
        });

        pos += 4;
    }

    if references.is_empty() {
        return Err(parse_error(
            "missing_string_reference_surface",
            "bytecode",
            "BGI bytecode profile must expose at least one string-reference surface",
        ));
    }

    Ok(references)
}

pub(super) fn code_start_for_variant(
    bytes: &[u8],
    variant: BgiBytecodeVariant,
) -> Result<usize, BgiBytecodeParseError> {
    match variant {
        BgiBytecodeVariant::Header => {
            if bytes.len() < BGI_HEADER_BASE_SIZE + 4 || !bytes.starts_with(BGI_HEADER_MAGIC) {
                return Err(parse_error(
                    "malformed_header",
                    "header",
                    "BGI header bytecode must start with BurikoCompiledScriptVer1.00 NUL magic and an additional-header-size dword",
                ));
            }
            let additional =
                read_u32_le(bytes, BGI_HEADER_ADDITIONAL_SIZE_OFFSET).ok_or_else(|| {
                    parse_error(
                        "malformed_header",
                        "header.additionalHeaderSize",
                        "BGI header additional-size dword is truncated",
                    )
                })? as usize;
            let Some(code_start) = BGI_HEADER_BASE_SIZE.checked_add(additional) else {
                return Err(parse_error(
                    "malformed_header",
                    "header.additionalHeaderSize",
                    "BGI header additional-size dword overflows code start",
                ));
            };
            if code_start >= bytes.len() {
                return Err(parse_error(
                    "malformed_header",
                    "header.additionalHeaderSize",
                    "BGI header additional-size dword moves code start beyond EOF",
                ));
            }
            Ok(code_start)
        }
        BgiBytecodeVariant::NoHeader => {
            if bytes.starts_with(BGI_HEADER_MAGIC) {
                return Err(parse_error(
                    "malformed_header",
                    "header",
                    "BGI no-header bytecode profile must not carry the header-only magic",
                ));
            }
            Ok(0)
        }
    }
}

pub(super) fn find_code_end(
    bytes: &[u8],
    code_start: usize,
) -> Result<usize, BgiBytecodeParseError> {
    bytes[code_start..]
        .windows(BGI_CODE_TERMINATOR.len())
        .rposition(|window| window == BGI_CODE_TERMINATOR)
        .map(|index| code_start + index + BGI_CODE_TERMINATOR.len())
        .ok_or_else(|| {
            parse_error(
                "missing_code_terminator",
                "bytecode",
                "BGI bytecode code section must end before the 1b000000 terminal dword",
            )
        })
}

fn classify_reference(
    r#type: u32,
    code: &[u8],
    pos: usize,
    config: BgiBytecodeReferenceConfig,
) -> BgiBytecodeTextSurface {
    if r#type == BGI_FILE_TYPE {
        return BgiBytecodeTextSurface::FileReference;
    }
    if check_code_dword(code, pos, config.name_probe, BGI_TEXT_FUNCTION) {
        BgiBytecodeTextSurface::CharacterName
    } else if check_code_dword(code, pos, config.dialogue_probe, BGI_TEXT_FUNCTION) {
        BgiBytecodeTextSurface::Dialogue
    } else if check_code_dword(code, pos, config.ruby_kanji_slot, BGI_RUBY_FUNCTION) {
        BgiBytecodeTextSurface::RubyKanji
    } else if check_code_dword(code, pos, config.ruby_furigana_slot, BGI_RUBY_FUNCTION) {
        BgiBytecodeTextSurface::RubyFurigana
    } else if check_code_dword(code, pos, config.backlog_call, BGI_BACKLOG_FUNCTION) {
        BgiBytecodeTextSurface::Backlog
    } else {
        BgiBytecodeTextSurface::Other
    }
}

fn check_code_dword(code: &[u8], pos: usize, offset: usize, expected: u32) -> bool {
    pos.checked_add(offset).and_then(|at| read_u32_le(code, at)) == Some(expected)
}

#[derive(Default)]
struct BgiReferenceCounters {
    character_name: u32,
    dialogue: u32,
    backlog: u32,
    ruby_kanji: u32,
    ruby_furigana: u32,
    other: u32,
    file_reference: u32,
}

impl BgiReferenceCounters {
    fn next(&mut self, surface: BgiBytecodeTextSurface) -> u32 {
        let counter = match surface {
            BgiBytecodeTextSurface::CharacterName => &mut self.character_name,
            BgiBytecodeTextSurface::Dialogue => &mut self.dialogue,
            BgiBytecodeTextSurface::Backlog => &mut self.backlog,
            BgiBytecodeTextSurface::RubyKanji => &mut self.ruby_kanji,
            BgiBytecodeTextSurface::RubyFurigana => &mut self.ruby_furigana,
            BgiBytecodeTextSurface::Other => &mut self.other,
            BgiBytecodeTextSurface::FileReference => &mut self.file_reference,
        };
        *counter += 1;
        *counter
    }
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes(slice.try_into().ok()?))
}
