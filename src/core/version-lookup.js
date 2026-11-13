// 延伸功能 5：向 Jira 讀修正版本與專案版本清單。jira 由外部注入，這裡不 import 任何 @forge/*。
// 只給後端用（matrix 前端不 import 這個檔案，因為它依賴 workorder.js 的 DomainError）。

import { DomainError } from './workorder.js';
import { cleanString } from './validate.js';
import { versionFilter } from './versions.js';

const norm = (name) => cleanString(name).toLowerCase();

const unavailable = () =>
  new DomainError(
    'VERSIONS_UNAVAILABLE',
    'The fix versions could not be read from Jira right now, so the result was not built. Try again in a moment.',
  );

// 把每個議題加上 fixVersions（名稱陣列）。Jira 沒回傳的議題設為 null，不當成「沒有版本」。
export async function withFixVersions(jira, issues, caller) {
  if (issues.length === 0) return [];
  const byId = await jira.getFixVersions(
    issues.map((issue) => issue.issueId),
    caller,
  );
  return issues.map((issue) => ({ ...issue, fixVersions: byId.get(String(issue.issueId)) ?? null }));
}

// 需要版本才能回答的呼叫（篩選）：讀不到就失敗，不可退回成不篩選
export async function requireFixVersions(jira, issues, caller) {
  try {
    return await withFixVersions(jira, issues, caller);
  } catch {
    throw unavailable();
  }
}

// 把「依版本名稱篩選」換成專案裡實際存在的版本（用專案裡的正式拼法）。名稱不存在就回清楚的錯誤，
// 並列出可用的版本，讓呼叫者（人或代理）不必猜；不可以回空清單讓人誤以為「沒有缺口」。
export async function resolveVersionFilter(jira, project, filter, caller) {
  if (filter.kind !== 'version') return filter;
  let versions;
  try {
    versions = await jira.getProjectVersions(project, caller);
  } catch {
    throw unavailable();
  }
  const wanted = norm(filter.name);
  const found = versions.find((v) => norm(v.name) === wanted);
  if (found) return versionFilter(found.name);
  const names = versions.map((v) => v.name);
  const available =
    names.length === 0
      ? 'This project has no versions.'
      : `Available versions: ${names.slice(0, 20).join(', ')}${names.length > 20 ? `, and ${names.length - 20} more` : ''}.`;
  throw new DomainError('VERSION_NOT_FOUND', `Version "${filter.name}" does not exist in project ${project.projectKey}. ${available}`);
}
