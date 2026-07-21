use super::*;

fn runtime_with_namae_shape(first_mode: i32, first_color_index: i32) -> AudioRuntime {
    let source = format!(
        "#COLOR_TABLE.011=10,20,30\n\
         #COLOR_TABLE.012=11,21,31\n\
         #COLOR_TABLE.014=12,22,32\n\
         #COLOR_TABLE.015=13,23,33\n\
         #COLOR_TABLE.016=14,24,34\n\
         #COLOR_TABLE.018=15,25,35\n\
         #NAMAE=\"SPEAKER-A\" = \"SPEAKER-A\" = ({first_mode},{first_color_index},-1)\n\
         #NAMAE=\"SPEAKER-B\" = \"SPEAKER-B\" = (1,011,-1)\n\
         #NAMAE=\"SPEAKER-C\" = \"SPEAKER-C\" = (1,011,-1)\n\
         #NAMAE=\"SPEAKER-D\" = \"SPEAKER-D\" = (1,014,-1)\n\
         #NAMAE=\"SPEAKER-E\" = \"SPEAKER-E\" = (1,014,-1)\n\
         #NAMAE=\"SPEAKER-F\" = \"SPEAKER-F\" = (1,015,-1)\n\
         #NAMAE=\"SPEAKER-G\" = \"SPEAKER-G\" = (1,015,-1)\n\
         #NAMAE=\"SPEAKER-H\" = \"SPEAKER-H\" = (1,016,-1)\n\
         #NAMAE=\"SPEAKER-I\" = \"SPEAKER-I\" = (1,018,-1)\n\
         #NAMAE=\"SPEAKER-J\" = \"SPEAKER-J\" = (1,018,-1)\n\
         #NAMAE=\"SPEAKER-K\" = \"SPEAKER-K\" = (1,018,-1)\n"
    );
    let bytes = encoding_rs::SHIFT_JIS.encode(&source).0.into_owned();
    let gameexe = Arc::new(Gameexe::parse(&bytes).expect("synthetic Gameexe parses"));
    let runtime = AudioRuntime::new(Arc::new(AudioEventEmitter::new()));
    runtime.set_gameexe(gameexe);
    runtime
}

#[test]
fn namae_fallback_maps_when_complete_shape_is_confident() {
    let runtime = runtime_with_namae_shape(0, 11);

    assert_eq!(
        runtime.select_speaker_by_display_name("SPEAKER-F"),
        Some(1015)
    );
    assert_eq!(runtime.current_speaker_archive(), Some(1015));
}

#[test]
fn namae_fallback_is_unresolved_when_unrelated_row_breaks_shape() {
    let runtime = runtime_with_namae_shape(0, 12);

    assert_eq!(runtime.select_speaker_by_display_name("SPEAKER-F"), None);
    assert_eq!(runtime.current_speaker_archive(), None);
}
