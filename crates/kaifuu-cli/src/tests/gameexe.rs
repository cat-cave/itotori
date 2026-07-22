/// KAIFUU bridge regression: a `Gameexe.ini` that exists but cannot be
/// read (e.g. `chmod 000`) must surface the structured
/// `kaifuu.reallive.gameexe_unreadable` diagnostic rather than silently
/// degrading to an empty inventory, and a genuinely-absent file must be
/// distinguished as `kaifuu.reallive.gameexe_absent`. Both replace the
/// pre-fix `unwrap_or_default` silent fallback that produced a
/// structurally-valid-but-wrong bundle.
#[cfg(unix)]
#[test]
fn gameexe_read_surfaces_structured_diagnostic_instead_of_silent_default() {
    use std::os::unix::fs::PermissionsExt;

    let root = temp_dir("gameexe-read-diagnostic");
    let gameexe_path = root.join("Gameexe.ini");

    // Readable Gameexe.ini round-trips its bytes (no diagnostic).
    fs::write(&gameexe_path, b"#SCENE001 = synthetic\n").unwrap();
    let ok = read_gameexe_inventory_bytes(&gameexe_path).unwrap();
    assert_eq!(ok, b"#SCENE001 = synthetic\n");

    // Unreadable Gameexe.ini (permission-denied) is a real failure.
    let mut permissions = fs::metadata(&gameexe_path).unwrap().permissions();
    permissions.set_mode(0o000);
    fs::set_permissions(&gameexe_path, permissions).unwrap();
    let unreadable = read_gameexe_inventory_bytes(&gameexe_path).unwrap_err();
    let unreadable = unreadable.to_string();
    assert!(
        unreadable.contains("kaifuu.reallive.gameexe_unreadable"),
        "expected unreadable diagnostic, got: {unreadable}"
    );
    assert!(
        !unreadable.contains("kaifuu.reallive.gameexe_absent"),
        "unreadable must not be conflated with absent: {unreadable}"
    );
    // Restore permissions so the temp tree can be cleaned up.
    let mut permissions = fs::metadata(&gameexe_path).unwrap().permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(&gameexe_path, permissions).unwrap();

    // A genuinely-absent Gameexe.ini is distinguished from unreadable.
    let absent = read_gameexe_inventory_bytes(&root.join("missing-Gameexe.ini")).unwrap_err();
    let absent = absent.to_string();
    assert!(
        absent.contains("kaifuu.reallive.gameexe_absent"),
        "expected absent diagnostic, got: {absent}"
    );

    let _ = fs::remove_dir_all(root);
}
