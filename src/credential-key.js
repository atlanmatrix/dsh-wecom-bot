import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { credentialKey, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'

function profileHash(directory) {
  return createHash('sha256').update(directory).digest('hex').slice(0, 24)
}

/** A hash alone may start with a digit, which DSH rejects as a credential ID. */
export function profileCredentialKey(directory) {
  return credentialKey('wecom-bot', `profile-${profileHash(directory)}`)
}

/** Migrate readable legacy IDs through the provider without replacing newer credentials. */
export async function migrateProfileCredential(provider, directory) {
  const key = profileCredentialKey(directory)
  const legacyId = profileHash(directory)
  // Invalid legacy IDs stop the provider before this plugin can load; use the offline repair.
  if (!isCredentialKeySegment(legacyId) || await provider.readRecord(key)) return key
  const legacyKey = credentialKey('wecom-bot', legacyId)
  const previous = await provider.readRecord(legacyKey)
  if (previous) {
    const stored = await provider.modifyRecord(key, async current => current ?? previous)
    if (isDeepStrictEqual(stored, previous)) await provider.deleteRecord(legacyKey)
  }
  return key
}
