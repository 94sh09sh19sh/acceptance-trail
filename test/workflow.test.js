import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { callerFrom } from '../src/actions/caller.js';
import { listEvents, verifyChain } from '../src/core/chain.js';
import { headKey, revKey } from '../src/core/keys.js';
import { GAP, STATUS } from '../src/core/state.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

const AGENT = { accountId: 'agent-account' };
const HUMAN = { accountId: 'human-account' };

const description = adfDoc(
  h(2, 'Acceptance criteria'),
  ul('Discharge is cut above the over-temperature threshold', 'Discharge resumes only after hysteresis', 'Fault is logged', 'Unit tests cover both edges'),
);

function setup({ hidden = [] } = {}) {
  const store = createMemoryStore();
  const jira = createFakeJira({
    issues: [
      { issueId: '10001', issueKey: 'BMS-1', title: 'Cell over-temperature protection', projectId: '20000', projectKey: 'BMS', description },
      { issueId: '10002', issueKey: 'BMS-2', title: 'Second issue', projectId: '20000', projectKey: 'BMS', description },
    ],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
    hidden,
  });
  const now = sequentialClock();
  const tools = createTools({ store, jira, now });
  const ui = createResolverLogic({ store, jira, now });
  const panel = (issueId = '10001') => ({ accountId: HUMAN.accountId, issueId, projectKey: 'BMS' });
  return { store, jira, tools, ui, panel };
}

const evidence = (criterionId, overrides = {}) => ({
  issueKey: 'BMS-1',
  criterionId,
  workOrderRev: 1,
  verdict: 'pass',
  evidenceType: 'test',
  summary: `Tests for ${criterionId} pass`,
  reference: 'abc1234',
  outputExcerpt: 'ok 1 - test',
  agentName: 'Claude Code',
  ...overrides,
});

async function approveFromDescription(ctx, issueId = '10001') {
  await ctx.ui.draftFromDescription(ctx.panel(issueId));
  return ctx.ui.approve(ctx.panel(issueId), {});
}

test('未核准時 get-work-order 不給驗收條件內容', async () => {
  const ctx = setup();
  await ctx.ui.draftFromDescription(ctx.panel());
  const result = await ctx.tools.getWorkOrder({ issueKey: 'BMS-1' }, AGENT);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'not-approved');
  assert.equal(result.hasDraft, true);
  assert.equal(result.criteria, undefined);
  assert.equal(JSON.stringify(result).includes('hysteresis'), false);
});

test('核准後 get-work-order 回版次與逐條條件', async () => {
  const ctx = setup();
  const view = await approveFromDescription(ctx);
  assert.equal(view.workOrder.rev, 1);
  assert.equal(view.workOrder.approvedBy, HUMAN.accountId);
  assert.equal(view.draft, null);
  const result = await ctx.tools.getWorkOrder({ issueKey: 'bms-1' }, AGENT);
  assert.equal(result.status, 'approved');
  assert.equal(result.workOrderRev, 1);
  assert.equal(result.stale, false);
  assert.deepEqual(result.criteria.map((c) => c.criterionId), ['AC-1', 'AC-2', 'AC-3', 'AC-4']);
});

test('submit-evidence：版次不符、條件代號不存在、未核准都拒絕且不寫入', async () => {
  const ctx = setup();
  const notApproved = await ctx.tools.submitEvidence(evidence('AC-1'), AGENT).catch((e) => e);
  assert.equal(notApproved.code, 'NOT_APPROVED');

  await approveFromDescription(ctx);
  const before = (await listEvents(ctx.store, '10001')).length;
  const wrongRev = await ctx.tools.submitEvidence(evidence('AC-1', { workOrderRev: 2 }), AGENT).catch((e) => e);
  assert.equal(wrongRev.code, 'REVISION_MISMATCH');
  const unknown = await ctx.tools.submitEvidence(evidence('AC-9'), AGENT).catch((e) => e);
  assert.equal(unknown.code, 'UNKNOWN_CRITERION');
  const badVerdict = await ctx.tools.submitEvidence(evidence('AC-1', { verdict: 'maybe' }), AGENT).catch((e) => e);
  assert.equal(badVerdict.name, 'ValidationError');
  assert.equal((await listEvents(ctx.store, '10001')).length, before);
});

test('submit-evidence：超長欄位截斷並在回傳註明', async () => {
  const ctx = setup();
  await approveFromDescription(ctx);
  const result = await ctx.tools.submitEvidence(
    evidence('AC-1', { summary: 's'.repeat(2500), outputExcerpt: 'o'.repeat(4001), reference: 'r'.repeat(501) }),
    AGENT,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.truncated, ['summary', 'reference', 'outputExcerpt']);
  assert.match(result.note, /truncated/);
  const stored = (await listEvents(ctx.store, '10001')).find((e) => e.seq === result.seq);
  assert.equal(stored.payload.summary.length, 2000);
  assert.equal(stored.payload.outputExcerpt.length, 4000);
  assert.equal(stored.payload.reference.length, 500);
  assert.equal(stored.actor, AGENT.accountId);
});

test('狀態與缺口推導：沒有證據、失敗、未覆核、接受、退回、最新一筆為準', async () => {
  const ctx = setup();
  await approveFromDescription(ctx);
  const ac1 = await ctx.tools.submitEvidence(evidence('AC-1'), AGENT);
  await ctx.tools.submitEvidence(evidence('AC-2', { verdict: 'fail' }), AGENT);
  const ac3 = await ctx.tools.submitEvidence(evidence('AC-3'), AGENT);

  let status = await ctx.tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT);
  const byId = () => Object.fromEntries(status.criteria.map((c) => [c.criterionId, c]));
  assert.equal(byId()['AC-1'].status, STATUS.SUBMITTED);
  assert.equal(byId()['AC-1'].gap, GAP.UNREVIEWED);
  assert.equal(byId()['AC-2'].gap, GAP.FAILED);
  assert.equal(byId()['AC-4'].status, STATUS.NO_EVIDENCE);
  assert.equal(byId()['AC-4'].gap, GAP.NO_EVIDENCE);
  assert.equal(status.gapCount, 4);

  await ctx.ui.review(ctx.panel(), { evidenceSeq: ac1.seq, decision: 'accept', note: 'Looks good' });
  await ctx.ui.review(ctx.panel(), { evidenceSeq: ac3.seq, decision: 'reject', note: 'Missing edge case' });
  status = await ctx.tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT);
  assert.equal(byId()['AC-1'].status, STATUS.ACCEPTED);
  assert.equal(byId()['AC-1'].gap, null);
  assert.equal(byId()['AC-3'].status, STATUS.REJECTED);
  assert.equal(byId()['AC-3'].gap, GAP.REJECTED);
  assert.equal(byId()['AC-3'].reviewNote, 'Missing edge case');

  // 代理重新送出 AC-2 通過：最新一筆為準，變成待覆核
  const retry = await ctx.tools.submitEvidence(evidence('AC-2'), AGENT);
  status = await ctx.tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT);
  assert.equal(byId()['AC-2'].status, STATUS.SUBMITTED);
  assert.equal(byId()['AC-2'].gap, GAP.UNREVIEWED);
  assert.equal(status.chainVerified, true);

  // 舊的那筆不能再覆核
  const oldReview = await ctx.ui.review(ctx.panel(), { evidenceSeq: retry.seq - 4, decision: 'accept' }).catch((e) => e);
  assert.ok(oldReview instanceof Error);
});

test('同時送 5 筆證據：序號連續、鏈驗證通過', async () => {
  const ctx = setup();
  await approveFromDescription(ctx);
  const results = await Promise.all(
    ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-1'].map((id) => ctx.tools.submitEvidence(evidence(id), AGENT)),
  );
  assert.deepEqual(results.map((r) => r.seq).sort((a, b) => a - b), [2, 3, 4, 5, 6]);
  const events = await listEvents(ctx.store, '10001');
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(verifyChain(events, await ctx.store.get(headKey('10001'))).verified, true);
  const view = await ctx.ui.getPanel(ctx.panel());
  assert.equal(view.chain.verified, true);
});

test('手動改掉一筆事件或工作單記錄後，面板顯示斷鏈', async () => {
  const ctx = setup();
  await approveFromDescription(ctx);
  const sent = await ctx.tools.submitEvidence(evidence('AC-1'), AGENT);
  const key = `ev:10001:${String(sent.seq).padStart(6, '0')}`;
  const tampered = ctx.store.data.get(key);
  tampered.payload.verdict = 'pass';
  tampered.payload.summary = 'edited';
  ctx.store.data.set(key, tampered);
  assert.equal((await ctx.ui.getPanel(ctx.panel())).chain.verified, false);

  const ctx2 = setup();
  await approveFromDescription(ctx2);
  const wo = ctx2.store.data.get(revKey('10001', 1));
  wo.criteria[0].text = 'Something weaker';
  ctx2.store.data.set(revKey('10001', 1), wo);
  assert.equal((await ctx2.ui.getPanel(ctx2.panel())).chain.verified, false);
});

test('描述改過後標示過期；propose-work-order 存成下一版草稿不影響現行版', async () => {
  const ctx = setup();
  await approveFromDescription(ctx);
  ctx.jira.issues.get('10001').description = adfDoc(h(2, 'Acceptance criteria'), ul('Changed requirement'));
  const wo = await ctx.tools.getWorkOrder({ issueKey: 'BMS-1' }, AGENT);
  assert.equal(wo.stale, true);

  const proposed = await ctx.tools.proposeWorkOrder({ issueKey: 'BMS-1', criteriaJson: '[{"text":"Changed requirement","evidenceType":"test"}]' }, AGENT);
  assert.equal(proposed.status, 'draft-saved');
  assert.equal(proposed.draftForRevision, 2);
  const still = await ctx.tools.getWorkOrder({ issueKey: 'BMS-1' }, AGENT);
  assert.equal(still.workOrderRev, 1);

  await ctx.ui.approve(ctx.panel(), {});
  const next = await ctx.tools.getWorkOrder({ issueKey: 'BMS-1' }, AGENT);
  assert.equal(next.workOrderRev, 2);
  assert.equal(next.stale, false);
  const oldRev = await ctx.tools.submitEvidence(evidence('AC-1', { workOrderRev: 1 }), AGENT).catch((e) => e);
  assert.equal(oldRev.code, 'REVISION_MISMATCH');
});

test('list-gaps 與 list-open-work-orders 依專案彙整，且不列出看不到的議題', async () => {
  const ctx = setup();
  await approveFromDescription(ctx, '10001');
  await approveFromDescription(ctx, '10002');
  for (const id of ['AC-1', 'AC-2', 'AC-3', 'AC-4']) {
    const sent = await ctx.tools.submitEvidence(evidence(id, { issueKey: 'BMS-2' }), AGENT);
    await ctx.ui.review(ctx.panel('10002'), { evidenceSeq: sent.seq, decision: 'accept' });
  }
  const gaps = await ctx.tools.listGaps({ projectKey: 'BMS' }, AGENT);
  assert.equal(gaps.issuesWithWorkOrders, 2);
  assert.deepEqual(gaps.issues.map((i) => i.issueKey), ['BMS-1']);
  assert.equal(gaps.issues[0].gaps.length, 4);
  assert.ok(gaps.issues[0].gaps.every((g) => g.kind === GAP.NO_EVIDENCE));

  const open = await ctx.tools.listOpenWorkOrders({ projectKey: 'BMS' }, AGENT);
  assert.deepEqual(open.workOrders, [{ issueKey: 'BMS-1', title: 'Cell over-temperature protection', workOrderRev: 1, gapCount: 4 }]);

  const matrix = await ctx.ui.getMatrix(ctx.panel());
  assert.deepEqual(matrix.totals, { issues: 2, criteria: 8, accepted: 4, gaps: 4 });

  const hiddenCtx = setup({ hidden: ['10001'] });
  const hiddenStatus = await hiddenCtx.tools.getWorkOrder({ issueKey: 'BMS-1' }, AGENT).catch((e) => e);
  assert.equal(hiddenStatus.code, 'ISSUE_NOT_FOUND');
});

test('沒有編輯權限的人不能核准或覆核', async () => {
  const store = createMemoryStore();
  const jira = createFakeJira({
    issues: [{ issueId: '10001', issueKey: 'BMS-1', title: 'T', projectId: '20000', projectKey: 'BMS', description }],
    editors: false,
  });
  const ui = createResolverLogic({ store, jira });
  const error = await ui.approve({ accountId: 'viewer', issueId: '10001' }, { criteria: [{ text: 'A', evidenceType: 'test' }] }).catch((e) => e);
  assert.equal(error.code, 'FORBIDDEN');
  assert.equal(await store.get('wo:10001:rev:1'), undefined);
});

test('呼叫者 accountId：依序從 context.principal、context、payload.context 取，都沒有記 unknown', () => {
  assert.equal(callerFrom({}, { principal: { accountId: 'a' } }).accountId, 'a');
  assert.equal(callerFrom({}, { accountId: 'b' }).accountId, 'b');
  assert.equal(callerFrom({ context: { accountId: 'c' } }, {}).accountId, 'c');
  assert.equal(callerFrom({}, undefined).accountId, 'unknown');
});
