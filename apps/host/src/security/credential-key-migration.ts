// Compatibility for the schemaVersion 1 URL-encoded credential key.
// Migration only prepares an immutable next snapshot; the caller validates the
// encrypted payload before committing it through the atomic persistence writer.
import {
  credentialIdentityTupleKey,
  legacyCredentialIdentityKey,
  type CanonicalCredentialIdentity,
} from './credential-identity.js';
import { credentialEntriesWithoutKey, decodeStoredCredentialEntry } from './credential-persistence.js';
import type { CredentialEntry } from './credential-store-types.js';

export type CredentialKeyLookup = {
  changed: boolean;
  entry: CredentialEntry | null;
  entries: Record<string, unknown>;
};

function sameEntry(left: CredentialEntry, right: CredentialEntry): boolean {
  return left.sealed === right.sealed
    && JSON.stringify(left.summary) === JSON.stringify(right.summary);
}

function conflict(): Error {
  return new Error('credential key conflict between tuple and legacy entries');
}

export function credentialAtIdentity(
  entries: Record<string, unknown>,
  identity: CanonicalCredentialIdentity,
): CredentialKeyLookup {
  const tupleKey = credentialIdentityTupleKey(identity);
  const hasTuple = Object.hasOwn(entries, tupleKey);
  const tupleEntry = decodeStoredCredentialEntry(tupleKey, entries[tupleKey]);
  const legacyKey = legacyCredentialIdentityKey(identity);
  const hasLegacy = Object.hasOwn(entries, legacyKey);
  const legacyEntry = decodeStoredCredentialEntry(legacyKey, entries[legacyKey]);
  if (hasTuple && hasLegacy) {
    if (!tupleEntry || !legacyEntry || !sameEntry(tupleEntry, legacyEntry)) throw conflict();
    return {
      changed: true,
      entry: tupleEntry,
      entries: credentialEntriesWithoutKey(entries, legacyKey),
    };
  }
  if (tupleEntry) return { changed: false, entry: tupleEntry, entries };
  if (hasLegacy && !legacyEntry) throw new Error('legacy credential entry is corrupt or invalid');
  if (!legacyEntry) return { changed: false, entry: null, entries };
  const migrated = credentialEntriesWithoutKey(entries, legacyKey);
  migrated[tupleKey] = entries[legacyKey];
  return { changed: true, entry: legacyEntry, entries: migrated };
}

export function migrateLegacyCredentialKeys(entries: Record<string, unknown>): {
  changed: boolean;
  entries: Record<string, unknown>;
} {
  const identities = new Map<string, CanonicalCredentialIdentity>();
  for (const [key, value] of Object.entries(entries)) {
    const entry = decodeStoredCredentialEntry(key, value);
    if (entry) identities.set(credentialIdentityTupleKey(entry.summary), entry.summary);
  }
  let changed = false;
  let migrated = entries;
  for (const identity of identities.values()) {
    const lookup = credentialAtIdentity(migrated, identity);
    changed ||= lookup.changed;
    migrated = lookup.entries;
  }
  return { changed, entries: migrated };
}
