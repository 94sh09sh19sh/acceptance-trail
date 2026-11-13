import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTools } from '../src/actions/tools.js';
import { toCsv, toMarkdown } from '../src/core/audit.js';
import {
  ALL_VERSIONS,
  NO_VERSION,
  describeVersionFilter,
  filterByVersion,
  filterFromValue,
  filterToValue,
  matchesVersionFilter,
  optionalVersionName,
  parseVersionFilter,
  totalsOf,
  versionFileTag,
  versionFilter,
} from '../src/core/versions.js';
import { createJiraClient } from '../src/jira/client.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

// ---- 篩選邏輯（純函式）----

test('matchesVersionFilter: all, none, named version (case-insensitive, any of several), unknown versions', () => {
  assert.equal(matchesVersionFilter(['1.4.0'], ALL_VERSIONS), true);
  assert.equal(matchesVersionFilter(null, ALL_VERSIONS), true);
  assert.equal(matchesVersionFilter([], NO_VERSION), true);
  assert.equal(matchesVersionFilter(['1.4.0'], NO_VERSION), false);
  // 讀不到版本（null）不能被當成「沒有版本」
  assert.equal(matchesVersionFilter(null, NO_VERSION), false);
  assert.equal(matchesVersionFilter(null, versionFilter('1.4.0')), false);
  assert.equal(matchesVersionFilter(['1.4.0', '1.5.0'], versionFilter('1.5.0')), true);
  assert.equal(matchesVersionFilter(['Release A'], versionFilter(' release a ')), true);
  assert.equal(matchesVersionFilter(['1.4.0'], versionFilter('1.4')), false);
  assert.equal(matchesVersionFilter([], versionFilter('1.4.0')), false);
});

test('filterByVersion and totalsOf: statistics cover only the matching issues', () => {
  const issues = [
    { issueKey: 'A-1', total: 4, accepted: 1, gapCount: 3, fixVersions: ['1.4.0'] },
    { issueKey: 'A-2', total: 3, accepted: 0, gapCount: 3, fixVersions: ['1.5.0'] },
    { issueKey: 'A-3', total: 2, accepted: 2, gapCount: 0, fixVersions: [] },
    { issueKey: 'A-4', total: 5, accepted: 5, gapCount: 0, fixVersions: ['1.4.0', '1.5.0'] },
    { issueKey: 'A-5', total: 1, accepted: 0, gapCount: 1, fixVersions: null },
  ];
  const keys = (filter) => filterByVersion(issues, filter).map((i) => i.issueKey);
  assert.deepEqual(keys(ALL_VERSIONS), ['A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
  assert.deepEqual(keys(versionFilter('1.4.0')), ['A-1', 'A-4']);
  assert.deepEqual(keys(versionFilter('1.5.0')), ['A-2', 'A-4']);
  assert.deepEqual(keys(NO_VERSION), ['A-3']);
  assert.deepEqual(totalsOf(filterByVersion(issues, versionFilter('1.4.0'))), { issues: 2, criteria: 9, accepted: 6, gaps: 3 });
  assert.deepEqual(totalsOf(filterByVersion(issues, versionFilter('9.9.9'))), { issues: 0, criteria: 0, accepted: 0, gaps: 0 });
});

test('filter parsing, menu values, descriptions and file name tags', () => {
  assert.deepEqual(parseVersionFilter(undefined), ALL_VERSIONS);
  assert.deepEqual(parseVersionFilter(null), ALL_VERSIONS);
  assert.deepEqual(parseVersionFilter({ kind: 'none' }), NO_VERSION);
  assert.deepEqual(parseVersionFilter({ kind: 'version', name: ' 1.4.0 ' }), versionFilter('1.4.0'));
  for (const bad of ['1.4.0', [], { kind: 'version' }, { kind: 'version', name: '   ' }, { kind: 'version', name: 'x'.repeat(256) }, { kind: 'other' }]) {
    assert.throws(() => parseVersionFilter(bad), { name: 'ValidationError' }, JSON.stringify(bad));
  }
  assert.equal(optionalVersionName(undefined), null);
  assert.equal(optionalVersionName('   '), null);
  assert.equal(optionalVersionName(' 1.4.0 '), '1.4.0');
  assert.equal(optionalVersionName(2), '2');
  assert.throws(() => optionalVersionName({ name: 'x' }), { name: 'ValidationError' });
  assert.throws(() => optionalVersionName('x'.repeat(256)), { name: 'ValidationError' });

  for (const filter of [ALL_VERSIONS, NO_VERSION, versionFilter('1.4.0'), versionFilter('v:odd')]) {
    assert.deepEqual(filterFromValue(filterToValue(filter)), filter);
  }
  assert.equal(describeVersionFilter(versionFilter('1.4.0')), 'fix version "1.4.0"');
  assert.equal(describeVersionFilter(NO_VERSION), 'no fix version');
  assert.equal(versionFileTag(ALL_VERSIONS), null);
  assert.equal(versionFileTag(NO_VERSION), 'no-fixversion');
  assert.equal(versionFileTag(versionFilter('1.4.0')), 'fixversion-1.4.0');
  assert.equal(versionFileTag(versionFilter('../Release 2: "beta"/x')), 'fixversion-.._Release_2_beta_x');
  assert.equal(versionFileTag(versionFilter('中文')), 'fixversion-version');
});

// ---- 工具、矩陣、匯出（記憶體 store 加假 Jira）----

const HUMAN = { accountId: 'human-account', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };
const description = adfDoc(h(2, 'Acceptance criteria'), ul('First | pipe', 'Second'));

// BMS-1：1.4.0；BMS-2：1.5.0；BMS-3：1.4.0 與 1.5.0；BMS-4：沒有版本；BMS-5：1.4.0 但沒有工作單。
// BMS-1 全部接受（沒有缺口）、BMS-2 沒證據（2 個缺口）、BMS-3 送了一筆失敗（2 個缺口）、BMS-4 沒證據（2 個缺口）。
async function setup(options = {}) {
  const store = createMemoryStore();
  const issue = (n, fixVersions) => ({ issueId: String(10000 + n), issueKey: `BMS-${n}`, title: `Issue ${n}`, projectId: '20000', projectKey: 'BMS', description, fixVersions });
  const jira = createFakeJira({
    issues: [issue(1, ['1.4.0']), issue(2, ['1.5.0']), issue(3, ['1.4.0', '1.5.0']), issue(4, []), issue(5, ['1.4.0'])],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
    projectVersions: [{ name: '1.4.0', released: true }, { name: '1.5.0' }, { name: '2.0.0', archived: true }],
    ...options,
  });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now });
  const tools = createTools({ store, jira, now });
  for (const n of [1, 2, 3, 4]) {
    await ui.draftFromDescription({ ...HUMAN, issueId: String(10000 + n) });
    await ui.approve({ ...HUMAN, issueId: String(10000 + n) }, {});
  }
  const send = (issueKey, criterionId, verdict) =>
    tools.submitEvidence({ issueKey, criterionId, workOrderRev: 1, verdict, evidenceType: 'test', summary: 'simulated', agentName: 'Test agent' }, AGENT);
  for (const criterionId of ['AC-1', 'AC-2']) {
    const sent = await send('BMS-1', criterionId, 'pass');
    await ui.review({ ...HUMAN, issueId: '10001' }, { evidenceSeq: sent.seq, decision: 'accept' });
  }
  await send('BMS-3', 'AC-1', 'fail');
  return { ui, tools, jira, store };
}

const keysOf = (result) => result.issues.map((i) => i.issueKey);

test('list-gaps without fixVersion behaves as before and does not call Jira for versions', async () => {
  const { tools, jira } = await setup();
  const result = await tools.listGaps({ projectKey: 'BMS' }, AGENT);
  assert.deepEqual(keysOf(result), ['BMS-2', 'BMS-3', 'BMS-4']);
  assert.equal(result.issuesWithWorkOrders, 4);
  assert.equal('fixVersion' in JSON.parse(JSON.stringify(result)), false);
  assert.equal(JSON.parse(JSON.stringify(result)).issues[0].fixVersions, undefined);
  assert.deepEqual(jira.calls, { getFixVersions: 0, getProjectVersions: 0 });
  // 空字串與只有空白等於沒給
  const blank = await tools.listGaps({ projectKey: 'BMS', fixVersion: '  ' }, AGENT);
  assert.deepEqual(keysOf(blank), ['BMS-2', 'BMS-3', 'BMS-4']);
});

test('list-gaps with fixVersion: only that version, counts scoped, versions echoed', async () => {
  const { tools } = await setup();
  const v14 = await tools.listGaps({ projectKey: 'BMS', fixVersion: '1.4.0' }, AGENT);
  // BMS-1（沒有缺口）與 BMS-3 屬於 1.4.0；BMS-5 在 1.4.0 但沒有工作單，不算
  assert.equal(v14.ok, true);
  assert.equal(v14.fixVersion, '1.4.0');
  assert.equal(v14.issuesWithWorkOrders, 2);
  assert.equal(v14.issuesWithGaps, 1);
  assert.deepEqual(keysOf(v14), ['BMS-3']);
  assert.deepEqual(v14.issues[0].fixVersions, ['1.4.0', '1.5.0']);
  assert.deepEqual(v14.issues[0].gaps, [
    { kind: 'failed', criterionId: 'AC-1' },
    { kind: 'no-evidence', criterionId: 'AC-2' },
  ]);

  const v15 = await tools.listGaps({ projectKey: 'BMS', fixVersion: '1.5.0' }, AGENT);
  assert.deepEqual(keysOf(v15), ['BMS-2', 'BMS-3']);
  assert.equal(v15.issuesWithWorkOrders, 2);

  // 版本存在但沒有任何議題：回成功與零筆，不是錯誤
  const v20 = await tools.listGaps({ projectKey: 'BMS', fixVersion: '2.0.0' }, AGENT);
  assert.equal(v20.ok, true);
  assert.equal(v20.issuesWithWorkOrders, 0);
  assert.deepEqual(v20.issues, []);
});

test('list-gaps: version names match case-insensitively and are returned in the project spelling', async () => {
  const { tools } = await setup({ projectVersions: [{ name: 'Release A' }] });
  // 版本名稱沒有任何議題用到 → 零筆；但名稱存在，所以不是錯誤
  const result = await tools.listGaps({ projectKey: 'BMS', fixVersion: ' release a ' }, AGENT);
  assert.equal(result.ok, true);
  assert.equal(result.fixVersion, 'Release A');
});

test('list-gaps: an unknown version is a clear error that lists the project versions, never an empty list', async () => {
  const { tools } = await setup();
  const result = await tools.listGaps({ projectKey: 'BMS', fixVersion: '9.9.9' }, AGENT).catch((e) => e);
  assert.equal(result.code, 'VERSION_NOT_FOUND');
  assert.match(result.message, /Version "9\.9\.9" does not exist in project BMS\./);
  assert.match(result.message, /Available versions: 1\.4\.0, 1\.5\.0, 2\.0\.0\./);

  const none = await setup({ projectVersions: [] });
  const empty = await none.tools.listGaps({ projectKey: 'BMS', fixVersion: '1.4.0' }, AGENT).catch((e) => e);
  assert.equal(empty.code, 'VERSION_NOT_FOUND');
  assert.match(empty.message, /This project has no versions\./);

  const many = await setup({ projectVersions: Array.from({ length: 25 }, (_, i) => ({ name: `v${i + 1}` })) });
  const long = await many.tools.listGaps({ projectKey: 'BMS', fixVersion: 'nope' }, AGENT).catch((e) => e);
  assert.match(long.message, /v20, and 5 more\./);
});

test('list-gaps: bad input and unreadable versions are errors, not an unfiltered answer', async () => {
  const { tools } = await setup();
  const bad = await tools.listGaps({ projectKey: 'BMS', fixVersion: { name: '1.4.0' } }, AGENT).catch((e) => e);
  assert.equal(bad.name, 'ValidationError');
  const failing = await setup({ failVersionLookup: true });
  const error = await failing.tools.listGaps({ projectKey: 'BMS', fixVersion: '1.4.0' }, AGENT).catch((e) => e);
  assert.equal(error.code, 'VERSIONS_UNAVAILABLE');
  // 不帶版本的呼叫完全不受影響
  const plain = await failing.tools.listGaps({ projectKey: 'BMS' }, AGENT);
  assert.deepEqual(keysOf(plain), ['BMS-2', 'BMS-3', 'BMS-4']);
});

test('list-gaps with fixVersion leaves out issues the caller cannot see', async () => {
  const { tools, store } = await setup();
  const hiddenJira = createFakeJira({
    issues: [{ issueId: '10003', issueKey: 'BMS-3', title: 'Issue 3', projectId: '20000', projectKey: 'BMS', description, fixVersions: ['1.4.0', '1.5.0'] }],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
    projectVersions: [{ name: '1.4.0' }],
    hidden: ['10003'],
  });
  const viewerTools = createTools({ store, jira: hiddenJira });
  const result = await viewerTools.listGaps({ projectKey: 'BMS', fixVersion: '1.4.0' }, AGENT);
  assert.deepEqual(result.issues, []);
  assert.equal(result.issuesWithWorkOrders, 0);
});

test('matrix: each row carries its fix versions, the version list feeds the menu, totals stay project-wide', async () => {
  const { ui } = await setup();
  const matrix = await ui.getMatrix(HUMAN);
  assert.equal(matrix.fixVersionsAvailable, true);
  assert.deepEqual(
    matrix.issues.map((i) => [i.issueKey, i.fixVersions]),
    [['BMS-1', ['1.4.0']], ['BMS-2', ['1.5.0']], ['BMS-3', ['1.4.0', '1.5.0']], ['BMS-4', []]],
  );
  assert.deepEqual(matrix.versions, [
    { name: '1.4.0', released: true, archived: false },
    { name: '1.5.0', released: false, archived: false },
    { name: '2.0.0', released: false, archived: true },
  ]);
  assert.deepEqual(matrix.totals, { issues: 4, criteria: 8, accepted: 2, gaps: 6 });
  // 前端用同一組函式篩選與統計：1.4.0 = BMS-1 + BMS-3
  const shown = filterByVersion(matrix.issues, versionFilter('1.4.0'));
  assert.deepEqual(shown.map((i) => i.issueKey), ['BMS-1', 'BMS-3']);
  assert.deepEqual(totalsOf(shown), { issues: 2, criteria: 4, accepted: 2, gaps: 2 });
  // 同一個版本在 list-gaps 與矩陣看到的缺口議題一致
  const withGaps = shown.filter((i) => i.gapCount > 0).map((i) => i.issueKey);
  assert.deepEqual(withGaps, ['BMS-3']);
});

test('matrix: versions that the project list lacks are added; unreadable versions degrade instead of failing', async () => {
  const odd = await setup({ projectVersions: [{ name: '1.4.0' }] });
  const matrix = await odd.ui.getMatrix(HUMAN);
  assert.deepEqual(matrix.versions.map((v) => v.name), ['1.4.0', '1.5.0']);

  const failing = await setup({ failVersionLookup: true });
  const degraded = await failing.ui.getMatrix(HUMAN);
  assert.equal(degraded.fixVersionsAvailable, false);
  assert.equal(degraded.issues.length, 4);
  assert.ok(degraded.issues.every((i) => i.fixVersions === null));
  assert.deepEqual(degraded.versions, []);
  assert.equal(degraded.totals.issues, 4);
});

test('audit export with a version filter: only that version, scoped totals, header states the filter, file name carries it', async () => {
  const { ui } = await setup();
  const md = await ui.exportAudit(HUMAN, { format: 'markdown', fixVersion: { kind: 'version', name: '1.4.0' } });
  assert.match(md.fileName, /^BMS-evidence-audit-fixversion-1\.4\.0-\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(md.filter, 'fix version "1.4.0"');
  assert.equal(md.issueCount, 2);
  const text = md.content;
  assert.match(text, /^# Evidence audit pack: BMS/);
  assert.match(text, /\*\*Filter: fix version "1\.4\.0"\.\*\* Only work items with this fix version are included/);
  // 標頭在統計表之前；統計只算 BMS-1 與 BMS-3（2 個議題、4 條、2 條已接受、2 個缺口）
  assert.ok(text.indexOf('**Filter:') < text.indexOf('| Issues with work orders |'));
  assert.match(text, /\| 2 \| 4 \| 2 \| 2 \|/);
  assert.match(text, /## BMS-1: Issue 1/);
  assert.match(text, /## BMS-3: Issue 3/);
  assert.doesNotMatch(text, /## BMS-2:/);
  assert.doesNotMatch(text, /## BMS-4:/);
  assert.match(text, /- Fix versions: 1\.4\.0, 1\.5\.0/);

  const csv = await ui.exportAudit(HUMAN, { format: 'csv', fixVersion: { kind: 'version', name: '1.5.0' } });
  assert.match(csv.fileName, /^BMS-evidence-audit-fixversion-1\.5\.0-.*\.csv$/);
  const lines = csv.content.trim().split('\r\n');
  assert.equal(lines.length, 1 + 4);
  assert.deepEqual([...new Set(lines.slice(1).map((l) => l.split(',')[0]))], ['BMS-2', 'BMS-3']);
  assert.ok(lines[1].endsWith(',1.5.0'));
  assert.ok(lines.find((l) => l.startsWith('BMS-3,')).endsWith(',1.4.0; 1.5.0'));
});

test('audit export with "no version", and without a filter', async () => {
  const { ui } = await setup();
  const none = await ui.exportAudit(HUMAN, { format: 'markdown', fixVersion: { kind: 'none' } });
  assert.match(none.fileName, /^BMS-evidence-audit-no-fixversion-/);
  assert.equal(none.issueCount, 1);
  assert.match(none.content, /\*\*Filter: no fix version\.\*\* Only work items without a fix version are included/);
  assert.match(none.content, /## BMS-4: Issue 4/);
  assert.match(none.content, /- Fix versions: none/);

  const all = await ui.exportAudit(HUMAN, { format: 'markdown' });
  assert.equal(all.filter, null);
  assert.equal(all.issueCount, 4);
  assert.match(all.fileName, /^BMS-evidence-audit-\d{4}-/);
  assert.doesNotMatch(all.content, /Filter:/);
  assert.match(all.content, /\| 4 \| 8 \| 2 \| 6 \|/);
  const explicit = await ui.exportAudit(HUMAN, { format: 'markdown', fixVersion: { kind: 'all' } });
  assert.equal(explicit.issueCount, 4);
});

test('audit export: unknown version, unreadable versions and malformed filter are refused; unfiltered export still works without versions', async () => {
  const { ui } = await setup();
  const unknown = await ui.exportAudit(HUMAN, { format: 'markdown', fixVersion: { kind: 'version', name: '9.9.9' } }).catch((e) => e);
  assert.equal(unknown.code, 'VERSION_NOT_FOUND');
  const malformed = await ui.exportAudit(HUMAN, { format: 'markdown', fixVersion: 'oops' }).catch((e) => e);
  assert.equal(malformed.name, 'ValidationError');

  const failing = await setup({ failVersionLookup: true });
  const refused = await failing.ui.exportAudit(HUMAN, { format: 'markdown', fixVersion: { kind: 'none' } }).catch((e) => e);
  assert.equal(refused.code, 'VERSIONS_UNAVAILABLE');
  const refusedNamed = await failing.ui.exportAudit(HUMAN, { format: 'csv', fixVersion: { kind: 'version', name: '1.4.0' } }).catch((e) => e);
  assert.equal(refusedNamed.code, 'VERSIONS_UNAVAILABLE');
  // 沒有篩選時讀不到版本只是少了版本資訊
  const plain = await failing.ui.exportAudit(HUMAN, { format: 'markdown' });
  assert.equal(plain.issueCount, 4);
  assert.doesNotMatch(plain.content, /Fix versions:/);
});

test('audit Markdown escapes version names; CSV neutralises formula-like names', () => {
  const csvPack = {
    projectKey: 'BMS',
    generatedAt: '2026-11-13T00:00:00.000Z',
    generatedBy: 'someone',
    filter: ALL_VERSIONS,
    totals: { issues: 1, criteria: 1, accepted: 0, gaps: 1 },
    issues: [
      {
        issueKey: 'BMS-1',
        title: 'T',
        rev: 1,
        approvedBy: 'a',
        approvedAt: '2026-11-13T00:00:00.000Z',
        stale: false,
        fixVersions: ['=cmd|x', '1.4.0'],
        chain: { verified: true, count: 1 },
        criteria: [{ id: 'AC-1', text: 'x', evidenceType: 'test', status: 'no-evidence', gap: 'no-evidence', latestEvidence: null, review: null, history: [] }],
      },
    ],
  };
  const row = toCsv(csvPack).trim().split('\r\n')[1];
  assert.ok(row.endsWith(",'=cmd|x; 1.4.0"));
  const pack = {
    projectKey: 'BMS',
    generatedAt: '2026-11-13T00:00:00.000Z',
    generatedBy: 'someone',
    filter: versionFilter('v|<b>'),
    totals: { issues: 0, criteria: 0, accepted: 0, gaps: 0 },
    issues: [],
  };
  const text = toMarkdown(pack);
  assert.ok(text.includes('fix version "v\\|&lt;b>"'));
});

// ---- Jira 轉接層 ----

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeForgeApi(handlers) {
  const calls = [];
  const requester = (as) => ({
    async requestJira(route, init = {}) {
      const path = String(route.value ?? route.value_ ?? route);
      const method = init.method ?? 'GET';
      calls.push({ as, method, path: path.split('?')[0], body: init.body ? JSON.parse(init.body) : null });
      const handler = handlers.find(([pattern]) => pattern.test(`${as} ${method} ${path}`));
      if (!handler) throw new Error(`Unexpected request ${as} ${method} ${path}`);
      return handler[1](init);
    },
  });
  return { calls, asUser: () => requester('user'), asApp: () => requester('app') };
}

const bulkBody = (ids, versionsOf) => ({
  issues: ids.map((id) => ({ id, key: `BMS-${id}`, fields: { fixVersions: (versionsOf(id) ?? []).map((name) => ({ id: name, name })) } })),
});

test('getFixVersions: bulk fetch in chunks of 100 as the user, asking only for the fixVersions field', async () => {
  const api = fakeForgeApi([[/^user POST \/rest\/api\/3\/issue\/bulkfetch/, (init) => json(200, bulkBody(JSON.parse(init.body).issueIdsOrKeys, (id) => (Number(id) % 2 ? ['1.4.0'] : []))) ]]);
  const ids = Array.from({ length: 150 }, (_, i) => String(10001 + i));
  const found = await createJiraClient(api).getFixVersions(ids, { accountId: 'someone' });
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls.map((c) => c.body.issueIdsOrKeys.length), [100, 50]);
  assert.deepEqual(api.calls[0].body.fields, ['fixVersions']);
  assert.equal(found.size, 150);
  assert.deepEqual(found.get('10001'), ['1.4.0']);
  assert.deepEqual(found.get('10002'), []);
});

test('getFixVersions: issues Jira does not return are absent, not "no version"; Jira errors are thrown', async () => {
  const api = fakeForgeApi([[/^user POST \/rest\/api\/3\/issue\/bulkfetch/, () => json(200, bulkBody(['10001'], () => ['1.4.0']))]]);
  const found = await createJiraClient(api).getFixVersions(['10001', '10002'], { accountId: 'someone' });
  assert.equal(found.has('10002'), false);
  const broken = fakeForgeApi([[/bulkfetch/, () => json(500, {})]]);
  await assert.rejects(() => createJiraClient(broken).getFixVersions(['10001'], { accountId: 'someone' }), /status 500/);
});

test('getFixVersions: falls back to the app only when the user call is refused, and then keeps only issues the caller may browse', async () => {
  const api = fakeForgeApi([
    [/^user POST .*bulkfetch/, () => json(403, {})],
    [/^app POST .*bulkfetch/, (init) => json(200, bulkBody(JSON.parse(init.body).issueIdsOrKeys, () => ['1.4.0']))],
    [/^app POST .*permissions\/check/, (init) => {
      const { accountId } = JSON.parse(init.body);
      assert.equal(accountId, 'caller-account');
      return json(200, { projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: [10001] }] });
    }],
  ]);
  const found = await createJiraClient(api).getFixVersions(['10001', '10002'], { accountId: 'caller-account' });
  assert.deepEqual([...found.keys()], ['10001']);
  // 身分不明時，退回 asApp 也不放行任何議題
  const unknown = await createJiraClient(fakeForgeApi([
    [/^user POST .*bulkfetch/, () => json(403, {})],
    [/^app POST .*bulkfetch/, () => json(200, bulkBody(['10001'], () => ['1.4.0']))],
  ])).getFixVersions(['10001'], { accountId: 'unknown' });
  assert.equal(unknown.size, 0);
});

test('getProjectVersions: maps the list, and the app fallback needs browse permission on the project', async () => {
  const versions = [{ id: '1', name: '1.4.0', released: true }, { id: '2', name: '1.5.0', archived: true }, { id: '3' }];
  const ok = fakeForgeApi([[/^user GET \/rest\/api\/3\/project\/BMS\/versions/, () => json(200, versions)]]);
  const project = { projectId: '20000', projectKey: 'BMS' };
  assert.deepEqual(await createJiraClient(ok).getProjectVersions(project, { accountId: 'someone' }), [
    { id: '1', name: '1.4.0', released: true, archived: false },
    { id: '2', name: '1.5.0', released: false, archived: true },
  ]);

  const viaApp = (projects) =>
    fakeForgeApi([
      [/^user GET .*\/versions/, () => json(403, {})],
      [/^app GET .*\/versions/, () => json(200, versions)],
      [/^app POST .*permissions\/check/, () => json(200, { projectPermissions: [{ permission: 'BROWSE_PROJECTS', projects }] })],
    ]);
  assert.equal((await createJiraClient(viaApp([20000])).getProjectVersions(project, { accountId: 'someone' })).length, 2);
  await assert.rejects(() => createJiraClient(viaApp([])).getProjectVersions(project, { accountId: 'someone' }), /No permission/);
  const missing = fakeForgeApi([[/^user GET .*\/versions/, () => json(404, {})]]);
  await assert.rejects(() => createJiraClient(missing).getProjectVersions(project, { accountId: 'someone' }), /did not return/);
});

// ---- manifest ----

test('manifest: list-gaps declares an optional fixVersion input; the Rovo agent prompt and action list match', () => {
  const text = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = text.slice(text.indexOf('    - key: list-gaps\n      name: List gaps'), text.indexOf('\n  function:\n'));
  assert.match(block, /fixVersion:\n {10}title: Fix version\n {10}type: string\n {10}required: false\n {10}description: .+/);
  assert.match(block, /projectKey:\n {10}title: Project key\n {10}type: string\n {10}required: true/);
  assert.match(block, /Optional fixVersion limits it to one version/);
  // Rovo agent 用同一個 action，提示要教它帶版本、不猜版本
  assert.match(text, /pass fixVersion with the version name the user gave/);
  assert.match(text, /never guess a version/);
  assert.match(text, /actions:\n(?: {8}- [a-z-]+\n)*? {8}- list-gaps\n/);
});
