// 同一議題同時寫入很多筆（代理平行呼叫 submit-evidence）時的序號防撞（找錯報告 2026-11-21 的 F8 重現測試，改成 repo 的格式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools, errorResult } from '../src/actions/tools.js';
import { EVENT_TYPES, MAX_APPEND_ATTEMPTS, appendEvent, listEvents, verifyChain } from '../src/core/chain.js';
import { DomainError } from '../src/core/workorder.js';
import { headKey } from '../src/core/keys.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, p, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'DEMO' };
const AGENT = { accountId: 'agent-account' };
const ISSUE = {
  issueId: '10001',
  issueKey: 'DEMO-1',
  title: 'T',
  projectId: '20000',
  projectKey: 'DEMO',
  description: adfDoc(p('Acceptance criteria'), ul(...Array.from({ length: 30 }, (_, i) => `C${i + 1}`))),
};

for (const n of [10, 30]) {
  test(`同時送 ${n} 筆證據：全部成功、序號連續、鏈驗證通過`, async () => {
    const store = createMemoryStore();
    const jira = createFakeJira({ issues: [ISSUE], projects: [{ projectId: '20000', projectKey: 'DEMO', name: 'Demo' }] });
    const now = sequentialClock();
    const ui = createResolverLogic({ store, jira, now });
    const tools = createTools({ store, jira, now });
    await ui.draftFromDescription(HUMAN);
    await ui.approve(HUMAN, {});
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        tools
          .submitEvidence({ issueKey: 'DEMO-1', criterionId: `AC-${i + 1}`, workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 's', agentName: 'a' }, AGENT)
          .catch((e) => errorResult(e)),
      ),
    );
    assert.deepEqual(results.filter((r) => !r.ok), []);
    const events = await listEvents(store, '10001');
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: n + 1 }, (_, i) => i + 1));
    assert.equal(verifyChain(events, await store.get(headKey('10001'))).verified, true);
  });
}

test('序號防撞的重試用完時回 BUSY（可辨識的「請重試」），不是 INTERNAL_ERROR，也沒有寫入', async () => {
  const store = createMemoryStore();
  // 每次都搶輸的儲存層：事件鍵的「不存在才寫入」一律失敗
  store.setIfAbsent = async () => false;
  const waits = [];
  const error = await appendEvent(store, '10001', { type: EVENT_TYPES.SUBMITTED, actor: 'a', at: '2026-11-21T00:00:00.000Z', payload: {} }, { wait: async (attempt) => waits.push(attempt) }).catch((e) => e);
  assert.ok(error instanceof DomainError);
  assert.deepEqual(errorResult(error), { ok: false, error: { code: 'BUSY', message: 'Too many writes at once. Retry this call.' } });
  // 第一次不等，之後每次重試前各等一次
  assert.deepEqual(waits, Array.from({ length: MAX_APPEND_ATTEMPTS - 1 }, (_, i) => i + 1));
  assert.equal(store.data.size, 0);
});

test('重試前的隨機等待：沒有衝突時不等；衝突後等一次再成功', async () => {
  const store = createMemoryStore();
  const waits = [];
  const wait = async (attempt) => waits.push(attempt);
  const body = { type: EVENT_TYPES.SUBMITTED, actor: 'a', at: '2026-11-21T00:00:00.000Z', payload: {} };
  await appendEvent(store, '10001', body, { wait });
  assert.deepEqual(waits, []);
  // 第一次寫入時有人搶先寫了同一個序號
  const realSetIfAbsent = store.setIfAbsent.bind(store);
  let raced = false;
  store.setIfAbsent = async (key, value) => {
    if (!raced) {
      raced = true;
      await realSetIfAbsent(key, { ...value, actor: 'someone else' });
      return false;
    }
    return realSetIfAbsent(key, value);
  };
  const event = await appendEvent(store, '10001', body, { wait });
  assert.equal(event.seq, 3);
  assert.deepEqual(waits, [1]);
});
