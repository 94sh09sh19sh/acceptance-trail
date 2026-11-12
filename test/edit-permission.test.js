import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { createJiraClient } from '../src/jira/client.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

// 寫入類工具（submit-evidence、propose-work-order）要有該議題的編輯權限；
// 只有瀏覽權限的人仍可用讀取類工具。和 permissions.test.js 一樣用模擬的 Forge API 回應。

const ISSUE = { issueId: '10001', issueKey: 'BMS-1', title: 'T', projectId: '20000', projectKey: 'BMS', description: adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B')) };
const ISSUE_BODY = { id: '10001', key: 'BMS-1', fields: { summary: 'T', project: { id: '20000', key: 'BMS' }, description: ISSUE.description } };
const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };
const EVIDENCE = { issueKey: 'BMS-1', criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 'Simulated test data', agentName: 'Test agent' };
const CRITERIA_JSON = JSON.stringify([{ text: 'Simulated criterion', evidenceType: 'test' }]);

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeForgeApi(handlers) {
  const calls = [];
  const requester = (as) => ({
    async requestJira(route, init = {}) {
      const path = String(route.value ?? route.value_ ?? route);
      const method = init.method ?? 'GET';
      calls.push(`${as} ${method} ${path.split('?')[0]}`);
      const handler = handlers.find(([pattern]) => pattern.test(`${as} ${method} ${path}`));
      if (!handler) throw new Error(`Unexpected request ${as} ${method} ${path}`);
      return handler[1](init);
    },
  });
  return { calls, asUser: () => requester('user'), asApp: () => requester('app') };
}

// asApp 的 permissions/check：依請求的權限種類回應是否授權給 agent-account
const appPermissionCheck = ({ browse, edit }) => [
  /^app POST \/rest\/api\/3\/permissions\/check/,
  (init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.accountId, 'agent-account');
    const permission = body.projectPermissions[0].permissions[0];
    const granted = permission === 'BROWSE_PROJECTS' ? browse : permission === 'EDIT_ISSUES' ? edit : false;
    return json(200, { projectPermissions: [{ permission, issues: granted ? [10001] : [] }] });
  },
];

test('canEditIssue: asUser 403 or a thrown asUser call falls back to an explicit asApp EDIT_ISSUES check for the caller', async () => {
  const user403 = [/^user GET \/rest\/api\/3\/mypermissions/, () => json(403, {})];
  assert.equal(await createJiraClient(fakeForgeApi([user403, appPermissionCheck({ edit: true })])).canEditIssue('10001', AGENT), true);
  assert.equal(await createJiraClient(fakeForgeApi([user403, appPermissionCheck({ edit: false })])).canEditIssue('10001', AGENT), false);

  const userThrows = [/^user GET \/rest\/api\/3\/mypermissions/, () => { throw new Error('no user context'); }];
  assert.equal(await createJiraClient(fakeForgeApi([userThrows, appPermissionCheck({ edit: true })])).canEditIssue('10001', AGENT), true);

  // 身分不明：不嘗試退回 asApp，直接視為沒有權限
  const unknown = fakeForgeApi([user403, appPermissionCheck({ edit: true })]);
  assert.equal(await createJiraClient(unknown).canEditIssue('10001', { accountId: 'unknown' }), false);
  assert.equal(unknown.calls.some((c) => c.startsWith('app ')), false);

  // 404 與 5xx 不退回 asApp
  for (const status of [404, 500]) {
    const api = fakeForgeApi([[/^user GET \/rest\/api\/3\/mypermissions/, () => json(status, {})], appPermissionCheck({ edit: true })]);
    assert.equal(await createJiraClient(api).canEditIssue('10001', AGENT), false, String(status));
    assert.equal(api.calls.some((c) => c.startsWith('app ')), false);
  }
});

async function approvedStore() {
  const store = createMemoryStore();
  const ui = createResolverLogic({ store, jira: createFakeJira({ issues: [ISSUE] }), now: sequentialClock() });
  await ui.draftFromDescription(HUMAN);
  await ui.approve(HUMAN, {});
  return store;
}

test('a viewer without edit permission cannot submit evidence or propose a work order, but can still read', async () => {
  const store = await approvedStore();
  const viewerJira = createFakeJira({ issues: [ISSUE], projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }], editors: false });
  const tools = createTools({ store, jira: viewerJira, now: sequentialClock() });
  const before = structuredClone(store.data);

  for (const attempt of [() => tools.submitEvidence(EVIDENCE, AGENT), () => tools.proposeWorkOrder({ issueKey: 'BMS-1', criteriaJson: CRITERIA_JSON }, AGENT)]) {
    const error = await attempt().catch((e) => e);
    assert.equal(error.code, 'FORBIDDEN');
    assert.match(error.message, /permission to edit/);
    assert.match(error.message, /Nothing was stored/);
  }
  // 鏈、草稿、工作單都沒變
  assert.deepEqual(store.data, before);

  // 讀取類工具照常可用
  assert.equal((await tools.getWorkOrder({ issueKey: 'BMS-1' }, AGENT)).status, 'approved');
  assert.equal((await tools.getEvidenceStatus({ issueKey: 'BMS-1' }, AGENT)).chainVerified, true);
  assert.equal((await tools.listGaps({ projectKey: 'BMS' }, AGENT)).issuesWithGaps, 1);
  assert.equal((await tools.listOpenWorkOrders({ projectKey: 'BMS' }, AGENT)).count, 1);
});

test('submit-evidence through the real client: mypermissions false is FORBIDDEN, true stores the event', async () => {
  const handlers = (havePermission) => [
    [/^user GET \/rest\/api\/3\/issue\/BMS-1/, () => json(200, ISSUE_BODY)],
    [/^user GET \/rest\/api\/3\/mypermissions/, () => json(200, { permissions: { EDIT_ISSUES: { havePermission } } })],
    [/^user PUT \/rest\/api\/3\/issue\/10001\/properties\//, () => json(200, {})],
  ];
  const store = await approvedStore();
  const before = structuredClone(store.data);
  const denied = createTools({ store, jira: createJiraClient(fakeForgeApi(handlers(false))), now: sequentialClock() });
  assert.equal((await denied.submitEvidence(EVIDENCE, AGENT).catch((e) => e)).code, 'FORBIDDEN');
  assert.deepEqual(store.data, before);

  const allowed = createTools({ store, jira: createJiraClient(fakeForgeApi(handlers(true))), now: sequentialClock() });
  assert.equal((await allowed.submitEvidence(EVIDENCE, AGENT)).seq, 2);
});

test('submit-evidence when asUser is refused (403): browse and edit are both checked as the app for the caller', async () => {
  const handlers = (edit) => [
    [/^user /, () => json(403, {})],
    [/^app GET \/rest\/api\/3\/issue\/BMS-1/, () => json(200, ISSUE_BODY)],
    appPermissionCheck({ browse: true, edit }),
  ];
  const store = await approvedStore();
  const before = structuredClone(store.data);
  const viewerApi = fakeForgeApi(handlers(false));
  const viewer = createTools({ store, jira: createJiraClient(viewerApi), now: sequentialClock() });
  assert.equal((await viewer.submitEvidence(EVIDENCE, AGENT).catch((e) => e)).code, 'FORBIDDEN');
  assert.equal((await viewer.proposeWorkOrder({ issueKey: 'BMS-1', criteriaJson: CRITERIA_JSON }, AGENT).catch((e) => e)).code, 'FORBIDDEN');
  assert.deepEqual(store.data, before);

  // 有編輯權限時寫入成功；鏡射用 asUser 寫 property 也被拒（403），但不影響主寫入
  const editorApi = fakeForgeApi(handlers(true));
  const editor = createTools({ store, jira: createJiraClient(editorApi), now: sequentialClock() });
  const result = await editor.submitEvidence(EVIDENCE, AGENT);
  assert.equal(result.ok, true);
  assert.equal(result.seq, 2);
  assert.ok(editorApi.calls.includes('user PUT /rest/api/3/issue/10001/properties/evidence-chain-summary'));
  assert.equal(editorApi.calls.some((c) => c.startsWith('app PUT')), false);
});
