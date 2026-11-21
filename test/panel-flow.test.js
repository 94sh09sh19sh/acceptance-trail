// 議題面板後端的起草、核准、覆核流程（找錯報告 2026-11-21 的 panel-flow 重現測試，改成 repo 的格式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorResult } from '../src/actions/tools.js';
import { CRITERIA_FROM } from '../src/core/adf.js';
import { listEvents } from '../src/core/chain.js';
import { FALLBACK_NOTICE, draftNotices } from '../src/core/draft-notice.js';
import { LIMITS } from '../src/core/validate.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, p, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'DEMO' };
const PROJECTS = [{ projectId: '20000', projectKey: 'DEMO', name: 'Demo' }];
const issueWith = (description) => ({ issueId: '10001', issueKey: 'DEMO-1', title: 'Export', projectId: '20000', projectKey: 'DEMO', description });

function setup(description) {
  const store = createMemoryStore();
  const jira = createFakeJira({ issues: [issueWith(description)], projects: PROJECTS });
  const ui = createResolverLogic({ store, jira, now: sequentialClock() });
  return { store, jira, ui };
}

// ---- F1 退回取全文清單時的提示 ----

test('draft from description: 找不到標題而退回全文清單時，草稿標成 all-lists 並有提示；找到標題時沒有提示', async () => {
  const fallback = setup(adfDoc(p('Some context'), ul('Uses the existing API'), ul('CSV has a header row')));
  const view = await fallback.ui.draftFromDescription(HUMAN);
  assert.deepEqual(view.draft.criteria.map((c) => c.text), ['Uses the existing API', 'CSV has a header row']);
  assert.equal(view.draft.source, 'parser');
  assert.equal(view.draft.extraction.from, CRITERIA_FROM.ALL_LISTS);
  assert.deepEqual(draftNotices(view.draft), [FALLBACK_NOTICE]);
  // 重新整理面板後提示還在（存在草稿裡，不是只在這次回應）
  assert.deepEqual(draftNotices((await fallback.ui.getPanel(HUMAN)).draft), [FALLBACK_NOTICE]);
  // 人存過草稿後就是人的草稿，不再提示
  const saved = await fallback.ui.saveDraft(HUMAN, { criteria: [{ text: 'CSV has a header row', evidenceType: 'test' }] });
  assert.deepEqual(draftNotices(saved.draft), []);

  const section = setup(adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B')));
  const sectionView = await section.ui.draftFromDescription(HUMAN);
  assert.equal(sectionView.draft.extraction.from, CRITERIA_FROM.SECTION);
  assert.deepEqual(draftNotices(sectionView.draft), []);

  // 描述裡什麼都抽不到：空白草稿，沒有提示
  const empty = setup(adfDoc(p('Only prose here.')));
  const emptyView = await empty.ui.draftFromDescription(HUMAN);
  assert.deepEqual(emptyView.draft.criteria, []);
  assert.deepEqual(draftNotices(emptyView.draft), []);
});

// ---- F4 描述裡的條目超過 30 條 ----

test('draft from description: 超過 30 條（11 條、每條 2 個子條目）時保留前 30 條、存檔成功，並提示找到幾條', async () => {
  const items = Array.from({ length: 11 }, (_, i) => ({ type: 'listItem', content: [p(`Criterion ${i + 1}`), ul(`Detail ${i + 1}a`, `Detail ${i + 1}b`)] }));
  const { ui } = setup(adfDoc(p('Acceptance criteria'), ul(...items)));
  const view = await ui.draftFromDescription(HUMAN);
  assert.ok(view.draft, '起草失敗，面板停在 No work order');
  assert.equal(view.draft.criteria.length, LIMITS.maxCriteria);
  assert.deepEqual(view.draft.criteria.slice(0, 3).map((c) => c.text), ['Criterion 1', 'Detail 1a', 'Detail 1b']);
  assert.equal(view.draft.criteria.at(-1).text, 'Detail 10b');
  assert.deepEqual(view.draft.extraction, { from: CRITERIA_FROM.SECTION, found: 33, kept: 30 });
  assert.deepEqual(draftNotices(view.draft), ['Found 33 items in the description and kept the first 30. Merge or remove items before you approve.']);
  // 留下的 30 條可以直接核准
  const approved = await ui.approve(HUMAN, {});
  assert.equal(approved.workOrder.rev, 1);
  assert.equal(approved.state.total, 30);
});

test('draft from description: 剛好 30 條不提示；退回全文清單又超過上限時兩則提示都有', async () => {
  const thirty = setup(adfDoc(p('Acceptance criteria'), ul(...Array.from({ length: 30 }, (_, i) => `C${i + 1}`))));
  const view = await thirty.ui.draftFromDescription(HUMAN);
  assert.equal(view.draft.criteria.length, 30);
  assert.deepEqual(draftNotices(view.draft), []);

  const both = setup(adfDoc(ul(...Array.from({ length: 20 }, (_, i) => `A${i + 1}`)), ul(...Array.from({ length: 15 }, (_, i) => `B${i + 1}`))));
  const bothView = await both.ui.draftFromDescription(HUMAN);
  assert.equal(bothView.draft.criteria.length, 30);
  assert.deepEqual(draftNotices(bothView.draft), [FALLBACK_NOTICE, 'Found 35 items in the description and kept the first 30. Merge or remove items before you approve.']);
});

// ---- F6 Draft new revision ----

test('draft new revision: 描述沒改過時以現行版為底，現行版選好的證據類型（AC-2 為 review）保留', async () => {
  const { ui } = setup(adfDoc(p('Acceptance criteria'), ul('A', 'B')));
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, { criteria: [{ text: 'A', evidenceType: 'test' }, { text: 'B', evidenceType: 'review' }] });
  const view = await ui.draftFromDescription(HUMAN);
  assert.equal(view.stale, false);
  assert.deepEqual(view.draft.criteria, [{ text: 'A', evidenceType: 'test' }, { text: 'B', evidenceType: 'review' }]);
  assert.deepEqual(draftNotices(view.draft), []);
});

test('draft new revision: 描述沒改過時，第 1 版裡人手改過的文字與手動加的條件是下一版草稿的底，不被描述重新解析的結果蓋掉', async () => {
  const { ui } = setup(adfDoc(p('Acceptance criteria'), ul('A', 'B')));
  await ui.draftFromDescription(HUMAN);
  const rev1 = [
    { text: 'A, measured at 25 °C (edited)', evidenceType: 'analysis' },
    { text: 'C added by hand', evidenceType: 'demo' },
  ];
  await ui.approve(HUMAN, { criteria: rev1 });
  const view = await ui.draftFromDescription(HUMAN);
  assert.deepEqual(view.draft.criteria, rev1);
});

test('draft new revision: 描述改過（stale）時用重新抽出的文字，文字相同的條件帶上現行版的證據類型', async () => {
  const { ui, jira } = setup(adfDoc(p('Acceptance criteria'), ul('A', 'B')));
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, { criteria: [{ text: 'A', evidenceType: 'analysis' }, { text: 'B', evidenceType: 'review' }] });
  jira.issues.get('10001').description = adfDoc(p('Acceptance criteria'), ul('A', 'B changed', 'C'));
  assert.equal((await ui.getPanel(HUMAN)).stale, true);
  const view = await ui.draftFromDescription(HUMAN);
  assert.deepEqual(view.draft.criteria, [
    { text: 'A', evidenceType: 'analysis' },
    { text: 'B changed', evidenceType: 'test' },
    { text: 'C', evidenceType: 'test' },
  ]);
  assert.equal(view.draft.source, 'parser');
  const approved = await ui.approve(HUMAN, {});
  assert.equal(approved.workOrder.rev, 2);
  assert.equal(approved.stale, false);
});

test('draft new revision: 描述改過但抽不到任何條目時沿用現行版的條件', async () => {
  const { ui, jira } = setup(adfDoc(p('Acceptance criteria'), ul('A', 'B')));
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, { criteria: [{ text: 'A', evidenceType: 'demo' }, { text: 'B', evidenceType: 'test' }] });
  jira.issues.get('10001').description = adfDoc(p('Criteria moved to the linked design document.'));
  const view = await ui.draftFromDescription(HUMAN);
  assert.deepEqual(view.draft.criteria, [{ text: 'A', evidenceType: 'demo' }, { text: 'B', evidenceType: 'test' }]);
  assert.equal(view.draft.extraction, undefined);
});

// ---- F7 重複核准 ----

test('approve 連按兩次（第二個請求在第一個完成後才到）：帶 expectedRev 時回 ALREADY_APPROVED，不多出第 2 版也不留草稿', async () => {
  const { ui, store } = setup(adfDoc(p('Acceptance criteria'), ul('A', 'B')));
  await ui.draftFromDescription(HUMAN);
  const rows = [{ text: 'A', evidenceType: 'test' }, { text: 'B', evidenceType: 'test' }];
  const first = await ui.approve(HUMAN, { criteria: rows, expectedRev: 1 });
  assert.equal(first.workOrder.rev, 1);
  const eventsBefore = (await listEvents(store, '10001')).length;
  const second = await ui.approve(HUMAN, { criteria: rows, expectedRev: 1 }).catch((e) => e);
  assert.deepEqual(errorResult(second), {
    ok: false,
    error: { code: 'ALREADY_APPROVED', message: 'This work order was already approved. Select Refresh to see the current revision.' },
  });
  const view = await ui.getPanel(HUMAN);
  assert.equal(view.workOrder.rev, 1);
  assert.equal(view.draft, null);
  assert.deepEqual(view.state.previousRevisions, []);
  assert.equal((await listEvents(store, '10001')).length, eventsBefore);
  assert.equal(view.chain.verified, true);
});

test('approve 同時送兩次：只成立一版（帶或不帶 expectedRev 都一樣）', async () => {
  for (const expectedRev of [undefined, 1]) {
    const { ui } = setup(adfDoc(p('Acceptance criteria'), ul('A', 'B')));
    await ui.draftFromDescription(HUMAN);
    const rows = [{ text: 'A', evidenceType: 'test' }];
    const results = await Promise.allSettled([ui.approve(HUMAN, { criteria: rows, expectedRev }), ui.approve(HUMAN, { criteria: rows, expectedRev })]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `expectedRev=${expectedRev}`);
    const failed = results.find((r) => r.status === 'rejected');
    assert.ok(['CONCURRENT_APPROVAL', 'ALREADY_APPROVED', 'EMPTY_DRAFT'].includes(failed.reason.code), failed.reason.code);
    const view = await ui.getPanel(HUMAN);
    assert.equal(view.workOrder.rev, 1);
    assert.equal(view.chain.verified, true);
  }
});

test('approve：expectedRev 是下一版時照常核准；沒帶 expectedRev 的呼叫行為不變（連續核准會成為第 2 版）', async () => {
  const { ui } = setup(adfDoc(p('Acceptance criteria'), ul('A')));
  await ui.draftFromDescription(HUMAN);
  assert.equal((await ui.approve(HUMAN, { expectedRev: '1' })).workOrder.rev, 1);
  await ui.draftFromDescription(HUMAN);
  assert.equal((await ui.approve(HUMAN, { expectedRev: 2 })).workOrder.rev, 2);
  // 不帶 expectedRev：和以前一樣，先存畫面送來的條件再核准成下一版
  const again = await ui.approve(HUMAN, { criteria: [{ text: 'A', evidenceType: 'test' }] });
  assert.equal(again.workOrder.rev, 3);
  const bad = await ui.approve(HUMAN, { criteria: [{ text: 'A', evidenceType: 'test' }], expectedRev: 0 }).catch((e) => e);
  assert.equal(errorResult(bad).error.code, 'INVALID_INPUT');
  assert.equal((await ui.getPanel(HUMAN)).workOrder.rev, 3);
});

// ---- F5 覆核時已有較新證據（後端部分；前端對話框的顯示見 src/frontend/panel.jsx）----

test('review: 覆核時已有較新證據，後端回 OUTDATED_EVIDENCE 且不寫入', async () => {
  const { ui, store } = setup(adfDoc(p('Acceptance criteria'), ul('A')));
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const first = await ui.recordEvidence(HUMAN, { criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 'first' });
  const oldSeq = first.state.criteria[0].latestEvidence.seq;
  await ui.recordEvidence(HUMAN, { criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 'second' });
  const before = (await listEvents(store, '10001')).length;
  const error = await ui.review(HUMAN, { evidenceSeq: oldSeq, decision: 'accept', note: '' }).catch((e) => e);
  assert.deepEqual(errorResult(error).error, { code: 'OUTDATED_EVIDENCE', message: 'Newer evidence exists for this criterion. Review the latest one.' });
  assert.equal((await listEvents(store, '10001')).length, before);
});

test('save draft: 人在草稿編輯器加到超過 30 條時照舊拒絕，草稿不變', async () => {
  const { ui } = setup(adfDoc(p('Acceptance criteria'), ul('A')));
  await ui.draftFromDescription(HUMAN);
  const rows = Array.from({ length: 31 }, (_, i) => ({ text: `C${i + 1}`, evidenceType: 'test' }));
  const error = await ui.saveDraft(HUMAN, { criteria: rows }).catch((e) => e);
  assert.equal(error.name, 'ValidationError');
  assert.equal(error.message, 'A work order can have at most 30 criteria.');
  assert.deepEqual((await ui.getPanel(HUMAN)).draft.criteria.map((c) => c.text), ['A']);
});
