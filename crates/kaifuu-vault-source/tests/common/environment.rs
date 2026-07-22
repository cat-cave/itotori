use super::*;
/// Resolve this crate's manifest directory for locating tracked test fixtures.
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would point fixture reads at
/// a dead path (`Os NotFound`). `cargo test` sets `CARGO_MANIFEST_DIR` in the
/// RUNTIME environment to the LIVE crate directory; prefer that, falling back to
/// the compile-time constant only outside cargo.
pub fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

/// Neutralise the ambient `ITOTORI_VAULT_ROOT` / `ITOTORI_SCRATCH_ROOT`
/// environment variables so tests that pass an explicit `vault_root_override`
/// are deterministic regardless of the surrounding shell.
/// `resolve_vault_root` (src/config.rs) consults the env var FIRST — the
/// operator env override intentionally beats a caller-supplied
/// `vault_root_override` — so a real-bytes shell with
/// `ITOTORI_VAULT_ROOT=/archive/vault` set (as the vault integration suite
/// runs under) would otherwise make every override-based test silently open
/// the *real* vault: the negative-path tests would then see `Ok(..)` and
/// panic on `unwrap_err`. The removal runs exactly once and the vars are
/// never re-set in this process, so parallel test threads never race a
/// concurrent `setenv` against a `getenv`.
// reason: edition-2024 `remove_var` is unsafe; this is test-only and the Once
// guarantees the writes complete before any test proceeds past the call site.
#[allow(unsafe_code)]
pub fn isolate_ambient_vault_env() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: runs exactly once (Once) before the calling test proceeds;
        // the two vars are never re-set in this test process, so no other
        // thread's env read can race a concurrent env write.
        unsafe {
            std::env::remove_var("ITOTORI_VAULT_ROOT");
            std::env::remove_var("ITOTORI_SCRATCH_ROOT");
        }
    });
}
