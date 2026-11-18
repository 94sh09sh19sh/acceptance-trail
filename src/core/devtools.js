import { EVENT_TYPES, listEvents } from './chain.js';
import { eventKey, eventPrefix, headKey, summaryKey } from './keys.js';

// 僅限開發用的輔助函式：模擬有人在 app 之外改動儲存的記錄，
// 讓開發站台可以示範「Chain broken」狀態。
// resolver 要先通過開發環境檢查（resolvers/devtools-guard.js）才會呼叫這些函式。
// 原始事件會備份在 dev:backup 鍵底下，之後可以還原。

export const devBackupKey = (issueId, seq) => `dev:backup:${issueId}:${String(seq).padStart(6, '0')}`;
export const devBackupPrefix = (issueId) => `dev:backup:${issueId}:`;

// 開發用工具的環境條件（純函式，方便測試每一種組合）：
// Forge runtime 回報 DEVELOPMENT，而且環境變數 EC_DEV_TOOLS 剛好是 "1"，兩者都成立才開放。
export function devToolsAllowed(environmentType, flag) {
  return environmentType === 'DEVELOPMENT' && flag === '1';
}

export const TAMPER_MARK = ' [edited outside Acceptance Trail]';

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

// 僅限開發用：清掉一個議題的全部 Acceptance Trail 資料（草稿、各版工作單、鏈頭、事件、摘要、竄改備份），
// 讓拍示範影片前可以回到全新狀態。鏡射的 issue property 由呼叫端另外刪（要呼叫 Jira）。
// 正式環境沒有任何呼叫這個函式的途徑：resolver 要先通過開發環境檢查與編輯權限。
export async function resetIssueData(store, issueId, projectId) {
  const prefixed = await Promise.all([
    store.listByPrefix(`wo:${issueId}:`),
    store.listByPrefix(eventPrefix(issueId)),
    store.listByPrefix(devBackupPrefix(issueId)),
  ]);
  const keys = [...prefixed.flat().map((row) => row.key), headKey(issueId)];
  if (projectId) keys.push(summaryKey(projectId, issueId));
  let removed = 0;
  for (const key of keys) {
    if ((await store.get(key)) === undefined) continue;
    await store.delete(key);
    removed += 1;
  }
  return removed;
}
