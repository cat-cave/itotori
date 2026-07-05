//! UTSUSHI-008 — `trace-kag` subcommand.
//!
//! Drives the [`utsushi_kirikiri`] KAG command-trace probe against a
//! **plaintext / already-extracted** KiriKiri/KAG `.ks` script and writes the
//! deterministic (sorted-key) trace JSON to `--output`. The trace records, per
//! command in trace order: command index, source line, active label, macro id,
//! jump target, branch id, speaker, and observed text; speaker / message /
//! branch-option rows link back to the KAIFUU-009 extraction bridge unit for
//! their source text (`bridgeRef`).
//!
//! ## Honest scope
//!
//! Plaintext only. This command reads a `.ks` file that is already plaintext on
//! disk (an author tree, a fan-distributed script, or the extracted members of
//! an *unencrypted* XP3). It does NOT open, decrypt, or unpack an XP3 archive —
//! commercial encrypted-XP3 titles are a separate capability, entirely out of
//! scope. See [`utsushi_kirikiri::KAG_COMMAND_TRACE_SCOPE`].

use std::path::{Path, PathBuf};

use utsushi_kirikiri::trace_kag_commands;

const USAGE: &str = "usage: utsushi trace-kag <script.ks> --output <path>\n       (plaintext / already-extracted KAG `.ks` only — no packed/encrypted XP3)";

/// Run the `trace-kag` command. `tail` is argv with the leading `trace-kag`
/// slot already removed.
pub fn run_trace_kag_command(tail: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    // Strict flag validation: exactly one positional script path + a required
    // `--output <path>`; reject anything else rather than silently ignoring it.
    let mut script: Option<&String> = None;
    let mut output: Option<&String> = None;
    let mut index = 0;
    while index < tail.len() {
        let arg = tail[index].as_str();
        if arg == "--output" {
            let value = tail
                .get(index + 1)
                .filter(|v| !v.starts_with("--"))
                .ok_or_else(|| format!("missing value for flag --output; {USAGE}"))?;
            if output.replace(value).is_some() {
                return Err(format!("--output given more than once; {USAGE}").into());
            }
            index += 2;
            continue;
        }
        if arg.starts_with("--") {
            return Err(format!("unexpected flag {arg}; {USAGE}").into());
        }
        if script.replace(&tail[index]).is_some() {
            return Err(format!("unexpected extra argument {arg}; {USAGE}").into());
        }
        index += 1;
    }

    let script = script.ok_or_else(|| format!("missing <script.ks>; {USAGE}"))?;
    let output = output.ok_or_else(|| format!("missing --output; {USAGE}"))?;
    let script_path = PathBuf::from(script);
    let output_path = PathBuf::from(output);

    let bytes =
        std::fs::read(&script_path).map_err(|e| format!("read {}: {e}", script_path.display()))?;
    // Bridge-unit keys embed the source file name, so key off the base name (a
    // stable identity independent of where the script lives on disk).
    let source_file = source_file_name(&script_path);
    let trace = trace_kag_commands(&source_file, &bytes);
    let json = trace.to_deterministic_json()?;

    if let Some(parent) = output_path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    // Trailing newline for a POSIX-clean file; the golden is byte-compared
    // against exactly this (and is pinned in `vite.config.ts` fmt.ignorePatterns
    // so the formatter never rewrites it).
    std::fs::write(&output_path, format!("{json}\n"))
        .map_err(|e| format!("write {}: {e}", output_path.display()))?;
    Ok(())
}

/// The base file name (last path component) as a `String`, or the whole path
/// string if it has no file-name component.
fn source_file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.to_string_lossy().into_owned(),
        |n| n.to_string_lossy().into_owned(),
    )
}
