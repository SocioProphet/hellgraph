import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { KmsKeyProvider, type KmsClient } from './kms-key.js'
import { maskValue, unmaskValue } from './masking.js'

// A fake KMS: "unwrapping" = sha256 of the wrapped blob (deterministic 32-byte data key).
class FakeKms implements KmsClient {
  async decryptDataKey(encryptedDataKey: Buffer): Promise<Buffer> {
    return createHash('sha256').update(encryptedDataKey).digest()
  }
}

test('KMS envelope: load unwraps once, getKey returns the data key, masking round-trips', async () => {
  const kms = new FakeKms()
  const wrapped = randomBytes(64) // the stored, KMS-encrypted data key
  const provider = await KmsKeyProvider.load(kms, wrapped)

  const key = provider.getKey()
  assert.equal(key.length, 32)
  assert.equal(provider.getKey(), key, 'cached — no re-unwrap per call')

  const masked = maskValue('(123) 456-7890', key)
  assert.equal(unmaskValue(masked, provider.getKey()), '(123) 456-7890', 'standard-tier key unmasks')
})

test('KMS load rejects a data key of the wrong length', async () => {
  const badKms: KmsClient = { async decryptDataKey() { return Buffer.alloc(16) } }
  await assert.rejects(() => KmsKeyProvider.load(badKms, Buffer.alloc(8)), /expected a 32-byte data key/)
})
