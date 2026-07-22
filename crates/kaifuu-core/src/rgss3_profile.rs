//! RGSS3 / RGSSAD (RPG Maker VX Ace) layered-transform profile.
//! This module establishes the *tested transform boundaries* a production
//! RGSS3 adapter will later be built on. It is deliberately a PROFILE +
//! FIXTURE scaffold, not a full extraction/patching adapter: it pins the
//! RGSS3 transform stack as [layered-transform profile fields][`Rgss3LayeredTransformProfile`],
//! decodes a SYNTHETIC RGSSAD v3 archive structure and a SYNTHETIC Ruby
//! Marshal 4.8 blob to their structure (deterministically, no retail bytes),
//! and represents the binary-patcher patch-back risks as
//! [checked dependency constraints][`Rgss3PatchBackDependency`].
//! RGSS3 / VX Ace is its OWN engine family (`rgss3`) — distinct from RPG Maker
//! MV/MZ (`rpg_maker_mv_mz*`, JSON text + XOR-masked media). It shares only the
//! "RPG Maker" brand, not the container/codec/crypto:
//! | Layer | RGSS3 / VX Ace (this module) |
//! | container | RGSSAD archive (`.rgss3a`, magic `RGSSAD\0` v3) |
//! | crypto | per-file XOR keystream seeded from a base key |
//! | codec | Ruby Marshal 4.8 (`.rvdata2`); Scripts +zlib |
//! | surface | archive-entry / string table |
//! | patch-back | repack archive (reproduce keystream + offsets) |
//! The shared transform vocabulary already carries the tokens this family
//! needs ([`ContainerTransform::Rgssad`], [`CryptoTransform::Xor`],
//! [`CodecTransform::RubyMarshal`], [`PatchBackTransform::RepackArchive`]), and
//! the [`crate::packed_engine_readiness`] validator already checks a
//! `rgss3` readiness profile against those. This module goes one layer deeper:
//! it makes the RGSSAD keystream and the Ruby Marshal decode *executable and
//! tested* so the adapter starts from a real, proven boundary.
//! # Fidelity boundary (honest scoping)
//! The RGSSAD keystream constants and the Marshal subset modelled here are a
//! FAITHFUL-SHAPED synthetic scheme: the seed→key derivation, the per-file key,
//! and the advancing `k = k*7 + 3` keystream match the documented RGSSAD v3
//! shape, and the Marshal reader implements the real 4.8 integer/string/symbol/
//! array/hash/ivar grammar. Before a production adapter claims real-title
//! extraction, the exact constants MUST be validated against an oracle
//! (GARbro's `Rgssad` reader / rlvm) on real bytes — that validation is the
//! adapter's job, not this scaffold's. Everything here is exercised only on
//! bytes this module itself synthesises from known values.

use serde::{Deserialize, Serialize};

use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, OperationStatus,
    PartialDiagnosticSeverity, PatchBackTransform, SemanticErrorCode, SurfaceTransform,
    redact_for_log_or_report, stable_json,
};

/// Schema version of the RGSS3 profile record.
pub const RGSS3_PROFILE_SCHEMA_VERSION: &str = "0.1.0";

/// The canonical engine-family token for RPG Maker VX Ace / RGSS3.
pub const RGSS3_ENGINE_FAMILY: &str = "rgss3";

/// The RGSSAD archive signature: the 6 ASCII bytes `RGSSAD`, a `\0`, then the
/// version byte. VX Ace (`.rgss3a`) is version 3.
pub const RGSSAD_MAGIC: [u8; 7] = *b"RGSSAD\0";

/// The RGSSAD archive version RPG Maker VX Ace writes.
pub const RGSS3_ARCHIVE_VERSION: u8 = 3;

/// The Ruby Marshal format version VX Ace `.rvdata2` files carry (major.minor).
pub const RUBY_MARSHAL_VERSION: (u8, u8) = (4, 8);

#[path = "rgss3_profile/profile.rs"]
mod profile;
pub use profile::{
    Rgss3LayeredTransformProfile, Rgss3PatchBackDependency, Rgss3PatchBackDependencyDecl,
    Rgss3ProfileFinding, Rgss3ProfileReport, Rgss3XorKeystreamScheme, validate_rgss3_profile,
};

// Deliverable 2 — Ruby Marshal 4.8 reader/writer over a bounded subset

/// A decoded Ruby Marshal value over the bounded subset VX Ace `.rvdata2`
/// structure needs: nil, booleans, `Fixnum`, byte strings, symbols, arrays,
/// and hashes. `IVAR`-wrapped strings (encoding metadata) and symbol back-links
/// are read transparently; the writer emits the canonical link-free form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarshalValue {
    Nil,
    Bool(bool),
    /// A Ruby `Fixnum` (the Marshal `long` encoding).
    Int(i64),
    /// A Ruby `String` — Marshal carries raw bytes; encoding is an ivar.
    ByteString(Vec<u8>),
    Symbol(String),
    Array(Vec<MarshalValue>),
    /// A Ruby `Hash`, preserving insertion order (Marshal is order-significant).
    Hash(Vec<(MarshalValue, MarshalValue)>),
}

impl MarshalValue {
    /// A lossy UTF-8 view of a byte string (VX Ace strings are UTF-8).
    pub fn as_str_lossy(&self) -> Option<String> {
        match self {
            Self::ByteString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }
}

/// A typed Marshal decode error — never a panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarshalError {
    UnexpectedEof,
    BadVersion { major: u8, minor: u8 },
    UnsupportedType(u8),
    BadSymbolLink(i64),
    NonSymbolHashOrIvarKey,
}

impl std::fmt::Display for MarshalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEof => f.write_str("unexpected end of Marshal stream"),
            Self::BadVersion { major, minor } => {
                write!(f, "unsupported Marshal version {major}.{minor}")
            }
            Self::UnsupportedType(tag) => write!(f, "unsupported Marshal type tag 0x{tag:02x}"),
            Self::BadSymbolLink(index) => write!(f, "symbol back-link {index} out of range"),
            Self::NonSymbolHashOrIvarKey => {
                f.write_str("expected a symbol key in a hash or ivar block")
            }
        }
    }
}

impl std::error::Error for MarshalError {}

struct MarshalReader<'a> {
    bytes: &'a [u8],
    pos: usize,
    symbols: Vec<String>,
}

impl<'a> MarshalReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            pos: 0,
            symbols: Vec::new(),
        }
    }

    fn next_u8(&mut self) -> Result<u8, MarshalError> {
        let byte = *self
            .bytes
            .get(self.pos)
            .ok_or(MarshalError::UnexpectedEof)?;
        self.pos += 1;
        Ok(byte)
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], MarshalError> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or(MarshalError::UnexpectedEof)?;
        let slice = self
            .bytes
            .get(self.pos..end)
            .ok_or(MarshalError::UnexpectedEof)?;
        self.pos = end;
        Ok(slice)
    }

    /// The Marshal `long` integer encoding (also used for lengths + counts).
    fn read_long(&mut self) -> Result<i64, MarshalError> {
        let c = self.next_u8()? as i8;
        if c == 0 {
            return Ok(0);
        }
        if c > 0 {
            if c > 4 {
                return Ok(i64::from(c) - 5);
            }
            let mut value: i64 = 0;
            for i in 0..c as usize {
                value |= i64::from(self.next_u8()?) << (8 * i);
            }
            Ok(value)
        } else {
            if c < -4 {
                return Ok(i64::from(c) + 5);
            }
            let n = (-c) as usize;
            let mut value: i64 = -1;
            for i in 0..n {
                value &= !(0xffi64 << (8 * i));
                value |= i64::from(self.next_u8()?) << (8 * i);
            }
            Ok(value)
        }
    }

    fn read_byte_seq(&mut self) -> Result<Vec<u8>, MarshalError> {
        let len = self.read_long()?;
        let len = usize::try_from(len).map_err(|_| MarshalError::UnexpectedEof)?;
        Ok(self.take(len)?.to_vec())
    }

    fn read_symbol_define(&mut self) -> Result<String, MarshalError> {
        let bytes = self.read_byte_seq()?;
        let symbol = String::from_utf8_lossy(&bytes).into_owned();
        self.symbols.push(symbol.clone());
        Ok(symbol)
    }

    fn read_value(&mut self) -> Result<MarshalValue, MarshalError> {
        let tag = self.next_u8()?;
        match tag {
            b'0' => Ok(MarshalValue::Nil),
            b'T' => Ok(MarshalValue::Bool(true)),
            b'F' => Ok(MarshalValue::Bool(false)),
            b'i' => Ok(MarshalValue::Int(self.read_long()?)),
            b'"' => Ok(MarshalValue::ByteString(self.read_byte_seq()?)),
            b':' => Ok(MarshalValue::Symbol(self.read_symbol_define()?)),
            b';' => {
                let index = self.read_long()?;
                let symbol = usize::try_from(index)
                    .ok()
                    .and_then(|i| self.symbols.get(i).cloned())
                    .ok_or(MarshalError::BadSymbolLink(index))?;
                Ok(MarshalValue::Symbol(symbol))
            }
            b'[' => {
                let count = self.read_long()?;
                let count = usize::try_from(count).map_err(|_| MarshalError::UnexpectedEof)?;
                let mut items = Vec::with_capacity(count);
                for _ in 0..count {
                    items.push(self.read_value()?);
                }
                Ok(MarshalValue::Array(items))
            }
            b'{' => {
                let count = self.read_long()?;
                let count = usize::try_from(count).map_err(|_| MarshalError::UnexpectedEof)?;
                let mut pairs = Vec::with_capacity(count);
                for _ in 0..count {
                    let key = self.read_value()?;
                    let value = self.read_value()?;
                    pairs.push((key, value));
                }
                Ok(MarshalValue::Hash(pairs))
            }
            // IVAR wrapper: an object followed by its instance variables. VX Ace
            // strings carry an `:E`/`:encoding` ivar. Decode the inner object,
            // then transparently consume (and discard) the ivar block.
            b'I' => {
                let inner = self.read_value()?;
                let ivar_count = self.read_long()?;
                let ivar_count =
                    usize::try_from(ivar_count).map_err(|_| MarshalError::UnexpectedEof)?;
                for _ in 0..ivar_count {
                    // Key must be a symbol; value is discarded.
                    match self.read_value()? {
                        MarshalValue::Symbol(_) => {}
                        _ => return Err(MarshalError::NonSymbolHashOrIvarKey),
                    }
                    let _ = self.read_value()?;
                }
                Ok(inner)
            }
            other => Err(MarshalError::UnsupportedType(other)),
        }
    }
}

/// Decode a full Ruby Marshal 4.8 stream (with the `\x04\x08` header) into its
/// structure. Bounded to the VX Ace `.rvdata2` subset; unsupported type tags
/// are a typed error, never a panic.
pub fn read_marshal(bytes: &[u8]) -> Result<MarshalValue, MarshalError> {
    let mut reader = MarshalReader::new(bytes);
    let major = reader.next_u8()?;
    let minor = reader.next_u8()?;
    if (major, minor) != RUBY_MARSHAL_VERSION {
        return Err(MarshalError::BadVersion { major, minor });
    }
    reader.read_value()
}

/// Append the Marshal `long` encoding of `n`.
fn write_long(n: i64, out: &mut Vec<u8>) {
    if n == 0 {
        out.push(0);
        return;
    }
    if n > 0 {
        if n <= 122 {
            out.push((n + 5) as u8);
            return;
        }
        let mut buf = Vec::new();
        let mut value = n as u64;
        while value > 0 {
            buf.push((value & 0xff) as u8);
            value >>= 8;
        }
        out.push(buf.len() as u8);
        out.extend_from_slice(&buf);
    } else {
        if n >= -123 {
            out.push((n - 5) as i8 as u8);
            return;
        }
        let mut buf = Vec::new();
        let mut value = n;
        loop {
            let byte = (value & 0xff) as u8;
            buf.push(byte);
            value >>= 8; // arithmetic shift preserves sign
            if value == -1 && (byte & 0x80) != 0 {
                break;
            }
        }
        out.push((-(buf.len() as i64)) as i8 as u8);
        out.extend_from_slice(&buf);
    }
}

fn write_value(value: &MarshalValue, out: &mut Vec<u8>) {
    match value {
        MarshalValue::Nil => out.push(b'0'),
        MarshalValue::Bool(true) => out.push(b'T'),
        MarshalValue::Bool(false) => out.push(b'F'),
        MarshalValue::Int(n) => {
            out.push(b'i');
            write_long(*n, out);
        }
        MarshalValue::ByteString(bytes) => {
            out.push(b'"');
            write_long(bytes.len() as i64, out);
            out.extend_from_slice(bytes);
        }
        MarshalValue::Symbol(name) => {
            out.push(b':');
            write_long(name.len() as i64, out);
            out.extend_from_slice(name.as_bytes());
        }
        MarshalValue::Array(items) => {
            out.push(b'[');
            write_long(items.len() as i64, out);
            for item in items {
                write_value(item, out);
            }
        }
        MarshalValue::Hash(pairs) => {
            out.push(b'{');
            write_long(pairs.len() as i64, out);
            for (key, val) in pairs {
                write_value(key, out);
                write_value(val, out);
            }
        }
    }
}

/// Encode a value to a canonical Ruby Marshal 4.8 stream (link-free: symbols
/// are written in full each time, no ivar wrappers). For a value that was
/// itself decoded from a canonical stream, this is the inverse of
/// [`read_marshal`] — the structure-preservation guarantee the
/// [`Rgss3PatchBackDependency::MarshalStructurePreserved`] dependency depends on.
pub fn write_marshal(value: &MarshalValue) -> Vec<u8> {
    let mut out = vec![RUBY_MARSHAL_VERSION.0, RUBY_MARSHAL_VERSION.1];
    write_value(value, &mut out);
    out
}

/// Build a SYNTHETIC `.rvdata2`-shaped Marshal blob from KNOWN values: an array
/// modelling a VX Ace `System`-style record — an id, a title string, a symbol
/// tag, and a nested hash mapping a symbol to a string. No retail bytes.
pub fn synthetic_rvdata2_value() -> MarshalValue {
    MarshalValue::Array(vec![
        MarshalValue::Int(3),
        MarshalValue::ByteString(b"synthetic game title".to_vec()),
        MarshalValue::Symbol("vx_ace".to_string()),
        MarshalValue::Hash(vec![
            (
                MarshalValue::Symbol("greeting".to_string()),
                MarshalValue::ByteString("hello world".as_bytes().to_vec()),
            ),
            (
                MarshalValue::Symbol("enabled".to_string()),
                MarshalValue::Bool(true),
            ),
            (
                MarshalValue::Symbol("nothing".to_string()),
                MarshalValue::Nil,
            ),
        ]),
    ])
}

#[path = "rgss3_profile/archive.rs"]
mod archive;
pub use archive::{RgssadEntry, RgssadError, build_synthetic_rgss3a, decode_synthetic_rgss3a};

#[cfg(test)]
#[path = "rgss3_profile/tests.rs"]
mod tests;
