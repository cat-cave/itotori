fn decode_str_bank(bank: BankId, payload: &str) -> Result<BTreeMap<u16, Vec<u8>>, String> {
    let wire: StrBankWire =
        serde_json::from_str(payload).map_err(|err| format!("malformed str-bank JSON: {err}"))?;
    if wire.bank != bank.as_str() {
        return Err(format!(
            "str-bank payload labelled {:?} does not match path-bank {:?}",
            wire.bank,
            bank.as_str()
        ));
    }
    let mut slots = BTreeMap::new();
    for entry in wire.entries {
        if entry.idx >= BANK_INDEX_CAP {
            return Err(format!(
                "str-bank entry idx {} >= cap {}",
                entry.idx, BANK_INDEX_CAP
            ));
        }
        let bytes = hex_to_bytes(&entry.bytes_hex)?;
        slots.insert(entry.idx, bytes);
    }
    Ok(slots)
}


