import { EVENT_TYPES, listEvents } from './chain.js';
import { eventKey } from './keys.js';

// Development-only helpers that simulate someone editing stored records outside the app,
// so the "Chain broken" state can be demonstrated on a development site.
// The resolver only calls these after checking the development guard (resolvers/devtools-guard.js).
// The original event is kept under a dev:backup key so the edit can be undone.

export const devBackupKey = (issueId, seq) => `dev:backup:${issueId}:${String(seq).padStart(6, '0')}`;
export const devBackupPrefix = (issueId) => `dev:backup:${issueId}:`;

export const TAMPER_MARK = ' [edited outside Evidence Chain]';

// Edits the newest evidence event (or the newest event of any type) without updating its hash.
export async function tamperLatestEvent(store, issueId) {
  const events = await listEvents(store, issueId);
  if (events.length === 0) return null;
  const target = [...events].reverse().find((e) => e.type === EVENT_TYPES.SUBMITTED) ?? events[events.length - 1];
  // Keep only the first original: tampering twice must not overwrite the clean copy
  await store.setIfAbsent(devBackupKey(issueId, target.seq), target);
  const edited = structuredClone(target);
  if (edited.type === EVENT_TYPES.SUBMITTED) {
    edited.payload.summary = `${edited.payload.summary}${TAMPER_MARK}`;
  } else {
    edited.at = new Date(Date.parse(edited.at) + 60_000).toISOString();
  }
  await store.set(eventKey(issueId, target.seq), edited);
  return { seq: target.seq, type: target.type };
}

// Puts every backed-up original back and removes the backups.
export async function restoreTamperedEvents(store, issueId) {
  const backups = await store.listByPrefix(devBackupPrefix(issueId));
  for (const { key, value } of backups) {
    await store.set(eventKey(issueId, value.seq), value);
    await store.delete(key);
  }
  return backups.length;
}

export async function countTamperedEvents(store, issueId) {
  return (await store.listByPrefix(devBackupPrefix(issueId))).length;
}
