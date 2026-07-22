use super::*;

// --- Container parsing ------------------------------------------------------

pub(super) fn parse_container(
    profile_id: &str,
    container: &'static str,
    magic: &[u8; 14],
    declared: RuntimeCompression,
    bytes: &[u8],
) -> Result<ContainerDigest, RuntimeBoundaryDiagnostic> {
    let mut reader = Reader::new(bytes);

    // Magic.
    let observed_magic = reader.take(magic.len()).map_err(|detail| {
        RuntimeBoundaryDiagnostic::MalformedContainer {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail,
        }
    })?;
    if observed_magic != magic {
        return Err(RuntimeBoundaryDiagnostic::OutOfProfile {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail: "container magic does not match the supported runtime profile".to_string(),
        });
    }

    // Compression flag — the parser-boundary check that classifies out-of-profile.
    let flag = reader
        .u8()
        .map_err(|detail| RuntimeBoundaryDiagnostic::MalformedContainer {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail,
        })?;
    let observed = RuntimeCompression::from_wire(flag).ok_or_else(|| {
        RuntimeBoundaryDiagnostic::OutOfProfile {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail: format!("unknown compression flag {flag}"),
        }
    })?;
    if observed != RuntimeCompression::Uncompressed || observed != declared {
        return Err(RuntimeBoundaryDiagnostic::OutOfProfile {
            profile_id: profile_id.to_string(),
            container: container.to_string(),
            detail: format!(
                "compression {} is out of profile (declared {})",
                observed.as_str(),
                declared.as_str()
            ),
        });
    }

    // Record directory (scene: skip sceneId; both: u32 count + length-prefixed
    // records). We only need the record count + total byte length + a content
    // hash for the digest — no payload text enters the report.
    let malformed = |detail: String| RuntimeBoundaryDiagnostic::MalformedContainer {
        profile_id: profile_id.to_string(),
        container: container.to_string(),
        detail,
    };
    if container == "Scene.pck" {
        // Consume the sceneId scalar that Gameexe.dat does not carry.
        reader.u32().map_err(&malformed)?;
    }
    let record_count = reader.u32().map_err(&malformed)?;
    for _ in 0..record_count {
        let payload_len = reader.u32().map_err(&malformed)? as usize;
        reader.take(payload_len).map_err(&malformed)?;
    }

    Ok(ContainerDigest {
        container: container.to_string(),
        record_count,
        byte_len: u32::try_from(bytes.len()).unwrap_or(u32::MAX),
        content_hash: ProofHash::commit(bytes),
    })
}

// --- Synthetic fixture builders ---------------------------------------------

pub(super) fn build_scene_container(source: &RuntimeContainerSource) -> Vec<u8> {
    match source {
        RuntimeContainerSource::SyntheticInProfile => {
            let records: Vec<Vec<u8>> = FIXTURE_SCENE_UNITS
                .iter()
                .map(|text| utf16le_encode(text))
                .collect();
            build_record_container(
                SCENE_PCK_MAGIC,
                COMPRESSION_UNCOMPRESSED,
                Some(FIXTURE_SCENE_ID),
                &records,
            )
        }
        RuntimeContainerSource::SyntheticOutOfProfile => {
            build_out_of_profile_container(SCENE_PCK_MAGIC)
        }
    }
}

pub(super) fn build_gameexe_container(source: &RuntimeContainerSource) -> Vec<u8> {
    match source {
        RuntimeContainerSource::SyntheticInProfile => {
            let mut records: Vec<Vec<u8>> = Vec::with_capacity(FIXTURE_GAMEEXE_ENTRIES.len() * 2);
            for (key, value) in FIXTURE_GAMEEXE_ENTRIES {
                records.push(utf16le_encode(key));
                records.push(utf16le_encode(value));
            }
            build_record_container(GAMEEXE_DAT_MAGIC, COMPRESSION_UNCOMPRESSED, None, &records)
        }
        RuntimeContainerSource::SyntheticOutOfProfile => {
            build_out_of_profile_container(GAMEEXE_DAT_MAGIC)
        }
    }
}

fn build_record_container(
    magic: &[u8; 14],
    compression_flag: u8,
    scene_id: Option<u32>,
    records: &[Vec<u8>],
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(magic);
    bytes.push(compression_flag);
    if let Some(scene_id) = scene_id {
        bytes.extend_from_slice(&scene_id.to_le_bytes());
    }
    bytes.extend_from_slice(
        &u32::try_from(records.len())
            .expect("fixture record count fits in u32")
            .to_le_bytes(),
    );
    for record in records {
        bytes.extend_from_slice(
            &u32::try_from(record.len())
                .expect("record length fits in u32")
                .to_le_bytes(),
        );
        bytes.extend_from_slice(record);
    }
    bytes
}

/// A container flagged with the out-of-profile proprietary-LZSS compression.
/// The body is deliberately opaque: the boundary refuses it at the compression
/// flag, before any decode, so no fabricated LZSS stream exists here.
fn build_out_of_profile_container(magic: &[u8; 14]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(magic);
    bytes.push(COMPRESSION_LZSS);
    bytes.extend_from_slice(b"...out-of-profile-lzss-body-not-decoded...");
    bytes
}

fn utf16le_encode(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

// --- Byte reader ------------------------------------------------------------

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| format!("length overflow at byte {}", self.position))?;
        let slice = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| format!("truncated at byte {} (needed {count} more)", self.position))?;
        self.position = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

// --- Redaction-swept serialization ------------------------------------------

/// Serialize a value to compact JSON and run the substrate's local-path
/// redaction sweep over the serialized form. Returns the JSON string on success
/// or a stable error string on a serialization / redaction failure.
pub(super) fn stable_redacted_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json_value = serde_json::to_value(value)
        .map_err(|error| format!("runtime-profile report serialization failed: {error}"))?;
    reject_unredacted_local_paths("", &json_value)
        .map_err(|error| format!("runtime-profile report failed redaction sweep: {error}"))?;
    serde_json::to_string(&json_value)
        .map_err(|error| format!("runtime-profile report re-serialization failed: {error}"))
}
