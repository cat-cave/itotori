use std::fs;
use std::path::PathBuf;

use crate::{
    HelperRedactionStatus, LocalKeyImportRequest, LocalKeyImportSource, LocalSecretDirectoryStore,
    ProofHash, SecretRef, atomic_write_text, flag, flag_optional, parse_hex_bytes, positional,
    sha256_hash_bytes,
};

pub(crate) fn run_key_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match positional(args, 1)? {
        "import" => {
            let secret_store = PathBuf::from(flag(args, "--secret-store")?);
            let secret_ref = SecretRef::new(flag(args, "--secret-ref")?.to_string())?;
            let key_purpose = flag(args, "--purpose")?.to_string();
            let engine_profile_id = flag(args, "--engine-profile-id")?.to_string();
            let source_hash = ProofHash::new(flag_optional(args, "--source-hash").map_or_else(
                || sha256_hash_bytes(format!("{engine_profile_id}:{key_purpose}").as_bytes()),
                str::to_string,
            ))?;
            let output = PathBuf::from(flag(args, "--output")?);
            let source = match flag_optional(args, "--source").unwrap_or("manual") {
                "manual" | "manual-key-entry" => LocalKeyImportSource::ManualKeyEntry,
                "known-key" | "known-key-database" => LocalKeyImportSource::KnownKeyDatabaseImport,
                value => {
                    return Err(format!("unsupported key import source {value}").into());
                }
            };
            let material = import_key_material_from_args(args)?;
            let result = LocalSecretDirectoryStore::new(secret_store).import_key_reference(
                LocalKeyImportRequest {
                    secret_ref,
                    key_purpose,
                    engine_profile_id,
                    source_hash,
                    redaction_status: HelperRedactionStatus::Redacted,
                    source,
                    material,
                },
            )?;
            atomic_write_text(&output, &result.stable_json()?)?;
        }
        _ => {
            return Err(
                "usage: kaifuu key import --secret-store <dir> --secret-ref <local-secret:id> --purpose <id> --engine-profile-id <id> --key-file <path> --output <metadata.json> [--source-hash sha256:<hash>] [--source manual|known-key]\n  Provide key material with --key-file <path> (recommended): the raw key is read from a local file, so it never appears in shell history or the process list.\n  The report persists only a sha256 hash of the key material; the raw key is written solely to the local secret store and is never echoed.\n  [--key-hex <hex>] is also accepted but DISCOURAGED: a hex key typed on the command line leaks into shell history and is visible to other users via `ps` / the process list. Prefer --key-file."
                    .into(),
            );
        }
    }
    Ok(())
}

pub(crate) fn import_key_material_from_args(
    args: &[String],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let key_hex = flag_optional(args, "--key-hex");
    let key_file = flag_optional(args, "--key-file");
    match (key_hex, key_file) {
        (Some(_), Some(_)) => Err("choose either --key-hex or --key-file, not both".into()),
        (Some(hex), None) => Ok(parse_hex_bytes(hex)?),
        (None, Some(path)) => Ok(fs::read(path)?),
        (None, None) => Err("key import requires --key-file <path> (recommended: shell-history-safe) or --key-hex <hex> (discouraged: leaks into shell history and the process list)".into()),
    }
}
