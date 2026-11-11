// 擴充 1（規格第 10 節）：議題變動時保持矩陣摘要最新，
// 讓過期標記不必等有人開啟議題面板就會出現。
// 這裡不匯入任何 @forge/*；store 與 jira 和其他模組一樣由外部注入。

import { hashDescription } from '../core/canonical.js';
import { summaryKey } from '../core/keys.js';
import { getCurrentWorkOrder, refreshSummary } from '../core/workorder.js';

// 會影響摘要列的變更：description（過期判斷）、summary（列標題）、
// project 與 key（議題被移動）。
const RELEVANT_FIELDS = new Set(['description', 'summary', 'project', 'key']);

function changedFields(event) {
  const items = event?.changelog?.items;
  if (!Array.isArray(items)) return null;
  return items.map((item) => String(item.fieldId ?? item.field ?? '').toLowerCase());
}

export function createIssueUpdatedHandler({ store, jira, now = () => new Date().toISOString() }) {
  return async function handleIssueUpdated(event) {
    const issueId = event?.issue?.id ? String(event.issue.id) : null;
    if (!issueId) return { result: 'skipped', reason: 'no-issue' };

    // 只有已核准工作單的議題才有需要維持最新的摘要列
    if (!(await getCurrentWorkOrder(store, issueId))) return { result: 'skipped', reason: 'no-work-order' };

    const fields = changedFields(event);
    if (fields && !fields.some((field) => RELEVANT_FIELDS.has(field))) {
      return { result: 'skipped', reason: 'irrelevant-change' };
    }

    // trigger 背後沒有使用者，所以這次讀取使用 app 身分。
    // 議題內容只用來重算已儲存的摘要，不會回傳給任何人。
    const issue = await jira.getIssueAsApp(issueId);
    if (!issue) return { result: 'skipped', reason: 'not-found' };

    // 議題移到其他專案：把它從舊專案的矩陣中移除
    for (const item of event?.changelog?.items ?? []) {
      const field = String(item.fieldId ?? item.field ?? '').toLowerCase();
      if (field === 'project' && item.from && String(item.from) !== issue.projectId) {
        await store.delete(summaryKey(String(item.from), issueId));
      }
    }

    const loaded = await refreshSummary(store, issue, { currentDescriptionHash: hashDescription(issue.description), at: now() });
    return { result: 'refreshed', stale: loaded.stale };
  };
}
