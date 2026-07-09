//! Emit the canonical set of Unicode codepoints accepted by the RealLive
//! patchback Shift-JIS encoder.
//!
//! This is intentionally an example binary rather than a production bridge: the
//! TypeScript patchback-safety path remains dependency-free at runtime, while
//! tests can audit its WHATWG decode-derived keep-set against the exact Rust
//! encoder used by patchback (`kaifuu_reallive::encode_shift_jis_slot`).

use std::io::{self, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let codepoints = build_shift_jis_encodable_codepoints();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &codepoints)?;
    writeln!(out)?;
    Ok(())
}

fn build_shift_jis_encodable_codepoints() -> Vec<u32> {
    let mut codepoints = Vec::new();
    for cp in 0..=0x10_ffff {
        let Some(ch) = char::from_u32(cp) else {
            continue;
        };
        let mut utf8 = [0; 4];
        let text = ch.encode_utf8(&mut utf8);
        if kaifuu_reallive::encode_shift_jis_slot(text).is_ok() {
            codepoints.push(cp);
        }
    }
    codepoints
}
