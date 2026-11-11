import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { summaryKey } from '../src/core/keys.js';
import { createJiraClient } from '../src/jira/client.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { createKvsStore } from '../src/storage/kvs.js';
import { createFakeJira, createMemoryStore } from './helpers.js';

// 模擬 Forge KVS 查詢 API：每頁最多 `limit` 筆，用 cursor 接續下一頁。
function fakeKvs(entries) {
  const pagesServed = [];
  const client = {
    query() {
      const q = { prefix: '', limit: 10, cursor: null };
      const builder = {
        where(field, condition) {
          q.prefix = condition.prefix;
          return builder;
        },
        limit(n) {
          q.limit = n;
          return builder;
        },
        cursor(c) {
          q.cursor = c;
          return builder;
        },
        async getMany() {
          const matching = entries.filter(([key]) => key.startsWith(q.prefix));
          const start = q.cursor ? Number(q.cursor) : 0;
          const page = matching.slice(start, start + q.limit);
          pagesServed.push(page.length);
          const next = start + q.limit < matching.length ? String(start + q.limit) : undefined;
          return { results: page.map(([key, value]) => ({ key, value })), nextCursor: next };
        },
      };
      return builder;
    },
  };
  const where = { beginsWith: (prefix) => ({ prefix }) };
  return { client, where, pagesServed };
}

function summaries(count, projectId = '20000') {
  return Array.from({ length: count }, (_, i) => {
    const issueId = String(10001 + i);
    return [
      summaryKey(projectId, issueId),
      { issueId, issueKey: `BMS-${i + 1}`, title: `Issue ${i + 1}`, rev: 1, total: 4, accepted: i % 5 === 0 ? 4 : 2, gapCount: i % 5 === 0 ? 0 : 2, gapKinds: i % 5 === 0 ? [] : ['no-evidence'], stale: false, criteria: [] },
    ];
  });
}

test('KVS listByPrefix follows the cursor across pages of 100', async () => {
  const other = [['sum:99999:1', { issueId: '1' }], ['ev:10001:000001', {}]];
  const fake = fakeKvs([...summaries(230), ...other]);
  const store = createKvsStore(fake.client, fake.where);
  const rows = await store.listByPrefix('sum:20000:');
  assert.equal(rows.length, 230);
  assert.deepEqual(fake.pagesServed, [100, 100, 30]);
  assert.equal(new Set(rows.map((r) => r.key)).size, 230);
});

test('permission check is sent in chunks of 1000 issue IDs', async () => {
  const sent = [];
  const api = {
    asUser: () => ({
      async requestJira(route, init) {
        const ids = JSON.parse(init.body).projectPermissions[0].issues;
        sent.push(ids.length);
        // 呼叫者看不到 ID 尾數為 7 的議題
        const visible = ids.filter((id) => id % 10 !== 7);
        return { ok: true, status: 200, json: async () => ({ projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: visible }] }) };
      },
    }),
    asApp: () => {
      throw new Error('asApp must not be used when asUser works');
    },
  };
  const ids = Array.from({ length: 1500 }, (_, i) => String(10001 + i));
  const visible = await createJiraClient(api).filterVisibleIssueIds(ids, { accountId: 'someone' });
  assert.deepEqual(sent, [1000, 500]);
  assert.equal(visible.length, 1350);
  assert.equal(visible.includes('10007'), false);
});

test('matrix and list-gaps with 60 issues: all rows returned in natural key order, totals add up, hidden issues left out', async () => {
  const store = createMemoryStore();
  for (const [key, value] of summaries(60)) store.data.set(key, value);
  const jira = createFakeJira({ projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }], hidden: ['10060'] });
  const ui = createResolverLogic({ store, jira });
  const matrix = await ui.getMatrix({ accountId: 'someone', projectKey: 'BMS' });
  assert.equal(matrix.issues.length, 59);
  assert.deepEqual(matrix.issues.slice(0, 3).map((i) => i.issueKey), ['BMS-1', 'BMS-2', 'BMS-3']);
  assert.equal(matrix.issues[9].issueKey, 'BMS-10');
  assert.equal(matrix.issues.at(-1).issueKey, 'BMS-59');
  // 60 個議題中有 12 個沒有缺口（i % 5 === 0）；BMS-60（i = 59）被隱藏，而且有缺口
  assert.deepEqual(matrix.totals, { issues: 59, criteria: 236, accepted: 12 * 4 + 47 * 2, gaps: 47 * 2 });

  const tools = createTools({ store, jira });
  const gaps = await tools.listGaps({ projectKey: 'BMS' }, { accountId: 'someone' });
  assert.equal(gaps.issuesWithWorkOrders, 59);
  assert.equal(gaps.issuesWithGaps, 47);
  const open = await tools.listOpenWorkOrders({ projectKey: 'BMS' }, { accountId: 'someone' });
  assert.equal(open.count, 47);
});
