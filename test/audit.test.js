import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { CSV_COLUMNS, csvCell } from '../src/core/audit.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };

async function setup() {
  const store = createMemoryStore();
  const description = adfDoc(h(2, 'Acceptance criteria'), ul('Cut discharge, then log | fault', 'Resume after hysteresis'));
  const jira = createFakeJira({
    issues: [
      { issueId: '10001', issueKey: 'BMS-1', title: 'Over-temperature', projectId: '20000', projectKey: 'BMS', description },
      { issueId: '10002', issueKey: 'BMS-2', title: 'Hidden issue', projectId: '20000', projectKey: 'BMS', description },
    ],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
  });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now });
  const tools = createTools({ store, jira, now });
  for (const issueId of ['10001', '10002']) {
    await ui.draftFromDescription({ ...HUMAN, issueId });
    await ui.approve({ ...HUMAN, issueId }, {});
  }
  const sent = await tools.submitEvidence(
    {
      issueKey: 'BMS-1',
      criterionId: 'AC-1',
      workOrderRev: 1,
      verdict: 'pass',
      evidenceType: 'test',
      summary: '=HYPERLINK("x") simulated, with "quotes", commas\nand a newline',
      reference: 'abc1234',
      agentName: 'Test agent',
    },
    AGENT,
  );
  await ui.review({ ...HUMAN, issueId: '10001' }, { evidenceSeq: sent.seq, decision: 'accept', note: 'Checked' });
  // 檢視者看不到 BMS-2，所以匯出內容必須排除它
  const viewerJira = createFakeJira({ issues: [...jira.issues.values()], projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }], hidden: ['10002'] });
  return { ui: createResolverLogic({ store, jira: viewerJira, now }), store, sent };
}

test('audit export CSV: one row per criterion, quoted safely, formula cells neutralised', async () => {
  const { ui } = await setup();
  const result = await ui.exportAudit(HUMAN, { format: 'csv' });
  assert.equal(result.format, 'csv');
  assert.match(result.fileName, /^BMS-evidence-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(result.issueCount, 1);
  const lines = result.content.trim().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  // 標題列加上 BMS-1 的 2 條驗收條件；多行的摘要留在同一個有引號的儲存格內
  assert.equal(result.content.split('\r\n').filter((l) => l.startsWith('BMS-')).length, 2);
  assert.ok(result.content.includes(`"'=HYPERLINK(""x"") simulated, with ""quotes"", commas\nand a newline"`));
  assert.ok(result.content.includes('accept'));
  assert.equal(result.content.includes('Hidden issue'), false);
});

test('audit export Markdown: totals, chain status, escaped table cells, no hidden issues', async () => {
  const { ui, sent } = await setup();
  const result = await ui.exportAudit(HUMAN, { format: 'markdown' });
  assert.match(result.fileName, /\.md$/);
  const text = result.content;
  assert.match(text, /^# Evidence audit pack: BMS/);
  assert.match(text, /not a compliance determination/);
  assert.match(text, /from Acceptance Trail records/);
  assert.doesNotMatch(text, /Evidence Chain records/);
  assert.match(text, /\| 1 \| 2 \| 1 \| 1 \|/);
  assert.match(text, /## BMS-1: Over-temperature/);
  // 核准、證據、覆核
  assert.match(text, /Evidence chain: verified, 3 events, last hash [0-9a-f]{12}/);
  assert.ok(text.includes('Cut discharge, then log \\| fault'));
  assert.ok(text.includes(`#${sent.seq}, hash ${sent.hash.slice(0, 12)}`));
  assert.ok(text.includes('accept by `human-account`'));
  assert.equal(text.includes('Hidden issue'), false);
});

test('audit export: broken chain is reported; unknown format is refused', async () => {
  const { ui, store } = await setup();
  const key = 'ev:10001:000002';
  const event = store.data.get(key);
  event.payload.summary = 'edited';
  store.data.set(key, event);
  const text = (await ui.exportAudit(HUMAN, { format: 'markdown' })).content;
  assert.match(text, /Evidence chain: BROKEN at event 2/);
  const csv = (await ui.exportAudit(HUMAN, { format: 'csv' })).content;
  assert.ok(csv.split('\r\n')[1].includes(',no,AC-1,'));
  const error = await ui.exportAudit(HUMAN, { format: 'pdf' }).catch((e) => e);
  assert.equal(error.code, 'INVALID_FORMAT');
});

test('csvCell quoting rules', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell(null), '');
});
