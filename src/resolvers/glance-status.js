import { loadGlanceStatus } from '../core/glance.js';
import { kvsStore } from '../storage/kvs.js';

// jira:issueContext 模組（evidence-glance）的 dynamicProperties 處理函式。
// Jira 會在議題頁面首次繪製時，以及內容面板每次收合時呼叫它。
// 它只回傳簡短的狀態標籤；不可記錄 payload（裡面帶有 context token）。
export async function glanceStatus(payload, context) {
  const ext = payload?.extension ?? context?.extension ?? {};
  try {
    const status = await loadGlanceStatus(kvsStore, {
      issueId: ext.issue?.id ? String(ext.issue.id) : null,
      projectId: ext.project?.id ? String(ext.project.id) : null,
    });
    return { status };
  } catch (error) {
    console.error(`[glance-status] ${String(error?.message ?? error).slice(0, 200)}`);
    return { status: { type: 'lozenge', value: { label: 'Open', type: 'default' } } };
  }
}
