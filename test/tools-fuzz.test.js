// MCP／Rovo 工具收到缺欄位、型別不對、超長字串、不存在的議題、錯誤版次時，都回 ok 或結構化錯誤
// （找錯報告 2026-11-21 的 tools-fuzz 測試，改成 repo 的格式）。
// 模擬 actions/index.js 的 wrap：只取宣告的欄位、例外轉成 errorResult。INTERNAL_ERROR 代表未預期的例外。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools, errorResult } from '../src/actions/tools.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, p, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'DEMO' };
const PROJECTS = [{ projectId: '20000', projectKey: 'DEMO', name: 'Demo' }];
const ISSUE = {
  issueId: '10001',
  issueKey: 'DEMO-1',
  title: '=HYPERLINK("http://x","y")',
  projectId: '20000',
  projectKey: 'DEMO',
  description: adfDoc(p('Acceptance criteria'), ul('A | pipe\nnewline <b>', '@SUM(1,2)')),
};

const INPUTS = {
  getWorkOrder: ['issueKey'],
  listOpenWorkOrders: ['projectKey'],
  getEvidenceStatus: ['issueKey'],
  submitEvidence: ['issueKey', 'criterionId', 'workOrderRev', 'verdict', 'evidenceType', 'summary', 'reference', 'outputExcerpt', 'agentName'],
  proposeWorkOrder: ['issueKey', 'criteriaJson'],
  listGaps: ['projectKey', 'fixVersion'],
};

async function setup() {
  const store = createMemoryStore();
  const jira = createFakeJira({ issues: [structuredClone(ISSUE)], projects: PROJECTS, projectVersions: [{ name: '1.0' }] });
  const now = sequentialClock();
  const tools = createTools({ store, jira, now });
  const ui = createResolverLogic({ store, jira, now });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const call = async (name, payload) => {
    const input = {};
    for (const field of INPUTS[name]) input[field] = payload?.[field];
    try {
      return await tools[name](input, { accountId: 'agent' });
    } catch (error) {
      return errorResult(error);
    }
  };
  return { store, tools, ui, call };
}

const WEIRD = [undefined, null, '', '   ', 0, -1, 1.5, true, {}, [], ['DEMO-1'], 'x'.repeat(100000), 'demo-1', ' DEMO-1 ', 'DEMO-999', 'DEMO-1; DROP', '😀', '1e0', NaN];

test('tools fuzz: 六個工具對各種奇怪輸入都回 ok 或結構化錯誤，沒有 INTERNAL_ERROR', async () => {
  const { call } = await setup();
  const internal = [];
  const base = { issueKey: 'DEMO-1', criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 's', agentName: 'a', projectKey: 'DEMO', criteriaJson: '[{"text":"X"}]' };
  for (const name of Object.keys(INPUTS)) {
    for (const field of INPUTS[name]) {
      for (const value of WEIRD) {
        const result = await call(name, { ...base, [field]: value });
        if (result === undefined || result === null) internal.push(`${name}.${field} returned nothing`);
        else if (result.ok === false && result.error.code === 'INTERNAL_ERROR') internal.push(`${name}.${field}=${JSON.stringify(value)?.slice(0, 30)}`);
      }
    }
  }
  const jsons = ['[null]', '["a","b"]', '{"text":"A"}', '[{"text":{"a":1}}]', '[{"text":5}]', '[{"text":"A","evidenceType":5}]', `[${'{"text":"A"},'.repeat(40)}{"text":"B"}]`, `[{"text":"${'y'.repeat(5000)}"}]`];
  for (const json of jsons) {
    const result = await call('proposeWorkOrder', { issueKey: 'DEMO-1', criteriaJson: json });
    if (result?.ok === false && result.error.code === 'INTERNAL_ERROR') internal.push(`proposeWorkOrder criteriaJson=${json.slice(0, 30)}`);
  }
  assert.deepEqual(internal, []);
});

test('criteriaJson 與面板送來的條件：text 不是字串時回 INVALID_INPUT，不存成「[object Object]」', async () => {
  const { call, ui } = await setup();
  const before = (await ui.getPanel(HUMAN)).draft;
  for (const json of ['[{"text":{"a":1}}]', '[{"text":5}]', '[{"text":["A"]}]', '[{"text":"A"},{"text":true}]']) {
    const result = await call('proposeWorkOrder', { issueKey: 'DEMO-1', criteriaJson: json });
    assert.deepEqual(result, { ok: false, error: { code: 'INVALID_INPUT', message: 'Each criterion text must be a string.' } }, json);
  }
  assert.deepEqual((await ui.getPanel(HUMAN)).draft, before);
  // 面板的 Save draft 與 Approve 走同一個檢查
  const saved = await ui.saveDraft(HUMAN, { criteria: [{ text: { a: 1 }, evidenceType: 'test' }] }).catch((e) => e);
  assert.equal(errorResult(saved).error.code, 'INVALID_INPUT');
  const approved = await ui.approve(HUMAN, { criteria: [{ text: 1, evidenceType: 'test' }] }).catch((e) => e);
  assert.equal(errorResult(approved).error.code, 'INVALID_INPUT');
  assert.equal((await ui.getPanel(HUMAN)).workOrder.rev, 1);
  // text 缺少或是 null 的條目照舊略過
  const ok = await call('proposeWorkOrder', { issueKey: 'DEMO-1', criteriaJson: '[{"text":null},{"evidenceType":"test"},{"text":"A"}]' });
  assert.equal(ok.ok, true);
  assert.deepEqual((await ui.getPanel(HUMAN)).draft.criteria, [{ text: 'A', evidenceType: 'test' }]);
});

test('稽核包：CSV 公式字首、引號、逗號、換行；Markdown 的 |、換行與 < 都有跳脫', async () => {
  const { call, ui } = await setup();
  await call('submitEvidence', { issueKey: 'DEMO-1', criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: '+cmd|" /C calc"!A0, "quoted"\nline2', reference: '-2+3', agentName: '@agent' });
  await call('submitEvidence', { issueKey: 'DEMO-1', criterionId: 'AC-2', workOrderRev: 1, verdict: 'fail', evidenceType: 'test', summary: 'pipe | in \\| summary\r\nnext', agentName: '=1+1' });
  const csv = (await ui.exportAudit(HUMAN, { format: 'csv' })).content;
  const md = (await ui.exportAudit(HUMAN, { format: 'markdown' })).content;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""y"")"`));
  assert.ok(csv.includes(`"'+cmd|"" /C calc""!A0, ""quoted""\nline2"`));
  assert.ok(csv.includes(`'-2+3`));
  assert.ok(csv.includes(`'@SUM(1,2)`));
  assert.ok(csv.includes(`'=1+1`));
  const rows = md.split('\n').filter((line) => line.startsWith('| AC-'));
  assert.equal(rows.length, 2);
  for (const line of rows) {
    // 未跳脫的 | 只應是欄位分隔：7 欄的表格每列 8 個
    assert.equal(line.replace(/\\\|/g, '').split('|').length - 1, 8, line);
    assert.equal(line.includes('<b>'), false);
  }
});
