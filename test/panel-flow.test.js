// 議題面板後端的起草、核准、覆核流程（找錯報告 2026-11-21 的 panel-flow 重現測試，改成 repo 的格式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRITERIA_FROM } from '../src/core/adf.js';
import { FALLBACK_NOTICE, draftNotices } from '../src/core/draft-notice.js';
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
