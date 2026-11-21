// 截斷時不切在表情符號中間（找錯報告 2026-11-21 的 F9 重現測試，改成 repo 的格式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { EVENT_TYPES, appendEvent, listEvents, verifyChain } from '../src/core/chain.js';
import { headKey } from '../src/core/keys.js';
import { LIMITS, truncate } from '../src/core/validate.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, p, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'DEMO' };
const AGENT = { accountId: 'agent-account' };
const PROJECTS = [{ projectId: '20000', projectKey: 'DEMO', name: 'Demo' }];
const ISSUE = { issueId: '10001', issueKey: 'DEMO-1', title: 'T', projectId: '20000', projectKey: 'DEMO', description: adfDoc(p('Acceptance criteria'), ul('A')) };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// 模擬「存進去時孤立代理字元變成 U+FFFD」的儲存層（許多 UTF-8 後端會這樣做）
const lossy = (value) =>
  JSON.parse(
    new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(value).replace(/\\ud[89a-f][0-9a-f]{2}/gi, (m) => String.fromCharCode(parseInt(m.slice(2), 16))))),
  );

test('truncate：依碼點截斷，切點落在表情符號時整個字保留，不留孤立的代理字元', () => {
  const { value, truncated } = truncate(`${'x'.repeat(LIMITS.summary - 1)}😀 tail`, LIMITS.summary);
  assert.equal(truncated, true);
  assert.equal(value, `${'x'.repeat(LIMITS.summary - 1)}😀`);
  assert.equal(LONE_SURROGATE.test(value), false);
  assert.equal(Array.from(value).length, LIMITS.summary);
  // 碼點數在上限內就不截斷（即使 UTF-16 單位數超過上限）
  assert.deepEqual(truncate('😀'.repeat(6), 10), { value: '😀'.repeat(6), truncated: false });
  assert.deepEqual(truncate('😀'.repeat(11), 10), { value: '😀'.repeat(10), truncated: true });
});

test('儲存層把孤立代理字元正規化時，截斷過的證據仍驗證通過', async () => {
  const store = createMemoryStore();
  const realSet = store.set.bind(store);
  const realSetIfAbsent = store.setIfAbsent.bind(store);
  store.set = (k, v) => realSet(k, lossy(v));
  store.setIfAbsent = (k, v) => realSetIfAbsent(k, lossy(v));
  const jira = createFakeJira({ issues: [ISSUE], projects: PROJECTS });
  const ui = createResolverLogic({ store, jira, now: sequentialClock() });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const view = await ui.recordEvidence(HUMAN, { criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: `${'x'.repeat(LIMITS.summary - 1)}😀 tail` });
  assert.equal(view.chain.verified, true);
  assert.deepEqual(view.recorded.truncated, ['summary']);
});

test('稽核包：CSV 與 Markdown 的截斷也不切在表情符號中間', async () => {
  const store = createMemoryStore();
  const jira = createFakeJira({ issues: [ISSUE], projects: PROJECTS });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now });
  const tools = createTools({ store, jira, now });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  // CSV 截 500、Markdown 截 200：兩個切點都剛好落在表情符號上
  const summary = `${'x'.repeat(199)}😀${'y'.repeat(299)}😀 tail`;
  await tools.submitEvidence({ issueKey: 'DEMO-1', criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary, agentName: 'a' }, AGENT);
  const csv = (await ui.exportAudit(HUMAN, { format: 'csv' })).content;
  const md = (await ui.exportAudit(HUMAN, { format: 'markdown' })).content;
  assert.equal(LONE_SURROGATE.test(csv), false);
  assert.equal(LONE_SURROGATE.test(md), false);
  assert.ok(csv.includes(`${'y'.repeat(299)}😀…`));
  assert.ok(md.includes(`${'x'.repeat(199)}😀…`));
});

test('舊資料相容：以前截斷留下孤立代理字元的事件，雜湊方式沒變，照樣驗證通過', async () => {
  const store = createMemoryStore();
  const old = `${'x'.repeat(5)}${'😀'.slice(0, 1)}`;
  await appendEvent(store, '10001', { type: EVENT_TYPES.SUBMITTED, actor: 'a', at: '2026-11-12T08:00:00.000Z', payload: { summary: old } });
  const events = await listEvents(store, '10001');
  assert.equal(events[0].payload.summary, old);
  assert.equal(verifyChain(events, await store.get(headKey('10001'))).verified, true);
});
