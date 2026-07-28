#[path = "support/real_corpus.rs"]
mod real_corpus;

#[test]
#[should_panic(expected = "real-bytes coverage is STRICT")]
fn missing_required_corpus_fails_loudly() {
    real_corpus::require_real_bytes("missing_required_corpus_fails_loudly");
}
