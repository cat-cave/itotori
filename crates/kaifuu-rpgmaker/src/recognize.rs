//! Evidence-driven recognizers for message-bearing plugin (356/357) and
//! script (355/655) commands.
//!
//! The MV/MZ extractor surfaces Plugin Command (356/357) and Script
//! (355/655) entries as structured [`crate::Finding`]s by default: there is
//! no plugin registry, so blindly extracting `parameters[0]` would grab
//! engine control (`window.close()`, screen-shake, sound-effect filenames)
//! as if it were dialogue. This module is the opposite of a blind grab: a
//! small set of recognizers, each keyed to a KNOWN plugin command whose
//! text-argument shape was verified against the LustMemory corpus. A
//! command that no recognizer claims stays a finding — no silent skip, no
//! engine control mis-extracted as dialogue.
//!
//! # The patchback-safe shape
//!
//! A recognized unit's text is the WHOLE `parameters[0]` literal, so the
//! `rpgmaker:<file>#/.../parameters/0` pointer and its `sourceHash` stay
//! byte-surgical-patchback targetable, exactly like a `Show Text` line. The
//! non-translatable structural tokens of the command (its keyword, a
//! trailing numeric font-size argument, …) are returned as preserve-exact
//! `control_markup` spans — the same mechanism that protects an inline
//! `\V[1]` code inside a dialogue line (see [`crate::escape`]). The
//! translator therefore sees only the display-text region as editable, and
//! patchback rewrites the literal in place with the keyword/size preserved
//! verbatim.
//!
//! # Evidence (LustMemory corpus, real bytes)
//!
//! Of the 356 plugin commands actually present — screen-shake `P_SHAKE` /
//! `P_STOP_SHAKE`, achievement-by-id (`Achievement`/`実績`), calendar `C_*`,
//! sound `SSC_*`, movie `MP_*`/`MM_*`, difficulty, `D_TEXT_SETTING`
//! (font/alignment config), … — only `D_TEXT` (triacontane's DTextPicture
//! plugin) carries display text; every other command's arguments are
//! numeric ids, identifiers, or asset filenames and stay findings. The 355
//! script commands present are all engine control
//! (`BattleManager._statusWindow.show/hide()`, `window.close()`) with no
//! string literals, so NO script recognizer is added — adding one with no
//! corpus evidence would be speculative.

use crate::escape::EscapeSpan;

/// A recognized message-bearing plugin/script command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecognizedCommand {
    /// The recognized command keyword (surface provenance), e.g. `"D_TEXT"`.
    pub command: &'static str,
    /// Preserve-exact structural spans over the non-translatable tokens of
    /// the FULL `parameters[0]` literal (keyword prefix, trailing size, …).
    /// Byte offsets are relative to the literal passed to the recognizer.
    pub control_spans: Vec<EscapeSpan>,
}

/// Try to recognize a Plugin Command (356/357) `parameters[0]` string as
/// message-bearing. Returns `None` for control commands — which then stay
/// structured findings — and for any command no recognizer claims.
pub fn recognize_plugin_command(param0: &str) -> Option<RecognizedCommand> {
    // MV's `Game_Interpreter.command356` splits `parameters[0]` on single
    // spaces and shifts the first token as the command name.
    let command = param0.split(' ').next()?;
    match command {
        "D_TEXT" => recognize_d_text(param0),
        _ => None,
    }
}

/// Mirror DTextPicture's `isNaN`-based trailing-size test: a token is the
/// numeric font size when it parses as a number.
fn is_numeric_size(token: &str) -> bool {
    !token.is_empty() && token.parse::<f64>().is_ok()
}

/// Recognize a `D_TEXT <display text> [fontSize]` plugin command
/// (triacontane's DTextPicture).
///
/// Mirrors the plugin's own argument parsing: the command splits
/// `parameters[0]` on single spaces; the trailing token is consumed as the
/// font size only when it is numeric AND at least one text token precedes it
/// (`if (isNaN(args[last]) || args.length === 1) args.push(default);
/// fontSize = args.pop();`), otherwise the whole remainder is display text.
/// The returned spans protect the `D_TEXT ` keyword prefix and the
/// ` <size>` suffix so only the display-text region is translatable.
fn recognize_d_text(param0: &str) -> Option<RecognizedCommand> {
    let tokens: Vec<&str> = param0.split(' ').collect();
    // tokens[0] == "D_TEXT"; need at least one argument to display text.
    if tokens.len() < 2 {
        return None;
    }

    // Byte offset of the start of each `split(' ')` token. Single-space
    // separators make this reconstruction exact and equal to `param0`.
    let mut offsets = Vec::with_capacity(tokens.len());
    let mut pos = 0usize;
    for (index, token) in tokens.iter().enumerate() {
        offsets.push(pos);
        pos += token.len();
        if index + 1 < tokens.len() {
            pos += 1; // the single ' ' separator
        }
    }

    let arg_count = tokens.len() - 1;
    // Strip a trailing numeric token as the font size only when there are
    // >= 2 args (a lone arg is always display text in DTextPicture).
    let trailing_is_size = arg_count >= 2 && is_numeric_size(tokens[tokens.len() - 1]);
    let last_text_index = if trailing_is_size {
        tokens.len() - 2
    } else {
        tokens.len() - 1
    };

    // Display-text region [text_start, text_end) inside `param0`.
    let text_start = offsets[1];
    let text_end = offsets[last_text_index] + tokens[last_text_index].len();
    if text_end <= text_start {
        // Nothing translatable remains (e.g. `"D_TEXT 32"`): keep as finding.
        return None;
    }

    let mut control_spans = Vec::new();
    // Keyword prefix: `D_TEXT ` (keyword + separator run up to the text).
    control_spans.push(EscapeSpan {
        start_byte: 0,
        end_byte: text_start,
        raw: param0[..text_start].to_string(),
        parsed_name: "rpgmaker.plugin.D_TEXT.command".to_string(),
        argument: None,
    });
    // Trailing size suffix: ` <size>` (separator + numeric font-size token).
    if trailing_is_size {
        control_spans.push(EscapeSpan {
            start_byte: text_end,
            end_byte: param0.len(),
            raw: param0[text_end..].to_string(),
            parsed_name: "rpgmaker.plugin.D_TEXT.font_size".to_string(),
            argument: Some(tokens[tokens.len() - 1].to_string()),
        });
    }

    Some(RecognizedCommand {
        command: "D_TEXT",
        control_spans,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `D_TEXT <text> <size>`: the keyword prefix and trailing size are
    /// protected; the middle token is the translatable region.
    #[test]
    fn d_text_with_trailing_size_protects_keyword_and_size() {
        // Synthetic (non-retail) command string.
        let param0 = "D_TEXT Hello 32";
        let rec = recognize_plugin_command(param0).expect("D_TEXT is recognized");
        assert_eq!(rec.command, "D_TEXT");
        assert_eq!(rec.control_spans.len(), 2);

        let prefix = &rec.control_spans[0];
        assert_eq!(prefix.raw, "D_TEXT ");
        assert_eq!(&param0[prefix.start_byte..prefix.end_byte], "D_TEXT ");

        let suffix = &rec.control_spans[1];
        assert_eq!(suffix.raw, " 32");
        assert_eq!(&param0[suffix.start_byte..suffix.end_byte], " 32");
        assert_eq!(suffix.argument.as_deref(), Some("32"));

        // The unprotected (translatable) region is exactly the display text.
        assert_eq!(&param0[prefix.end_byte..suffix.start_byte], "Hello");
    }

    /// Multi-word display text with a trailing size: the whole middle run
    /// stays translatable, only the trailing size is stripped.
    #[test]
    fn d_text_multiword_text_keeps_internal_spaces() {
        let param0 = "D_TEXT one two three 28";
        let rec = recognize_plugin_command(param0).unwrap();
        assert_eq!(rec.control_spans.len(), 2);
        let (prefix, suffix) = (&rec.control_spans[0], &rec.control_spans[1]);
        assert_eq!(&param0[prefix.end_byte..suffix.start_byte], "one two three");
        assert_eq!(suffix.raw, " 28");
    }

    /// No trailing numeric token: the whole remainder is display text and
    /// only the keyword prefix is protected.
    #[test]
    fn d_text_without_trailing_size_protects_only_keyword() {
        let param0 = "D_TEXT plain words";
        let rec = recognize_plugin_command(param0).unwrap();
        assert_eq!(rec.control_spans.len(), 1);
        assert_eq!(rec.control_spans[0].raw, "D_TEXT ");
        assert_eq!(
            &param0[rec.control_spans[0].end_byte..],
            "plain words",
            "the full remainder is translatable when no size trails"
        );
    }

    /// A single non-numeric argument is display text (no size to strip).
    #[test]
    fn d_text_single_arg_is_display_text() {
        let rec = recognize_plugin_command("D_TEXT word").unwrap();
        assert_eq!(rec.control_spans.len(), 1);
        assert_eq!(rec.control_spans[0].raw, "D_TEXT ");
    }

    /// A single numeric argument: DTextPicture treats it as display text
    /// (a lone arg is never stripped), so it is still recognized.
    #[test]
    fn d_text_single_numeric_arg_is_display_text() {
        let rec = recognize_plugin_command("D_TEXT 100").unwrap();
        // No trailing size stripped (arg_count == 1).
        assert_eq!(rec.control_spans.len(), 1);
        assert_eq!(rec.control_spans[0].raw, "D_TEXT ");
    }

    /// `D_TEXT` with no argument has nothing to display: not recognized.
    #[test]
    fn bare_d_text_keyword_is_not_recognized() {
        assert!(recognize_plugin_command("D_TEXT").is_none());
    }

    /// Control plugin commands present in the corpus are NOT recognized and
    /// stay findings (no engine control mis-extracted as dialogue).
    #[test]
    fn control_commands_are_not_recognized() {
        for control in [
            "D_TEXT_SETTING ALIGN CENTER",
            "P_SHAKE 1 2 3",
            "P_STOP_SHAKE",
            "Achievement 5",
            "実績 3",
            "C_SET_TIME 12 0",
            "SSC_CHANGE_SYSTEM_SE 1 Cursor",
            "MP_SET_MOVIE intro",
            "CommonSave 1",
            "Difficulty 2",
        ] {
            assert!(
                recognize_plugin_command(control).is_none(),
                "control command {control:?} must stay a finding"
            );
        }
    }
}
