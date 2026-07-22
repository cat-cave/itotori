use super::*;

// Deliverable 1/3 support — SYNTHETIC RGSSAD v3 archive structure

/// One decoded RGSSAD directory entry + its decrypted payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgssadEntry {
    pub name: String,
    pub payload: Vec<u8>,
}

/// A typed RGSSAD decode error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RgssadError {
    BadMagic,
    BadVersion(u8),
    UnexpectedEof,
}

impl std::fmt::Display for RgssadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadMagic => f.write_str("not an RGSSAD archive"),
            Self::BadVersion(v) => write!(f, "unsupported RGSSAD version {v}"),
            Self::UnexpectedEof => f.write_str("unexpected end of RGSSAD archive"),
        }
    }
}

impl std::error::Error for RgssadError {}

/// XOR a data payload against the advancing per-file keystream (word-wise, LE),
/// starting from `file_key`. Self-inverse, so the same routine encrypts and
/// decrypts.
fn rgssad_xor_payload(scheme: Rgss3XorKeystreamScheme, file_key: u32, data: &mut [u8]) {
    let mut key = file_key;
    for chunk in data.chunks_mut(4) {
        let key_bytes = key.to_le_bytes();
        for (byte, key_byte) in chunk.iter_mut().zip(key_bytes.iter()) {
            *byte ^= key_byte;
        }
        key = scheme.advance(key);
    }
}

/// Build a SYNTHETIC RGSSAD v3 (`.rgss3a`) archive from KNOWN entries: header
/// (`RGSSAD\0` + version 3 + seed), a directory of XOR-obfuscated entries, and
/// per-file XOR-keystream-encrypted payloads. Deterministic; no retail bytes.
pub fn build_synthetic_rgss3a(
    scheme: Rgss3XorKeystreamScheme,
    seed: u32,
    entries: &[(&str, &[u8])],
) -> Vec<u8> {
    let base_key = scheme.base_key(seed);

    // Directory record size: offset+size+file_key+name_len (4 u32) + name bytes.
    let mut dir_size = 0usize;
    for (name, _) in entries {
        dir_size += 16 + name.len();
    }
    // Header (7 magic + 1 version + 4 seed) + directory + terminator (one u32).
    let data_start = 8 + 4 + dir_size + 4;

    let mut out = Vec::new();
    out.extend_from_slice(&RGSSAD_MAGIC);
    out.push(RGSS3_ARCHIVE_VERSION);
    out.extend_from_slice(&seed.to_le_bytes());

    // Assign a distinct per-file key + running offset to each entry.
    let mut offset = data_start as u32;
    let mut file_keys = Vec::with_capacity(entries.len());
    let mut offsets = Vec::with_capacity(entries.len());
    for (index, (_, payload)) in entries.iter().enumerate() {
        let file_key = base_key
            .wrapping_add((index as u32).wrapping_mul(0x0100_0193))
            .wrapping_add(1);
        file_keys.push(file_key);
        offsets.push(offset);
        offset = offset.wrapping_add(payload.len() as u32);
    }

    // Write the directory (each u32 + the name bytes XOR the base key).
    let push_masked_u32 = |out: &mut Vec<u8>, value: u32| {
        out.extend_from_slice(&(value ^ base_key).to_le_bytes());
    };
    for (index, (name, _)) in entries.iter().enumerate() {
        push_masked_u32(&mut out, offsets[index]);
        push_masked_u32(&mut out, entries[index].1.len() as u32);
        push_masked_u32(&mut out, file_keys[index]);
        push_masked_u32(&mut out, name.len() as u32);
        let key_bytes = base_key.to_le_bytes();
        for (i, byte) in name.as_bytes().iter().enumerate() {
            out.push(byte ^ key_bytes[i % 4]);
        }
    }
    // Terminator: an offset of 0 marks end-of-directory (masked).
    push_masked_u32(&mut out, 0);

    // Write each encrypted payload at its offset (they are contiguous here).
    for (index, (_, payload)) in entries.iter().enumerate() {
        let mut data = payload.to_vec();
        rgssad_xor_payload(scheme, file_keys[index], &mut data);
        debug_assert_eq!(out.len(), offsets[index] as usize);
        out.extend_from_slice(&data);
    }
    out
}

/// Decode a SYNTHETIC RGSSAD v3 archive built by [`build_synthetic_rgss3a`]
/// back into its directory + decrypted payloads. Typed errors, never a panic.
pub fn decode_synthetic_rgss3a(
    scheme: Rgss3XorKeystreamScheme,
    bytes: &[u8],
) -> Result<Vec<RgssadEntry>, RgssadError> {
    if bytes.len() < 8 || bytes[0..7] != RGSSAD_MAGIC {
        return Err(RgssadError::BadMagic);
    }
    let version = bytes[7];
    if version != RGSS3_ARCHIVE_VERSION {
        return Err(RgssadError::BadVersion(version));
    }
    let read_u32 = |bytes: &[u8], at: usize| -> Result<u32, RgssadError> {
        let slice = bytes.get(at..at + 4).ok_or(RgssadError::UnexpectedEof)?;
        Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    };

    let seed = read_u32(bytes, 8)?;
    let base_key = scheme.base_key(seed);
    let key_bytes = base_key.to_le_bytes();

    let mut pos = 12;
    let mut records = Vec::new();
    loop {
        let offset = read_u32(bytes, pos)? ^ base_key;
        pos += 4;
        if offset == 0 {
            break;
        }
        let size = read_u32(bytes, pos)? ^ base_key;
        pos += 4;
        let file_key = read_u32(bytes, pos)? ^ base_key;
        pos += 4;
        let name_len = (read_u32(bytes, pos)? ^ base_key) as usize;
        pos += 4;
        let name_raw = bytes
            .get(pos..pos + name_len)
            .ok_or(RgssadError::UnexpectedEof)?;
        let name: String = name_raw
            .iter()
            .enumerate()
            .map(|(i, byte)| (byte ^ key_bytes[i % 4]) as char)
            .collect();
        pos += name_len;
        records.push((name, offset as usize, size as usize, file_key));
    }

    let mut entries = Vec::with_capacity(records.len());
    for (name, offset, size, file_key) in records {
        let mut payload = bytes
            .get(offset..offset + size)
            .ok_or(RgssadError::UnexpectedEof)?
            .to_vec();
        rgssad_xor_payload(scheme, file_key, &mut payload);
        entries.push(RgssadEntry { name, payload });
    }
    Ok(entries)
}
