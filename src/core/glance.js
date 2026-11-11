import { draftKey, summaryKey } from './keys.js';

// Status shown on the collapsed issue context panel (jira:issueContext dynamic properties).
// It only reads stored data, so it is cheap and needs no Jira call:
// the matrix summary (written whenever the issue state is refreshed) and the draft, if any.

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
