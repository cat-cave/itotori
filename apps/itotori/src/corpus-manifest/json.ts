// Strict JSON parsing for private corpus manifests.
//
// JSON.parse intentionally accepts duplicate object keys and retains only the
// last one. That is unsafe for a metadata-only manifest: a copyrighted payload
// can be hidden in an earlier duplicate key, then disappear before the privacy
// scan and content-address hash run. Scan the raw JSON grammar first and reject
// duplicate *decoded* object keys before handing it to JSON.parse.

/** Parse JSON only when every object has unique decoded property names. */
export function parseStrictJson(raw: string): unknown {
  new DuplicateKeyRejectingJsonScanner(raw).scan();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Do not include any portion of the manifest in this error: callers may
    // surface it in logs, and malformed input can itself contain source bytes.
    throw new Error("corpus manifest JSON is invalid");
  }
}

/**
 * A deliberately small JSON grammar scanner. It validates enough grammar to
 * walk every object and decodes each property name with JSON's own string
 * semantics before Set membership is checked. The final JSON.parse remains the
 * authority for materializing the value after the raw duplicate-key gate.
 */
class DuplicateKeyRejectingJsonScanner {
  private offset = 0;

  constructor(private readonly raw: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.offset !== this.raw.length) {
      this.invalidJson();
    }
  }

  private scanValue(): void {
    this.skipWhitespace();
    switch (this.peek()) {
      case "{":
        this.scanObject();
        return;
      case "[":
        this.scanArray();
        return;
      case '"':
        this.scanString();
        return;
      case "t":
        this.scanLiteral("true");
        return;
      case "f":
        this.scanLiteral("false");
        return;
      case "n":
        this.scanLiteral("null");
        return;
      default:
        this.scanNumber();
    }
  }

  private scanObject(): void {
    this.expect("{");
    this.skipWhitespace();
    if (this.consume("}")) {
      return;
    }

    const keys = new Set<string>();
    while (true) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        this.invalidJson();
      }
      const key = this.scanString();
      if (keys.has(key)) {
        // Keep this content-free: a duplicate key itself could be a payload.
        throw new Error("corpus manifest rejected: duplicate JSON object key");
      }
      keys.add(key);

      this.skipWhitespace();
      this.expect(":");
      this.scanValue();
      this.skipWhitespace();
      if (this.consume("}")) {
        return;
      }
      this.expect(",");
    }
  }

  private scanArray(): void {
    this.expect("[");
    this.skipWhitespace();
    if (this.consume("]")) {
      return;
    }

    while (true) {
      this.scanValue();
      this.skipWhitespace();
      if (this.consume("]")) {
        return;
      }
      this.expect(",");
    }
  }

  /** Scan and decode one valid JSON string token without exposing raw input. */
  private scanString(): string {
    const start = this.offset;
    this.expect('"');
    while (this.offset < this.raw.length) {
      const code = this.raw.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset += 1;
        try {
          const decoded = JSON.parse(this.raw.slice(start, this.offset)) as unknown;
          if (typeof decoded !== "string") {
            this.invalidJson();
          }
          return decoded;
        } catch {
          this.invalidJson();
        }
      }
      if (code <= 0x1f) {
        this.invalidJson();
      }
      if (code === 0x5c) {
        this.offset += 1;
        this.scanEscapeSequence();
      } else {
        this.offset += 1;
      }
    }
    this.invalidJson();
  }

  private scanEscapeSequence(): void {
    const escape = this.peek();
    if (escape === undefined) {
      this.invalidJson();
    }
    if (escape === "u") {
      this.offset += 1;
      for (let index = 0; index < 4; index += 1) {
        if (!isHexDigit(this.raw.charCodeAt(this.offset + index))) {
          this.invalidJson();
        }
      }
      this.offset += 4;
      return;
    }
    if (escape === '"' || escape === "\\" || escape === "/" || "bfnrt".includes(escape)) {
      this.offset += 1;
      return;
    }
    this.invalidJson();
  }

  private scanLiteral(literal: "true" | "false" | "null"): void {
    if (!this.raw.startsWith(literal, this.offset)) {
      this.invalidJson();
    }
    this.offset += literal.length;
  }

  private scanNumber(): void {
    if (this.consume("-")) {
      // The integer component below remains mandatory after a sign.
    }
    if (this.consume("0")) {
      // JSON does not permit a leading zero before another digit.
      if (isDigit(this.raw.charCodeAt(this.offset))) {
        this.invalidJson();
      }
    } else if (isNonZeroDigit(this.raw.charCodeAt(this.offset))) {
      this.offset += 1;
      while (isDigit(this.raw.charCodeAt(this.offset))) {
        this.offset += 1;
      }
    } else {
      this.invalidJson();
    }

    if (this.consume(".")) {
      if (!isDigit(this.raw.charCodeAt(this.offset))) {
        this.invalidJson();
      }
      while (isDigit(this.raw.charCodeAt(this.offset))) {
        this.offset += 1;
      }
    }
    if (this.peek() === "e" || this.peek() === "E") {
      this.offset += 1;
      if (this.peek() === "+" || this.peek() === "-") {
        this.offset += 1;
      }
      if (!isDigit(this.raw.charCodeAt(this.offset))) {
        this.invalidJson();
      }
      while (isDigit(this.raw.charCodeAt(this.offset))) {
        this.offset += 1;
      }
    }
  }

  private skipWhitespace(): void {
    while (isJsonWhitespace(this.raw.charCodeAt(this.offset))) {
      this.offset += 1;
    }
  }

  private consume(expected: string): boolean {
    if (this.raw.startsWith(expected, this.offset)) {
      this.offset += expected.length;
      return true;
    }
    return false;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) {
      this.invalidJson();
    }
  }

  private peek(): string | undefined {
    return this.raw[this.offset];
  }

  private invalidJson(): never {
    throw new Error("corpus manifest JSON is invalid");
  }
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isNonZeroDigit(code: number): boolean {
  return code >= 0x31 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}
