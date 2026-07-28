impl<'a> ByteCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], WolfEncryptedSmokeError> {
        let end = self.offset.checked_add(len).ok_or_else(|| {
            WolfEncryptedSmokeError::ContainerFormat {
                detail: "synthetic archive cursor overflowed".to_string(),
            }
        })?;
        if end > self.bytes.len() {
            return Err(WolfEncryptedSmokeError::ContainerFormat {
                detail: "synthetic archive ended early".to_string(),
            });
        }
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn read_u32(&mut self) -> Result<u32, WolfEncryptedSmokeError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .expect("take(4) returns four bytes");
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_u64(&mut self) -> Result<u64, WolfEncryptedSmokeError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .expect("take(8) returns eight bytes");
        Ok(u64::from_le_bytes(bytes))
    }

    fn is_finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}


