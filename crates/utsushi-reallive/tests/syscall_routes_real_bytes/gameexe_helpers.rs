use super::*;

pub(super) fn resolve_gameexe_path() -> Option<std::path::PathBuf> {
    real_corpus::gameexe_ini_path()
}

pub(super) fn load_reallive_real_bytes_gameexe() -> Option<Gameexe> {
    let path = resolve_gameexe_path()?;
    let bytes = fs::read(&path).unwrap_or_else(|err| {
        panic!(
            "ITOTORI_REAL_GAME_ROOT is set but Gameexe.ini at {} could not be read: {err}",
            path.display(),
        )
    });
    Some(Gameexe::parse(&bytes).expect("real Gameexe.ini must parse without error"))
}
