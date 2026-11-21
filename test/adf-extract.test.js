// 從議題描述抽驗收條件的各種 ADF 寫法（找錯報告 2026-11-21 的 F1～F3 重現測試，改成 repo 的格式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCriteriaFromAdf } from '../src/core/adf.js';
import { adfDoc, h, ul } from './helpers.js';

// 這個檔案需要帶標記的文字與行內節點，所以段落、清單另外寫（helpers 的 p 只接受一段純文字）
const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...inline) => ({ type: 'paragraph', content: inline.map((x) => (typeof x === 'string' ? text(x) : x)) });
const li = (...blocks) => ({ type: 'listItem', content: blocks });
const ol = (...items) => ({ type: 'orderedList', attrs: { order: 1 }, content: items.map((i) => (typeof i === 'string' ? li(para(i)) : i)) });
const taskItem = (t) => ({ type: 'taskItem', attrs: { localId: t, state: 'TODO' }, content: [text(t)] });

// ---- F2 行內節點 ----

test('ADF 行內節點：智慧連結取網址、提及取顯示文字、表情取文字、日期轉成 YYYY-MM-DD，只有連結的條目不會消失', () => {
  const doc = adfDoc(
    para('Acceptance criteria'),
    ol(
      li(para('Layout matches ', { type: 'inlineCard', attrs: { url: 'https://example.com/design' } })),
      li(para({ type: 'mention', attrs: { id: 'abc', text: '@QA Lead' } }, ' signs off the test report')),
      li(para('Shows ', { type: 'emoji', attrs: { shortName: ':white_check_mark:', text: '✅' } }, ' when the export finishes')),
      li(para('Ships before ', { type: 'date', attrs: { timestamp: '1767225600000' } })),
      li(para({ type: 'inlineCard', attrs: { url: 'https://example.com/spec#ac-6' } })),
    ),
  );
  assert.deepEqual(extractCriteriaFromAdf(doc), [
    'Layout matches https://example.com/design',
    '@QA Lead signs off the test report',
    'Shows ✅ when the export finishes',
    'Ships before 2026-01-01',
    'https://example.com/spec#ac-6',
  ]);
});

test('ADF 行內節點：表情沒有文字時用 shortName；狀態取文字；blockCard 取網址；未知節點有 attrs.text 才用；placeholder 不取', () => {
  const doc = adfDoc(
    para('Acceptance criteria'),
    ol(
      li(para('Custom ', { type: 'emoji', attrs: { shortName: ':party-parrot:' } }, ' shows')),
      li(para('Ticket is ', { type: 'status', attrs: { text: 'DONE', color: 'green' } })),
      li(para('See'), { type: 'blockCard', attrs: { url: 'https://example.com/board' } }),
      li(para('Unknown ', { type: 'futureInline', attrs: { text: 'kept' } }, { type: 'futureInline', attrs: { id: 'x' } }, ' node')),
      li(para({ type: 'placeholder', attrs: { text: 'Type a criterion' } }, 'Real text')),
      li(para('Bad date ', { type: 'date', attrs: { timestamp: 'not a number' } })),
    ),
  );
  assert.deepEqual(extractCriteriaFromAdf(doc), [
    'Custom :party-parrot: shows',
    'Ticket is DONE',
    'See https://example.com/board',
    'Unknown kept node',
    'Real text',
    'Bad date',
  ]);
});

// ---- F3 巢狀與多段落 ----

test('ADF 巢狀核取清單：子 taskList 直接放在 taskList 底下時，子條目不會被丟掉', () => {
  const doc = adfDoc(para('Acceptance criteria'), {
    type: 'taskList',
    attrs: { localId: 'l1' },
    content: [taskItem('Parent check'), { type: 'taskList', attrs: { localId: 'l2' }, content: [taskItem('Child check A'), taskItem('Child check B')] }],
  });
  assert.deepEqual(extractCriteriaFromAdf(doc), ['Parent check', 'Child check A', 'Child check B']);
});

test('ADF 清單條目裡有兩段文字或程式碼區塊：段落之間留空白，不會黏在一起', () => {
  const doc = adfDoc(
    para('Acceptance criteria'),
    ul(li(para('Export works offline.'), para('Retries three times.')), li(para('Run the check'), { type: 'codeBlock', content: [text('npm test')] })),
  );
  assert.deepEqual(extractCriteriaFromAdf(doc), ['Export works offline. Retries three times.', 'Run the check npm test']);
});

test('ADF 巢狀符號清單（Scenario 底下 Given/When/Then）：子條目維持各自成為一條（刻意保留的行為）', () => {
  const doc = adfDoc(para('Acceptance criteria'), ul(li(para('Scenario: export'), ul('Given a logged-in user', 'When they export', 'Then a CSV downloads'))));
  assert.deepEqual(extractCriteriaFromAdf(doc), ['Scenario: export', 'Given a logged-in user', 'When they export', 'Then a CSV downloads']);
});

test('ADF 標題文字裡的行內節點不影響原本的標題比對', () => {
  const doc = adfDoc(h(2, 'Background'), ul('Not a criterion'), para(text('Acceptance criteria', [{ type: 'strong' }])), ul('A', 'B'));
  assert.deepEqual(extractCriteriaFromAdf(doc), ['A', 'B']);
});
