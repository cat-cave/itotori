//! Typed recognizers for message-bearing and opaque plugin (356/357) and
//! script (355/655) commands.
//!
//! MV/MZ's event command payloads do not carry a plugin registry. A blind
//! extraction of `parameters[0]` would therefore turn engine control
//! (`window.close()`, screen shake, sound-effect filenames, and numeric ids)
//! into dialogue. This module has two deliberately closed paths instead:
//! `D_TEXT` is a message-bearing command whose display-text argument is
//! extracted, while every observed control command is named in the exact
//! opaque tables below. A command outside those tables remains an explicit
//! unknown finding and is a test failure for the real-byte recognizer lane.
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
//! # Real-byte evidence
//!
//! LustMemory contributes 328 plugin-command entries and 22 script entries;
//! Countryside Life contributes 1,684 plugin-command entries and 4 script
//! entries. Only `D_TEXT` carries display text (two occurrences in
//! LustMemory). The other observed plugin commands have documented control
//! semantics, and every observed script is a state/window operation with no
//! string literal. The closed tables below are the resulting semantic
//! census; they are intentionally not a catch-all for future plugins.

use crate::escape::EscapeSpan;

/// One intentionally opaque command family observed in the real MV/MZ
/// titles. Opaque means that the command's documented arguments are ids,
/// flags, timing, asset names, or state operations rather than player-facing
/// text. The reason is part of the allowlist so an opaque classification is
/// reviewable instead of becoming an untyped skip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpaqueCommandSpec {
    /// MV command token, or the exact script expression for script entries.
    pub name: &'static str,
    /// One-line semantic reason no translatable unit is emitted.
    pub reason: &'static str,
}

/// Exact opaque MV/MZ plugin-command set established from the two real title
/// censuses. Matching is by the first ASCII-space-delimited MV command token,
/// except for the recorded full-width-space literal, which is its own exact
/// token under MV's documented `split(" ")` parser.
pub const OPAQUE_PLUGIN_COMMANDS: &[OpaqueCommandSpec] = &[
    OpaqueCommandSpec {
        name: "Achievement",
        reason: "achievement id selector; the argument is not display text",
    },
    OpaqueCommandSpec {
        name: "Achievment",
        reason: "misspelled achievement id command; the argument is not display text",
    },
    OpaqueCommandSpec {
        name: "実績",
        reason: "achievement id selector; the argument is not display text",
    },
    OpaqueCommandSpec {
        name: "C_ADD_DAY",
        reason: "Chronus advances calendar time by a numeric day count",
    },
    OpaqueCommandSpec {
        name: "C_ADD_TIME",
        reason: "Chronus advances clock time by a numeric minute count",
    },
    OpaqueCommandSpec {
        name: "C_ADD_TIME　30",
        reason: "full-width separator leaves a non-text command token under MV parsing",
    },
    OpaqueCommandSpec {
        name: "C_DISABLE_TINT",
        reason: "Chronus toggles time-of-day tinting; it has no text argument",
    },
    OpaqueCommandSpec {
        name: "C_DISABLE_WEATHER",
        reason: "Chronus toggles weather progression; it has no text argument",
    },
    OpaqueCommandSpec {
        name: "C_HIDE",
        reason: "Chronus hides the calendar UI; it has no text argument",
    },
    OpaqueCommandSpec {
        name: "C_SET_DAY",
        reason: "Chronus sets a numeric year/month/day tuple",
    },
    OpaqueCommandSpec {
        name: "C_SET_TIME",
        reason: "Chronus sets a numeric hour/minute tuple",
    },
    OpaqueCommandSpec {
        name: "C_SET_TIME_REAL",
        reason: "Chronus selects real-time clock sourcing; it has no text argument",
    },
    OpaqueCommandSpec {
        name: "C_SHOW",
        reason: "Chronus shows the calendar UI; it has no text argument",
    },
    OpaqueCommandSpec {
        name: "C_START",
        reason: "Chronus starts time progression; it has no text argument",
    },
    OpaqueCommandSpec {
        name: "C_STOP",
        reason: "Chronus stops time progression; it has no text argument",
    },
    OpaqueCommandSpec {
        name: "CommonSave",
        reason: "common-save operation selector; arguments choose persistence state",
    },
    OpaqueCommandSpec {
        name: "CRD_OPEN_CARDGAME",
        reason: "card-game command opens a configured game scene; no text argument",
    },
    OpaqueCommandSpec {
        name: "CRD_Player",
        reason: "card-game player setup uses configuration values, not display text",
    },
    OpaqueCommandSpec {
        name: "Difficulty",
        reason: "difficulty command selects a numeric difficulty id or direction",
    },
    OpaqueCommandSpec {
        name: "D_TEXT_SETTING",
        reason: "DTextPicture formatting/state command; it does not draw text",
    },
    OpaqueCommandSpec {
        name: "hideHpGauge",
        reason: "map HP-gauge visibility control; its optional argument is a gauge id",
    },
    OpaqueCommandSpec {
        name: "MM_設定_ループ",
        reason: "movie-manager loop flag; the argument is a boolean setting",
    },
    OpaqueCommandSpec {
        name: "MP_SET_LOOP",
        reason: "movie playback loop flag; arguments select a boolean setting",
    },
    OpaqueCommandSpec {
        name: "MP_SET_MOVIE",
        reason: "movie playback command selects an asset id, not display text",
    },
    OpaqueCommandSpec {
        name: "OnlySellShopCall",
        reason: "sell-only shop command takes a numeric sell-rate percentage",
    },
    OpaqueCommandSpec {
        name: "P_SHAKE",
        reason: "screen-shake command takes numeric amplitude/speed/duration values",
    },
    OpaqueCommandSpec {
        name: "P_STOP_SHAKE",
        reason: "screen-shake stop command takes a numeric channel id",
    },
    OpaqueCommandSpec {
        name: "showHpGauge",
        reason: "map HP-gauge visibility control; its optional argument is a gauge id",
    },
    OpaqueCommandSpec {
        name: "SSC_CHANGE_SYSTEM_SE",
        reason: "system sound-effect command selects an id and playback settings",
    },
    OpaqueCommandSpec {
        name: "SSC_RESET_SYSTEM_SE",
        reason: "system sound-effect reset command selects an id",
    },
];

/// Exact opaque script expressions observed in both real title censuses.
/// These expressions mutate engine/plugin state and contain no string
/// literal that could be surfaced as player-facing text.
pub const OPAQUE_SCRIPT_COMMANDS: &[OpaqueCommandSpec] = &[
    OpaqueCommandSpec {
        name: "BattleManager._statusWindow.hide();",
        reason: "engine status-window visibility call contains no string literal",
    },
    OpaqueCommandSpec {
        name: "BattleManager._statusWindow.show();",
        reason: "engine status-window visibility call contains no string literal",
    },
    OpaqueCommandSpec {
        name: "window.close()",
        reason: "engine window close call contains no string literal",
    },
    OpaqueCommandSpec {
        name: "$gameVariables.setValue(21, $gameVariables.value(21).clamp(0, 100))",
        reason: "script clamps a numeric game variable and contains no string literal",
    },
    OpaqueCommandSpec {
        name: "$gameVariables.setValue(22, $gameVariables.value(22).clamp(0, 100))",
        reason: "script clamps a numeric game variable and contains no string literal",
    },
    OpaqueCommandSpec {
        name: "$gameVariables.setValue(23, $gameVariables.value(23).clamp(0, 100))",
        reason: "script clamps a numeric game variable and contains no string literal",
    },
    OpaqueCommandSpec {
        name: "$gameVariables.setValue(24, $gameVariables.value(24).clamp(0, 100))",
        reason: "script clamps a numeric game variable and contains no string literal",
    },
];

/// Result of applying the closed plugin-command recognizer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginCommandRecognition {
    /// A command whose argument contains player-visible text.
    Translatable(RecognizedCommand),
    /// A command in [`OPAQUE_PLUGIN_COMMANDS`].
    Opaque(&'static OpaqueCommandSpec),
    /// A command outside the exact real-byte census.
    Unknown,
}

/// Result of applying the closed script-command recognizer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptCommandRecognition {
    /// A command in [`OPAQUE_SCRIPT_COMMANDS`].
    Opaque(&'static OpaqueCommandSpec),
    /// A script expression outside the exact real-byte census.
    Unknown,
}

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
/// message-bearing. Returns `None` for opaque control commands and for any
/// command no recognizer claims. Call [`classify_plugin_command`] when the
/// caller needs to distinguish those two cases.
pub fn recognize_plugin_command(param0: &str) -> Option<RecognizedCommand> {
    // MV's `Game_Interpreter.command356` splits `parameters[0]` on single
    // spaces and shifts the first token as the command name.
    let command = param0.split(' ').next()?;
    match command {
        "D_TEXT" => recognize_d_text(param0),
        _ => None,
    }
}

/// Classify one MV/MZ plugin-command literal without a generic fallback.
/// `Unknown` is intentionally available so callers and real-byte tests can
/// fail loudly when a new command appears outside the enumerated semantic set.
pub fn classify_plugin_command(param0: &str) -> PluginCommandRecognition {
    if let Some(command) = recognize_plugin_command(param0) {
        return PluginCommandRecognition::Translatable(command);
    }

    let command_name = param0.split(' ').next().unwrap_or_default();
    OPAQUE_PLUGIN_COMMANDS
        .iter()
        .find(|spec| spec.name == command_name)
        .map_or(PluginCommandRecognition::Unknown, |spec| {
            PluginCommandRecognition::Opaque(spec)
        })
}

/// Classify one `Script` (355/655) literal. The real-byte set currently has
/// no script-call text surface; each observed expression is a typed opaque
/// state operation. A future text-bearing script shape must be added as a
/// semantic recognizer rather than admitted by a string-sweep heuristic.
pub fn classify_script_command(param0: &str) -> ScriptCommandRecognition {
    OPAQUE_SCRIPT_COMMANDS
        .iter()
        .find(|spec| spec.name == param0.trim())
        .map_or(ScriptCommandRecognition::Unknown, |spec| {
            ScriptCommandRecognition::Opaque(spec)
        })
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

    #[test]
    fn observed_control_families_are_typed_opaque_and_unknowns_stay_unknown() {
        for control in [
            "Achievement 5",
            "C_ADD_TIME 30",
            "C_ADD_TIME　30",
            "CRD_Player settings 1345",
            "OnlySellShopCall 100",
            "showHpGauge",
        ] {
            assert!(
                matches!(
                    classify_plugin_command(control),
                    PluginCommandRecognition::Opaque(_)
                ),
                "observed control command {control:?} must be typed opaque"
            );
        }
        assert!(matches!(
            classify_plugin_command("NewPlugin maybe text"),
            PluginCommandRecognition::Unknown
        ));
    }

    #[test]
    fn observed_scripts_are_typed_opaque_but_new_script_shapes_are_unknown() {
        for script in [
            "BattleManager._statusWindow.hide();",
            "BattleManager._statusWindow.show();",
            "window.close()",
            "$gameVariables.setValue(21, $gameVariables.value(21).clamp(0, 100))",
        ] {
            assert!(matches!(
                classify_script_command(script),
                ScriptCommandRecognition::Opaque(_)
            ));
        }
        assert!(matches!(
            classify_script_command("showText('new')"),
            ScriptCommandRecognition::Unknown
        ));
    }
}
