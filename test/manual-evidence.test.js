import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { CSV_COLUMNS } from '../src/core/audit.js';
import { EVENT_TYPES, listEvents, verifyChain } from '../src/core/chain.js';
import { eventKey, headKey, revKey, summaryKey } from '../src/core/keys.js';
import { MIRROR_PROPERTY_KEY } from '../src/core/mirror.js';
import { EVIDENCE_SOURCE, MANUAL_AGENT_NAME, evidenceSource, sourceLabel } from '../src/core/source.js';
import { EVIDENCE_ROLE, GAP, STATUS } from '../src/core/state.js';
import { createJiraClient } from '../src/jira/client.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

// 議題面板的 Record evidence（人手動記錄證據）：和 MCP 的 submit-evidence 走同一個核心函式，
// 來源固定為 panel、代理名稱由後端寫死；要編輯權限；不能讓既有事件的鏈驗證失敗。

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };
const description = adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B'));
const ISSUE = { issueId: '10001', issueKey: 'BMS-1', title: 'Over-temperature', projectId: '20000', projectKey: 'BMS', description };
const PROJECTS = [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }];

const form = (criterionId, overrides = {}) => ({
  criterionId,
  workOrderRev: 1,
  verdict: 'pass',
  evidenceType: 'test',
  summary: `Simulated manual entry for ${criterionId}`,
  ...overrides,
});
const mcpEvidence = (criterionId, overrides = {}) => ({
  issueKey: 'BMS-1',
  criterionId,
  workOrderRev: 1,
  verdict: 'pass',
  evidenceType: 'test',
  summary: `Simulated agent evidence for ${criterionId}`,
  agentName: 'Test agent',
  ...overrides,
});

async function setup({ editors = true } = {}) {
  const store = createMemoryStore();
  const jira = createFakeJira({ issues: [structuredClone(ISSUE)], projects: PROJECTS });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now });
  const tools = createTools({ store, jira, now });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const viewer = createResolverLogic({ store, jira: createFakeJira({ issues: [structuredClone(ISSUE)], projects: PROJECTS, editors }), now });
  return { store, jira, ui, tools, viewer };
}

const eventAt = async (store, seq) => (await listEvents(store, '10001')).find((e) => e.seq === seq);

test('record evidence: stores a panel event through the same core path, then the panel shows it as the latest evidence', async () => {
  const { store, ui } = await setup();
  const view = await ui.recordEvidence(HUMAN, form('AC-1', { reference: 'abc1234', outputExcerpt: 'ok 1 - simulated' }));

  assert.deepEqual(view.recorded, { criterionId: 'AC-1', seq: 2, truncated: [] });
  const event = await eventAt(store, 2);
  assert.equal(event.type, EVENT_TYPES.SUBMITTED);
  assert.equal(event.actor, HUMAN.accountId);
  assert.equal(event.payload.source, EVIDENCE_SOURCE.PANEL);
  assert.equal(event.payload.agentName, MANUAL_AGENT_NAME);
  assert.equal(event.payload.rev, 1);
  assert.equal(event.payload.reference, 'abc1234');
  assert.equal(event.payload.outputExcerpt, 'ok 1 - simulated');

  const ac1 = view.state.criteria[0];
  assert.equal(ac1.status, STATUS.SUBMITTED);
  assert.equal(ac1.gap, GAP.UNREVIEWED);
  assert.equal(ac1.latestEvidence.seq, 2);
  assert.equal(ac1.latestEvidence.source, EVIDENCE_SOURCE.PANEL);
  assert.equal(ac1.latestEvidence.submittedBy, HUMAN.accountId);
  assert.equal(view.chain.verified, true);
  assert.equal(view.chain.count, 2);
});

test('record evidence: source and agent name come from the backend, not from the form or an MCP caller', async () => {
  const { store, ui, tools } = await setup();
  // 前端（或直接呼叫 resolver 的人）塞了 agentName 與 source，一律不用
  await ui.recordEvidence(HUMAN, { ...form('AC-1'), agentName: 'Claude Code', source: 'mcp' });
  const manual = await eventAt(store, 2);
  assert.equal(manual.payload.source, EVIDENCE_SOURCE.PANEL);
  assert.equal(manual.payload.agentName, MANUAL_AGENT_NAME);

  // MCP 呼叫者送 source=panel、或把自己取名成手動記錄的字樣，仍記成 mcp，介面標示也分得出來
  const sent = await tools.submitEvidence(mcpEvidence('AC-2', { source: 'panel', agentName: MANUAL_AGENT_NAME }), AGENT);
  const spoof = await eventAt(store, sent.seq);
  assert.equal(spoof.payload.source, EVIDENCE_SOURCE.MCP);
  assert.equal(spoof.payload.agentName, MANUAL_AGENT_NAME);
  const view = await ui.getPanel(HUMAN);
  assert.equal(sourceLabel(view.state.criteria[0].latestEvidence), MANUAL_AGENT_NAME);
  assert.equal(sourceLabel(view.state.criteria[1].latestEvidence), `MCP: ${MANUAL_AGENT_NAME}`);
});

test('record evidence: needs edit permission; viewers get FORBIDDEN, nothing is stored, and the panel tells the UI to hide the action', async () => {
  const { store, viewer } = await setup({ editors: false });
  const before = structuredClone(store.data);
  const error = await viewer.recordEvidence(HUMAN, form('AC-1')).catch((e) => e);
  assert.equal(error.code, 'FORBIDDEN');
  assert.match(error.message, /permission to edit this issue/);
  assert.match(error.message, /record evidence/);
  assert.deepEqual(store.data, before);
  // 面板資料的 canEdit 為 false，前端據此不顯示 Record evidence
  assert.equal((await viewer.getPanel(HUMAN)).canEdit, false);
});

test('record evidence through the real Jira client: mypermissions false is FORBIDDEN, true stores the event', async () => {
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const issueBody = { id: '10001', key: 'BMS-1', fields: { summary: ISSUE.title, project: { id: '20000', key: 'BMS' }, description } };
  const api = (havePermission) => {
    const handlers = [
      [/^user GET \/rest\/api\/3\/issue\/10001/, () => json(200, issueBody)],
      [/^user GET \/rest\/api\/3\/mypermissions/, () => json(200, { permissions: { EDIT_ISSUES: { havePermission } } })],
      [/^user PUT \/rest\/api\/3\/issue\/10001\/properties\//, () => json(200, {})],
    ];
    const requester = (as) => ({
      async requestJira(route, init = {}) {
        const path = String(route.value ?? route.value_ ?? route);
        const key = `${as} ${init.method ?? 'GET'} ${path}`;
        const handler = handlers.find(([pattern]) => pattern.test(key));
        if (!handler) throw new Error(`Unexpected request ${key}`);
        return handler[1](init);
      },
    });
    return { asUser: () => requester('user'), asApp: () => requester('app') };
  };
  const { store } = await setup();
  const before = structuredClone(store.data);
  const denied = createResolverLogic({ store, jira: createJiraClient(api(false)), now: sequentialClock() });
  assert.equal((await denied.recordEvidence(HUMAN, form('AC-1')).catch((e) => e)).code, 'FORBIDDEN');
  assert.deepEqual(store.data, before);

  const allowed = createResolverLogic({ store, jira: createJiraClient(api(true)), now: sequentialClock() });
  const view = await allowed.recordEvidence(HUMAN, form('AC-1'));
  assert.equal(view.recorded.seq, 2);
  assert.equal(view.canEdit, true);
});

test('record evidence: the same validation as submit-evidence, and nothing is stored on any error', async () => {
  const store = createMemoryStore();
  const jira = createFakeJira({ issues: [structuredClone(ISSUE)], projects: PROJECTS });
  const ui = createResolverLogic({ store, jira, now: sequentialClock() });
  // 還沒核准
  assert.equal((await ui.recordEvidence(HUMAN, form('AC-1')).catch((e) => e)).code, 'NOT_APPROVED');
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const before = (await listEvents(store, '10001')).length;

  const invalid = [
    form('AC-1', { summary: '   ' }),
    form('AC-1', { verdict: 'maybe' }),
    form('AC-1', { verdict: undefined }),
    form('AC-1', { evidenceType: 'video' }),
    form('', {}),
    form('AC-1', { workOrderRev: 0 }),
  ];
  for (const input of invalid) {
    const error = await ui.recordEvidence(HUMAN, input).catch((e) => e);
    assert.equal(error.name, 'ValidationError', JSON.stringify(input));
  }
  const unknown = await ui.recordEvidence(HUMAN, form('AC-9')).catch((e) => e);
  assert.equal(unknown.code, 'UNKNOWN_CRITERION');
  assert.match(unknown.message, /AC-1, AC-2/);
  assert.equal((await listEvents(store, '10001')).length, before);

  // 大小寫與數字字串照 submit-evidence 的規則接受
  const view = await ui.recordEvidence(HUMAN, form('ac-2', { workOrderRev: '1', verdict: 'NOT-RUN', evidenceType: 'Review' }));
  assert.equal(view.recorded.criterionId, 'AC-2');
  const stored = await eventAt(store, view.recorded.seq);
  assert.equal(stored.payload.verdict, 'not-run');
  assert.equal(stored.payload.evidenceType, 'review');
});

test('record evidence: long fields are truncated to the submit-evidence limits and the panel says which', async () => {
  const { store, ui } = await setup();
  const view = await ui.recordEvidence(HUMAN, form('AC-1', { summary: 's'.repeat(2500), reference: 'r'.repeat(501), outputExcerpt: 'o'.repeat(4001) }));
  assert.deepEqual(view.recorded.truncated, ['summary', 'reference', 'outputExcerpt']);
  const stored = await eventAt(store, view.recorded.seq);
  assert.equal(stored.payload.summary.length, 2000);
  assert.equal(stored.payload.reference.length, 500);
  assert.equal(stored.payload.outputExcerpt.length, 4000);
  assert.deepEqual(stored.payload.truncated, ['summary', 'reference', 'outputExcerpt']);
  assert.deepEqual(view.state.criteria[0].latestEvidence.truncated, ['summary', 'reference', 'outputExcerpt']);
});

test('record evidence: a stale revision from an open form is refused with a message for people, and nothing is stored', async () => {
  const { store, ui, jira } = await setup();
  jira.issues.get('10001').description = adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B', 'C'));
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  const before = (await listEvents(store, '10001')).length;
  const error = await ui.recordEvidence(HUMAN, form('AC-1', { workOrderRev: 1 })).catch((e) => e);
  assert.equal(error.code, 'REVISION_MISMATCH');
  assert.match(error.message, /Select Refresh/);
  assert.doesNotMatch(error.message, /get-work-order/);
  assert.equal((await listEvents(store, '10001')).length, before);
  // 現行版次照常可記錄
  assert.equal((await ui.recordEvidence(HUMAN, form('AC-3', { workOrderRev: 2 }))).recorded.criterionId, 'AC-3');
});

test('record evidence: status rules are unchanged (latest counts, fail and not-run are gaps, then Accept or Reject)', async () => {
  const { ui } = await setup();
  let view = await ui.recordEvidence(HUMAN, form('AC-1', { verdict: 'fail' }));
  assert.equal(view.state.criteria[0].status, STATUS.SUBMITTED);
  assert.equal(view.state.criteria[0].gap, GAP.FAILED);
  view = await ui.recordEvidence(HUMAN, form('AC-2', { verdict: 'not-run' }));
  // not-run 是獨立的缺口種類，不算成 failed
  assert.equal(view.state.criteria[1].gap, GAP.NOT_RUN);
  const firstAc1 = view.state.criteria[0].latestEvidence.seq;

  // 同一條再記一次：最新一筆算數，舊的成為 superseded
  view = await ui.recordEvidence(HUMAN, form('AC-1', { verdict: 'pass' }));
  const ac1 = view.state.criteria[0];
  assert.equal(ac1.evidenceCount, 2);
  assert.equal(ac1.gap, GAP.UNREVIEWED);
  assert.deepEqual(ac1.history.map((e) => [e.role, e.verdict, e.source]), [
    [EVIDENCE_ROLE.LATEST, 'pass', EVIDENCE_SOURCE.PANEL],
    [EVIDENCE_ROLE.SUPERSEDED, 'fail', EVIDENCE_SOURCE.PANEL],
  ]);
  const outdated = await ui.review(HUMAN, { evidenceSeq: firstAc1, decision: 'accept' }).catch((e) => e);
  assert.equal(outdated.code, 'OUTDATED_EVIDENCE');

  view = await ui.review(HUMAN, { evidenceSeq: ac1.latestEvidence.seq, decision: 'accept', note: 'Checked by hand' });
  assert.equal(view.state.criteria[0].status, STATUS.ACCEPTED);
  assert.equal(view.state.criteria[0].gap, null);
  view = await ui.review(HUMAN, { evidenceSeq: view.state.criteria[1].latestEvidence.seq, decision: 'reject' });
  assert.equal(view.state.criteria[1].status, STATUS.REJECTED);
  assert.equal(view.state.accepted, 1);
  assert.equal(view.state.gapCount, 1);
  assert.equal(view.chain.verified, true);
});

test('record evidence: refreshes the matrix row and the JQL issue property like the other writes', async () => {
  const { store, jira, ui } = await setup();
  const before = await store.get(summaryKey('20000', '10001'));
  assert.deepEqual(before.criteria.map((c) => c.gap), [GAP.NO_EVIDENCE, GAP.NO_EVIDENCE]);
  await ui.recordEvidence(HUMAN, form('AC-1', { verdict: 'fail' }));
  const after = await store.get(summaryKey('20000', '10001'));
  assert.deepEqual(after.criteria.map((c) => [c.status, c.gap]), [[STATUS.SUBMITTED, GAP.FAILED], [STATUS.NO_EVIDENCE, GAP.NO_EVIDENCE]]);
  const property = jira.properties.get(`10001/${MIRROR_PROPERTY_KEY}`);
  assert.deepEqual(property.gapKinds, [GAP.FAILED, GAP.NO_EVIDENCE].sort());
  // 鏡射不帶來源或任何代理文字
  assert.equal(JSON.stringify(property).includes('Manual entry'), false);
});

test('get-evidence-status: latestSource tells MCP clients which evidence was recorded by hand', async () => {
  const { ui, tools } = await setup();
  await ui.recordEvidence(HUMAN, form('AC-1'));
  await tools.submitEvidence(mcpEvidence('AC-2'), AGENT);
  const status = await tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT);
  assert.deepEqual(status.criteria.map((c) => [c.criterionId, c.latestSource, c.latestVerdict]), [
    ['AC-1', EVIDENCE_SOURCE.PANEL, 'pass'],
    ['AC-2', EVIDENCE_SOURCE.MCP, 'pass'],
  ]);
  const empty = await setup();
  assert.equal((await empty.tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT)).criteria[0].latestSource, null);
});

// 加 source 欄位以前寫入的事件（固定資料，雜湊用 509e2ea 的程式算出；chain.js 與 canonical.js 這次沒改）
const LEGACY = {
  descriptionHash: 'fd58b905198fb101d9fad864ed017c522aeeac9c5fd6dff6105ec58b6e87b83f',
  criteria: [{ id: 'AC-1', text: 'A', evidenceType: 'test' }, { id: 'AC-2', text: 'B', evidenceType: 'test' }],
  h1: '1b0691f19db4566cb854829d9ff6e118a927ec1c25c2769c093e6db396413cf5',
  h2: '3be683953903efead47d90260ecea352b929c727ed8979a8d2d9f8bc6c421e28',
};
async function legacyStore() {
  const store = createMemoryStore();
  const { criteria, descriptionHash, h1, h2 } = LEGACY;
  await store.set(eventKey('10001', 1), {
    seq: 1, type: EVENT_TYPES.APPROVED, at: '2026-11-12T08:00:00.000Z', actor: 'human-account', payload: { rev: 1, criteria, descriptionHash }, prevHash: '0'.repeat(64), hash: h1,
  });
  await store.set(eventKey('10001', 2), {
    seq: 2, type: EVENT_TYPES.SUBMITTED, at: '2026-11-12T08:05:00.000Z', actor: 'agent-account', prevHash: h1, hash: h2,
    payload: { rev: 1, criterionId: 'AC-1', verdict: 'fail', evidenceType: 'test', summary: 'Simulated legacy evidence', reference: 'abc1234', outputExcerpt: '', agentName: 'Claude Code', truncated: [] },
  });
  await store.set(revKey('10001', 1), { rev: 1, criteria, approvedBy: 'human-account', approvedAt: '2026-11-12T08:00:00.000Z', descriptionHash, draftSource: 'parser', approvalSeq: 1 });
  await store.set(headKey('10001'), { rev: 1, seq: 2, hash: h2 });
  return store;
}

test('old events without a source field still verify, count as MCP, and new panel events extend the same chain', async () => {
  const store = await legacyStore();
  const jira = createFakeJira({ issues: [structuredClone(ISSUE)], projects: PROJECTS });
  const ui = createResolverLogic({ store, jira, now: sequentialClock() });
  const tools = createTools({ store, jira, now: sequentialClock() });

  let view = await ui.getPanel(HUMAN);
  assert.equal(view.chain.verified, true);
  assert.equal(view.stale, false);
  const legacy = view.state.criteria[0].latestEvidence;
  assert.equal(legacy.source, EVIDENCE_SOURCE.MCP);
  assert.equal(sourceLabel(legacy), 'MCP: Claude Code');
  assert.equal(evidenceSource({}), EVIDENCE_SOURCE.MCP);
  assert.equal((await tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT)).criteria[0].latestSource, EVIDENCE_SOURCE.MCP);

  // 舊事件本身沒被改寫
  assert.equal('source' in (await eventAt(store, 2)).payload, false);

  view = await ui.recordEvidence(HUMAN, form('AC-1'));
  await tools.submitEvidence(mcpEvidence('AC-2'), AGENT);
  const events = await listEvents(store, '10001');
  assert.deepEqual(events.map((e) => e.payload.source ?? null), [null, null, EVIDENCE_SOURCE.PANEL, EVIDENCE_SOURCE.MCP]);
  assert.equal(events[2].prevHash, LEGACY.h2);
  assert.equal(verifyChain(events, await store.get(headKey('10001'))).verified, true);
  assert.deepEqual(view.state.criteria[0].history.map((e) => e.source), [EVIDENCE_SOURCE.PANEL, EVIDENCE_SOURCE.MCP]);
});

test('the source field is covered by the hash: relabelling a manual entry as MCP breaks the chain', async () => {
  const { store, ui } = await setup();
  const view = await ui.recordEvidence(HUMAN, form('AC-1'));
  const key = eventKey('10001', view.recorded.seq);
  const event = store.data.get(key);
  event.payload.source = EVIDENCE_SOURCE.MCP;
  event.payload.agentName = 'Claude Code';
  store.data.set(key, event);
  const after = await ui.getPanel(HUMAN);
  assert.equal(after.chain.verified, false);
  assert.equal(after.chain.brokenAt, view.recorded.seq);
});

test('audit pack: CSV has evidence_source, Markdown labels manual entries and explains the two sources', async () => {
  const { ui, tools } = await setup();
  const first = (await ui.recordEvidence(HUMAN, form('AC-1', { verdict: 'fail' }))).recorded;
  await ui.recordEvidence(HUMAN, form('AC-1', { verdict: 'pass' }));
  await tools.submitEvidence(mcpEvidence('AC-2'), AGENT);

  const csv = (await ui.exportAudit(HUMAN, { format: 'csv' })).content;
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  const sourceIndex = CSV_COLUMNS.indexOf('evidence_source');
  assert.equal(CSV_COLUMNS[sourceIndex - 1], 'agent_name');
  assert.equal(CSV_COLUMNS.at(-1), 'fix_versions');
  const cells = (criterionId) => lines.find((l) => l.includes(`,${criterionId},`)).split(',');
  // 這兩列的儲存格都沒有逗號，可以直接切
  assert.equal(cells('AC-1')[sourceIndex], EVIDENCE_SOURCE.PANEL);
  assert.equal(cells('AC-1')[sourceIndex - 1], MANUAL_AGENT_NAME);
  assert.equal(cells('AC-2')[sourceIndex], EVIDENCE_SOURCE.MCP);
  assert.match(lines.find((l) => l.includes(',AC-1,')), new RegExp(`#${first.seq} fail \\S+ hash [0-9a-f]{12} \\(manual entry\\),`));

  const md = (await ui.exportAudit(HUMAN, { format: 'markdown' })).content;
  assert.match(md, /^Evidence sources: `MCP: <agent name>` was reported by an AI agent through MCP/m);
  const row = (id) => md.split('\n').find((l) => l.startsWith(`| ${id} |`));
  assert.match(row('AC-1'), /pass \(test\) #\d+, hash [0-9a-f]{12}, Manual entry \(Jira panel\), by `human-account`,/);
  assert.match(row('AC-2'), /pass \(test\) #\d+, hash [0-9a-f]{12}, MCP: Test agent, by `agent-account`,/);
  assert.match(md, new RegExp(`- AC-1: #${first.seq} fail .* \\(manual entry\\)`));
  assert.match(md, /Evidence chain: verified, 4 events/);
});

test('audit pack Markdown: no source legend when every piece of evidence came through MCP', async () => {
  const { ui, tools } = await setup();
  await tools.submitEvidence(mcpEvidence('AC-1'), AGENT);
  const md = (await ui.exportAudit(HUMAN, { format: 'markdown' })).content;
  assert.equal(md.includes('Evidence sources:'), false);
  assert.equal(md.includes('manual entry'), false);
});
