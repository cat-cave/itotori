use std::path::PathBuf;

use utsushi_core::{RuntimeAdapterRegistry, RuntimeOperation, RuntimeRequest, write_json};
use utsushi_fixture::FixtureRuntimeAdapter;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let input_root = PathBuf::from(args.get(1).ok_or("missing game_dir")?);
    let output = flag(&args, "--output")?;
    let operation = match args.first().map(String::as_str) {
        Some("trace") => RuntimeOperation::Trace,
        Some("capture") => RuntimeOperation::Capture,
        Some("smoke") => RuntimeOperation::SmokeValidation,
        _ => return Err("usage: utsushi <trace|capture|smoke> <game_dir> --output <path>".into()),
    };

    let adapter = FixtureRuntimeAdapter::new();
    let mut registry = RuntimeAdapterRegistry::new();
    registry.register(&adapter)?;
    let value = registry.run(
        FixtureRuntimeAdapter::NAME,
        operation,
        &RuntimeRequest::new(&input_root),
    )?;
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
