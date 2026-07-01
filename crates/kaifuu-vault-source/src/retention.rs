//! Retention-policy state machine + per-run / per-game cleanup.
//!
//! The contract names four policies; each is implemented as a small function
//! over [`crate::extraction::ScratchPaths`] and the
//! [`crate::config::RetentionPolicy`] enum.

use std::path::Path;

use crate::config::RetentionPolicy;
use crate::extraction::ScratchPaths;

/// Did the run succeed?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    /// Materialize / consume call returned `Ok`.
    Success,
    /// Materialize / consume call returned an error.
    Failure,
}

/// Apply the retention policy after a run, removing `<run-id>/` (or not)
/// per the policy.
pub fn apply_retention(
    policy: RetentionPolicy,
    paths: &ScratchPaths,
    outcome: RunOutcome,
) -> std::io::Result<()> {
    match (policy, outcome) {
        (RetentionPolicy::KeepNone, _) | (RetentionPolicy::KeepOnFailure, RunOutcome::Success) => {
            remove_run_dir(paths)
        }
        (RetentionPolicy::KeepOnFailure, RunOutcome::Failure) | (RetentionPolicy::KeepAll, _) => {
            Ok(())
        }
        (RetentionPolicy::KeepExtractedForGame, _) => {
            // Promote `extracted/` to `<game-id>/extracted/` so a subsequent
            // run with the same game id can reuse it.
            promote_extracted_to_game(paths)
        }
    }
}

fn remove_run_dir(paths: &ScratchPaths) -> std::io::Result<()> {
    if paths.run_root.exists() {
        std::fs::remove_dir_all(&paths.run_root)?;
    }
    Ok(())
}

fn promote_extracted_to_game(paths: &ScratchPaths) -> std::io::Result<()> {
    let canonical_extracted = paths.game_root.join("extracted");
    if paths.extracted_root.exists() {
        if canonical_extracted.exists() {
            std::fs::remove_dir_all(&canonical_extracted)?;
        }
        std::fs::rename(&paths.extracted_root, &canonical_extracted)?;
        // remove the now-empty run_root
        let _ = std::fs::remove_dir_all(&paths.run_root);
    }
    Ok(())
}

/// Look up the previously-cached artifact `canonical_id` for a game id, if the
/// `KeepExtractedForGame` policy left one behind.
pub fn read_last_canonical_id(marker: &Path) -> Option<String> {
    std::fs::read_to_string(marker)
        .ok()
        .map(|s| s.trim().to_string())
}

/// Write the marker file for a freshly-materialised artifact under the
/// `KeepExtractedForGame` policy.
pub fn write_last_canonical_id(marker: &Path, canonical_id: &str) -> std::io::Result<()> {
    if let Some(p) = marker.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::write(marker, canonical_id.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup_run(td: &Path) -> ScratchPaths {
        let p = ScratchPaths::compose(td, "v1234", "run-abc");
        std::fs::create_dir_all(&p.extracted_root).unwrap();
        std::fs::write(p.extracted_root.join("hello.txt"), b"hi").unwrap();
        p
    }

    #[test]
    fn keep_none_deletes_run_dir_on_success_and_on_failure() {
        let td = tempdir().unwrap();
        let p = setup_run(td.path());
        apply_retention(RetentionPolicy::KeepNone, &p, RunOutcome::Success).unwrap();
        assert!(!p.run_root.exists());

        let p = setup_run(td.path());
        apply_retention(RetentionPolicy::KeepNone, &p, RunOutcome::Failure).unwrap();
        assert!(!p.run_root.exists());
    }

    #[test]
    fn keep_on_failure_preserves_run_dir_on_failure_and_deletes_on_success() {
        let td = tempdir().unwrap();
        let p = setup_run(td.path());
        apply_retention(RetentionPolicy::KeepOnFailure, &p, RunOutcome::Failure).unwrap();
        assert!(p.run_root.exists());

        std::fs::remove_dir_all(&p.run_root).unwrap();
        let p = setup_run(td.path());
        apply_retention(RetentionPolicy::KeepOnFailure, &p, RunOutcome::Success).unwrap();
        assert!(!p.run_root.exists());
    }

    #[test]
    fn keep_all_never_deletes_run_dir() {
        let td = tempdir().unwrap();
        let p = setup_run(td.path());
        apply_retention(RetentionPolicy::KeepAll, &p, RunOutcome::Success).unwrap();
        assert!(p.run_root.exists());
        apply_retention(RetentionPolicy::KeepAll, &p, RunOutcome::Failure).unwrap();
        assert!(p.run_root.exists());
    }

    #[test]
    fn keep_extracted_for_game_promotes_extracted_to_game_root() {
        let td = tempdir().unwrap();
        let p = setup_run(td.path());
        apply_retention(
            RetentionPolicy::KeepExtractedForGame,
            &p,
            RunOutcome::Success,
        )
        .unwrap();
        // run_root removed (because extracted/ was promoted)
        assert!(!p.run_root.exists());
        let canonical = p.game_root.join("extracted");
        assert!(canonical.exists());
        assert!(canonical.join("hello.txt").exists());
    }

    #[test]
    fn keep_extracted_for_game_reuses_existing_extracted_tree_when_canonical_id_matches() {
        let td = tempdir().unwrap();
        let p = setup_run(td.path());
        let cid = "hello-galaxy.v1234.v1-0.ja";
        write_last_canonical_id(&p.last_canonical_id_marker, cid).unwrap();
        assert_eq!(
            read_last_canonical_id(&p.last_canonical_id_marker).as_deref(),
            Some(cid)
        );
    }

    #[test]
    fn keep_extracted_for_game_reextracts_when_canonical_id_changes() {
        let td = tempdir().unwrap();
        let p = setup_run(td.path());
        write_last_canonical_id(&p.last_canonical_id_marker, "old.v1.ja").unwrap();
        assert_eq!(
            read_last_canonical_id(&p.last_canonical_id_marker).as_deref(),
            Some("old.v1.ja")
        );
        write_last_canonical_id(&p.last_canonical_id_marker, "new.v1.ja").unwrap();
        assert_eq!(
            read_last_canonical_id(&p.last_canonical_id_marker).as_deref(),
            Some("new.v1.ja")
        );
    }
}
