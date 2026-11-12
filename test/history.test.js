import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTools } from '../src/actions/tools.js';
import { CSV_COLUMNS } from '../src/core/audit.js';
import { EVIDENCE_ROLE, GAP, STATUS } from '../src/core/state.js';
import { countLabel, plural } from '../src/core/text.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };

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

// AC-1：第一次 fail 被駁回、第二次 fail 沒人覆核、第三次 pass（最新）。AC-2 只有一筆。AC-3 沒有證據。
async function setup() {
  const store = createMemoryStore();
  const description = adfDoc(h(2, 'Acceptance criteria'), ul('Charge path opens at 45 C', 'Discharge path opens at 60 C', 'Sensor fault opens both paths'));
  const jira = createFakeJira({
    issues: [{ issueId: '10001', issueKey: 'BMS-1', title: 'Over-temperature', projectId: '20000', projectKey: 'BMS', description }],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
  });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now });
  const tools = createTools({ store, jira, now });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const first = await tools.submitEvidence(evidence('AC-1', 1, { verdict: 'fail', agentName: '=cmd|evil' }), AGENT);
  await ui.review(HUMAN, { evidenceSeq: first.seq, decision: 'reject', note: 'Fails at 45 C' });
  const second = await tools.submitEvidence(evidence('AC-1', 1, { verdict: 'fail' }), AGENT);
  const ac2 = await tools.submitEvidence(evidence('AC-2', 1), AGENT);
  const third = await tools.submitEvidence(evidence('AC-1', 1, { summary: 'Simulated: fixed and passing' }), AGENT);
  return { store, jira, ui, tools, first, second, third, ac2 };
}

test('evidence history: all submissions for the current revision, newest first, only the latest counts', async () => {
  const { ui, first, second, third, ac2 } = await setup();
  const view = await ui.getPanel(HUMAN);
  const [ac1, ac2View, ac3] = view.state.criteria;

  assert.equal(ac1.evidenceCount, 3);
  assert.deepEqual(ac1.history.map((e) => e.seq), [third.seq, second.seq, first.seq]);
  assert.deepEqual(ac1.history.map((e) => e.role), [EVIDENCE_ROLE.LATEST, EVIDENCE_ROLE.SUPERSEDED, EVIDENCE_ROLE.SUPERSEDED]);
  assert.deepEqual(ac1.history.map((e) => e.verdict), ['pass', 'fail', 'fail']);
  assert.equal(ac1.history[0].hash, third.hash);
  assert.equal(ac1.history[2].agentName, '=cmd|evil');
  // 覆核結果跟著被覆核的那一筆，不會移到較新的證據上
  assert.equal(ac1.history[0].review, null);
  assert.equal(ac1.history[1].review, null);
  assert.deepEqual(ac1.history[2].review, { decision: 'reject', reviewedBy: HUMAN.accountId, at: ac1.history[2].review.at });
  // 狀態只看最新一筆：pass 且未覆核
  assert.equal(ac1.latestEvidence.seq, third.seq);
  assert.equal(ac1.status, STATUS.SUBMITTED);
  assert.equal(ac1.gap, GAP.UNREVIEWED);
  assert.equal(ac1.review, null);
  // 歷史只放短欄位，不帶代理的摘要與輸出摘錄
  assert.equal('summary' in ac1.history[0], false);
  assert.equal('outputExcerpt' in ac1.history[0], false);

  assert.equal(ac2View.evidenceCount, 1);
  assert.deepEqual(ac2View.history.map((e) => [e.seq, e.role]), [[ac2.seq, EVIDENCE_ROLE.LATEST]]);
  assert.equal(ac3.evidenceCount, 0);
  assert.deepEqual(ac3.history, []);
});

test('evidence history: superseded evidence cannot be reviewed; the latest one can', async () => {
  const { ui, second, third } = await setup();
  const outdated = await ui.review(HUMAN, { evidenceSeq: second.seq, decision: 'accept' }).catch((e) => e);
  assert.equal(outdated.code, 'OUTDATED_EVIDENCE');
  const view = await ui.review(HUMAN, { evidenceSeq: third.seq, decision: 'accept' });
  const ac1 = view.state.criteria[0];
  assert.equal(ac1.status, STATUS.ACCEPTED);
  assert.equal(ac1.gap, null);
  assert.equal(ac1.history[0].review.decision, 'accept');
  assert.equal(ac1.history[1].review, null);
});

test('evidence history: a new revision starts with an empty history', async () => {
  const { ui, jira } = await setup();
  jira.issues.get('10001').description = adfDoc(h(2, 'Acceptance criteria'), ul('Charge path opens at 45 C', 'Discharge path opens at 60 C'));
  await ui.draftFromDescription(HUMAN);
  const view = await ui.approve(HUMAN, {});
  assert.equal(view.workOrder.rev, 2);
  assert.deepEqual(view.state.criteria.map((c) => [c.evidenceCount, c.history.length]), [[0, 0], [0, 0]]);
  assert.equal(view.state.previousRevisions[0].evidenceCount, 4);
});

test('get-evidence-status: evidenceCount per criterion for the current revision', async () => {
  const { tools } = await setup();
  const status = await tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT);
  assert.deepEqual(
    status.criteria.map((c) => [c.criterionId, c.evidenceCount, c.latestVerdict]),
    [
      ['AC-1', 3, 'pass'],
      ['AC-2', 1, 'pass'],
      ['AC-3', 0, null],
    ],
  );
});

test('audit pack CSV: superseded evidence column, still one row per criterion, no agent text in it', async () => {
  const { ui, first, second } = await setup();
  const csv = (await ui.exportAudit(HUMAN, { format: 'csv' })).content;
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(CSV_COLUMNS.at(-1), 'superseded_evidence');
  assert.equal(lines.length, 1 + 3);
  const ac1 = lines.find((l) => l.startsWith('BMS-1,') && l.includes(',AC-1,'));
  const iso = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
  assert.match(
    ac1,
    new RegExp(`,#${second.seq} fail ${iso} hash ${second.hash.slice(0, 12)}; #${first.seq} fail ${iso} hash ${first.hash.slice(0, 12)} \\(review: reject\\)$`),
  );
  // 被取代那筆的代理名稱只會出現在最新證據欄（這次最新的是 Test agent），不會進入 superseded 欄
  assert.equal(ac1.includes('=cmd|evil'), false);
  const ac2 = lines.find((l) => l.includes(',AC-2,'));
  assert.ok(ac2.endsWith(','));
});

test('audit pack Markdown: superseded evidence listed under the table, singular event wording', async () => {
  const { ui, first, second, third } = await setup();
  const text = (await ui.exportAudit(HUMAN, { format: 'markdown' })).content;
  assert.match(text, /Superseded evidence in revision 1 \(kept in the chain, not counted; newest first\):/);
  const line = text.split('\n').find((l) => l.startsWith('- AC-1: '));
  assert.ok(line.includes(`#${second.seq} fail `));
  assert.ok(line.includes(`hash ${second.hash.slice(0, 12)}`));
  assert.ok(line.includes(`#${first.seq} fail `));
  assert.ok(line.includes('(review: reject)'));
  assert.ok(line.indexOf(`#${second.seq} `) < line.indexOf(`#${first.seq} `));
  assert.equal(line.includes(`#${third.seq} `), false);
  assert.equal(text.split('\n').some((l) => l.startsWith('- AC-2: ')), false);
  assert.equal(text.includes('=cmd'), false);
  assert.match(text, /Evidence chain: verified, 6 events/);
});

test('audit pack Markdown: no superseded section when every criterion has at most one submission', async () => {
  const store = createMemoryStore();
  const jira = createFakeJira({
    issues: [{ issueId: '10001', issueKey: 'BMS-1', title: 'Over-temperature', projectId: '20000', projectKey: 'BMS', description: adfDoc(h(2, 'Acceptance criteria'), ul('Only one')) }],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
  });
  const ui = createResolverLogic({ store, jira, now: sequentialClock() });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const text = (await ui.exportAudit(HUMAN, { format: 'markdown' })).content;
  assert.equal(text.includes('Superseded evidence'), false);
  assert.match(text, /Evidence chain: verified, 1 event(?!s)/);
});

test('countLabel and plural switch between singular and plural', () => {
  assert.equal(countLabel(0, 'event'), '0 events');
  assert.equal(countLabel(1, 'event'), '1 event');
  assert.equal(countLabel(2, 'gap'), '2 gaps');
  assert.equal(countLabel(1, 'criterion', 'criteria'), '1 criterion');
  assert.equal(countLabel(4, 'criterion', 'criteria'), '4 criteria');
  assert.equal(plural('1', 'issue'), 'issue');
});

test('propose-work-order message uses singular criterion for one criterion', async () => {
  const { tools } = await setup();
  const result = await tools.proposeWorkOrder({ issueKey: 'BMS-1', criteriaJson: JSON.stringify([{ text: 'One', evidenceType: 'test' }]) }, AGENT);
  assert.match(result.message, /^Draft saved with 1 criterion and waiting/);
});

// 工具的 description 給代理看，平台上限 255 字元（規格第 6 節）
test('manifest: every action description fits in 255 characters', () => {
  const lines = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8').split(/\r?\n/);
  const start = lines.indexOf('  action:');
  const end = lines.indexOf('  function:');
  assert.ok(start > 0 && end > start);
  const descriptions = [];
  for (let i = start; i < end; i += 1) {
    const match = /^ {6}description: (.*)$/.exec(lines[i]);
    if (!match) continue;
    let text = match[1];
    if (text === '>') {
      const parts = [];
      for (let j = i + 1; j < end && /^ {8,}\S/.test(lines[j]); j += 1) parts.push(lines[j].trim());
      text = parts.join(' ');
    }
    descriptions.push(text);
  }
  assert.equal(descriptions.length, 6);
  for (const text of descriptions) assert.ok(text.length <= 255, `${text.length}: ${text.slice(0, 40)}`);
});
