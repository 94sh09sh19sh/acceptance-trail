import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { CSV_COLUMNS } from '../src/core/audit.js';
import { summaryKey } from '../src/core/keys.js';
import { MIRROR_PROPERTY_KEY, mirrorFingerprint, mirrorValue } from '../src/core/mirror.js';
import { GAP, GAP_KINDS, STATUS } from '../src/core/state.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { createIssueUpdatedHandler } from '../src/triggers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

// 缺口種類 not-run：最新證據的判定是 not-run 時，缺口是 not-run，不再算成 failed。
// 「沒有執行」不是「失敗」。兩者都算缺口、都不算接受，覆核結果也不改變缺口種類。

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };
const description = adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B', 'C'));
const issue = (n) => ({ issueId: String(10000 + n), issueKey: `BMS-${n}`, title: `Issue ${n}`, projectId: '20000', projectKey: 'BMS', description });
const PROJECTS = [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }];
const PROP = `10001/${MIRROR_PROPERTY_KEY}`;

const evidence = (issueKey, criterionId, verdict) => ({
  issueKey,
  criterionId,
  workOrderRev: 1,
  verdict,
  evidenceType: 'test',
  summary: `Simulated ${verdict} for ${criterionId}`,
  agentName: 'Test agent',
});

// BMS-1 與 BMS-2 都核准了三條驗收條件（AC-1 到 AC-3），還沒有任何證據
async function setup() {
  const store = createMemoryStore();
  const jira = createFakeJira({ issues: [issue(1), issue(2)], projects: PROJECTS });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now });
  const tools = createTools({ store, jira, now });
  for (const issueId of ['10001', '10002']) {
    await ui.draftFromDescription({ ...HUMAN, issueId });
    await ui.approve({ ...HUMAN, issueId }, {});
  }
  // 代理經 MCP 送一筆證據，回傳事件序號
  const send = async (criterionId, verdict, issueKey = 'BMS-1') => (await tools.submitEvidence(evidence(issueKey, criterionId, verdict), AGENT)).seq;
  // 人在議題面板手動記錄一筆證據
  const record = (criterionId, verdict) =>
    ui.recordEvidence(HUMAN, { criterionId, workOrderRev: 1, verdict, evidenceType: 'test', summary: `Manual ${verdict} for ${criterionId}` });
  const criterion = async (id) => (await ui.getPanel(HUMAN)).state.criteria.find((c) => c.id === id);
  return { store, jira, ui, tools, send, record, criterion, trigger: createIssueUpdatedHandler({ store, jira, now }) };
}

test('not-run 缺口：缺口種類的順序把 not-run 放在 failed 後面', () => {
  assert.equal(GAP.NOT_RUN, 'not-run');
  assert.deepEqual(GAP_KINDS, ['no-evidence', 'failed', 'not-run', 'unreviewed', 'rejected', 'stale']);
});

test('not-run 缺口：最新證據是 not-run 時缺口是 not-run，不是 failed；仍計入缺口、不算接受', async () => {
  const { ui, tools, send } = await setup();
  await send('AC-1', 'fail');
  await send('AC-2', 'not-run');
  const view = await ui.getPanel(HUMAN);
  assert.deepEqual(view.state.criteria.map((c) => [c.id, c.status, c.gap]), [
    ['AC-1', STATUS.SUBMITTED, GAP.FAILED],
    ['AC-2', STATUS.SUBMITTED, GAP.NOT_RUN],
    ['AC-3', STATUS.NO_EVIDENCE, GAP.NO_EVIDENCE],
  ]);
  assert.equal(view.state.gapCount, 3);
  assert.equal(view.state.accepted, 0);
  assert.deepEqual(view.state.gapKinds, [GAP.FAILED, GAP.NOT_RUN, GAP.NO_EVIDENCE]);

  // get-evidence-status 回傳同樣的缺口種類，判定照原樣
  const status = await tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT);
  assert.deepEqual(status.criteria.map((c) => [c.criterionId, c.gap, c.latestVerdict]), [
    ['AC-1', 'failed', 'fail'],
    ['AC-2', 'not-run', 'not-run'],
    ['AC-3', 'no-evidence', null],
  ]);
  assert.equal(status.gapCount, 3);
});

test('not-run 缺口的轉換：fail 之後記 not-run 變成 not-run，not-run 之後記 pass 變成 unreviewed，再記 fail 變回 failed', async () => {
  const { send, record, criterion } = await setup();
  await send('AC-1', 'fail');
  assert.equal((await criterion('AC-1')).gap, GAP.FAILED);

  // 人在面板手動記錄 not-run（試用步驟走的路徑）：最新一筆為準
  let view = await record('AC-1', 'not-run');
  let ac1 = view.state.criteria[0];
  assert.equal(ac1.gap, GAP.NOT_RUN);
  assert.deepEqual(ac1.history.map((e) => [e.role, e.verdict]), [['latest', 'not-run'], ['superseded', 'fail']]);

  await send('AC-1', 'pass');
  ac1 = await criterion('AC-1');
  assert.equal(ac1.status, STATUS.SUBMITTED);
  assert.equal(ac1.gap, GAP.UNREVIEWED);

  view = await record('AC-1', 'fail');
  assert.equal(view.state.criteria[0].gap, GAP.FAILED);
  assert.equal(view.state.criteria[0].evidenceCount, 4);
  assert.equal(view.chain.verified, true);
});

test('not-run 被接受或退回後缺口仍是 not-run，也不算接受（和 failed 相同）', async () => {
  const { ui, send } = await setup();
  const ac1 = await send('AC-1', 'not-run');
  const ac2 = await send('AC-2', 'not-run');
  const ac3 = await send('AC-3', 'fail');
  await ui.review(HUMAN, { evidenceSeq: ac1, decision: 'accept', note: 'Not run is acceptable for now' });
  await ui.review(HUMAN, { evidenceSeq: ac2, decision: 'reject' });
  const view = await ui.review(HUMAN, { evidenceSeq: ac3, decision: 'accept' });
  assert.deepEqual(view.state.criteria.map((c) => [c.id, c.status, c.gap]), [
    ['AC-1', STATUS.ACCEPTED, GAP.NOT_RUN],
    ['AC-2', STATUS.REJECTED, GAP.NOT_RUN],
    ['AC-3', STATUS.ACCEPTED, GAP.FAILED],
  ]);
  assert.equal(view.state.accepted, 0);
  assert.equal(view.state.gapCount, 3);
});

test('list-gaps：not-run 以獨立的 kind 回傳，依 kind 篩出 not-run 只得到那幾條；矩陣的缺口種類與計數相同', async () => {
  const { ui, tools, send } = await setup();
  await send('AC-1', 'fail');
  await send('AC-2', 'not-run');
  await send('AC-1', 'fail', 'BMS-2');

  const result = await tools.listGaps({ projectKey: 'BMS' }, AGENT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues.find((i) => i.issueKey === 'BMS-1').gaps, [
    { kind: 'failed', criterionId: 'AC-1' },
    { kind: 'not-run', criterionId: 'AC-2' },
    { kind: 'no-evidence', criterionId: 'AC-3' },
  ]);
  // list-gaps 沒有缺口種類參數；Evidence Auditor 依回傳的 kind 篩。BMS-2 只有 failed，不會被當成 not-run
  const byKind = (kind) => result.issues.flatMap((i) => i.gaps.filter((g) => g.kind === kind).map((g) => `${i.issueKey} ${g.criterionId}`));
  assert.deepEqual(byKind(GAP.NOT_RUN), ['BMS-1 AC-2']);
  assert.deepEqual(byKind(GAP.FAILED), ['BMS-1 AC-1', 'BMS-2 AC-1']);

  // 矩陣：Filter by gap 用列的 gapKinds 比對，Not run ×N 用 criteria 的 gap 計數（見 matrix.jsx）
  const matrix = await ui.getMatrix(HUMAN);
  assert.deepEqual(matrix.gapKinds, GAP_KINDS);
  const row = (key) => matrix.issues.find((i) => i.issueKey === key);
  assert.deepEqual(matrix.issues.filter((i) => i.gapKinds.includes('not-run')).map((i) => i.issueKey), ['BMS-1']);
  assert.equal(row('BMS-1').criteria.filter((c) => c.gap === 'not-run').length, 1);
  assert.equal(row('BMS-1').criteria.filter((c) => c.gap === 'failed').length, 1);
  assert.equal(row('BMS-2').gapKinds.includes('not-run'), false);
});

test('稽核包：CSV 的 gap 欄與 Markdown 的 Gap 欄把 not-run 寫成 not-run，fail 仍是 failed', async () => {
  const { ui, send } = await setup();
  await send('AC-1', 'fail');
  await send('AC-2', 'not-run');

  const csv = (await ui.exportAudit(HUMAN, { format: 'csv' })).content;
  const lines = csv.trim().split('\r\n');
  const col = (name) => CSV_COLUMNS.indexOf(name);
  // 這幾列的儲存格都沒有逗號，可以直接切
  const cells = (criterionId) => lines.find((l) => l.startsWith('BMS-1,') && l.includes(`,${criterionId},`)).split(',');
  assert.deepEqual([cells('AC-1')[col('status')], cells('AC-1')[col('gap')], cells('AC-1')[col('verdict')]], ['submitted', 'failed', 'fail']);
  assert.deepEqual([cells('AC-2')[col('status')], cells('AC-2')[col('gap')], cells('AC-2')[col('verdict')]], ['submitted', 'not-run', 'not-run']);
  assert.equal(cells('AC-3')[col('gap')], 'no-evidence');

  const md = (await ui.exportAudit(HUMAN, { format: 'markdown' })).content;
  const section = md.slice(md.indexOf('## BMS-1'), md.indexOf('## BMS-2'));
  const row = (id) => section.split('\n').find((l) => l.startsWith(`| ${id} |`));
  assert.match(row('AC-1'), /^\| AC-1 \| A \| test \| submitted \| failed \| fail \(test\) #\d+/);
  assert.match(row('AC-2'), /^\| AC-2 \| B \| test \| submitted \| not-run \| not-run \(test\) #\d+/);
  assert.match(row('AC-3'), /^\| AC-3 \| C \| test \| no-evidence \| no-evidence \| - \|/);
});

test('JQL 鏡射：gapKinds 多一種 not-run（排序後），和矩陣摘要一致；改記 pass 後拿掉', async () => {
  const { store, jira, ui, send } = await setup();
  await send('AC-1', 'fail');
  const ac2 = await send('AC-2', 'not-run');
  let prop = jira.properties.get(PROP);
  assert.deepEqual(prop.gapKinds, ['failed', 'no-evidence', 'not-run']);
  assert.equal(prop.gapCount, 3);
  assert.deepEqual(prop, mirrorValue(await store.get(summaryKey('20000', '10001'))));

  // 接受 not-run 的證據不改變缺口種類
  await ui.review(HUMAN, { evidenceSeq: ac2, decision: 'accept' });
  prop = jira.properties.get(PROP);
  assert.deepEqual(prop.gapKinds, ['failed', 'no-evidence', 'not-run']);
  assert.equal(prop.accepted, 0);

  await send('AC-2', 'pass');
  prop = jira.properties.get(PROP);
  assert.deepEqual(prop.gapKinds, ['failed', 'no-evidence', 'unreviewed']);
});

test('既有資料：舊版摘要把 not-run 記成 failed 時，推導立刻是 not-run；摘要與 JQL 屬性在下一次重算時改寫', async () => {
  const { store, jira, ui, tools, send, trigger } = await setup();
  await send('AC-2', 'not-run');
  // 模擬舊版程式留下的摘要與 issue property：AC-2 記成 failed
  const key = summaryKey('20000', '10001');
  const current = await store.get(key);
  const asOld = (kind) => (kind === 'not-run' ? 'failed' : kind);
  const old = { ...current, gapKinds: current.gapKinds.map(asOld), criteria: current.criteria.map((c) => ({ ...c, gap: asOld(c.gap) })) };
  old.mirrorFingerprint = mirrorFingerprint(mirrorValue(old));
  await store.set(key, old);
  jira.properties.set(PROP, mirrorValue(old));

  // 讀已儲存摘要的地方（list-gaps、矩陣）在重算前仍是舊值
  let gaps = await tools.listGaps({ projectKey: 'BMS' }, AGENT);
  assert.equal(gaps.issues.find((i) => i.issueKey === 'BMS-1').gaps.find((g) => g.criterionId === 'AC-2').kind, 'failed');
  // 稽核包當場由事件推導，馬上是 not-run
  const csv = (await ui.exportAudit(HUMAN, { format: 'csv' })).content;
  const ac2Row = csv.split('\r\n').find((l) => l.startsWith('BMS-1,') && l.includes(',AC-2,')).split(',');
  assert.equal(ac2Row[CSV_COLUMNS.indexOf('gap')], 'not-run');
  // 和摘要無關的議題變更（例如標籤）不觸發重算
  assert.equal((await trigger({ issue: { id: '10001' }, changelog: { items: [{ field: 'labels', fieldId: 'labels' }] } })).reason, 'irrelevant-change');
  assert.deepEqual(jira.properties.get(PROP).gapKinds, ['failed', 'no-evidence']);

  // 開面板（或 get-evidence-status 等任何重算）後，摘要與 JQL 屬性都改寫成 not-run
  const writes = jira.propertyWrites.length;
  await ui.getPanel(HUMAN);
  assert.equal(jira.propertyWrites.length, writes + 1);
  assert.deepEqual(jira.properties.get(PROP).gapKinds, ['no-evidence', 'not-run']);
  gaps = await tools.listGaps({ projectKey: 'BMS' }, AGENT);
  assert.equal(gaps.issues.find((i) => i.issueKey === 'BMS-1').gaps.find((g) => g.criterionId === 'AC-2').kind, 'not-run');
});
