// 議題面板後端的起草、核准、覆核流程（找錯報告 2026-11-21 的 panel-flow 重現測試，改成 repo 的格式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRITERIA_FROM } from '../src/core/adf.js';
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

test('save draft: 人在草稿編輯器加到超過 30 條時照舊拒絕，草稿不變', async () => {
  const { ui } = setup(adfDoc(p('Acceptance criteria'), ul('A')));
  await ui.draftFromDescription(HUMAN);
  const rows = Array.from({ length: 31 }, (_, i) => ({ text: `C${i + 1}`, evidenceType: 'test' }));
  const error = await ui.saveDraft(HUMAN, { criteria: rows }).catch((e) => e);
  assert.equal(error.name, 'ValidationError');
  assert.equal(error.message, 'A work order can have at most 30 criteria.');
  assert.deepEqual((await ui.getPanel(HUMAN)).draft.criteria.map((c) => c.text), ['A']);
});
