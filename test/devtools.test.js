import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { TAMPER_MARK, devBackupPrefix, devToolsAllowed } from '../src/core/devtools.js';
import { eventKey } from '../src/core/keys.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };

function setup({ devTools = true, editors = true } = {}) {
  const store = createMemoryStore();
  const jira = createFakeJira({
    issues: [{ issueId: '10001', issueKey: 'BMS-1', title: 'T', projectId: '20000', projectKey: 'BMS', description: adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B')) }],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
    editors,
  });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now, devToolsEnabled: () => devTools });
  const tools = createTools({ store, jira, now });
  return { store, jira, ui, tools };
}

async function approvedWithEvidence(ctx) {
  // 先以有編輯權限的人核准，再以有編輯權限的代理送出一筆證據
  const editorJira = createFakeJira({ issues: [...ctx.jira.issues.values()] });
  const editorUi = createResolverLogic({ store: ctx.store, jira: editorJira, now: sequentialClock() });
  await editorUi.draftFromDescription(HUMAN);
  await editorUi.approve(HUMAN, {});
  return createTools({ store: ctx.store, jira: editorJira, now: sequentialClock() }).submitEvidence(
    { issueKey: 'BMS-1', criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 'Simulated test data', agentName: 'Test agent' },
    AGENT,
  );
}

test('dev tools: tamper makes the chain broken, restore makes it verified again', async () => {
  const ctx = setup();
  const sent = await approvedWithEvidence(ctx);
  let view = await ctx.ui.getPanel(HUMAN);
  assert.equal(view.chain.verified, true);
  assert.deepEqual(view.devTools, { tampered: 0 });

  view = await ctx.ui.devTamper(HUMAN);
  assert.equal(view.chain.verified, false);
  assert.equal(view.chain.brokenAt, sent.seq);
  assert.equal(view.devTools.tampered, 1);
  assert.ok(ctx.store.data.get(eventKey('10001', sent.seq)).payload.summary.endsWith(TAMPER_MARK));

  // 竄改兩次，備份仍保留第一份乾淨的內容
  await ctx.ui.devTamper(HUMAN);
  view = await ctx.ui.devRestore(HUMAN);
  assert.equal(view.chain.verified, true);
  assert.equal(view.devTools.tampered, 0);
  assert.equal(ctx.store.data.get(eventKey('10001', sent.seq)).payload.summary, 'Simulated test data');
});

test('dev tools: refused and invisible when the development guard is off', async () => {
  const ctx = setup({ devTools: false });
  const sent = await approvedWithEvidence(ctx);
  const before = structuredClone(ctx.store.data.get(eventKey('10001', sent.seq)));
  const view = await ctx.ui.getPanel(HUMAN);
  assert.equal(view.devTools, null);
  for (const call of ['devTamper', 'devRestore']) {
    const error = await ctx.ui[call](HUMAN).catch((e) => e);
    assert.equal(error.code, 'NOT_AVAILABLE');
  }
  assert.deepEqual(ctx.store.data.get(eventKey('10001', sent.seq)), before);
  assert.equal((await ctx.store.listByPrefix(devBackupPrefix('10001'))).length, 0);
});

test('dev tools: people without edit permission cannot use them even in development', async () => {
  const ctx = setup({ editors: false });
  await approvedWithEvidence(ctx);
  const error = await ctx.ui.devTamper(HUMAN).catch((e) => e);
  assert.equal(error.code, 'FORBIDDEN');
  assert.equal((await ctx.ui.getPanel(HUMAN)).devTools, null);
});

// ---- 示範資料重設（僅限開發環境）----

async function twoIssuesWithData(devTools = true, editors = true) {
  const store = createMemoryStore();
  const issues = [
    { issueId: '10001', issueKey: 'BMS-1', title: 'T', projectId: '20000', projectKey: 'BMS', description: adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B')) },
    { issueId: '1000', issueKey: 'BMS-9', title: 'Other', projectId: '20000', projectKey: 'BMS', description: adfDoc(h(2, 'Acceptance criteria'), ul('C')) },
  ];
  const editorJira = createFakeJira({ issues });
  const editorUi = createResolverLogic({ store, jira: editorJira, now: sequentialClock(), devToolsEnabled: () => true });
  const agent = createTools({ store, jira: editorJira, now: sequentialClock() });
  for (const issueId of ['10001', '1000']) {
    await editorUi.draftFromDescription({ ...HUMAN, issueId });
    await editorUi.approve({ ...HUMAN, issueId }, {});
  }
  await agent.submitEvidence({ issueKey: 'BMS-1', criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 'Simulated test data', agentName: 'Test agent' }, AGENT);
  await editorUi.draftFromDescription(HUMAN); // 第 2 版草稿
  await editorUi.devTamper(HUMAN); // 留一份竄改備份
  // 同一份資料，換成指定的環境與權限來測
  const jira = createFakeJira({ issues, editors });
  for (const [key, value] of editorJira.properties) jira.properties.set(key, value);
  const ui = createResolverLogic({ store, jira, now: sequentialClock(), devToolsEnabled: () => devTools });
  return { store, jira, ui };
}

const issueKeys = (store, issueId) => [...store.data.keys()].filter((k) => k.split(':').includes(issueId));

test('dev reset: deletes every record of this issue and its issue property, and nothing of other issues', async () => {
  const { store, jira, ui } = await twoIssuesWithData();
  assert.ok(issueKeys(store, '10001').length >= 6);
  assert.ok(jira.properties.has('10001/evidence-chain-summary'));
  const otherBefore = issueKeys(store, '1000').map((k) => [k, structuredClone(store.data.get(k))]);

  const view = await ui.devReset(HUMAN);
  assert.deepEqual(issueKeys(store, '10001'), []);
  assert.equal(jira.properties.has('10001/evidence-chain-summary'), false);
  assert.equal(view.workOrder, null);
  assert.equal(view.draft, null);
  assert.equal(view.reset.propertyRemoved, true);
  assert.ok(view.reset.removed >= 6);
  // 只差一個數字的議題 1000 完全沒被動到
  assert.deepEqual(issueKeys(store, '1000').map((k) => [k, store.data.get(k)]), otherBefore);
  assert.ok(jira.properties.has('1000/evidence-chain-summary'));

  // 重設後可以從頭來
  const fresh = await ui.draftFromDescription(HUMAN);
  assert.equal(fresh.draft.criteria.length, 2);
});

test('dev reset: refused with storage unchanged when the development guard is off or the user cannot edit', async () => {
  for (const [devTools, editors, code] of [[false, true, 'NOT_AVAILABLE'], [true, false, 'FORBIDDEN'], [false, false, 'NOT_AVAILABLE']]) {
    const { store, jira, ui } = await twoIssuesWithData(devTools, editors);
    const before = structuredClone(store.data);
    const propsBefore = structuredClone(jira.properties);
    const error = await ui.devReset(HUMAN).catch((e) => e);
    assert.equal(error.code, code, `devTools=${devTools} editors=${editors}`);
    assert.deepEqual(store.data, before);
    assert.deepEqual(jira.properties, propsBefore);
  }
});

test('dev tools guard: only the DEVELOPMENT runtime together with EC_DEV_TOOLS=1 passes', () => {
  assert.equal(devToolsAllowed('DEVELOPMENT', '1'), true);
  for (const [env, flag] of [['STAGING', '1'], ['PRODUCTION', '1'], ['DEVELOPMENT', undefined], ['DEVELOPMENT', '0'], ['DEVELOPMENT', 'true'], [undefined, '1']]) {
    assert.equal(devToolsAllowed(env, flag), false, `${env} ${flag}`);
  }
});
