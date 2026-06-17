use std::path::PathBuf;

use kaifuu_core::{read_json, write_json};
use kaifuu_delta::{apply_delta, create_delta};
use kaifuu_engine_fixture::{
    extract_fixture, patch_fixture, verify_fixture, write_fixture_profile,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("extract") => {
            let game_dir = positional(&args, 1)?;
            let output = flag(&args, "--output")?;
            write_json(
                &PathBuf::from(output),
                &extract_fixture(&PathBuf::from(game_dir))?,
            )?;
        }
        Some("patch") => {
            let game_dir = positional(&args, 1)?;
            let patch = flag(&args, "--patch")?;
            let output = flag(&args, "--output")?;
            let result = patch_fixture(
                &PathBuf::from(game_dir),
                &read_json(&PathBuf::from(patch))?,
                &PathBuf::from(output),
            )?;
            write_json(&PathBuf::from(output).join("patch-result.json"), &result)?;
        }
        Some("diff") => {
            let original = positional(&args, 1)?;
            let patched = positional(&args, 2)?;
            let output = flag(&args, "--output")?;
            write_json(
                &PathBuf::from(output),
                &create_delta(&PathBuf::from(original), &PathBuf::from(patched))?,
            )?;
        }
        Some("apply") => {
            let game_dir = positional(&args, 1)?;
            let patch = flag(&args, "--patch")?;
            let output = flag(&args, "--output")?;
            let result = apply_delta(
                &PathBuf::from(game_dir),
                &PathBuf::from(patch),
                &PathBuf::from(output),
            )?;
            write_json(&PathBuf::from(output).join("patch-result.json"), &result)?;
        }
        Some("verify") => {
            let game_dir = positional(&args, 1)?;
            let output = flag_optional(&args, "--output").unwrap_or("verify-result.json");
            write_json(
                &PathBuf::from(output),
                &verify_fixture(&PathBuf::from(game_dir))?,
            )?;
        }
        Some("profile") => {
            let game_dir = positional(&args, 1)?;
            let output = flag(&args, "--output")?;
            write_fixture_profile(&PathBuf::from(game_dir), &PathBuf::from(output))?;
        }
        _ => return Err("usage: kaifuu <extract|patch|diff|apply|verify|profile> ...".into()),
    }
    Ok(())
}

fn positional(args: &[String], index: usize) -> Result<&str, Box<dyn std::error::Error>> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("missing positional argument {index}").into())
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    flag_optional(args, name).ok_or_else(|| format!("missing flag {name}").into())
}

fn flag_optional<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}
