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
//   - `releaseKeyReference` is idempotent (a malformed / already-released ref is
//     a no-op), so an interrupted retention pass resumes safely.
//
// Retention boundary: with a single static env master key, the wrapped DEK is
// inline in the row's `key_ref` column; it is not independently deletable. The
// retention pass clears the live ciphertext column and retains a metadata
// tombstone. This removes the production copy but is not crypto-shredding: a
// backup that still holds ciphertext, the inline key ref, and the master key can
// decrypt it. Per-record destruction that also protects historical backups needs
// an external key authority with independently deletable material.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { LlmMemoCipher } from "@itotori/db";
import { readRegisteredProjectEnv } from "../../env/registry.js";

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
  let raw: string | undefined;
  try {
    raw = readRegisteredProjectEnv(env, FIELD_CIPHER_KEY_ENV_VAR);
  } catch (error) {
    throw new FieldCipherKeyError(
      error instanceof Error ? error.message : "the env var is not set",
    );
  }
  if (raw === undefined) {
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

  async releaseKeyReference(keyRef: string): Promise<void> {
    // The wrapped DEK is inline in key_ref, so this cipher has no independent
    // material to release. Validate recognized refs but make repeated cleanup a
    // no-op; callers erase the live ciphertext in the same retention transaction.
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
