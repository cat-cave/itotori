use super::{
    COMPRESSION_LZSS, COMPRESSION_UNCOMPRESSED, GAMEEXE_SMOKE_MAGIC, SCENE_SMOKE_MAGIC,
    model::{KnownKeyMaterial, KnownKeySmokeError, SiglusKnownKeyCompression},
};

pub(super) fn build_gameexe_container(
    compression: SiglusKnownKeyCompression,
    records: &[(Vec<u8>, Vec<u8>)],
) -> Vec<u8> {
    let flag = match compression {
        SiglusKnownKeyCompression::Uncompressed => COMPRESSION_UNCOMPRESSED,
        SiglusKnownKeyCompression::Lzss => COMPRESSION_LZSS,
    };
    let mut bytes = Vec::new();
    bytes.extend_from_slice(GAMEEXE_SMOKE_MAGIC);
    bytes.push(flag);
    bytes.extend_from_slice(
        &u32::try_from(records.len())
            .expect("gameexe entry count fits in u32")
            .to_le_bytes(),
    );
    for (enc_key, enc_val) in records {
        push_encrypted_slice(&mut bytes, enc_key);
        push_encrypted_slice(&mut bytes, enc_val);
    }
    bytes
}

fn push_encrypted_slice(bytes: &mut Vec<u8>, encrypted: &[u8]) {
    bytes.extend_from_slice(
        &u32::try_from(encrypted.len())
            .expect("encrypted slice length fits in u32")
            .to_le_bytes(),
    );
    bytes.extend_from_slice(encrypted);
}

pub(super) fn build_scene_container(
    scene_id: u32,
    compression: SiglusKnownKeyCompression,
    records: &[(u32, Vec<u8>)],
) -> Vec<u8> {
    let flag = match compression {
        SiglusKnownKeyCompression::Uncompressed => COMPRESSION_UNCOMPRESSED,
        SiglusKnownKeyCompression::Lzss => COMPRESSION_LZSS,
    };
    let mut bytes = Vec::new();
    bytes.extend_from_slice(SCENE_SMOKE_MAGIC);
    bytes.push(flag);
    bytes.extend_from_slice(&scene_id.to_le_bytes());
    bytes.extend_from_slice(
        &u32::try_from(records.len())
            .expect("scene unit count fits in u32")
            .to_le_bytes(),
    );
    for (unit_index, encrypted) in records {
        bytes.extend_from_slice(&unit_index.to_le_bytes());
        bytes.extend_from_slice(
            &u32::try_from(encrypted.len())
                .expect("encrypted unit length fits in u32")
                .to_le_bytes(),
        );
        bytes.extend_from_slice(encrypted);
    }
    bytes
}

pub(super) struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], KnownKeySmokeError> {
        let end = self
            .position
            .checked_add(count)
            .ok_or(KnownKeySmokeError::Truncated {
                byte_offset: self.position,
                needed: count,
            })?;
        let slice = self
            .bytes
            .get(self.position..end)
            .ok_or(KnownKeySmokeError::Truncated {
                byte_offset: self.position,
                needed: end.saturating_sub(self.bytes.len()),
            })?;
        self.position = end;
        Ok(slice)
    }

    pub(super) fn expect_magic(
        &mut self,
        magic: &[u8; 14],
        expected: &'static str,
    ) -> Result<(), KnownKeySmokeError> {
        let observed = self.take(magic.len())?;
        if observed == magic {
            Ok(())
        } else {
            Err(KnownKeySmokeError::BadMagic { expected })
        }
    }

    pub(super) fn u8(&mut self) -> Result<u8, KnownKeySmokeError> {
        Ok(self.take(1)?[0])
    }

    pub(super) fn u32(&mut self) -> Result<u32, KnownKeySmokeError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    /// A length-prefixed still-encrypted text slice (borrowed).
    pub(super) fn encrypted_slice(&mut self) -> Result<&'a [u8], KnownKeySmokeError> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    /// A length-prefixed encrypted UTF-16LE text unit, decrypted + decoded.
    pub(super) fn encrypted_utf16le(
        &mut self,
        key: &KnownKeyMaterial,
    ) -> Result<String, KnownKeySmokeError> {
        let offset = self.position;
        let encrypted = self.encrypted_slice()?;
        let plaintext = key.xor_cycle(encrypted);
        utf16le_decode(&plaintext, offset)
    }
}

pub(crate) fn utf16le_encode(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

pub(super) fn utf16le_decode(
    bytes: &[u8],
    byte_offset: usize,
) -> Result<String, KnownKeySmokeError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(KnownKeySmokeError::InvalidUtf16Le { byte_offset });
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).map_err(|_| KnownKeySmokeError::InvalidUtf16Le { byte_offset })
}

pub(super) fn source_unit_key(scene_id: u32, unit_index: u32) -> String {
    format!("siglus:scene-{scene_id:04}#{unit_index:04}")
}

/// Parse just the unit index out of a canonical `siglus:scene-NNNN#OOOO` key.
/// Used by the adapter to identify edited units.
pub(crate) fn parse_source_unit_index(key: &str) -> Result<u32, KnownKeySmokeError> {
    parse_source_unit_key(key).map(|(_, unit_index)| unit_index)
}

pub(super) fn parse_source_unit_key(key: &str) -> Result<(u32, u32), KnownKeySmokeError> {
    let malformed = || KnownKeySmokeError::BadUnitKey {
        source_unit_key: key.to_string(),
    };
    let rest = key.strip_prefix("siglus:scene-").ok_or_else(malformed)?;
    let (scene, unit) = rest.split_once('#').ok_or_else(malformed)?;
    let scene_id = scene.parse::<u32>().map_err(|_| malformed())?;
    let unit_index = unit.parse::<u32>().map_err(|_| malformed())?;
    Ok((scene_id, unit_index))
}
