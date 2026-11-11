import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { EVENT_TYPES, listEvents } from '../src/core/chain.js';
import { summaryKey } from '../src/core/keys.js';
import { GAP, STATUS } from '../src/core/state.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };
const criteria = ['Discharge is cut above the threshold', 'Discharge resumes after hysteresis', 'Fault is logged'];

const evidence = (criterionId, workOrderRev, overrides = {}) => ({
  issueKey: 'BMS-1',
  criterionId,
  workOrderRev,
  verdict: 'pass',
  evidenceType: 'test',
  summary: `Simulated test data for ${criterionId}`,
  agentName: 'Test agent',
  ...overrides,
});

// Revision 1 with evidence for AC-1 (accepted) and AC-2 (awaiting review), then the
// description changes and revision 2 is approved with the same three criteria texts.
async function twoRevisions() {
  const store = createMemoryStore();
  const jira = createFakeJira({
    issues: [{ issueId: '10001', issueKey: 'BMS-1', title: 'Over-temperature', projectId: '20000', projectKey: 'BMS', description: adfDoc(h(2, 'Acceptance criteria'), ul(...criteria)) }],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
  });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now });
  const tools = createTools({ store, jira, now });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const ac1 = await tools.submitEvidence(evidence('AC-1', 1), AGENT);
  const ac2 = await tools.submitEvidence(evidence('AC-2', 1), AGENT);
  await ui.review(HUMAN, { evidenceSeq: ac1.seq, decision: 'accept', note: 'ok' });
  jira.issues.get('10001').description = adfDoc(h(2, 'Acceptance criteria'), ul(...criteria), { type: 'paragraph', content: [{ type: 'text', text: 'Threshold value changed.' }] });
  assert.equal((await ui.getPanel(HUMAN)).stale, true);
  await ui.draftFromDescription(HUMAN);
  const view = await ui.approve(HUMAN, {});
  return { store, jira, ui, tools, ac1, ac2, view };
}

test('revision 2: every criterion starts again at no-evidence; earlier evidence is summarised, not counted', async () => {
  const { view } = await twoRevisions();
  assert.equal(view.workOrder.rev, 2);
  assert.equal(view.stale, false);
  assert.equal(view.chain.verified, true);
  assert.deepEqual(view.state.criteria.map((c) => c.status), [STATUS.NO_EVIDENCE, STATUS.NO_EVIDENCE, STATUS.NO_EVIDENCE]);
  assert.deepEqual(view.state.criteria.map((c) => c.gap), [GAP.NO_EVIDENCE, GAP.NO_EVIDENCE, GAP.NO_EVIDENCE]);
  assert.equal(view.state.accepted, 0);
  assert.deepEqual(view.state.previousRevisions, [{ rev: 1, total: 3, accepted: 1, evidenceCount: 2 }]);
});

test('revision 2: old evidence cannot be reviewed, old revision is rejected, new evidence counts', async () => {
  const { store, ui, tools, ac2 } = await twoRevisions();
  const eventsBefore = (await listEvents(store, '10001')).length;

  const oldReview = await ui.review(HUMAN, { evidenceSeq: ac2.seq, decision: 'accept' }).catch((e) => e);
  assert.equal(oldReview.code, 'OUTDATED_EVIDENCE');
  const oldRev = await tools.submitEvidence(evidence('AC-1', 1), AGENT).catch((e) => e);
  assert.equal(oldRev.code, 'REVISION_MISMATCH');
  assert.equal((await listEvents(store, '10001')).length, eventsBefore);

  const fresh = await tools.submitEvidence(evidence('AC-1', 2), AGENT);
  assert.equal(fresh.ok, true);
  const status = await tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT);
  assert.equal(status.workOrderRev, 2);
  assert.equal(status.criteria[0].status, STATUS.SUBMITTED);
  assert.deepEqual(status.previousRevisions, [{ rev: 1, total: 3, accepted: 1, evidenceCount: 2 }]);
  assert.match(status.previousRevisionsNote, /workOrderRev=2/);
  assert.equal(status.chainVerified, true);

  // All events of both revisions stay in one chain
  const events = await listEvents(store, '10001');
  assert.deepEqual(events.filter((e) => e.type === EVENT_TYPES.APPROVED).map((e) => e.payload.rev), [1, 2]);

  // The matrix summary follows the current revision only
  const summary = await store.get(summaryKey('20000', '10001'));
  assert.equal(summary.rev, 2);
  assert.equal(summary.accepted, 0);
  assert.equal(summary.gapCount, 3);
});
