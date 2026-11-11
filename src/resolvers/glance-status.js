import { loadGlanceStatus } from '../core/glance.js';
import { kvsStore } from '../storage/kvs.js';

// dynamicProperties handler of the jira:issueContext module (evidence-glance).
// Jira calls it when the issue view first renders and whenever the context panel is collapsed.
// It returns only a short status label; never log the payload (it carries a context token).
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
