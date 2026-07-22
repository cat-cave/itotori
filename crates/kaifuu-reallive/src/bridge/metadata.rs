use super::*;

/// Textout markup is RealLive engine grammar, not a game profile. RLDEV's
/// `lib/textout.kh`, cited by rlvm's `src/doc/notes/NamesAndIndentation.txt`,
/// defines lenticular names; rlvm's `TextoutLongOperation` treats U+3010 as a
/// name token. A textout may omit any optional token, but the grammar is shared.
const RLDEV_LENTICULAR_NAME_DELIMITERS: (char, char) = ('【', '】');

pub(super) fn extract_name_token_spans(
    decoded: &str,
    prefix_offset: u64,
) -> (Option<String>, Vec<ProtoSpan>) {
    // `【話者】` is the `#NAMAE` lookup key; `「話者」` is dialogue quotation.
    let (open, close) = RLDEV_LENTICULAR_NAME_DELIMITERS;
    if let Some(open_pos) = decoded.find(open)
        && let Some(close_offset) = decoded[open_pos + open.len_utf8()..].find(close)
    {
        let close_pos = open_pos + open.len_utf8() + close_offset + close.len_utf8();
        let raw_speaker =
            decoded[open_pos + open.len_utf8()..close_pos - close.len_utf8()].to_string();
        let raw_bracketed = decoded[open_pos..close_pos].to_string();
        let span = ProtoSpan {
            parsed_name: "reallive.name_token",
            out_of_band: false,
            start_byte: prefix_offset + open_pos as u64,
            end_byte: prefix_offset + close_pos as u64,
            raw: raw_bracketed,
        };
        return (Some(raw_speaker), vec![span]);
    }
    (None, Vec::new())
}

pub(super) fn extract_inline_tag_spans(
    decoded: &str,
    prefix_offset: u64,
    tags: &[&str],
    parsed_name: &'static str,
) -> Vec<ProtoSpan> {
    let mut spans = Vec::new();
    for &tag in tags {
        let mut start = 0usize;
        while let Some(rel) = decoded[start..].find(tag) {
            let tag_start = start + rel;
            let mut tag_end = tag_start + tag.len();
            // Optional bracketed arg list.
            if decoded[tag_end..].starts_with('(')
                && let Some(close_rel) = decoded[tag_end..].find(')')
            {
                tag_end += close_rel + 1;
            }
            let raw = decoded[tag_start..tag_end].to_string();
            spans.push(ProtoSpan {
                parsed_name,
                out_of_band: false,
                start_byte: prefix_offset + tag_start as u64,
                end_byte: prefix_offset + tag_end as u64,
                raw,
            });
            start = tag_end;
        }
    }
    spans
}

pub(super) fn extract_choice_marker_spans(
    raw_bytes: &[u8],
    decoded: &str,
    prefix_offset: u64,
) -> Vec<ProtoSpan> {
    // Choice markers are control bytes `0x30..0x34` per spec — when
    // present they survive Shift-JIS decode as ASCII digits `'0'..'4'`.
    // PROVENANCE (2nd-corpus calibration): TITLE-CALIBRATED heuristic (not an
    // RLDEV-documented marker). Emits ZERO spans on BOTH real corpora — real
    // RealLive selection is carried by `module_sel` Choice opcodes, not inline
    // ASCII-digit bytes in the choice body. Kept bounded (first match only) so
    // it cannot mis-fire; not RealLive-engine-general.
    let mut spans = Vec::new();
    for byte in [0x30u8, 0x31, 0x32, 0x33] {
        let ch = byte as char;
        // Only match the first one to keep the span set bounded.
        if raw_bytes.contains(&byte)
            && let Some(pos) = decoded.find(ch)
        {
            spans.push(ProtoSpan {
                parsed_name: "reallive.choice_marker",
                out_of_band: false,
                start_byte: prefix_offset + pos as u64,
                end_byte: prefix_offset + pos as u64 + 1,
                raw: ch.to_string(),
            });
            break;
        }
    }
    spans
}

/// Compute the typed speaker resolution for one collected unit.
/// Only a `dialogue` line with a pinned speaker box can carry a speaker.
/// A box flagged `speaker_from_fallback` is a bounded guess and stays
/// `parser_unknown`. Otherwise the box is resolved against the NAMAE
/// registry: a UNIQUE row match keeps the resolved identity (`Revealed`
/// when the box name is the character's real name, `Concealed` when the
/// box shows a mask); no match — or an ambiguous match — is
/// `parser_unknown` (never a fabricated identity).
pub(super) fn resolve_unit_speaker(
    unit: &ProtoUnit,
    gameexe_inventory: &GameexeInventoryReport,
) -> SpeakerResolution {
    if unit.surface_kind != "dialogue" {
        return SpeakerResolution::NotApplicable;
    }
    let Some(raw) = unit.raw_speaker.as_deref() else {
        return SpeakerResolution::NotApplicable;
    };
    if unit.speaker_from_fallback {
        return SpeakerResolution::ParserUnknown {
            raw: raw.to_string(),
            evidence: "namae_first_line_fallback",
        };
    }
    match resolve_namae_row(raw, gameexe_inventory) {
        Some(row) => {
            let canonical_ref = format!("reallive:namae:{}", row.display_key);
            if row.display_key == row.box_name {
                SpeakerResolution::Revealed {
                    display_name: row.display_key,
                    canonical_ref,
                    color: row.color,
                }
            } else {
                SpeakerResolution::Concealed {
                    display_name: row.display_key,
                    reader_label: row.box_name,
                    canonical_ref,
                    color: row.color,
                }
            }
        }
        None => SpeakerResolution::ParserUnknown {
            raw: raw.to_string(),
            evidence: "inline_name_token_unresolved",
        },
    }
}

/// Resolve a raw `【…】` speaker token to a UNIQUE `#NAMAE` row.
/// Matches on EXACT equality against a row's DISPLAY KEY (the first quoted
/// field) ONLY — never the second/box-shown field, and never a substring
/// `contains`. This is the exact lookup the runtime performs
/// (`utsushi-reallive`'s `NamaeResolver::resolve` keys `by_key` on the
/// display string an authored `【…】` prefix carries), so the Bridge cannot
/// invent an identity the engine would not resolve:
/// - A token that equals only a censored box label (e.g. `【？？？】` against
///   `#NAMAE="？？？／凛"="？？？"`) has NO display key `？？？` and stays
///   unresolved, exactly as the runtime leaves it.
/// - With rows `A="???"` and `B="A"`, the token `【A】` uniquely matches row
///   A's display key; row B's box-shown `A` is NOT a second match, so this is
///   a clean single resolution, not spurious `parser_unknown` ambiguity.
///
/// Reveal state is then derived from the matched row's REAL fields (display
/// key vs box-shown name) by the caller, never fabricated. A token that
/// still matches two or more rows on the display key is ambiguous and
/// returns `None`: the producer must not guess which row a duplicated key
/// belongs to.
fn resolve_namae_row(raw: &str, gameexe_inventory: &GameexeInventoryReport) -> Option<NamaeRow> {
    let mut matched: Option<NamaeRow> = None;
    for entry in &gameexe_inventory.entries {
        if !matches!(entry.family, GameexeKeyFamily::Namae) {
            continue;
        }
        let Some(display_key) = namae_display(&entry.value) else {
            continue;
        };
        if display_key == raw {
            if matched.is_some() {
                // Ambiguous exact display-key match — do not guess an identity.
                return None;
            }
            let box_name = namae_second_field(&entry.value).unwrap_or_else(|| display_key.clone());
            let color = namae_color_index(&entry.value)
                .and_then(|index| color_table_rgb(index, gameexe_inventory));
            matched = Some(NamaeRow {
                display_key,
                box_name,
                color,
            });
        }
    }
    matched
}

/// The first `"…"` quoted field of a `#NAMAE` RHS
/// (`"display" = "canonical" = (mode, color_table_index, reserved)`).
fn namae_display(value: &str) -> Option<String> {
    let start = value.find('"')? + 1;
    let end = value[start..].find('"')? + start;
    Some(value[start..end].to_string())
}

/// The second `"…"` quoted field of a `#NAMAE` RHS — the box-shown
/// (reader-facing) name. Absent on a single-quote row, in which case the
/// caller falls back to the display key.
fn namae_second_field(value: &str) -> Option<String> {
    let first_open = value.find('"')? + 1;
    let first_close = value[first_open..].find('"')? + first_open;
    let rest = &value[first_close + 1..];
    let second_open = rest.find('"')? + 1;
    let second_close = rest[second_open..].find('"')? + second_open;
    Some(rest[second_open..second_close].to_string())
}

/// The middle tuple field of a `#NAMAE` RHS — the `#COLOR_TABLE` row
/// index (the speaker's dialogue text colour), NOT a voice slot.
fn namae_color_index(value: &str) -> Option<i32> {
    let open = value.find('(')?;
    let close = value[open..].find(')')? + open;
    let inner = &value[open + 1..close];
    let mut parts = inner.split(',');
    let _mode = parts.next()?;
    parts.next()?.trim().parse::<i32>().ok()
}

/// Look up `#COLOR_TABLE.<index>` in the inventory and parse its
/// `r,g,b` value into an RGB triple. Indices are authored zero-padded
/// to three digits (`#COLOR_TABLE.016`); a bare form is accepted too.
fn color_table_rgb(index: i32, gameexe_inventory: &GameexeInventoryReport) -> Option<[u8; 3]> {
    if index < 0 {
        return None;
    }
    let padded = format!("{index:03}");
    let bare = index.to_string();
    let entry = gameexe_inventory.entries.iter().find(|entry| {
        matches!(&entry.family, GameexeKeyFamily::ColorTable { index: idx } if *idx == padded || *idx == bare)
    })?;
    let mut parts = entry
        .value
        .split(',')
        .map(|part| part.trim().parse::<i32>());
    let r = parts.next()?.ok()?;
    let g = parts.next()?.ok()?;
    let b = parts.next()?.ok()?;
    // Reject an out-of-range row instead of clamping it: a clamped triple
    // (`300,-1,17` → `[255,0,17]`) is a colour that is NOT present in
    // Gameexe, i.e. a fabricated RGB. An 8-bit channel is `0..=255`; any
    // authored value outside that omits the colour (the speaker still
    // resolves, just without a fabricated `textColor`).
    let channel = |v: i32| (0..=255).contains(&v).then_some(v as u8);
    Some([channel(r)?, channel(g)?, channel(b)?])
}
