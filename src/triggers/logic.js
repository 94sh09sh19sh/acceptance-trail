// Extension 1 (spec section 10): keep the matrix summary fresh when an issue changes,
// so stale markers appear without anyone opening the issue panel.
// No @forge/* imports here; store and jira are injected like the other modules.

import { hashDescription } from '../core/canonical.js';
import { summaryKey } from '../core/keys.js';
import { getCurrentWorkOrder, refreshSummary } from '../core/workorder.js';

// Changes that can affect a summary row: description (staleness), summary (row title),
// project and key (the issue moved).
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

    // Only issues with an approved work order have a summary row to keep fresh
    if (!(await getCurrentWorkOrder(store, issueId))) return { result: 'skipped', reason: 'no-work-order' };

    const fields = changedFields(event);
    if (fields && !fields.some((field) => RELEVANT_FIELDS.has(field))) {
      return { result: 'skipped', reason: 'irrelevant-change' };
    }

    // There is no user behind a trigger, so this read uses the app identity.
    // The issue content is only used to recompute the stored summary, never returned to anyone.
    const issue = await jira.getIssueAsApp(issueId);
    if (!issue) return { result: 'skipped', reason: 'not-found' };

    // Moved to another project: drop the row from the old project's matrix
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
