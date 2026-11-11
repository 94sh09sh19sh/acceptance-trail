import { jiraClient } from '../jira/client.js';
import { kvsStore } from '../storage/kvs.js';
import { createIssueUpdatedHandler } from './logic.js';

const handleIssueUpdated = createIssueUpdatedHandler({ store: kvsStore, jira: jiraClient });

// trigger 模組 issue-updated（avi:jira:updated:issue）。只記錄議題 ID 與處理結果。
export async function issueUpdated(event) {
  const issueId = event?.issue?.id ? String(event.issue.id) : '-';
  try {
    const outcome = await handleIssueUpdated(event);
    console.log(`[trigger:issue-updated] ${issueId} ${outcome.result}${outcome.reason ? ` ${outcome.reason}` : ''}${outcome.stale ? ' stale' : ''}`);
  } catch (error) {
    console.error(`[trigger:issue-updated] ${issueId} ${String(error?.message ?? error).slice(0, 200)}`);
  }
}
