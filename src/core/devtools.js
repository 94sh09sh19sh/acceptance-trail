import { EVENT_TYPES, listEvents } from './chain.js';
import { eventKey } from './keys.js';

// 僅限開發用的輔助函式：模擬有人在 app 之外改動儲存的記錄，
// 讓開發站台可以示範「Chain broken」狀態。
// resolver 要先通過開發環境檢查（resolvers/devtools-guard.js）才會呼叫這些函式。
// 原始事件會備份在 dev:backup 鍵底下，之後可以還原。

export const devBackupKey = (issueId, seq) => `dev:backup:${issueId}:${String(seq).padStart(6, '0')}`;
export const devBackupPrefix = (issueId) => `dev:backup:${issueId}:`;

export const TAMPER_MARK = ' [edited outside Evidence Chain]';

// 改動最新的證據事件（沒有證據事件就改最新的任何事件），但不更新它的雜湊。
export async function tamperLatestEvent(store, issueId) {
  const events = await listEvents(store, issueId);
  if (events.length === 0) return null;
  const target = [...events].reverse().find((e) => e.type === EVENT_TYPES.SUBMITTED) ?? events[events.length - 1];
  // 只留第一份原始內容：竄改兩次也不能蓋掉乾淨的備份
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

// 把所有備份的原始事件放回去，並移除備份。
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
