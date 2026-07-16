use std::fs;
use std::path::PathBuf;

use crate::{
    ContractStageStatus, Xp3CapabilityProfileFixture, Xp3CapabilityProfileRequest,
    Xp3ProfileProofFixture, Xp3ProfileProofRequest, atomic_write_text, encode_xp3, flag,
    flag_optional, generate_xp3_capability_profile, pack_plain_xp3_from_directory,
    plain_xp3_writer_capability, positional, read_json, read_plain_xp3_archive,
    redact_for_log_or_report, replace_plain_xp3_entry_payload, run_encrypted_xp3_contract_scaffold,
    run_plain_xp3_smoke_from_path, sha256_hash_bytes, stable_json, unpack_plain_xp3_to_directory,
    xp3_profile_proof,
};

/// `kaifuu xp3` subcommands.
/// `profile-proof`: reads a KiriKiri XP3 profile-proof
/// fixture, classifies the referenced archive bytes (plain / encrypted
/// helper-required / unsupported-protected-executable), and writes a
/// redacted proof report. The command never decrypts encrypted bytes,
/// never extracts payloads, and never claims patch-back on anything
/// other than plain XP3.
/// `unpack` / `pack` / `replace` / `writer-capability`
/// expose the deterministic plain-XP3 writer surface. `unpack` lays an
/// archive out under a directory (`manifest.json` + raw segment
/// payloads), `pack` rebuilds an archive from such a directory, and
/// `replace` rewrites a single allowed (uncompressed, single-segment)
/// entry's payload — round-tripping any of these against an unchanged
/// plain fixture produces byte-identical output (determinism
/// guarantee). Each non-plain input (encrypted, helper-required,
/// protected-executable, compressed-replacement) is rejected with a
/// `kaifuu.*` semantic diagnostic before any write side effect.
/// `writer-capability` reports the writer's capability tuple
/// (`patch_back_mode=archive_rebuild_plain`) for orchestrator
/// inspection.
/// Exits non-zero on any blocking diagnostic.
pub(crate) fn run_xp3_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "profile-proof" => {
            let fixture_path = PathBuf::from(flag(args, "--fixture")?);
            let output = PathBuf::from(flag(args, "--output")?);
            let fixture: Xp3ProfileProofFixture = read_json(&fixture_path)?;
            let fixture_dir = fixture_path
                .parent()
                .ok_or("fixture path must have a parent directory")?;
            let report = xp3_profile_proof(Xp3ProfileProofRequest {
                fixture: &fixture,
                fixture_dir,
            })?;
            let redacted = report.redacted_for_report();
            atomic_write_text(&output, &redacted.stable_json()?)?;
            if redacted.status == kaifuu_core::OperationStatus::Failed {
                return Err(format!(
                    "XP3 profile proof failed: {}",
                    redacted
                        .diagnostics
                        .iter()
                        .filter(|diagnostic| diagnostic.severity.is_blocking())
                        .map(|diagnostic| format!(
                            "{}:{}",
                            diagnostic.severity.as_str(),
                            diagnostic.code
                        ))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into());
            }
        }
        "unpack" => {
            let archive_path = PathBuf::from(flag(args, "--archive")?);
            let output_dir = PathBuf::from(flag(args, "--output-dir")?);
            let bytes = std::fs::read(&archive_path)
                .map_err(|error| format!("read {}: {error}", archive_path.display()))?;
            let manifest = unpack_plain_xp3_to_directory(&bytes, &output_dir).map_err(
                |error| -> Box<dyn std::error::Error> {
                    format!("{} (semantic: {})", error, error.semantic_code()).into()
                },
            )?;
            // Surface a summary to stdout so CI logs carry the entry
            // count and variant without re-reading the manifest.
            println!(
                "kaifuu xp3 unpack: variant={} entries={}",
                manifest.variant,
                manifest.entries.len()
            );
        }
        "pack" => {
            let input_dir = PathBuf::from(flag(args, "--input-dir")?);
            let output_path = PathBuf::from(flag(args, "--output")?);
            let bytes = pack_plain_xp3_from_directory(&input_dir).map_err(
                |error| -> Box<dyn std::error::Error> {
                    format!("{} (semantic: {})", error, error.semantic_code()).into()
                },
            )?;
            std::fs::write(&output_path, &bytes)
                .map_err(|error| format!("write {}: {error}", output_path.display()))?;
            println!(
                "kaifuu xp3 pack: bytes={} sha256={}",
                bytes.len(),
                sha256_hash_bytes(&bytes)
            );
        }
        "replace" => {
            let input_dir = PathBuf::from(flag(args, "--input-dir")?);
            let entry_path = flag(args, "--entry-path")?;
            let payload_path = PathBuf::from(flag(args, "--payload")?);
            let payload = std::fs::read(&payload_path)
                .map_err(|error| format!("read {}: {error}", payload_path.display()))?;
            let manifest = replace_plain_xp3_entry_payload(&input_dir, entry_path, &payload)
                .map_err(|error| -> Box<dyn std::error::Error> {
                    format!("{} (semantic: {})", error, error.semantic_code()).into()
                })?;
            let replaced = manifest
                .entries
                .iter()
                .find(|entry| entry.path == entry_path)
                .ok_or("replaced entry vanished from manifest")?;
            println!(
                "kaifuu xp3 replace: entry={} original_size={} archive_size={} adler32={}",
                replaced.path,
                replaced.original_size,
                replaced.archive_size,
                replaced.stored_adler32_hex.as_deref().unwrap_or("none")
            );
        }
        "verify" => {
            // verification surface: read both the source
            // archive and the rebuilt directory's pack output, then
            // confirm byte-identity. Used by the CI determinism gate.
            let source_path = PathBuf::from(flag(args, "--source")?);
            let input_dir = PathBuf::from(flag(args, "--input-dir")?);
            let source = std::fs::read(&source_path)
                .map_err(|error| format!("read {}: {error}", source_path.display()))?;
            let archive =
                read_plain_xp3_archive(&source).map_err(|error| -> Box<dyn std::error::Error> {
                    format!("{} (semantic: {})", error, error.semantic_code()).into()
                })?;
            let direct_rebuild =
                encode_xp3(&archive).map_err(|error| -> Box<dyn std::error::Error> {
                    format!("{} (semantic: {})", error, error.semantic_code()).into()
                })?;
            let directory_rebuild = pack_plain_xp3_from_directory(&input_dir).map_err(
                |error| -> Box<dyn std::error::Error> {
                    format!("{} (semantic: {})", error, error.semantic_code()).into()
                },
            )?;
            if direct_rebuild != source {
                return Err(
                    "encode_xp3 rebuild of source bytes did not match source (determinism violation)"
                        .into(),
                );
            }
            if directory_rebuild != source {
                return Err(
                    "pack_plain_xp3_from_directory rebuild did not match source (round-trip violation)"
                        .into(),
                );
            }
            println!(
                "kaifuu xp3 verify: sha256={} bytes={} entries={}",
                sha256_hash_bytes(&source),
                source.len(),
                archive.entries.len()
            );
        }
        "writer-capability" => {
            let capability = plain_xp3_writer_capability();
            let json = stable_json(&serde_json::to_value(capability)?)?;
            match flag_optional(args, "--output") {
                Some(output) => atomic_write_text(&PathBuf::from(output), &json)?,
                None => println!("{json}"),
            }
        }
        "capability-profile" => {
            return run_xp3_capability_profile(args);
        }
        "plain-smoke" => {
            return run_xp3_plain_smoke(args);
        }
        "contract-scaffold" => {
            return run_xp3_contract_scaffold(args);
        }
        "crypt-smoke" => {
            return run_xp3_crypt_chain_smoke(args);
        }
        _ => {
            return Err(
                "usage: kaifuu xp3 <profile-proof|capability-profile|plain-smoke|unpack|pack|replace|verify|writer-capability|contract-scaffold|crypt-smoke> ..."
                    .into(),
            );
        }
    }
    Ok(())
}

/// `kaifuu xp3 crypt-smoke --fixture <fixture.json>
/// --manifest <manifest.json> [--output <report.json>]`.
/// Runs the full Kaifuu chain on an encrypted KiriKiri XP3 archive through a
/// keyRef-bound crypt profile: detect the container by magic-byte signature,
/// resolve the crypt profile + decrypt key through the keyRef, decrypt +
/// integrity-verify + extract every member, apply one trivial text replacement,
/// re-encipher + repack, re-decrypt + verify against the declared profile +
/// secret requirement id, and emit a REDACTED delta package (one-way hashes +
/// secret refs only). Engine-general and game-agnostic: the crypt profile +
/// keyRef are data, not a per-game code path. Writes the redacted report to
/// `--output` (or stdout) and exits non-zero if the chain fails.
fn run_xp3_crypt_chain_smoke(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = PathBuf::from(flag(args, "--fixture")?);
    let manifest_path = PathBuf::from(flag(args, "--manifest")?);
    let report =
        kaifuu_kirikiri::run_xp3_crypt_chain_smoke_from_paths(&fixture_path, &manifest_path)
            .map_err(|error| -> Box<dyn std::error::Error> { error.to_string().into() })?;
    let json = report.stable_json()?;
    match flag_optional(args, "--output") {
        Some(output) => atomic_write_text(&PathBuf::from(output), &json)?,
        None => println!("{json}"),
    }
    if !report.is_ok() {
        return Err(format!("XP3 crypt-chain smoke failed: status {:?}", report.status).into());
    }
    // Surface a one-line stage summary to stdout so CI logs carry the chain
    // shape without re-reading the report.
    let stages: Vec<&str> = report
        .stages
        .iter()
        .map(|outcome| outcome.stage.as_str())
        .collect();
    eprintln!(
        "kaifuu xp3 crypt-smoke: stages={} delta_changed={} delta_unchanged={}",
        stages.join("->"),
        report.delta.members_changed,
        report.delta.members_unchanged
    );
    Ok(())
}

/// `kaifuu xp3 capability-profile --fixture <manifest>
/// [--output <report.json>]`.
/// Generates (and inseparably validates) a KiriKiri XP3 capability profile
/// from the manifest's detector / key-helper / crypt-profile / archive fixture
/// evidence. The capability tuple of every entry is recomputed from evidence:
/// only plain XP3 enters the `claimed` tier, encrypted / helper-required /
/// protected-executable / universal-dump entries are `research`-tier routing
/// diagnostics, and plaintext `.ks` is the `null_container` special case. The
/// redacted report is written to `--output` (or stdout) and the command exits
/// non-zero, listing each entry's blocking finding codes, when any entry fails
/// validation against its evidence.
fn run_xp3_capability_profile(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = PathBuf::from(flag(args, "--fixture")?);
    let fixture: Xp3CapabilityProfileFixture = read_json(&fixture_path)?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or("fixture path must have a parent directory")?;
    let fixture_file_name = fixture_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("fixture path must have a file name")?;
    let report = generate_xp3_capability_profile(Xp3CapabilityProfileRequest {
        fixture: &fixture,
        fixture_dir,
        fixture_file_name,
    })?;
    let redacted = report.redacted_for_report();
    let json = redacted.stable_json()?;
    match flag_optional(args, "--output") {
        Some(output) => atomic_write_text(&PathBuf::from(output), &json)?,
        None => println!("{json}"),
    }
    if redacted.status == kaifuu_core::OperationStatus::Failed {
        let failures = redacted
            .entries
            .iter()
            .filter(|entry| entry.status == kaifuu_core::OperationStatus::Failed)
            .map(|entry| {
                let codes = entry
                    .findings
                    .iter()
                    .filter(|finding| finding.severity.is_blocking())
                    .map(|finding| format!("{}:{}", finding.severity.as_str(), finding.code))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{} [{}]", entry.entry_id, codes)
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("XP3 capability profile validation failed: {failures}").into());
    }
    Ok(())
}

/// `kaifuu xp3 plain-smoke --fixture <descriptor> --out
/// <report.json>`.
/// Inventories a public plain-XP3 archive and deterministically rebuilds it
/// through the SHARED reader/writer path
/// ([`kaifuu_core::read_plain_xp3_inventory`] for member hashes,
/// [`kaifuu_core::read_plain_xp3_archive`] + [`kaifuu_core::encode_xp3`] for the
/// rebuild), then proves byte-identity (or a documented manifest equivalence).
/// Malformed-table and unsupported-member-flags negatives must fail BEFORE any
/// rebuild byte and cite in-archive member ids — never raw local paths. The
/// redacted report is written to `--out` and the command exits non-zero, listing
/// each blocking finding code, when any positive check or negative case fails.
/// Requires no encryption key and no private corpus.
fn run_xp3_plain_smoke(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture_path = PathBuf::from(flag(args, "--fixture")?);
    let report = run_plain_xp3_smoke_from_path(&fixture_path)?;
    let redacted = report.redacted_for_report();
    let json = redacted.stable_json()?;
    // `--out` is the command-contract flag; accept `--output` as an alias.
    match flag_optional(args, "--out").or_else(|| flag_optional(args, "--output")) {
        Some(output) => atomic_write_text(&PathBuf::from(output), &json)?,
        None => println!("{json}"),
    }

    // Surface a compact summary to stdout for CI logs (counts / hashes only).
    println!(
        "kaifuu xp3 plain-smoke: status={:?} members={} compressed={} rebuild={} outputHash={} negatives={}",
        redacted.status,
        redacted.archive.member_count,
        redacted.archive.compressed_member_count,
        redacted.rebuild.equivalence.as_str(),
        redacted.rebuild.output_hash.as_str(),
        redacted.negatives.len(),
    );

    if redacted.status == kaifuu_core::OperationStatus::Failed {
        let mut codes: Vec<String> = redacted
            .findings
            .iter()
            .filter(|finding| finding.severity.is_blocking())
            .map(|finding| match &finding.member_id {
                Some(member_id) => format!("{}@{}", finding.code, member_id),
                None => finding.code.clone(),
            })
            .collect();
        for negative in &redacted.negatives {
            if negative.status == kaifuu_core::OperationStatus::Failed {
                codes.push(format!("negative:{}", negative.case_id));
            }
        }
        return Err(format!("plain XP3 smoke failed: {}", codes.join(", ")).into());
    }
    Ok(())
}

/// `kaifuu xp3 contract-scaffold --fixture <descriptor>
/// [--output <report.json>]`.
/// Runs the end-to-end encrypted-XP3 contract scaffolding harness
/// (`kaifuu_delta::run_encrypted_xp3_contract_scaffold`) against the synthetic
/// public fixture, exercising detect -> key resolution -> extract -> patch ->
/// verify -> delta-apply. Prints the not-a-retail-readiness-claim disclaimer
/// and a per-stage PASS/FAIL summary to stdout, optionally writes the JSON
/// report, and exits non-zero (with the drifting stages' semantic codes) if
/// any contract stage drifted.
fn run_xp3_contract_scaffold(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let fixture = PathBuf::from(flag(args, "--fixture")?);

    // Scratch space the harness owns. Use a caller-provided --work-dir when
    // present, else a unique temp directory we clean up afterward.
    let (work_dir, owns_work_dir) = if let Some(value) = flag_optional(args, "--work-dir") {
        (PathBuf::from(value), false)
    } else {
        let unique = format!(
            "kaifuu-xp3-contract-scaffold-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos())
        );
        (std::env::temp_dir().join(unique), true)
    };

    let report = run_encrypted_xp3_contract_scaffold(&fixture, &work_dir)?;

    if owns_work_dir {
        let _ = fs::remove_dir_all(&work_dir);
    }

    // Disclaimer first — this harness is contract scaffolding, never a retail
    // readiness claim.
    println!("kaifuu xp3 contract-scaffold");
    println!("{}", report.disclaimer);
    for outcome in &report.stages {
        let marker = match outcome.status {
            ContractStageStatus::Passed => "PASS",
            ContractStageStatus::Failed => "FAIL",
        };
        match &outcome.semantic_code {
            Some(code) => println!(
                "  [{marker}] {} (semantic: {code}) — {}",
                outcome.stage.as_str(),
                redact_for_log_or_report(&outcome.detail)
            ),
            None => println!(
                "  [{marker}] {} — {}",
                outcome.stage.as_str(),
                redact_for_log_or_report(&outcome.detail)
            ),
        }
    }

    if let Some(output) = flag_optional(args, "--output") {
        atomic_write_text(&PathBuf::from(output), &report.stable_json()?)?;
    }

    if report.status == kaifuu_core::OperationStatus::Failed {
        let drift = report
            .stages
            .iter()
            .filter(|outcome| outcome.status == ContractStageStatus::Failed)
            .map(|outcome| {
                format!(
                    "{}:{}",
                    outcome.stage.as_str(),
                    outcome.semantic_code.as_deref().unwrap_or("unknown")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!("encrypted-XP3 contract scaffold drift: {drift}").into());
    }

    println!(
        "all {} contract stages passed (contract scaffolding only — not a retail readiness claim)",
        report.stages.len()
    );
    Ok(())
}
