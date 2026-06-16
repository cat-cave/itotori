use std::path::PathBuf;

use utsushi_core::{capture_fixture, smoke_fixture, trace_fixture, write_json};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let game_dir = args.get(1).ok_or("missing game_dir")?;
    let output = flag(&args, "--output")?;
    let value = match args.first().map(String::as_str) {
        Some("trace") => trace_fixture(&PathBuf::from(game_dir))?,
        Some("capture") => capture_fixture(&PathBuf::from(game_dir))?,
        Some("smoke") => smoke_fixture(&PathBuf::from(game_dir))?,
        _ => return Err("usage: utsushi <trace|capture|smoke> <game_dir> --output <path>".into()),
    };
    write_json(&PathBuf::from(output), &value)?;
    Ok(())
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
        .ok_or_else(|| format!("missing flag {name}").into())
}
