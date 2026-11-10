import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCriteriaFromAdf } from '../src/core/adf.js';
import { LIMITS, ValidationError, parseCriteriaJson, truncate } from '../src/core/validate.js';
import { adfDoc, h, p, ul } from './helpers.js';

test('ADF：優先取 Acceptance criteria 標題底下的清單', () => {
  const doc = adfDoc(
    h(2, 'Background'),
    ul('Not a criterion'),
    h(2, 'Acceptance criteria'),
    p('The protection must:'),
    ul('Cut discharge above 60 °C', { type: 'listItem', content: [p('Resume only below 55 °C'), ul('Nested hysteresis check')] }),
    h(2, 'Notes'),
    ul('Also not a criterion'),
  );
  assert.deepEqual(extractCriteriaFromAdf(doc), ['Cut discharge above 60 °C', 'Resume only below 55 °C', 'Nested hysteresis check']);
});

test('ADF：段落式的「Acceptance criteria:」標題也算', () => {
  const doc = adfDoc(p('Intro text'), ul('Other list'), p('Acceptance Criteria:'), ul('A', 'B'), p('After'), ul('C'));
  assert.deepEqual(extractCriteriaFromAdf(doc), ['A', 'B']);
});

test('ADF：沒有標題時取全文所有清單（含 task list）', () => {
  const doc = adfDoc(
    p('Some text'),
    ul('First'),
    { type: 'orderedList', content: [{ type: 'listItem', content: [p('Second')] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'TODO' }, content: [{ type: 'text', text: 'Third' }] }] },
  );
  assert.deepEqual(extractCriteriaFromAdf(doc), ['First', 'Second', 'Third']);
});

test('ADF：沒有清單或描述是空的就給空白草稿', () => {
  assert.deepEqual(extractCriteriaFromAdf(adfDoc(p('Only prose here.'))), []);
  assert.deepEqual(extractCriteriaFromAdf(null), []);
  assert.deepEqual(extractCriteriaFromAdf({ type: 'doc', version: 1, content: [] }), []);
});

test('長度截斷：未超過不動、超過就截到上限並標記', () => {
  assert.deepEqual(truncate('  short  ', 10), { value: 'short', truncated: false });
  const long = 'x'.repeat(LIMITS.summary + 50);
  const result = truncate(long, LIMITS.summary);
  assert.equal(result.value.length, LIMITS.summary);
  assert.equal(result.truncated, true);
  assert.deepEqual(truncate(undefined, 5), { value: '', truncated: false });
});

test('criteriaJson：格式錯誤、空陣列、未知證據類型都拒絕', () => {
  assert.throws(() => parseCriteriaJson('not json'), ValidationError);
  assert.throws(() => parseCriteriaJson('[]'), ValidationError);
  assert.throws(() => parseCriteriaJson('[{"text":"A","evidenceType":"vibes"}]'), ValidationError);
  assert.deepEqual(parseCriteriaJson('[{"text":" A ","evidenceType":"Analysis"},{"text":""}]'), [{ text: 'A', evidenceType: 'analysis' }]);
});
