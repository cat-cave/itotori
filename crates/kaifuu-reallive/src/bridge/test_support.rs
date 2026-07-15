use super::*;

pub(super) fn sjis(text: &str) -> Vec<u8> {
    encoding_rs::SHIFT_JIS.encode(text).0.into_owned()
}

/// One Shift-JIS dialogue Textout body bounded by a MetaLine.
pub(super) fn dialogue_bytecode(body: &str) -> Vec<u8> {
    let mut bytecode = sjis(body);
    bytecode.extend_from_slice(&[0x0a, 0x05, 0x00]);
    bytecode
}

pub(super) fn opts_for_test() -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: "synthetic-bridge-test",
        game_version: "test",
        source_profile_id: "kaifuu-reallive-synthetic-bridge-test",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: 0,
    }
}
