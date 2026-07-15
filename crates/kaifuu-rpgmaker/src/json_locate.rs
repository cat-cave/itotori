//! Byte-accurate JSON value locator + ASCII-safe string encoder.
//! The patchback writes reviewed translations into `www/data/*.json` at
//! exactly the JSON-pointer surfaces the extractor keyed. To keep the
//! file **byte-identical outside the targeted string surfaces**, we must
//! NOT round-trip the file through a serializer (that would churn key
//! order, whitespace, number formatting, and the `\uXXXX` escaping the
//! RPG Maker editor emits). Instead this module navigates the *raw bytes*
//! to the byte span of the target string literal so the driver can splice
//! only that span.
//! [`Scanner::locate`] takes a sequence of JSON-pointer tokens (object
//! keys / array indices, already RFC6901-decoded) and returns the
//! [`QuotedSpan`] of the leaf string value — the byte range covering the
//! whole `"..."` literal, including both quotes. Decoding (for key
//! comparison and source-text recovery) reuses `serde_json` on that exact
//! byte slice, so every escape form the editor uses is handled by the
//! same parser the runtime trusts.

use std::fmt;

/// Return JSON bytes without the optional UTF-8 BOM emitted by some RPG
/// Maker MV projects. The caller still owns the original byte slice, so raw
/// offsets remain stable when a [`Scanner`] uses the same bytes for patching.
pub(crate) fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

/// Byte range `[start, end)` covering a complete JSON string literal,
/// including the opening and closing quote bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuotedSpan {
    pub start: usize,
    pub end: usize,
}

/// Why a JSON-pointer surface could not be resolved against the current
/// bytes. Carries only structural description — never the retail string
/// content — so it is safe to surface in reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocateError {
    /// The byte stream ended mid-value.
    Truncated,
    /// A value was expected but the byte was not a valid value opener.
    ExpectedValue,
    /// The leaf (or a key) was expected to be a JSON string.
    ExpectedString,
    /// A `:` was expected after an object key.
    ExpectedColon,
    /// A `,` or container terminator was expected.
    ExpectedCommaOrEnd,
    /// The object did not contain the requested key.
    KeyNotFound { key: String },
    /// The array index was past the end of the array.
    IndexOutOfRange { index: usize, len: usize },
    /// An array was navigated with a token that is not a decimal index.
    NotAnIndex { token: String },
    /// A pointer token tried to descend into a scalar (not object/array).
    NotAContainer,
    /// `serde_json` could not decode a string literal located in the bytes.
    StringDecode,
}

impl fmt::Display for LocateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => write!(f, "JSON byte stream ended mid-value"),
            Self::ExpectedValue => write!(f, "expected a JSON value"),
            Self::ExpectedString => write!(f, "expected a JSON string"),
            Self::ExpectedColon => write!(f, "expected ':' after object key"),
            Self::ExpectedCommaOrEnd => write!(f, "expected ',' or container terminator"),
            Self::KeyNotFound { key } => write!(f, "object has no key {key:?}"),
            Self::IndexOutOfRange { index, len } => {
                write!(
                    f,
                    "array index {index} out of range (array has {len} elements)"
                )
            }
            Self::NotAnIndex { token } => {
                write!(f, "array pointer token {token:?} is not a decimal index")
            }
            Self::NotAContainer => write!(f, "pointer token tried to descend into a scalar value"),
            Self::StringDecode => write!(f, "string literal failed to decode as JSON"),
        }
    }
}

/// Cursor over raw JSON bytes.
pub struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            pos: bytes.len() - strip_utf8_bom(bytes).len(),
        }
    }

    /// Locate the leaf string literal at the given pointer tokens.
    pub fn locate(&mut self, tokens: &[String]) -> Result<QuotedSpan, LocateError> {
        self.skip_ws();
        for token in tokens {
            self.skip_ws();
            match self.peek()? {
                b'{' => self.enter_object(token)?,
                b'[' => self.enter_array(token)?,
                _ => return Err(LocateError::NotAContainer),
            }
        }
        self.skip_ws();
        if self.peek()? != b'"' {
            return Err(LocateError::ExpectedString);
        }
        self.scan_string_span()
    }

    /// Decode a previously-located string literal back to its text via
    /// `serde_json` (handles every escape form the editor may emit).
    pub fn decode_span(bytes: &[u8], span: QuotedSpan) -> Result<String, LocateError> {
        serde_json::from_slice::<String>(&bytes[span.start..span.end])
            .map_err(|_| LocateError::StringDecode)
    }

    fn peek(&self) -> Result<u8, LocateError> {
        self.bytes
            .get(self.pos)
            .copied()
            .ok_or(LocateError::Truncated)
    }

    fn skip_ws(&mut self) {
        while let Some(&c) = self.bytes.get(self.pos) {
            if matches!(c, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    /// Position the cursor at the start of the value bound to `token`
    /// inside the object the cursor currently opens (`{`).
    fn enter_object(&mut self, token: &str) -> Result<(), LocateError> {
        debug_assert_eq!(self.bytes.get(self.pos), Some(&b'{'));
        self.pos += 1; // consume '{'
        self.skip_ws();
        if self.peek()? == b'}' {
            return Err(LocateError::KeyNotFound {
                key: token.to_string(),
            });
        }
        loop {
            self.skip_ws();
            if self.peek()? != b'"' {
                return Err(LocateError::ExpectedString);
            }
            let key_span = self.scan_string_span()?;
            let key = Self::decode_span(self.bytes, key_span)?;
            self.skip_ws();
            if self.peek()? != b':' {
                return Err(LocateError::ExpectedColon);
            }
            self.pos += 1; // consume ':'
            self.skip_ws();
            if key == token {
                // Cursor sits on the value start.
                return Ok(());
            }
            self.skip_value()?;
            self.skip_ws();
            match self.peek()? {
                b',' => {
                    self.pos += 1;
                }
                b'}' => {
                    return Err(LocateError::KeyNotFound {
                        key: token.to_string(),
                    });
                }
                _ => return Err(LocateError::ExpectedCommaOrEnd),
            }
        }
    }

    /// Position the cursor at the start of the element at index `token`
    /// inside the array the cursor currently opens (`[`).
    fn enter_array(&mut self, token: &str) -> Result<(), LocateError> {
        debug_assert_eq!(self.bytes.get(self.pos), Some(&b'['));
        let index: usize = token.parse().map_err(|_| LocateError::NotAnIndex {
            token: token.to_string(),
        })?;
        self.pos += 1; // consume '['
        self.skip_ws();
        if self.peek()? == b']' {
            return Err(LocateError::IndexOutOfRange { index, len: 0 });
        }
        let mut current = 0usize;
        loop {
            self.skip_ws();
            if current == index {
                return Ok(());
            }
            self.skip_value()?;
            self.skip_ws();
            match self.peek()? {
                b',' => {
                    self.pos += 1;
                    current += 1;
                }
                b']' => {
                    return Err(LocateError::IndexOutOfRange {
                        index,
                        len: current + 1,
                    });
                }
                _ => return Err(LocateError::ExpectedCommaOrEnd),
            }
        }
    }

    /// Advance the cursor past one complete JSON value.
    fn skip_value(&mut self) -> Result<(), LocateError> {
        self.skip_ws();
        match self.peek()? {
            b'"' => {
                self.scan_string_span()?;
                Ok(())
            }
            b'{' => self.skip_object(),
            b'[' => self.skip_array(),
            b't' => self.skip_literal(b"true"),
            b'f' => self.skip_literal(b"false"),
            b'n' => self.skip_literal(b"null"),
            c if c == b'-' || c.is_ascii_digit() => {
                self.skip_number();
                Ok(())
            }
            _ => Err(LocateError::ExpectedValue),
        }
    }

    fn skip_object(&mut self) -> Result<(), LocateError> {
        self.pos += 1; // consume '{'
        self.skip_ws();
        if self.peek()? == b'}' {
            self.pos += 1;
            return Ok(());
        }
        loop {
            self.skip_ws();
            if self.peek()? != b'"' {
                return Err(LocateError::ExpectedString);
            }
            self.scan_string_span()?; // key
            self.skip_ws();
            if self.peek()? != b':' {
                return Err(LocateError::ExpectedColon);
            }
            self.pos += 1; // consume ':'
            self.skip_value()?;
            self.skip_ws();
            match self.peek()? {
                b',' => self.pos += 1,
                b'}' => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => return Err(LocateError::ExpectedCommaOrEnd),
            }
        }
    }

    fn skip_array(&mut self) -> Result<(), LocateError> {
        self.pos += 1; // consume '['
        self.skip_ws();
        if self.peek()? == b']' {
            self.pos += 1;
            return Ok(());
        }
        loop {
            self.skip_value()?;
            self.skip_ws();
            match self.peek()? {
                b',' => self.pos += 1,
                b']' => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => return Err(LocateError::ExpectedCommaOrEnd),
            }
        }
    }

    fn skip_literal(&mut self, word: &[u8]) -> Result<(), LocateError> {
        if self.pos + word.len() > self.bytes.len()
            || &self.bytes[self.pos..self.pos + word.len()] != word
        {
            return Err(LocateError::ExpectedValue);
        }
        self.pos += word.len();
        Ok(())
    }

    fn skip_number(&mut self) {
        while let Some(&c) = self.bytes.get(self.pos) {
            if c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.' | b'e' | b'E') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    /// Consume a complete string literal (the cursor must sit on the
    /// opening `"`). Returns its [`QuotedSpan`] and leaves the cursor just
    /// past the closing quote.
    fn scan_string_span(&mut self) -> Result<QuotedSpan, LocateError> {
        let start = self.pos;
        if self.peek()? != b'"' {
            return Err(LocateError::ExpectedString);
        }
        self.pos += 1; // consume opening quote
        loop {
            let c = self.peek()?;
            if c == b'\\' {
                // Skip the backslash and the byte it escapes. For \uXXXX
                // the four hex digits are ordinary (non-quote, non-
                // backslash) bytes consumed by later iterations.
                self.pos += 2;
                if self.pos > self.bytes.len() {
                    return Err(LocateError::Truncated);
                }
            } else if c == b'"' {
                self.pos += 1; // consume closing quote
                return Ok(QuotedSpan {
                    start,
                    end: self.pos,
                });
            } else {
                self.pos += 1;
            }
        }
    }
}

/// Encode `text` as a JSON string literal (including surrounding quotes)
/// using the **ASCII-safe** escaping convention the RPG Maker MV/MZ editor
/// emits: every codepoint `>= 0x80` becomes `\uXXXX` (surrogate pair for
/// astral codepoints), control codes below `0x20` use the short escapes
/// where defined and `\u00XX` otherwise, and `"`/`\` are backslash-escaped.
/// Printable ASCII passes through verbatim. This keeps a patched string
/// stylistically identical to the editor's own output.
pub fn encode_json_string_ascii_safe(text: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        let code = ch as u32;
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ if code < 0x20 => {
                let _ = write!(out, "\\u{code:04x}");
            }
            _ if code < 0x80 => out.push(ch),
            _ if code <= 0xFFFF => {
                let _ = write!(out, "\\u{code:04x}");
            }
            _ => {
                let v = code - 0x10000;
                let hi = 0xD800 + (v >> 10);
                let lo = 0xDC00 + (v & 0x3FF);
                let _ = write!(out, "\\u{hi:04x}\\u{lo:04x}");
            }
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locate_text(bytes: &[u8], tokens: &[&str]) -> Result<String, LocateError> {
        let owned: Vec<String> = tokens
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        let mut scanner = Scanner::new(bytes);
        let span = scanner.locate(&owned)?;
        Scanner::decode_span(bytes, span)
    }

    #[test]
    fn locates_nested_object_and_array_string() {
        let bytes = br#"{"a":[null,{"name":"hi","n":1}],"b":"x"}"#;
        assert_eq!(locate_text(bytes, &["a", "1", "name"]).unwrap(), "hi");
        assert_eq!(locate_text(bytes, &["b"]).unwrap(), "x");
    }

    #[test]
    fn locates_string_after_utf8_bom_without_shifting_raw_offsets() {
        let bytes = b"\xEF\xBB\xBF{\"name\":\"hi\"}";
        let owned = vec!["name".to_string()];
        let mut scanner = Scanner::new(bytes);
        let span = scanner.locate(&owned).unwrap();
        assert_eq!(&bytes[span.start..span.end], br#""hi""#);
        assert_eq!(Scanner::decode_span(bytes, span).unwrap(), "hi");
    }

    #[test]
    fn skips_strings_containing_braces_and_escaped_quotes() {
        let bytes = br#"{"k":"a\"}{b","target":"value"}"#;
        assert_eq!(locate_text(bytes, &["target"]).unwrap(), "value");
    }

    #[test]
    fn decodes_unicode_escapes_in_keys_and_values() {
        // {"あ":"い"} — raw-UTF-8 hiragana A maps to hiragana I.
        let bytes = "{\"\u{3042}\":\"\u{3044}\"}".as_bytes();
        assert_eq!(locate_text(bytes, &["\u{3042}"]).unwrap(), "\u{3044}");
    }

    #[test]
    fn missing_key_and_index_are_typed_errors() {
        let bytes = br#"{"a":[ "only" ]}"#;
        assert!(matches!(
            locate_text(bytes, &["missing"]),
            Err(LocateError::KeyNotFound { .. })
        ));
        assert!(matches!(
            locate_text(bytes, &["a", "5"]),
            Err(LocateError::IndexOutOfRange { .. })
        ));
    }

    #[test]
    fn non_string_leaf_is_rejected() {
        let bytes = br#"{"n":42}"#;
        assert!(matches!(
            locate_text(bytes, &["n"]),
            Err(LocateError::ExpectedString)
        ));
    }

    #[test]
    fn ascii_safe_encoder_escapes_non_ascii_and_preserves_ascii() {
        assert_eq!(encode_json_string_ascii_safe("Hi!"), r#""Hi!""#);
        // Non-ASCII is \u-escaped (matches the editor's ASCII-safe output).
        assert_eq!(encode_json_string_ascii_safe("\u{3042}"), "\"\\u3042\"");
        assert_eq!(encode_json_string_ascii_safe("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(encode_json_string_ascii_safe("\n"), r#""\n""#);
        // Astral codepoint (U+1F600) becomes a UTF-16 surrogate pair.
        assert_eq!(
            encode_json_string_ascii_safe("\u{1F600}"),
            "\"\\ud83d\\ude00\""
        );
    }

    #[test]
    fn encoder_output_round_trips_through_serde() {
        for sample in [
            "Hello",
            "\u{3042}\u{3044}\u{3046}",
            "tab\tend",
            "quote\"slash\\",
        ] {
            let encoded = encode_json_string_ascii_safe(sample);
            let decoded: String = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded, sample);
        }
    }
}
