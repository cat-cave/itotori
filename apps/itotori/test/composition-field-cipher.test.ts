import { randomBytes } from "node:crypto";
import type { LlmMemoCipher } from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  FIELD_CIPHER_KEY_ENV_VAR,
  FieldCipherKeyError,
  FieldCipherRefError,
  createFieldMemoCipher,
} from "../src/composition/live/field-cipher.js";

// The production field cipher is DETERMINISTIC + correctness-critical (it seals
// every durable memo / accepted-output / wiki ciphertext column), so it is proven
// to strict bar OFFLINE: it round-trips encrypt→decrypt, fails loud without the
// env master key, uses a fresh per-payload data key (no deterministic reuse), and
// authenticates every payload (a tamper is a loud throw, never a silent partial).

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

function cipherWith(key: string): LlmMemoCipher {
  return createFieldMemoCipher({ [FIELD_CIPHER_KEY_ENV_VAR]: key });
}

describe("production field cipher — envelope encryption keyed from the environment", () => {
  it("round-trips seal → open for a payload", async () => {
    const cipher = cipherWith(KEY_A);
    const plaintext = JSON.stringify({ prompt: "localize this line", nested: [1, 2, 3] });
    const sealed = await cipher.seal(plaintext);
    expect(sealed.keyRef.startsWith("itotori-field-cipher:v1:")).toBe(true);
    expect(await cipher.open(sealed.ciphertext, sealed.keyRef)).toBe(plaintext);
  });

  it("round-trips unicode / SJIS-range payloads byte-for-byte", async () => {
    const cipher = cipherWith(KEY_A);
    const plaintext = "はじめまして。{{ph:0}} 〜！";
    const sealed = await cipher.seal(plaintext);
    expect(await cipher.open(sealed.ciphertext, sealed.keyRef)).toBe(plaintext);
  });

  it("mints a fresh data key + nonce per seal (identical plaintext → distinct bytes)", async () => {
    const cipher = cipherWith(KEY_A);
    const first = await cipher.seal("same");
    const second = await cipher.seal("same");
    // No deterministic reuse: independent DEK/nonce → distinct ciphertext AND ref.
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
    expect(first.keyRef).not.toBe(second.keyRef);
    // Both still open to the same plaintext under the same master key.
    expect(await cipher.open(first.ciphertext, first.keyRef)).toBe("same");
    expect(await cipher.open(second.ciphertext, second.keyRef)).toBe("same");
  });

  it("fails loud (GCM tag) when the payload ciphertext is tampered", async () => {
    const cipher = cipherWith(KEY_A);
    const sealed = await cipher.seal("secret");
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(cipher.open(tampered, sealed.keyRef)).rejects.toThrow();
  });

  it("fails loud when opened under the wrong master key", async () => {
    const sealed = await cipherWith(KEY_A).seal("secret");
    await expect(cipherWith(KEY_B).open(sealed.ciphertext, sealed.keyRef)).rejects.toThrow();
  });

  it("rejects a keyRef that is not a v1 envelope ref", async () => {
    const cipher = cipherWith(KEY_A);
    const sealed = await cipher.seal("secret");
    await expect(cipher.open(sealed.ciphertext, "not-a-real-ref")).rejects.toBeInstanceOf(
      FieldCipherRefError,
    );
  });

  it("destroyKey is idempotent for a valid and a malformed ref (retention resumes safely)", async () => {
    const cipher = cipherWith(KEY_A);
    const sealed = await cipher.seal("secret");
    await expect(cipher.destroyKey(sealed.keyRef)).resolves.toBeUndefined();
    await expect(cipher.destroyKey(sealed.keyRef)).resolves.toBeUndefined();
    await expect(cipher.destroyKey("already-gone")).resolves.toBeUndefined();
  });
});

describe("production field cipher — fail-loud key resolution", () => {
  it("throws FieldCipherKeyError when the env var is absent", () => {
    expect(() => createFieldMemoCipher({})).toThrow(FieldCipherKeyError);
  });

  it("throws when the key is not a base64-encoded 256-bit key", () => {
    // 16 bytes (128-bit) is a real key but the wrong strength — refused, not padded.
    expect(() => cipherWith(randomBytes(16).toString("base64"))).toThrow(FieldCipherKeyError);
    expect(() => cipherWith("")).toThrow(FieldCipherKeyError);
  });
});
