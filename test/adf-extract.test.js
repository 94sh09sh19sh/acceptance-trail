// 從議題描述抽驗收條件的各種 ADF 寫法（找錯報告 2026-11-21 的 F1～F3 重現測試，改成 repo 的格式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CRITERIA_FROM, extractCriteria, extractCriteriaFromAdf } from '../src/core/adf.js';
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

// ---- F1 標題寫法與標題底下的內容 ----

test('ADF 標題變體：表情符號、編號、括號註解、全形冒號、單數、AC、Definition of Done 都只取標題底下的清單', () => {
  const variants = [
    '✅ Acceptance Criteria',
    ':white_check_mark: Acceptance Criteria',
    'Acceptance Criteria (AC)',
    'Acceptance Criteria (AC):',
    'AC:',
    'AC',
    'ACs',
    'Acceptance criteria / Definition of Done',
    '3. Acceptance criteria',
    'Acceptance criteria：',
    'Acceptance Criterion',
    '**Acceptance criteria**',
  ];
  for (const variant of variants) {
    for (const kind of ['heading', 'paragraph']) {
      const header = kind === 'heading' ? h(2, variant) : para(variant);
      const before = kind === 'heading' ? h(2, 'Requirements') : para('Requirements');
      const doc = adfDoc(before, ul('Uses the existing API'), header, ul('CSV has a header row', 'Dates are ISO 8601'));
      assert.deepEqual(extractCriteria(doc), { items: ['CSV has a header row', 'Dates are ISO 8601'], from: CRITERIA_FROM.SECTION }, `${kind}: ${variant}`);
    }
  }
});

test('ADF 標題變體：提到 acceptance criteria 的一般句子、超過 60 字元的段落不算標題', () => {
  const sentences = [
    'The acceptance criteria were discussed with the customer last week.',
    'Acceptance criteria are listed in the linked design document',
    'See the acceptance criteria below',
    'AC power',
    `Acceptance criteria ${'x'.repeat(50)}`,
  ];
  for (const sentence of sentences) {
    const doc = adfDoc(ul('First list'), para(sentence), ul('Second list'));
    assert.deepEqual(extractCriteria(doc), { items: ['First list', 'Second list'], from: CRITERIA_FROM.ALL_LISTS }, sentence);
  }
});

test('ADF：重現步驟清單在前、「Acceptance Criteria (AC)」在後，只取標題底下的清單', () => {
  const doc = adfDoc(para('Steps to reproduce'), ol('Open the page', 'Click export'), h(3, 'Acceptance Criteria (AC)'), ol('CSV has a header row', 'Dates are ISO 8601'));
  assert.deepEqual(extractCriteriaFromAdf(doc), ['CSV has a header row', 'Dates are ISO 8601']);
});

test('ADF：標題底下是逐行段落（Given/When/Then）時逐段取，遇到 Out of scope 就停，不抓後面的清單', () => {
  const doc = adfDoc(
    para('Acceptance criteria'),
    para('Given a logged-in user, when they export, then a CSV downloads.'),
    para(),
    para('Given no data, when they export, then an empty-state message shows.'),
    para('Out of scope'),
    ul('Mobile app', 'Dark mode'),
  );
  assert.deepEqual(extractCriteria(doc), {
    items: ['Given a logged-in user, when they export, then a CSV downloads.', 'Given no data, when they export, then an empty-state message shows.'],
    from: CRITERIA_FROM.SECTION,
  });
});

test('ADF：段落底下的停止點——下一個標題、Notes: 標籤、清單以外的區塊', () => {
  const lines = ['Export works offline', 'CSV has a header row'];
  const nextHeading = adfDoc(h(2, 'Acceptance criteria'), para(lines[0]), para(lines[1]), h(2, 'Design'), ul('Not a criterion'));
  const notes = adfDoc(para('Acceptance criteria'), para(lines[0]), para(lines[1]), para('Notes:'), ul('Not a criterion'));
  const label = adfDoc(para('Acceptance criteria'), para(lines[0]), para(lines[1]), para('Edge cases:'), ul('Not a criterion'));
  const code = adfDoc(para('Acceptance criteria'), para(lines[0]), para(lines[1]), { type: 'codeBlock', content: [text('npm test')] }, ul('Not a criterion'));
  const list = adfDoc(para('Acceptance criteria'), para(lines[0]), para(lines[1]), ul('Not a criterion'));
  for (const doc of [nextHeading, notes, label, code, list]) assert.deepEqual(extractCriteriaFromAdf(doc), lines);
});

test('ADF：標題和清單之間只隔一段說明文字時取清單；說明以冒號結尾或是粗體標籤時也一樣', () => {
  const plain = adfDoc(para('Acceptance criteria'), para('These were agreed with the customer.'), ul('A', 'B'), para('After'), ul('C'));
  const colon = adfDoc(para('Acceptance criteria'), para('The feature must:'), ul('A', 'B'));
  const colonThenText = adfDoc(h(2, 'Acceptance criteria'), para('The feature must:'), para('These were agreed with the customer.'), ul('A', 'B'), h(2, 'Notes'), ul('N'));
  const boldLabel = adfDoc(h(2, 'Acceptance criteria'), para(text('Export', [{ type: 'strong' }])), ul('A'), para(text('Import', [{ type: 'strong' }])), ul('B'), h(2, 'Notes'), ul('N'));
  for (const doc of [plain, colon, colonThenText, boldLabel]) assert.deepEqual(extractCriteriaFromAdf(doc), ['A', 'B']);
});

test('ADF：說明段落後面不是緊接清單（兩段以上）時取段落，不跳過段落去抓後面的清單', () => {
  const doc = adfDoc(para('Acceptance criteria'), para('Export works offline'), para('CSV has a header row'), ul('Unrelated list'));
  assert.deepEqual(extractCriteriaFromAdf(doc), ['Export works offline', 'CSV has a header row']);
});

test('ADF：heading 底下的清單遇到 Out of scope（段落或子標題）就停；子標題底下的清單照舊收進來', () => {
  const paragraphLabel = adfDoc(h(2, 'Acceptance criteria'), ul('A'), para('Out of scope'), ul('Mobile app'), h(2, 'Notes'));
  const subheading = adfDoc(h(2, 'Acceptance criteria'), ul('A'), h(3, 'Out of scope'), ul('Mobile app'));
  const subsections = adfDoc(h(2, 'Acceptance criteria'), h(3, 'Export'), ul('A'), h(3, 'Import'), ul('B'), h(2, 'Notes'), ul('N'));
  assert.deepEqual(extractCriteriaFromAdf(paragraphLabel), ['A']);
  assert.deepEqual(extractCriteriaFromAdf(subheading), ['A']);
  assert.deepEqual(extractCriteriaFromAdf(subsections), ['A', 'B']);
});

test('ADF：整份描述是一個清單、其中一條是「Acceptance criteria:」帶子清單時，只取子清單', () => {
  const doc = adfDoc(ul('Background: users need exports', li(para('Acceptance criteria:'), ul('CSV has a header row', 'Dates are ISO 8601'))));
  assert.deepEqual(extractCriteria(doc), { items: ['CSV has a header row', 'Dates are ISO 8601'], from: CRITERIA_FROM.SECTION });
});

test('ADF：條件寫成表格時每個非標題列一條，儲存格用 — 相接，空列與空儲存格略過', () => {
  const cell = (...blocks) => ({ type: 'tableCell', content: blocks.map((b) => (typeof b === 'string' ? para(b) : b)) });
  const headerCell = (t) => ({ type: 'tableHeader', content: [para(t)] });
  const row = (...cells) => ({ type: 'tableRow', content: cells });
  const table = {
    type: 'table',
    content: [
      row(headerCell('#'), headerCell('Criterion')),
      row(cell('1'), cell('CSV has a header row')),
      row(cell(), cell()),
      row(cell('2'), cell('Dates are ISO 8601', ul('UTC only'))),
      row(cell(''), cell('No row number')),
    ],
  };
  assert.deepEqual(extractCriteriaFromAdf(adfDoc(para('Acceptance criteria'), table)), ['1 — CSV has a header row', '2 — Dates are ISO 8601 UTC only', 'No row number']);
  // 標題和表格之間隔一段說明文字也一樣
  assert.deepEqual(extractCriteriaFromAdf(adfDoc(h(2, 'Acceptance criteria'), para('One row per criterion.'), table)).length, 3);
});

test('ADF 對照組：粗體、冒號、全小寫、heading、核取清單、標題和清單之間隔一段，結果和以前相同', () => {
  const bold = adfDoc(para(text('Acceptance Criteria:', [{ type: 'strong' }])), ul('A', 'B'));
  const lower = adfDoc(para('acceptance criteria'), ol('A', 'B'));
  const heading = adfDoc(h(2, 'Acceptance criteria'), para('The feature must:'), ul('A', 'B'), h(2, 'Notes'), ul('N'));
  const tasks = adfDoc(para('Acceptance criteria'), { type: 'taskList', attrs: { localId: 'x' }, content: [taskItem('A'), taskItem('B')] });
  const gap = adfDoc(para('Acceptance criteria'), para('The feature must:'), ul('A', 'B'));
  const inPanel = adfDoc(ul('Elsewhere'), { type: 'panel', attrs: { panelType: 'info' }, content: [para('Acceptance criteria'), ul('A', 'B')] });
  for (const doc of [bold, lower, heading, tasks, gap, inPanel]) assert.deepEqual(extractCriteriaFromAdf(doc), ['A', 'B']);
});

test('ADF 來源標記：找不到標題、或標題底下沒有可用內容時退回全文清單並標成 all-lists；什麼都沒有時是 null', () => {
  assert.deepEqual(extractCriteria(adfDoc(para('Intro'), ul('First'), ul('Second'))), { items: ['First', 'Second'], from: CRITERIA_FROM.ALL_LISTS });
  assert.deepEqual(extractCriteria(adfDoc(para('Acceptance criteria'), para('Out of scope'), ul('Mobile app'))), { items: ['Mobile app'], from: CRITERIA_FROM.ALL_LISTS });
  assert.deepEqual(extractCriteria(adfDoc(para('Only prose here.'))), { items: [], from: null });
  assert.deepEqual(extractCriteria(null), { items: [], from: null });
});

// ---- README 的示範描述（BMS）：抽出來的結果必須和修改前逐字相同 ----

// 依 README「Try it」第 2 步的文字區塊組出 Jira 編輯器會產生的 ADF：每行一段，「1. 」開頭的行是編號清單
function readmeDemoDoc(headerKind) {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = readme.indexOf('```text', readme.indexOf('Title: `BMS firmware'));
  const body = readme.slice(start + '```text'.length, readme.indexOf('```', start + '```text'.length));
  const content = [];
  let list = null;
  for (const line of body.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const item = /^\d+\.\s+(.*)$/.exec(line);
    if (item) {
      if (!list) content.push((list = ol()));
      list.content.push(li(para(item[1])));
    } else {
      list = null;
      content.push(line === 'Acceptance criteria' && headerKind === 'heading' ? h(2, line) : para(line));
    }
  }
  return adfDoc(...content);
}

const DEMO_CRITERIA = [
  'When any cell temperature reaches 45 °C or higher, the BMS opens the charge path within 1 s and logs the event with timestamp and sensor ID.',
  'When any cell temperature reaches 60 °C or higher, the BMS opens the discharge path within 1 s and logs the event.',
  'The charge path is re-enabled only after all cell temperatures fall to 40 °C or lower (5 °C hysteresis), and the test shows no more than one open/close cycle while temperature oscillates between 43 °C and 46 °C.',
  'If a temperature sensor reads open-circuit or short-circuit, the BMS reports a sensor fault, opens both charge and discharge paths, and stays in the safe state until the fault is cleared and the sensor passes a plausibility check.',
];

test('README 示範描述：段落或 heading 形式的「Acceptance criteria」加編號清單，抽出的四條和修改前逐字相同', () => {
  for (const kind of ['paragraph', 'heading']) {
    const doc = readmeDemoDoc(kind);
    assert.equal(doc.content.length, 4, '兩段說明、一行標題、一個清單');
    assert.deepEqual(extractCriteria(doc), { items: DEMO_CRITERIA, from: CRITERIA_FROM.SECTION }, kind);
  }
});
