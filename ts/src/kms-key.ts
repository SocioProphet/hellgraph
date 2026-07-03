/**
 * kms-key — standard-tier key custody via KMS envelope encryption (spec 10 key decision).
 *
 * The standard tier of the tiered custody decision (the premium tier is threshold-key.ts).
 * Envelope pattern: a per-tenant data key is stored ENCRYPTED (wrapped by a KMS master key);
 * at startup the wrapped key is decrypted once via KMS and held in memory for the session, so
 * masking never calls KMS per field. The KMS client is injected (AWS KMS / GCP KMS / Vault
 * Transit), keeping this dependency-free + testable; the wire call is the one injected seam.
 *
 * Custody note: the operator's KMS can unwrap the data key — that is the standard-tier trade
 * (simple, managed). For custody where no single party can unmask, use the sovereign tier
 * (ThresholdKeyProvider).
 */

import type { KeyProvider } from './masking.js'

/** Minimal KMS client — an adapter over AWS KMS Decrypt / GCP KMS / Vault Transit implements this. */
export interface KmsClient {
  /** Unwrap an encrypted (envelope) data key, returning the 32-byte plaintext data key. */
  decryptDataKey(encryptedDataKey: Buffer): Promise<Buffer>
}

/**
 * A KeyProvider backed by a KMS-wrapped data key. `load` performs the single async KMS unwrap;
 * getKey() then returns the cached plaintext key synchronously (the AtomSpace/masking path is
 * sync), mirroring the async-open/sync-use bridge used elsewhere.
 */
export class KmsKeyProvider implements KeyProvider {
  private constructor(private readonly key: Buffer) {}

  static async load(client: KmsClient, encryptedDataKey: Buffer): Promise<KmsKeyProvider> {
    const key = await client.decryptDataKey(encryptedDataKey)
    if (key.length !== 32) throw new Error(`KmsKeyProvider: expected a 32-byte data key, got ${key.length}`)
    return new KmsKeyProvider(key)
  }

  getKey(): Buffer { return this.key }
}
