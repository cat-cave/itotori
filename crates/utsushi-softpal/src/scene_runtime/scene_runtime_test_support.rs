    use super::*;
    use kaifuu_softpal::{
        FILEDAT_MAGIC_TAIL, FILEDAT_SLOT_BYTE_LEN, PAC_HEADER_BYTE_LEN, PAC_INDEX_ENTRY_BYTE_LEN,
        SCRIPT_MAGIC_PREFIX, TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL,
    };

    fn op(id: u16) -> [u8; 4] {
        let mut token = [0; 4];
        token[..2].copy_from_slice(&id.to_le_bytes());
        token[2..].copy_from_slice(&1_u16.to_le_bytes());
        token
    }
    fn word(value: u32) -> [u8; 4] {
        value.to_le_bytes()
    }
    fn program(tokens: &[[u8; 4]]) -> Vec<u8> {
        let mut bytes = Vec::from(&SCRIPT_MAGIC_PREFIX[..]);
        bytes.extend_from_slice(b"20");
        bytes.extend_from_slice(&[0; 8]);
        for token in tokens {
            bytes.extend_from_slice(token);
        }
        bytes
    }
    fn textdat() -> (Vec<u8>, u32) {
        let mut bytes = vec![TEXTDAT_FLAG_PLAINTEXT];
        bytes.extend_from_slice(TEXTDAT_MAGIC_TAIL);
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        let pointer = bytes.len() as u32;
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(b"line\0");
        (bytes, pointer)
    }
    fn filedat(slots: &[&str]) -> Vec<u8> {
        let mut bytes = Vec::from(*b"_");
        bytes.extend_from_slice(FILEDAT_MAGIC_TAIL);
        bytes.extend_from_slice(&(slots.len() as u32).to_le_bytes());
        for value in slots {
            let mut slot = [0_u8; FILEDAT_SLOT_BYTE_LEN];
            slot[..value.len()].copy_from_slice(value.as_bytes());
            bytes.extend_from_slice(&slot);
        }
        bytes
    }
    fn pac(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let index_end = PAC_HEADER_BYTE_LEN + entries.len() * PAC_INDEX_ENTRY_BYTE_LEN;
        let mut bytes = vec![0_u8; index_end];
        bytes[..4].copy_from_slice(b"PAC ");
        bytes[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes());
        let mut payload_offset = index_end;
        for (index, (name, payload)) in entries.iter().enumerate() {
            let entry_offset = PAC_HEADER_BYTE_LEN + index * PAC_INDEX_ENTRY_BYTE_LEN;
            bytes[entry_offset..entry_offset + name.len()].copy_from_slice(name.as_bytes());
            bytes[entry_offset + 32..entry_offset + 36]
                .copy_from_slice(&(payload.len() as u32).to_le_bytes());
            bytes[entry_offset + 36..entry_offset + 40]
                .copy_from_slice(&(payload_offset as u32).to_le_bytes());
            payload_offset += payload.len();
        }
        for (_, payload) in entries {
            bytes.extend_from_slice(payload);
        }
        bytes
    }

