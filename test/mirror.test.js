import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { listEvents } from '../src/core/chain.js';
import { summaryKey } from '../src/core/keys.js';
import { MIRROR_PROPERTY_KEY, mirrorValue } from '../src/core/mirror.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { createIssueUpdatedHandler } from '../src/triggers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

// 延伸功能 4：摘要鏡射到 issue property。鏈才是事實來源，鏡射失敗不能讓主寫入失敗。

const original = adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B'));
const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };
const PROP = `10001/${MIRROR_PROPERTY_KEY}`;
const evidence = (criterionId, verdict = 'pass') => ({
  issueKey: 'BMS-1', criterionId, workOrderRev: 1, verdict, evidenceType: 'test', summary: 'Simulated test data', agentName: 'Test agent',
});

function setup(options = {}) {
  const store = createMemoryStore();
  const jira = createFakeJira({
    issues: [{ issueId: '10001', issueKey: 'BMS-1', title: 'T', projectId: '20000', projectKey: 'BMS', description: original }],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
    ...options,
  });
  const now = sequentialClock();
  return {
    store,
    jira,
    ui: createResolverLogic({ store, jira, now }),
    tools: createTools({ store, jira, now }),
    trigger: createIssueUpdatedHandler({ store, jira, now }),
  };
}

test('mirror: approve, submit and review keep the issue property in step with the matrix row, without personal data', async () => {
  const ctx = setup();
  await ctx.ui.draftFromDescription(HUMAN);
  assert.equal(ctx.jira.properties.has(PROP), false, 'drafts are not mirrored');

  await ctx.ui.approve(HUMAN, {});
  let prop = ctx.jira.properties.get(PROP);
  assert.deepEqual({ ...prop, updatedAt: undefined }, { schema: 1, rev: 1, total: 2, accepted: 0, gapCount: 2, gapKinds: ['no-evidence'], stale: 'false', updatedAt: undefined });
  assert.match(prop.updatedAt, /^2026-/);

  await ctx.tools.submitEvidence(evidence('AC-1'), AGENT);
  const failed = await ctx.tools.submitEvidence(evidence('AC-2', 'fail'), AGENT);
  prop = ctx.jira.properties.get(PROP);
  assert.deepEqual(prop.gapKinds, ['failed', 'unreviewed']);

  const first = (await listEvents(ctx.store, '10001')).find((e) => e.payload?.criterionId === 'AC-1');
  await ctx.ui.review(HUMAN, { evidenceSeq: first.seq, decision: 'accept' });
  prop = ctx.jira.properties.get(PROP);
  assert.equal(prop.accepted, 1);
  assert.equal(prop.gapCount, 1);
  assert.deepEqual(prop.gapKinds, ['failed']);
  assert.ok(failed.seq > first.seq);

  // 與矩陣摘要一致，而且沒有 accountId、條件文字或代理文字
  const summary = await ctx.store.get(summaryKey('20000', '10001'));
  assert.deepEqual(prop, mirrorValue(summary));
  const text = JSON.stringify(prop);
  for (const secret of ['human-account', 'agent-account', 'Simulated test data', 'Test agent']) assert.equal(text.includes(secret), false, secret);
  assert.ok(ctx.jira.propertyWrites.every((as) => as === 'user'));
});

test('mirror: reopening the panel without changes does not write the property again', async () => {
  const ctx = setup();
  await ctx.ui.draftFromDescription(HUMAN);
  await ctx.ui.approve(HUMAN, {});
  const writes = ctx.jira.propertyWrites.length;
  await ctx.ui.getPanel(HUMAN);
  await ctx.tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT);
  assert.equal(ctx.jira.propertyWrites.length, writes);
});

test('mirror: the trigger writes as the app and marks the issue stale', async () => {
  const ctx = setup();
  await ctx.ui.draftFromDescription(HUMAN);
  await ctx.ui.approve(HUMAN, {});
  ctx.jira.issues.get('10001').description = adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B changed'));
  await ctx.trigger({ issue: { id: '10001' }, changelog: { items: [{ field: 'description', fieldId: 'description' }] } });
  const prop = ctx.jira.properties.get(PROP);
  assert.equal(prop.stale, 'true');
  assert.ok(prop.gapKinds.includes('stale'));
  assert.equal(prop.gapCount, 3);
  assert.equal(ctx.jira.propertyWrites.at(-1), 'app');
});

test('mirror: a failed property write never fails approval, evidence or review, and is retried on the next refresh', async () => {
  const ctx = setup({ failPropertyWrites: true });
  await ctx.ui.draftFromDescription(HUMAN);
  const approved = await ctx.ui.approve(HUMAN, {});
  assert.equal(approved.workOrder.rev, 1);
  const sent = await ctx.tools.submitEvidence(evidence('AC-1'), AGENT);
  assert.equal(sent.ok, true);
  const reviewed = await ctx.ui.review(HUMAN, { evidenceSeq: sent.seq, decision: 'accept' });
  assert.equal(reviewed.chain.verified, true);
  assert.equal((await listEvents(ctx.store, '10001')).length, 3);
  assert.equal((await ctx.store.get(summaryKey('20000', '10001'))).accepted, 1);
  assert.equal(ctx.jira.properties.has(PROP), false);

  // 也包含 trigger 的路徑
  ctx.jira.issues.get('10001').title = 'Renamed';
  assert.equal((await ctx.trigger({ issue: { id: '10001' }, changelog: { items: [{ field: 'summary', fieldId: 'summary' }] } })).result, 'refreshed');

  // Jira 恢復後，下一次重算（例如開面板）會補寫
  ctx.jira.failPropertyWrites = false;
  await ctx.ui.getPanel(HUMAN);
  assert.equal(ctx.jira.properties.get(PROP).accepted, 1);
});
