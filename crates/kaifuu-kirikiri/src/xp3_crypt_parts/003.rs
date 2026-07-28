/// Convenience wrapper: read the fixture JSON at `fixture_path` and run the
/// smoke against the fixture's directory.
pub fn run_xp3_crypt_smoke_from_path(fixture_path: &Path) -> Result<Xp3CryptReport, Xp3CryptError> {
    let fixture: Xp3CryptFixture =
        read_json(fixture_path).map_err(|error| Xp3CryptError::Internal {
            message: error.to_string(),
        })?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or_else(|| Xp3CryptError::Internal {
            message: "fixture path must have a parent directory".to_string(),
        })?;
    run_xp3_crypt_smoke_from_fixture(&fixture, fixture_dir)
}


