use super::{GameexeKeyFamily, GameexeKeyTreatment, UnknownReason};

/// Return `true` when a trimmed Gameexe.ini RHS is a purely numeric
/// config value (a single integer like `8`, or a numeric tuple like
/// `1,2,3`) rather than an asset path or pack declaration. Used to keep
/// numeric `#G00*` knobs (`#G00BUF=8`) classified as
/// [`GameexeKeyTreatment::Config`] instead of an asset reference.
pub(super) fn is_numeric_config_value(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let mut saw_digit = false;
    for part in trimmed.split(',') {
        let part = part.trim();
        // Each comma-separated component must be a signed integer.
        match part.strip_prefix(['-', '+']).unwrap_or(part) {
            "" => return false,
            digits if digits.bytes().all(|b| b.is_ascii_digit()) => {
                saw_digit = true;
            }
            _ => return false,
        }
    }
    saw_digit
}

/// Classify a single upper-cased Gameexe.ini key into its
/// [`GameexeKeyFamily`] and high-level [`GameexeKeyTreatment`] bucket.
/// The key includes the leading `#`. Suffixes are passed by reference to
/// the `helpers` module so the per-family enum payload captures the
/// per-key suffix data without re-allocating the raw key string.
pub(super) fn classify_key(key: &str, value: &str) -> (GameexeKeyFamily, GameexeKeyTreatment) {
    // Reject structurally malformed keys early.
    if key.len() <= 1 || !key.starts_with('#') {
        return (
            GameexeKeyFamily::Unknown {
                raw_key: key.to_string(),
                reason: UnknownReason::MalformedKey,
            },
            GameexeKeyTreatment::Unknown,
        );
    }
    let bare = &key[1..];
    if bare.is_empty() || bare.starts_with('.') || bare.starts_with('=') {
        return (
            GameexeKeyFamily::Unknown {
                raw_key: key.to_string(),
                reason: UnknownReason::MalformedKey,
            },
            GameexeKeyTreatment::Unknown,
        );
    }

    if let Some(rest) = bare.strip_prefix("FOLDNAME.") {
        return (
            GameexeKeyFamily::FolderName {
                kind: rest.to_string(),
            },
            GameexeKeyTreatment::AssetReference,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSEACTIONCALL.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::MouseActionCall { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("WBCALL.") {
        return (
            GameexeKeyFamily::WbCall {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("WAKU.") {
        // Two shapes: `WAKU.NNN.FIELD` and `WAKU.NNN.MMM.FIELD`.
        let segments: Vec<&str> = rest.splitn(3, '.').collect();
        return match segments.as_slice() {
            [theme, field] => (
                GameexeKeyFamily::Waku {
                    theme: (*theme).to_string(),
                    variant: None,
                    field: (*field).to_string(),
                },
                GameexeKeyTreatment::Config,
            ),
            [theme, variant, field] => (
                GameexeKeyFamily::Waku {
                    theme: (*theme).to_string(),
                    variant: Some((*variant).to_string()),
                    field: (*field).to_string(),
                },
                GameexeKeyTreatment::Config,
            ),
            _ => (
                GameexeKeyFamily::Waku {
                    theme: rest.to_string(),
                    variant: None,
                    field: String::new(),
                },
                GameexeKeyTreatment::Config,
            ),
        };
    }
    if let Some(rest) = bare.strip_prefix("WINDOW.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::Window { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("WINDOW_") {
        return (
            GameexeKeyFamily::WindowConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MSGBK_WINDOW.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::MessageBackWindow { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MSGBK_") {
        return (
            GameexeKeyFamily::MessageBackConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("FULLSCREEN_MSGBK.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::FullScreenMessageBack { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("FULLSCREEN_MSGBK_") {
        return (
            GameexeKeyFamily::FullScreenMessageBackConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "FULLSCREEN_MSGBK" {
        return (
            GameexeKeyFamily::FullScreenMessageBackConfig {
                field: String::new(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSCOM.") {
        return (
            GameexeKeyFamily::Syscom {
                index: rest.to_string(),
            },
            // The SYSCOM RHS is a translatable `U:"…"` label; treat
            // SYSCOM lines as bridge-units. The protected `U:` prefix is
            // carried through in `value`.
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSCOM_") {
        return (
            GameexeKeyFamily::SyscomConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SELBTN.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::SelBtn { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SEL.") {
        return (
            GameexeKeyFamily::Sel {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SELPOINT_") {
        // e.g. `#SELPOINT_RETURN_MESS_STR` — translatable.
        let treatment = if rest.ends_with("_STR") {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::SelConfig {
                field: format!("POINT_{rest}"),
            },
            treatment,
        );
    }
    if bare == "DEFAULT_SEL_WINDOW" {
        return (
            GameexeKeyFamily::SelConfig {
                field: "DEFAULT_SEL_WINDOW".to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SEL_") {
        return (
            GameexeKeyFamily::SelConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("BTNOBJ.") {
        let (kind, rest_after) = split_first_dot(rest);
        return (
            GameexeKeyFamily::BtnObj {
                kind,
                rest: rest_after,
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSBTN.") {
        let (index, field) = split_first_dot(rest);
        return (
            GameexeKeyFamily::SysBtn { index, field },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSBTN_") {
        // `#SYSBTN_HIDE_STR` is translatable, others are config.
        let treatment = if rest.ends_with("_STR") {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::SysBtnConfig {
                field: rest.to_string(),
            },
            treatment,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSE_CURSOR_WINDOWBUTTON_") {
        return (
            GameexeKeyFamily::MouseCursorRegion {
                field: format!("WINDOWBUTTON_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSE_CURSOR_MESSAGEBACK_") {
        return (
            GameexeKeyFamily::MouseCursorRegion {
                field: format!("MESSAGEBACK_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "MOUSE_CURSOR_RESET" {
        return (
            GameexeKeyFamily::MouseCursorRegion {
                field: "RESET".to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSE_CURSOR.") {
        return (
            GameexeKeyFamily::MouseCursor {
                rest: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "MOUSE_CURSOR" {
        return (
            GameexeKeyFamily::MouseCursor {
                rest: String::new(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MOUSE_") {
        return (
            GameexeKeyFamily::MouseConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("OBJECT.") {
        return (
            GameexeKeyFamily::Object {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "OBJECT_MAX" {
        return (GameexeKeyFamily::ObjectMax, GameexeKeyTreatment::Config);
    }
    if let Some(rest) = bare.strip_prefix("OBJDISP.") {
        return (
            GameexeKeyFamily::ObjDisp {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("INIT_") {
        return (
            GameexeKeyFamily::Init {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("BGM_") {
        return (
            GameexeKeyFamily::BgmConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SE.") {
        return (
            GameexeKeyFamily::SoundEffect {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "SOUND_DEFAULT" {
        return (GameexeKeyFamily::SoundDefault, GameexeKeyTreatment::Config);
    }
    if bare == "DSTRACK" {
        return (
            GameexeKeyFamily::DsTrack,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if let Some(rest) = bare.strip_prefix("PCM_VOLMOD.") {
        return (
            GameexeKeyFamily::PcmVolMod {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SERIALPDT.") {
        return (
            GameexeKeyFamily::SerialPdt {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("DLL.") {
        // `#DLL.NNN = "rlBabel"` — RealLive extension-DLL slot binding.
        // The RHS names an engine extension module resolved by the VM;
        // it is engine configuration, not translatable text or an asset.
        return (
            GameexeKeyFamily::Dll {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    tail::classify_tail(key, value)
}

fn split_first_dot(rest: &str) -> (String, String) {
    match rest.find('.') {
        Some(idx) => (rest[..idx].to_string(), rest[idx + 1..].to_string()),
        None => (rest.to_string(), String::new()),
    }
}

mod tail;
