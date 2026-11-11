import { draftKey, summaryKey } from './keys.js';

// 議題內容面板收合時顯示的狀態（jira:issueContext 的 dynamic properties）。
// 只讀取已儲存的資料，所以成本低、不用呼叫 Jira：
// 資料來源是矩陣摘要（每次重新整理議題狀態時寫入）與草稿（如果有的話）。

const lozenge = (label, type) => ({ type: 'lozenge', value: { label, type } });

export function glanceStatus({ summary, draft }) {
  if (!summary) return draft ? lozenge('Draft', 'new') : lozenge('No work order', 'default');
  if (summary.chainVerified === false) return lozenge('Chain broken', 'removed');
  if (summary.gapCount === 0) return lozenge(`${summary.accepted}/${summary.total} accepted`, 'success');
  return lozenge(`${summary.gapCount} ${summary.gapCount === 1 ? 'gap' : 'gaps'}`, 'moved');
}

export async function loadGlanceStatus(store, { issueId, projectId }) {
  if (!issueId) return lozenge('Open', 'default');
  const [summary, draft] = await Promise.all([
    projectId ? store.get(summaryKey(projectId, issueId)) : undefined,
    store.get(draftKey(issueId)),
  ]);
  return glanceStatus({ summary, draft });
}
