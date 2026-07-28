pub fn require_real_bytes<T>(value: Option<T>, test_name: &str, identity: &str) -> T {
    value.unwrap_or_else(|| {
        panic!(
            "REAL-BYTES SKIP {test_name}: {identity} is unavailable; refusing a passing real-bytes proof without its required input"
        )
    })
}
