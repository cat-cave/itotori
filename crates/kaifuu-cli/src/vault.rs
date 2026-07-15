use std::path::PathBuf;

use kaifuu_core::stable_json;

use crate::{flag, flag_optional, flag_present};

/// `kaifuu vault <capabilities|discover|materialize|materialize-by-sha>`.
/// Exposes the `kaifuu-vault-source` [`LocalCorpusSource`] trait to operators
/// without writing Rust. Every subcommand runs against the configured vault
/// root (`--vault-root <PATH>`, or the adapter's env/default resolution) and a
/// scratch root (`--scratch-root <PATH>`) and can emit either a human summary
/// (default) or canonical JSON (`--json`).
/// Read-only-vault + copyright posture: the command reports only identities,
/// hashes, counts and redacted catalog/embedded metadata (ids, canonical
/// ids, sha256, roles, engine, languages, paths). It NEVER reads or prints the
/// raw bytes of any vaulted archive or extracted game file — `materialize`
/// reports the resolved sha/paths, not their contents.
pub(crate) fn run_vault_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use kaifuu_vault_source::{
        ClaimQuery, LocalCorpusSource, MaterializeOptions, ScratchConfig, VaultConfig, VaultSource,
        inventory_scratch_root, now_unix, prune_scratch_root, resolve_scratch_root,
    };

    let json = flag_present(args, "--json");
    let vault_cfg = VaultConfig {
        vault_root_override: flag_optional(args, "--vault-root").map(PathBuf::from),
    };
    let scratch_cfg = ScratchConfig {
        scratch_root_override: flag_optional(args, "--scratch-root").map(PathBuf::from),
    };

    let open =
        |v: &VaultConfig, s: &ScratchConfig| -> Result<VaultSource, Box<dyn std::error::Error>> {
            VaultSource::open(v, s).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.vault.open: {err}").into()
            })
        };

    match args.get(1).map(String::as_str) {
        Some("capabilities") => {
            let source = open(&vault_cfg, &scratch_cfg)?;
            let report = source.capabilities();
            let value = serde_json::json!({
                "source_id": report.source_id,
                "vault_root": report.vault_root.display().to_string(),
                "schema_version": report.schema_version,
                "supported_artifact_roles": report.supported_artifact_roles,
                "retention_policy_default": retention_policy_label(report.retention_policy_default),
                "read_only": report.read_only,
                "findings_sink_required": report.findings_sink_required,
            });
            if json {
                println!("{}", stable_json(&value)?);
            } else {
                println!("vault capabilities");
                println!("  source_id: {}", report.source_id);
                println!("  vault_root: {}", report.vault_root.display());
                println!("  schema_version: {}", report.schema_version);
                println!(
                    "  supported_artifact_roles: {}",
                    report.supported_artifact_roles.join(", ")
                );
                println!(
                    "  retention_policy_default: {}",
                    retention_policy_label(report.retention_policy_default)
                );
                println!("  read_only: {}", report.read_only);
                println!(
                    "  findings_sink_required: {}",
                    report.findings_sink_required
                );
            }
        }
        Some("discover") => {
            let source = open(&vault_cfg, &scratch_cfg)?;
            let claim = parse_vault_claim(args)?;
            let candidates =
                source
                    .discover(&claim)
                    .map_err(|err| -> Box<dyn std::error::Error> {
                        format!("kaifuu.vault.discover: {err}").into()
                    })?;
            let value = serde_json::Value::Array(
                candidates.iter().map(release_candidate_to_json).collect(),
            );
            if json {
                println!("{}", stable_json(&value)?);
            } else {
                println!("vault discover: {} candidate(s)", candidates.len());
                for c in &candidates {
                    println!(
                        "  release_id={} work_id={} engine={} store={} languages=[{}] platforms=[{}]",
                        c.release_id,
                        c.work_id,
                        c.engine.as_deref().unwrap_or("-"),
                        c.store.as_deref().unwrap_or("-"),
                        c.languages.join(","),
                        c.platforms.join(","),
                    );
                }
            }
        }
        Some("materialize") => {
            let source = open(&vault_cfg, &scratch_cfg)?;
            let claim = parse_vault_claim(args)?;
            let candidate = first_candidate(&source, &claim)?;
            let opts = MaterializeOptions {
                retention: parse_vault_retention(args)?,
                ..MaterializeOptions::default()
            };
            let result = source.materialize(&candidate, opts).map_err(
                |err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.vault.materialize: {err}").into()
                },
            )?;
            emit_materialize_report(&result, json)?;
        }
        Some("materialize-by-sha") => {
            let sha256 = flag(args, "--sha256")?.to_string();
            let source = open(&vault_cfg, &scratch_cfg)?;
            let claim = ClaimQuery::ByArtifactSha256 { sha256 };
            let candidate = first_candidate(&source, &claim)?;
            let opts = MaterializeOptions {
                retention: parse_vault_retention(args)?,
                ..MaterializeOptions::default()
            };
            let result = source.materialize(&candidate, opts).map_err(
                |err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.vault.materialize: {err}").into()
                },
            )?;
            emit_materialize_report(&result, json)?;
        }
        Some("inventory") => {
            // Scratch-only: resolve the scratch root WITHOUT opening the vault
            // (inventory reports what has been materialised; a vault need not be
            // present or valid to list scratch trees).
            let scratch_root = resolve_scratch_root(&scratch_cfg).map_err(
                |err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.vault.scratch_root: {err}").into()
                },
            )?;
            let compute_sha = !flag_present(args, "--no-sha");
            let inventory = inventory_scratch_root(&scratch_root, compute_sha).map_err(
                |err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.vault.inventory: {err}").into()
                },
            )?;
            emit_scratch_inventory(&inventory, json)?;
        }
        Some("prune") => {
            let scratch_root = resolve_scratch_root(&scratch_cfg).map_err(
                |err| -> Box<dyn std::error::Error> {
                    format!("kaifuu.vault.scratch_root: {err}").into()
                },
            )?;
            let policy = parse_prune_policy(args)?;
            let dry_run = flag_present(args, "--dry-run");
            let plan = prune_scratch_root(&scratch_root, policy, now_unix(), dry_run).map_err(
                |err| -> Box<dyn std::error::Error> { format!("kaifuu.vault.prune: {err}").into() },
            )?;
            emit_prune_plan(&plan, dry_run, json)?;
        }
        _ => {
            return Err("usage: kaifuu vault \
                 <capabilities|discover|materialize|materialize-by-sha|inventory|prune> \
                 [--vault-root <PATH>] [--scratch-root <PATH>] [--json] \
                 [--canonical-id <ID> | --release-id <N> | --sha256 <HEX> | \
                 --engine <NAME> [--engine-version <V>] | \
                 --external-id <source:kind:value> | --work-title <TITLE> [--language <LANG>]] \
                 [--retention <keep-none|keep-on-failure|keep-all|keep-extracted-for-game>] \
                 [inventory: --no-sha] \
                 [prune: --max-total-bytes <N> | --max-age-secs <N>] [--dry-run]"
                .into());
        }
    }
    Ok(())
}

/// Resolve a claim to its first discovered candidate (materialize operates on
/// one candidate; discovery may return several for a work-level claim).
fn first_candidate(
    source: &kaifuu_vault_source::VaultSource,
    claim: &kaifuu_vault_source::ClaimQuery,
) -> Result<kaifuu_vault_source::ReleaseCandidate, Box<dyn std::error::Error>> {
    use kaifuu_vault_source::LocalCorpusSource;
    source
        .discover(claim)
        .map_err(|err| -> Box<dyn std::error::Error> {
            format!("kaifuu.vault.discover: {err}").into()
        })?
        .into_iter()
        .next()
        .ok_or_else(|| -> Box<dyn std::error::Error> {
            format!(
                "kaifuu.vault.release_not_resolved: no candidate for {}",
                claim.summary()
            )
            .into()
        })
}

/// Render a discovered [`kaifuu_vault_source::ReleaseCandidate`] as redacted
/// JSON (catalog identities/metadata only — no artifact bytes).
fn release_candidate_to_json(c: &kaifuu_vault_source::ReleaseCandidate) -> serde_json::Value {
    serde_json::json!({
        "release_id": c.release_id,
        "work_id": c.work_id,
        "edition_name": c.edition_name,
        "release_date": c.release_date,
        "store": c.store,
        "engine": c.engine,
        "engine_version": c.engine_version,
        "engine_needs_review": c.engine_needs_review,
        "languages": c.languages,
        "platforms": c.platforms,
    })
}

/// Emit a materialize report (human or JSON). Reports resolved identities,
/// hashes and scratch/catalog paths ONLY — never the extracted file bytes.
fn emit_materialize_report(
    result: &kaifuu_vault_source::MaterializeResult,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let artifacts: Vec<serde_json::Value> = result
        .artifacts
        .iter()
        .map(|a| {
            serde_json::json!({
                "id": a.id,
                "role": a.role,
                "subpath": a.subpath,
                "canonical_id": a.canonical_id,
                "artifact_kind": a.artifact_kind,
                "canonical_sha256": a.canonical_sha256,
                "vault_path": a.vault_path,
            })
        })
        .collect();
    let embedded = serde_json::json!({
        "canonical_id": result.embedded.canonical_id,
        "engine": result.embedded.engine,
        "canonical_title": result.embedded.canonical_title,
        "languages": result.embedded.languages,
        "identifiers": result
            .embedded
            .identifiers
            .iter()
            .map(|(source, kind, value)| serde_json::json!({
                "source": source, "kind": kind, "value": value,
            }))
            .collect::<Vec<_>>(),
    });
    let value = serde_json::json!({
        "game_id": result.game_id,
        "run_id": result.run_id,
        "release_id": result.release_id,
        "artifact_canonical_id": result.artifact_canonical_id,
        "retention_policy": retention_policy_label(result.retention_policy),
        "extracted_root": result.extracted_root.display().to_string(),
        "tree_root": result.tree_root.display().to_string(),
        "subpath_root": result.subpath_root.as_ref().map(|p| p.display().to_string()),
        "artifacts": artifacts,
        "embedded": embedded,
        "findings_count": result.findings.len(),
    });
    if json {
        println!("{}", stable_json(&value)?);
    } else {
        println!("vault materialize");
        println!("  game_id: {}", result.game_id);
        println!("  run_id: {}", result.run_id);
        println!("  release_id: {}", result.release_id);
        println!("  artifact_canonical_id: {}", result.artifact_canonical_id);
        println!(
            "  retention_policy: {}",
            retention_policy_label(result.retention_policy)
        );
        println!("  tree_root: {}", result.tree_root.display());
        if let Some(subpath) = result.subpath_root.as_ref() {
            println!("  subpath_root: {}", subpath.display());
        }
        for a in &result.artifacts {
            println!(
                "  artifact: canonical_id={} role={} kind={} canonical_sha256={}",
                a.canonical_id,
                a.role,
                a.artifact_kind,
                a.canonical_sha256.as_deref().unwrap_or("-"),
            );
        }
        println!("  findings_count: {}", result.findings.len());
    }
    Ok(())
}

/// Parse a `vault discover`/`materialize` claim from operator flags. Exactly
/// one claim selector is honoured, checked in a fixed precedence order.
fn parse_vault_claim(
    args: &[String],
) -> Result<kaifuu_vault_source::ClaimQuery, Box<dyn std::error::Error>> {
    use kaifuu_vault_source::ClaimQuery;
    if let Some(canonical_id) = flag_optional(args, "--canonical-id") {
        return Ok(ClaimQuery::ByCanonicalId {
            canonical_id: canonical_id.to_string(),
        });
    }
    if let Some(release_id) = flag_optional(args, "--release-id") {
        let release_id = release_id
            .parse::<i64>()
            .map_err(|_| format!("--release-id must be an integer, got {release_id}"))?;
        return Ok(ClaimQuery::ByReleaseId { release_id });
    }
    if let Some(sha256) = flag_optional(args, "--sha256") {
        return Ok(ClaimQuery::ByArtifactSha256 {
            sha256: sha256.to_string(),
        });
    }
    if let Some(engine) = flag_optional(args, "--engine") {
        return Ok(ClaimQuery::ByEngineClaim {
            engine: engine.to_string(),
            engine_version: flag_optional(args, "--engine-version").map(str::to_string),
        });
    }
    if let Some(external) = flag_optional(args, "--external-id") {
        let parts: Vec<&str> = external.splitn(3, ':').collect();
        if parts.len() != 3 || parts.iter().any(|p| p.is_empty()) {
            return Err(
                format!("--external-id must be <source:kind:value>, got {external}").into(),
            );
        }
        return Ok(ClaimQuery::ByExternalId {
            source: parts[0].to_string(),
            kind: parts[1].to_string(),
            value: parts[2].to_string(),
        });
    }
    if let Some(title) = flag_optional(args, "--work-title") {
        return Ok(ClaimQuery::ByWorkTitle {
            language: flag_optional(args, "--language").map(str::to_string),
            title: title.to_string(),
        });
    }
    Err(
        "vault discover/materialize require a claim flag: --canonical-id <ID> | \
         --release-id <N> | --sha256 <HEX> | --engine <NAME> [--engine-version <V>] | \
         --external-id <source:kind:value> | --work-title <TITLE> [--language <LANG>]"
            .into(),
    )
}

/// Parse the optional `--retention` flag into a
/// [`kaifuu_vault_source::RetentionPolicy`]. Defaults to `keep-none` (the
/// adapter's CI-friendly default): the extraction persists in scratch until an
/// operator cleans it up, but no run dir is retained across invocations.
fn parse_vault_retention(
    args: &[String],
) -> Result<kaifuu_vault_source::RetentionPolicy, Box<dyn std::error::Error>> {
    use kaifuu_vault_source::RetentionPolicy;
    match flag_optional(args, "--retention") {
        None | Some("keep-none") => Ok(RetentionPolicy::KeepNone),
        Some("keep-on-failure") => Ok(RetentionPolicy::KeepOnFailure),
        Some("keep-all") => Ok(RetentionPolicy::KeepAll),
        Some("keep-extracted-for-game") => Ok(RetentionPolicy::KeepExtractedForGame),
        Some(other) => Err(format!(
            "unknown --retention {other}; expected \
             keep-none|keep-on-failure|keep-all|keep-extracted-for-game"
        )
        .into()),
    }
}

/// Stable operator-facing label for a
/// [`kaifuu_vault_source::RetentionPolicy`].
fn retention_policy_label(policy: kaifuu_vault_source::RetentionPolicy) -> &'static str {
    use kaifuu_vault_source::RetentionPolicy;
    match policy {
        RetentionPolicy::KeepNone => "keep-none",
        RetentionPolicy::KeepOnFailure => "keep-on-failure",
        RetentionPolicy::KeepAll => "keep-all",
        RetentionPolicy::KeepExtractedForGame => "keep-extracted-for-game",
    }
}

/// Emit a scratch inventory (`kaifuu vault inventory`).
/// Reports per-game id / size / mtime / content-digest ONLY — never raw game
/// bytes. `--json` yields the canonical deterministic form.
fn emit_scratch_inventory(
    inventory: &kaifuu_vault_source::ScratchInventory,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        println!("{}", stable_json(inventory)?);
    } else {
        println!("vault inventory: {} game(s)", inventory.game_count);
        println!("  scratch_root: {}", inventory.scratch_root);
        println!("  total_size_bytes: {}", inventory.total_size_bytes);
        for g in &inventory.games {
            println!(
                "  id={} size_bytes={} file_count={} mtime_unix={} sha256={}",
                g.id,
                g.size_bytes,
                g.file_count,
                g.mtime_unix
                    .map_or_else(|| "-".to_string(), |m| m.to_string()),
                g.sha256.as_deref().unwrap_or("-"),
            );
        }
    }
    Ok(())
}

/// Emit a prune plan/report (`kaifuu vault prune`). In `--dry-run`
/// the plan describes what WOULD be pruned; otherwise it describes what was
/// removed. Scratch-only — the vault is never a prune target.
fn emit_prune_plan(
    plan: &kaifuu_vault_source::PrunePlan,
    dry_run: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        println!("{}", stable_json(plan)?);
    } else {
        println!(
            "vault prune ({}): {}",
            if dry_run { "dry-run" } else { "applied" },
            plan.policy
        );
        println!("  scratch_root: {}", plan.scratch_root);
        println!(
            "  total_size_bytes_before: {}",
            plan.total_size_bytes_before
        );
        println!("  freed_bytes: {}", plan.freed_bytes);
        println!("  total_size_bytes_after: {}", plan.total_size_bytes_after);
        println!("  pruned: {} game(s)", plan.pruned.len());
        for g in &plan.pruned {
            println!("    - id={} size_bytes={}", g.id, g.size_bytes);
        }
        println!("  kept: {} game(s)", plan.kept.len());
        for g in &plan.kept {
            println!("    - id={} size_bytes={}", g.id, g.size_bytes);
        }
    }
    Ok(())
}

/// Parse the prune policy from operator flags. Exactly one of
/// `--max-total-bytes <N>` (quota) or `--max-age-secs <N>` (LRU horizon) is
/// required; both is an error.
fn parse_prune_policy(
    args: &[String],
) -> Result<kaifuu_vault_source::PrunePolicy, Box<dyn std::error::Error>> {
    use kaifuu_vault_source::PrunePolicy;
    let quota = flag_optional(args, "--max-total-bytes");
    let horizon = flag_optional(args, "--max-age-secs");
    match (quota, horizon) {
        (Some(_), Some(_)) => Err(
            "vault prune: pass exactly one of --max-total-bytes (quota) or \
             --max-age-secs (LRU horizon), not both"
                .into(),
        ),
        (Some(v), None) => {
            let max_total_bytes = v.parse::<u64>().map_err(|_| {
                format!("--max-total-bytes must be a non-negative integer, got {v}")
            })?;
            Ok(PrunePolicy::Quota { max_total_bytes })
        }
        (None, Some(v)) => {
            let max_age_secs = v
                .parse::<u64>()
                .map_err(|_| format!("--max-age-secs must be a non-negative integer, got {v}"))?;
            Ok(PrunePolicy::LruHorizon { max_age_secs })
        }
        (None, None) => Err(
            "vault prune requires a policy flag: --max-total-bytes <N> (quota) or \
             --max-age-secs <N> (LRU horizon)"
                .into(),
        ),
    }
}
