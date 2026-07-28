use super::*;

// Reject-on-secret deep scan

/// A reject-on-secret finding (field/where only — never the leaked value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretLeakFinding {
    /// Where the leak was found (`output-bytes` / `report:<path>`).
    pub location: String,
    /// The class of leak (`raw-key` / `decrypted-text`).
    pub kind: String,
}

/// Deep-scan an about-to-be-written output container + its redacted report for
/// secret-shaped material: the raw key bytes, or any decrypted plaintext, must
/// NOT appear in either artifact. Returns findings (locations/kinds only). A
/// non-empty result means the write must be refused.
/// The plaintext probes are the in-memory decoded texts (original + translated);
/// they are NEVER persisted — only used here to prove they did not leak into the
/// output bytes (which hold only XOR-masked text) or the report (which holds only
/// hashes).
pub fn scan_for_secret_leak(
    key: &ResolvedSiglusKey,
    output_bytes: &[u8],
    report_json: &str,
    plaintext_probes: &[String],
) -> Vec<SecretLeakFinding> {
    let mut findings = Vec::new();

    // (1) Raw key must not appear in the output bytes.
    if key.material().appears_in(output_bytes) {
        findings.push(SecretLeakFinding {
            location: "output-bytes".to_string(),
            kind: "raw-key".to_string(),
        });
    }
    // (2) Raw key must not appear in the report bytes.
    if key.material().appears_in(report_json.as_bytes()) {
        findings.push(SecretLeakFinding {
            location: "report".to_string(),
            kind: "raw-key".to_string(),
        });
    }
    // (3) Decrypted plaintext must not appear (UTF-8 or UTF-16LE) in the output.
    for probe in plaintext_probes {
        if probe.is_empty() {
            continue;
        }
        let utf8 = probe.as_bytes();
        let utf16 = utf16le_encode(probe);
        if contains_window(output_bytes, utf8) || contains_window(output_bytes, &utf16) {
            findings.push(SecretLeakFinding {
                location: "output-bytes".to_string(),
                kind: "decrypted-text".to_string(),
            });
        }
        // The report is redacted and text-free; a raw probe string appearing in
        // it would be a redaction regression.
        if report_json.contains(probe.as_str()) {
            findings.push(SecretLeakFinding {
                location: "report".to_string(),
                kind: "decrypted-text".to_string(),
            });
        }
    }
    findings
}

fn contains_window(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}
