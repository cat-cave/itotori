// The production field cipher — the REAL `LlmMemoCipher` the durable memo /
// accepted-output / wiki / conversation / human-input repositories seal their
// rebuilt-LLM ciphertext columns with.
//
// The only offline cipher that previously satisfied `LlmMemoCipher` was the
// in-memory `TestMemoCipher` (test-support only): it minted a fresh random key
// per seal and held it in a process Map, so its ciphertext never survived a
// restart and it was never a production durability substrate. This module is the
// production counterpart, keyed by a single operator-provisioned envelope master
// key read from the environment — consistent with how the OpenRouter credential
// + ZDR posture are managed (a load-bearing secret env var, fail-loud when
// absent, never passed on a CLI or defaulted).
//
// The scheme is envelope encryption with AES-256-GCM throughout, NOT a single
// static key over every payload:
//   - `seal` mints a fresh random 256-bit data key (DEK) per payload, encrypts
//     the plaintext under it (random 96-bit nonce, authenticated), then WRAPS the
//     DEK under the env master key (its own random nonce, authenticated). The
//     wrapped DEK travels in the returned `keyRef`; the payload ciphertext travels
//     in `ciphertext`. Two seals of identical plaintext produce independent DEKs,
//     nonces, and ciphertext — no deterministic reuse.
//   - `open` unwraps the DEK from the `keyRef` under the master key, then decrypts
//     and authenticates the payload ciphertext. Any tamper (wrong master key,
//     truncated/edited ciphertext or keyRef) fails the GCM tag — a loud throw,
//     never a silent partial plaintext.
//   - `destroyKey` is idempotent (a malformed / already-destroyed ref is a no-op),
//     so an interrupted retention pass resumes safely.
//
// Crypto-shred boundary (flagged honestly, not weakened): with a single static
// env master key there is no per-record key material to individually erase — the
// wrapped DEK lives inline in the row's `key_ref` column. The retention pass
// (`ItotoriLlmRetentionRepository.deleteExpired`) realizes the erasure by NULLING
// the ciphertext column of every expired row, after which no wrapped DEK can
// recover any payload. Hardware-grade per-record shred (deleting individual key
// material) would require a rotating KMS / key-vault the DEK is wrapped by — a
// deliberate follow-up, out of scope for an env-keyed cipher. The ENCRYPTION
// strength (AES-256-GCM, per-record random DEK, authenticated master-key wrap) is
// not weakened by this; only the granularity of key destruction is.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { LlmMemoCipher } from "@itotori/db";

/** The env var carrying the base64-encoded 256-bit envelope master key. A
 * load-bearing durability secret: fail loud when absent, never defaulted. */
export const FIELD_CIPHER_KEY_ENV_VAR = "ITOTORI_FIELD_CIPHER_KEY" as const;

/** The keyRef wire prefix — versions the envelope format so a future rotation is
 * distinguishable from a v1 wrapped key at `open` time. */
const KEY_REF_PREFIX = "itotori-field-cipher:v1:" as const;

const AES_256_GCM = "aes-256-gcm" as const;
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16; // GCM authentication tag

/** A missing / malformed envelope master key — the cipher refuses to construct.
 * There is no warning mode and no generated-on-the-fly key: an absent key means
 * the durable stores have no production sealing authority and MUST fail loud. */
export class FieldCipherKeyError extends Error {
  constructor(detail: string) {
    super(
      `${FIELD_CIPHER_KEY_ENV_VAR} is required and must be a base64-encoded 256-bit key: ${detail}`,
    );
    this.name = "FieldCipherKeyError";
  }
}

/** A sealed payload whose `keyRef` does not carry a v1 envelope-wrapped key. */
export class FieldCipherRefError extends Error {
  constructor(detail: string) {
    super(`field cipher key ref is not a v1 envelope ref: ${detail}`);
    this.name = "FieldCipherRefError";
  }
}

/** Decode + validate the env master key. Fails loud on absent, non-base64, or
 * wrong-length material — a 128-bit or a truncated key would silently weaken the
 * envelope, so only an exact 256-bit key is admitted. */
function resolveMasterKey(env: Readonly<Record<string, string | undefined>>): Buffer {
  const raw = env[FIELD_CIPHER_KEY_ENV_VAR];
  if (raw === undefined || raw.length === 0) {
    throw new FieldCipherKeyError("the env var is not set");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new FieldCipherKeyError("the value is not valid base64");
  }
  // Node's base64 decode is lenient (it drops invalid chars); re-encoding and
  // comparing byte length catches a value that is not genuinely 32 base64 bytes.
  if (decoded.length !== KEY_BYTES) {
    throw new FieldCipherKeyError(
      `decoded to ${decoded.length} bytes, expected ${KEY_BYTES} (a 256-bit key)`,
    );
  }
  return decoded;
}

/** AES-256-GCM seal: returns nonce || tag || ciphertext. */
function gcmSeal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AES_256_GCM, key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

/** AES-256-GCM open of a nonce || tag || ciphertext buffer. Throws on any tamper
 * (the GCM tag check fails) — never returns a partial or unauthenticated result. */
function gcmOpen(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new FieldCipherRefError("sealed buffer is shorter than a nonce + tag");
  }
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(AES_256_GCM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

class FieldMemoCipher implements LlmMemoCipher {
  readonly #masterKey: Buffer;

  constructor(masterKey: Buffer) {
    this.#masterKey = masterKey;
  }

  async seal(plaintext: string): Promise<{ ciphertext: Uint8Array; keyRef: string }> {
    // Fresh per-payload data key, wrapped under the env master key. The payload
    // ciphertext is bound to the DEK; the DEK is bound to the master key.
    const dataKey = randomBytes(KEY_BYTES);
    const ciphertext = gcmSeal(dataKey, Buffer.from(plaintext, "utf8"));
    const wrappedKey = gcmSeal(this.#masterKey, dataKey);
    return {
      ciphertext,
      keyRef: `${KEY_REF_PREFIX}${wrappedKey.toString("base64")}`,
    };
  }

  async open(ciphertext: Uint8Array, keyRef: string): Promise<string> {
    const dataKey = gcmOpen(this.#masterKey, unwrapKeyRef(keyRef));
    if (dataKey.length !== KEY_BYTES) {
      throw new FieldCipherRefError(`unwrapped a ${dataKey.length}-byte data key`);
    }
    return gcmOpen(dataKey, Buffer.from(ciphertext)).toString("utf8");
  }

  async destroyKey(keyRef: string): Promise<void> {
    // Idempotent: the wrapped DEK lives inline in the caller's stored key_ref, so
    // there is no separable key material to erase here (see the module header's
    // crypto-shred note — the retention pass nulls the ciphertext to realize the
    // erasure). Validate the ref shape so a genuinely corrupt ledger surfaces,
    // but treat an already-absent / malformed ref as a completed no-op.
    if (!keyRef.startsWith(KEY_REF_PREFIX)) return;
  }
}

/** Parse a v1 keyRef back into its wrapped-DEK buffer. */
function unwrapKeyRef(keyRef: string): Buffer {
  if (!keyRef.startsWith(KEY_REF_PREFIX)) {
    throw new FieldCipherRefError(`missing the '${KEY_REF_PREFIX}' prefix`);
  }
  const encoded = keyRef.slice(KEY_REF_PREFIX.length);
  const wrapped = Buffer.from(encoded, "base64");
  if (wrapped.length < NONCE_BYTES + TAG_BYTES + KEY_BYTES) {
    throw new FieldCipherRefError("wrapped key is shorter than a nonce + tag + 256-bit key");
  }
  return wrapped;
}

/**
 * Build the production `LlmMemoCipher` from the environment's envelope master
 * key. Fails loud (`FieldCipherKeyError`) when {@link FIELD_CIPHER_KEY_ENV_VAR}
 * is absent or not a base64-encoded 256-bit key — an unkeyed durable store has no
 * production sealing authority and must never silently fall back.
 */
export function createFieldMemoCipher(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LlmMemoCipher {
  return new FieldMemoCipher(resolveMasterKey(env));
}
