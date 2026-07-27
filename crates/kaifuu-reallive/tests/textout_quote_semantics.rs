use kaifuu_reallive::decode_dialogue_textout;

#[test]
fn exposes_only_the_textout_body_that_the_runtime_displays() {
    assert_eq!(
        decode_dialogue_textout(br#""visible""#).as_deref(),
        Some("visible")
    );
    assert_eq!(
        decode_dialogue_textout(br#""say \"yes\"""#).as_deref(),
        Some("say \"yes\"")
    );
    assert_eq!(decode_dialogue_textout(br#""""#), None);
}
