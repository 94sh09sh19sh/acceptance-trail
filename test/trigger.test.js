import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryKey } from '../src/core/keys.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { createIssueUpdatedHandler } from '../src/triggers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const original = adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B'));

async function setup() {
  const store = createMemoryStore();
  const jira = createFakeJira({
    issues: [
      { issueId: '10001', issueKey: 'BMS-1', title: 'Approved issue', projectId: '20000', projectKey: 'BMS', description: original },
      { issueId: '10002', issueKey: 'BMS-2', title: 'No work order', projectId: '20000', projectKey: 'BMS', description: original },
    ],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
  });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const handle = createIssueUpdatedHandler({ store, jira, now });
  return { store, jira, handle };
}

const updated = (issueId, ...fields) => ({ issue: { id: issueId }, changelog: { items: fields.map((field) => ({ field, fieldId: field })) } });

test('issue-updated trigger: description change marks the matrix row stale, and reverting clears it', async () => {
  const { store, jira, handle } = await setup();
  assert.equal((await store.get(summaryKey('20000', '10001'))).stale, false);

  jira.issues.get('10001').description = adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B changed'));
  assert.deepEqual(await handle(updated('10001', 'description')), { result: 'refreshed', stale: true });
  const stale = await store.get(summaryKey('20000', '10001'));
  assert.equal(stale.stale, true);
  assert.ok(stale.gapKinds.includes('stale'));

  jira.issues.get('10001').description = original;
  await handle(updated('10001', 'description'));
  assert.equal((await store.get(summaryKey('20000', '10001'))).stale, false);
});

test('issue-updated trigger: title change updates the row; unrelated changes and issues without work orders are skipped', async () => {
  const { store, jira, handle } = await setup();
  jira.issues.get('10001').title = 'Renamed issue';
  await handle(updated('10001', 'summary'));
  assert.equal((await store.get(summaryKey('20000', '10001'))).title, 'Renamed issue');

  const before = structuredClone(store.data);
  assert.equal((await handle(updated('10001', 'status'))).reason, 'irrelevant-change');
  assert.equal((await handle(updated('10002', 'description'))).reason, 'no-work-order');
  assert.equal((await handle({})).reason, 'no-issue');
  assert.deepEqual(store.data, before);
});

test('issue-updated trigger: moving the issue to another project moves its matrix row', async () => {
  const { store, jira, handle } = await setup();
  Object.assign(jira.issues.get('10001'), { projectId: '30000', projectKey: 'OPS', issueKey: 'OPS-7' });
  await handle({ issue: { id: '10001' }, changelog: { items: [{ field: 'project', fieldId: 'project', from: '20000', to: '30000' }, { field: 'Key', from: null }] } });
  assert.equal(await store.get(summaryKey('20000', '10001')), undefined);
  assert.equal((await store.get(summaryKey('30000', '10001'))).issueKey, 'OPS-7');
});
