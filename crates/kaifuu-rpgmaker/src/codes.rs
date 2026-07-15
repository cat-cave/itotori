//! RPG Maker MV/MZ event-command-code classification.
//! Every code that can appear in a top-level event `list` entry
//! (`events.pages.list`, `CommonEvents.list`,
//! `Troops.pages.list`) is classified into one of the [`CodeClass`]
//! variants. The classification is the backbone of the 100% /
//! no-silent-skip contract:
//! - [`CodeClass::Text`] codes carry translatable strings and are
//!   extracted into bridge units.
//! - [`CodeClass::Structural`] codes are recognised, carry no translatable
//!   text, and are skipped *without* a finding (they are known, not
//!   unknown).
//! - [`CodeClass::Script`] / [`CodeClass::Plugin`] codes can carry display
//!   text via project-specific plugins (e.g. a `D_TEXT` plugin command).
//!   The adapter has no plugin registry, so it neither drops them
//!   silently nor blindly extracts engine commands like `window.close`
//!   — it records a STRUCTURED FINDING so a human can review the surface.
//! - [`CodeClass::ControlVariable`] (code 122) is text-bearing only when
//!   its operand selects a script string; the walker resolves that at the
//!   call site and emits a finding for the script case.
//! - Any code not in this table is [`CodeClass::Unknown`] → structured
//!   finding.
//!   The code numbers are public RPG Maker MV/MZ engine constants
//!   (documented across the community wikis); no game-specific bytes inform
//!   this table.

/// The translatable role a [`CodeClass::Text`] code plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextRole {
    /// `Show Text` body line (code 401).
    DialogueLine,
    /// `Show Scrolling Text` body line (code 405).
    ScrollingLine,
    /// `Show Choices` option array (code 102).
    ChoiceList,
    /// `Change Name` literal (code 320).
    ChangeName,
    /// `Change Nickname` literal (code 324).
    ChangeNickname,
    /// `Change Profile` literal (code 325).
    ChangeProfile,
}

/// Classification of one event-command code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeClass {
    /// Carries translatable text with the given role.
    Text(TextRole),
    /// `Show Text` setup (code 101): face/position/(MZ speaker) context.
    ShowTextSetup,
    /// Recognised, carries no translatable text — skip silently.
    Structural,
    /// `Script` (355) / script continuation (655): possible text → finding.
    Script,
    /// `Plugin Command` (356 MV / 357 MZ): possible text → finding.
    Plugin,
    /// `Control Variables` (122): text only for a script-string operand.
    ControlVariable,
    /// Unrecognised code → structured finding.
    Unknown,
}

/// Classify a top-level event-command `code`.
pub fn classify(code: i64) -> CodeClass {
    match code {
        401 => CodeClass::Text(TextRole::DialogueLine),
        405 => CodeClass::Text(TextRole::ScrollingLine),
        102 => CodeClass::Text(TextRole::ChoiceList),
        320 => CodeClass::Text(TextRole::ChangeName),
        324 => CodeClass::Text(TextRole::ChangeNickname),
        325 => CodeClass::Text(TextRole::ChangeProfile),

        101 => CodeClass::ShowTextSetup,
        122 => CodeClass::ControlVariable,
        355 | 655 => CodeClass::Script,
        356 | 357 => CodeClass::Plugin,

        0       // end of list
        | 103   // Input Number
        | 104   // Select Item
        | 105   // Show Scrolling Text setup (speed/noFast; lines are 405)
        | 108 | 408 // Comment + comment continuation (developer-facing)
        | 402 | 403 | 404 // When [choice] / When Cancel / Choices End
        | 111 | 411 | 412 | 413 // Conditional Branch / Else / Branch End / Repeat
        | 112 | 113 | 115 // Loop / Break Loop / Exit Event Processing
        | 117 | 118 | 119 // Common Event / Label / Jump to Label
        | 121 | 123 | 124 // Control Switches / Self Switch / Timer
        | 125 | 126 | 127 | 128 | 129 // Gold / Items / Weapons / Armors / Party
        | 132 | 133 | 134 | 135 | 136 | 137 | 138 | 139 | 140 // misc settings
        | 201 | 202 | 203 | 204 | 205 | 206 // movement / transfer
        | 211 | 212 | 213 | 214 | 216 | 217 // char effects
        | 221 | 222 | 223 | 224 | 225 // screen effects
        | 230 | 231 | 232 | 233 | 234 | 235 | 236 // wait / pictures / weather
        | 241 | 242 | 243 | 244 | 245 | 246 | 249 | 250 | 251 // audio
        | 261 | 264 // movie / wait for movie
        | 281 | 282 | 283 | 284 | 285 // map display / tileset / parallax
        | 301 | 302 | 303 // battle / shop / name input processing
        | 311 | 312 | 313 | 314 | 315 | 316 | 317 | 318 | 319 // actor changes
        | 321 | 322 | 323 // class / actor image / vehicle image
        | 331 | 332 | 333 | 334 | 335 | 336 | 337 | 339 | 340 | 342 // battle
        | 351 | 352 | 353 | 354 // menu / save / game over / title
        | 505 // Set Move Route step wrapper
        | 601 | 602 | 603 | 604 // If Win / Escape / Lose / Battle End
        => CodeClass::Structural,

        _ => CodeClass::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_codes_classify_as_expected() {
        assert_eq!(classify(401), CodeClass::Text(TextRole::DialogueLine));
        assert_eq!(classify(102), CodeClass::Text(TextRole::ChoiceList));
        assert_eq!(classify(405), CodeClass::Text(TextRole::ScrollingLine));
        assert_eq!(classify(101), CodeClass::ShowTextSetup);
        assert_eq!(classify(356), CodeClass::Plugin);
        assert_eq!(classify(355), CodeClass::Script);
        assert_eq!(classify(122), CodeClass::ControlVariable);
        assert_eq!(classify(0), CodeClass::Structural);
        assert_eq!(classify(412), CodeClass::Structural);
        assert_eq!(classify(505), CodeClass::Structural);
    }

    #[test]
    fn unrecognised_code_is_unknown() {
        assert_eq!(classify(999), CodeClass::Unknown);
        assert_eq!(classify(70), CodeClass::Unknown);
    }
}
