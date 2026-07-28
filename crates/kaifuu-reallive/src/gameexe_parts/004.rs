fn classify_key_late(
    bare: &str,
    key: &str,
    value: &str,
) -> (GameexeKeyFamily, GameexeKeyTreatment) {
    if let Some(rest) = bare.strip_prefix("KOEONOFF.") {
        // Shape: `NNN.(MMM[,…]).ON`
        return (parse_koeonoff(rest), GameexeKeyTreatment::BridgeUnit);
    }
    if let Some(rest) = bare.strip_prefix("KOEREPLAYICON.") {
        return (
            GameexeKeyFamily::KoeReplayIcon {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "KOEREPLAYICON" {
        return (
            GameexeKeyFamily::KoeReplayIcon {
                field: String::new(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare.starts_with("KOEONOFF_") || bare == "KOEFILE_MOD" || bare == "KOEWAIT_TIME" {
        return (
            GameexeKeyFamily::KoeConfig {
                field: bare.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SHAKEZOOM.") {
        return (
            GameexeKeyFamily::ShakeZoom {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SHAKE.") {
        return (
            GameexeKeyFamily::Shake {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("HINT.") {
        let (kind, rest_after) = split_first_dot(rest);
        return (
            GameexeKeyFamily::Hint {
                kind,
                rest: rest_after,
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("COLOR_TABLE.") {
        return (
            GameexeKeyFamily::ColorTable {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MASK.") {
        return (
            GameexeKeyFamily::Mask {
                index: rest.to_string(),
            },
            GameexeKeyTreatment::AssetReference,
        );
    }
    if let Some(rest) = bare.strip_prefix("CGTABLE_") {
        return (
            GameexeKeyFamily::CgTable {
                field: rest.to_string(),
            },
            // CGTABLE_FILENAME is an asset path; CGTABLE_MOD is config.
            if rest == "FILENAME" {
                GameexeKeyTreatment::AssetReference
            } else {
                GameexeKeyTreatment::Config
            },
        );
    }
    if let Some(rest) = bare.strip_prefix("CDDA_") {
        return (
            GameexeKeyFamily::CddaSetup {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("HAIKEICHR_") {
        return (
            GameexeKeyFamily::HaikeiChr {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("KEYWAIT_") {
        return (
            GameexeKeyFamily::KeyWait {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("MESSAGE_KEY_WAIT_") {
        return (
            GameexeKeyFamily::MessageKeyWait {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("FONT_") {
        return (
            GameexeKeyFamily::FontConfig {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("RETURN_CURSOR_") {
        return (
            GameexeKeyFamily::Cursor {
                field: format!("RETURN_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("CURSOR.") {
        return (
            GameexeKeyFamily::Cursor {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "CURSOR" {
        return (
            GameexeKeyFamily::Cursor {
                field: String::new(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "QUARTERVIEW_SIZE" {
        return (
            GameexeKeyFamily::QuarterViewSize,
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SAVE_") {
        let treatment = match rest {
            "TITLE" | "NODATA" => GameexeKeyTreatment::BridgeUnit,
            _ => GameexeKeyTreatment::Config,
        };
        let family = if rest == "NODATA" {
            GameexeKeyFamily::SaveNoData
        } else {
            GameexeKeyFamily::Save {
                field: format!("_{rest}"),
            }
        };
        return (family, treatment);
    }
    if let Some(rest) = bare.strip_prefix("SAVEPOINT_") {
        return (
            GameexeKeyFamily::Save {
                field: format!("POINT_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "QUICK_SAVEDATA_USE" {
        return (
            GameexeKeyFamily::Save {
                field: "QUICK_USE".to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("SAVEMESSAGE_") {
        let treatment = if rest.ends_with("_STR") {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("SAVE_{rest}"),
            },
            treatment,
        );
    }
    if let Some(rest) = bare.strip_prefix("LOADMESSAGE_") {
        let treatment = if rest.ends_with("_STR") {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("LOAD_{rest}"),
            },
            treatment,
        );
    }
    if let Some(rest) = bare.strip_prefix("DLGSAVEMESSAGE_") {
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("DLGSAVE_{rest}"),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if let Some(rest) = bare.strip_prefix("DLGLOADMESSAGE_") {
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("DLGLOAD_{rest}"),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if bare == "SYSTEM_SAVELOADMESSAGE_STR" {
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: "SYSTEM_STR".to_string(),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if let Some(rest) = bare.strip_prefix("SAVELOADDLG_") {
        return (
            GameexeKeyFamily::SaveLoadMessage {
                field: format!("DLG_{rest}"),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("DEBUG_") {
        return (
            GameexeKeyFamily::Debug,
            // `DEBUG_WINDOW_CAPTION` is a window-title string. Treat
            // remaining DEBUG_* as config.
            match rest {
                "WINDOW_CAPTION" => GameexeKeyTreatment::BridgeUnit,
                _ => GameexeKeyTreatment::Config,
            },
        );
    }
    if let Some(rest) = bare.strip_prefix("SYSTEMCALL_") {
        return (
            GameexeKeyFamily::SystemCall {
                payload: rest.to_string(),
            },
            // The `_MOD` and `_<NAME>` variants are both scene-call dispatch
            // tuples / mode flags; all config.
            GameexeKeyTreatment::Config,
        );
    }
    if let Some(rest) = bare.strip_prefix("LOADCALL")
        && (rest.is_empty() || rest == "_MOD")
    {
        return (GameexeKeyFamily::LoadCall, GameexeKeyTreatment::Config);
    }
    if let Some(rest) = bare.strip_prefix("CANCELCALL")
        && (rest.is_empty() || rest == "_MOD")
    {
        return (GameexeKeyFamily::CancelCall, GameexeKeyTreatment::Config);
    }
    if let Some(rest) = bare.strip_prefix("EXAFTERCALL")
        && (rest.is_empty() || rest == "_MOD")
    {
        return (GameexeKeyFamily::ExAfterCall, GameexeKeyTreatment::Config);
    }
    if bare == "SEEN_START" || bare == "SEEN_MENU" || bare == "SEEN_TEXT_CURENT" {
        return (GameexeKeyFamily::SeenEntry, GameexeKeyTreatment::Config);
    }
    if bare.starts_with("SEEN") {
        return (
            GameexeKeyFamily::SeenAsset,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "NAMAE" {
        return (GameexeKeyFamily::Namae, GameexeKeyTreatment::BridgeUnit);
    }
    if let Some(rest) = bare.strip_prefix("NAME") {
        // `#NAME.A`, `#NAME_MAXLEN`.
        let treatment = if rest.starts_with('.') {
            GameexeKeyTreatment::BridgeUnit
        } else {
            GameexeKeyTreatment::Config
        };
        return (
            GameexeKeyFamily::Name {
                field: rest.to_string(),
            },
            treatment,
        );
    }
    if let Some(rest) = bare.strip_prefix("LOCALNAME.") {
        return (
            GameexeKeyFamily::LocalName {
                slot: rest.to_string(),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if let Some(rest) = bare.strip_prefix("READJUMP_") {
        return (
            GameexeKeyFamily::ReadJump {
                field: rest.to_string(),
            },
            GameexeKeyTreatment::Config,
        );
    }
    if bare == "UNREADJUMP_STR" {
        return (
            GameexeKeyFamily::ReadJump {
                field: "UNREAD_STR".to_string(),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    // Single-string UI messages.
    if matches!(
        bare,
        "GAME_END_MESS_STR" | "MENU_RETURN_MESS_STR" | "SYSTEM_ANIME_STR"
    ) {
        return (
            GameexeKeyFamily::UiMessageStr {
                key: bare.to_string(),
            },
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if bare == "CAPTION" {
        return (GameexeKeyFamily::Caption, GameexeKeyTreatment::BridgeUnit);
    }
    if bare == "SUBTITLE" {
        return (GameexeKeyFamily::Subtitle, GameexeKeyTreatment::Config);
    }
    if bare == "REGNAME" {
        return (
            GameexeKeyFamily::RegName,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "DISKMARK" {
        return (
            GameexeKeyFamily::DiskMark,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "VERSION_STR" {
        return (
            GameexeKeyFamily::VersionStr,
            GameexeKeyTreatment::BridgeUnit,
        );
    }
    if bare == "SCREENSIZE_MOD" {
        return (GameexeKeyFamily::ScreenSizeMod, GameexeKeyTreatment::Config);
    }
    if matches!(
        bare,
        "MMX_ENABLE"
            | "D3D_ENABLE"
            | "MEMORY"
            | "DEMONSTRATION"
            | "X_Z_KEY_MOD"
            | "ALT_ENTER_USE"
            | "CTRL_USE"
            | "GRAPHIC_DISP_MODE"
            | "WAIP_WINDOWCLOSE"
            | "GRPCOM_WINDOWCLOSE"
            | "ANIME_HISPEED_MODE"
            | "MANUAL_PATH"
            | "MASK"
    ) {
        return (
            GameexeKeyFamily::EngineBootstrap,
            GameexeKeyTreatment::Config,
        );
    }
    // Pre- minimal-subset asset prefixes (kept as family
    // members so the catalogue stays exhaustive for the keys those
    // titles use).
    if bare.starts_with("G00") {
        // `#G00BUF=8` and similar numeric knobs are image-buffer
        // counts/config, not asset paths. Only reserve AssetReference
        // never be emitted as a literal asset-path reference.
        let treatment = if is_numeric_config_value(value) {
            GameexeKeyTreatment::Config
        } else {
            GameexeKeyTreatment::AssetReference
        };
        return (GameexeKeyFamily::G00Family, treatment);
    }
    if bare.starts_with("KOE") {
        return (
            GameexeKeyFamily::KoePack,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare.starts_with("NWK") || bare.starts_with("OVK") {
        return (
            GameexeKeyFamily::NwkOvk,
            GameexeKeyTreatment::AssetReference,
        );
    }
    if bare == "GAMEEXE_VERSION" {
        return (
            GameexeKeyFamily::GameexeVersion,
            GameexeKeyTreatment::Config,
        );
    }

    (
        GameexeKeyFamily::Unknown {
            raw_key: key.to_string(),
            reason: UnknownReason::UnknownFamily,
        },
        GameexeKeyTreatment::Unknown,
    )
}
fn split_first_dot(rest: &str) -> (String, String) {
    match rest.find('.') {
        Some(idx) => (rest[..idx].to_string(), rest[idx + 1..].to_string()),
        None => (rest.to_string(), String::new()),
    }
}

fn parse_koeonoff(rest: &str) -> GameexeKeyFamily {
    // Shape: `NNN.(MMM[,…]).ON` (`.ON` may be `.OFF`; we ignore the
    // trailing field, just capture index and bracketed speakers).
    let (index, after_index) = split_first_dot(rest);
    // `after_index` may start with `(...)`.
    let mut speakers = String::new();
    if let Some(open) = after_index.find('(')
        && let Some(close) = after_index[open + 1..].find(')')
    {
        speakers = after_index[open + 1..open + 1 + close].to_string();
    }
    GameexeKeyFamily::KoeOnOff { index, speakers }
}


