import { jiraClient } from '../jira/client.js';
import { kvsStore } from '../storage/kvs.js';
import { createIssueUpdatedHandler } from './logic.js';

const handleIssueUpdated = createIssueUpdatedHandler({ store: kvsStore, jira: jiraClient });

// trigger module issue-updated (avi:jira:updated:issue). Logs only the issue ID and the outcome.
export async function issueUpdated(event) {
  const issueId = event?.issue?.id ? String(event.issue.id) : '-';
  try {
    const outcome = await handleIssueUpdated(event);
    console.log(`[trigger:issue-updated] ${issueId} ${outcome.result}${outcome.reason ? ` ${outcome.reason}` : ''}${outcome.stale ? ' stale' : ''}`);
  } catch (error) {
    console.error(`[trigger:issue-updated] ${issueId} ${String(error?.message ?? error).slice(0, 200)}`);
  }
}
