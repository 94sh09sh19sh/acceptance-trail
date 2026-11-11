import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraClient } from '../src/jira/client.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { createTools } from '../src/actions/tools.js';
import { adfDoc, createMemoryStore, h, ul } from './helpers.js';

// Simulated Forge API: each request is answered by a handler keyed on "<as> <method> <path>".
// No site has a second account, so these tests stand in for a viewer without edit permission.
const ISSUE_BODY = {
  id: '10001',
  key: 'BMS-1',
  fields: {
    summary: 'Over-temperature',
    project: { id: '20000', key: 'BMS' },
    description: adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B')),
  },
};

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

const editPermission = (havePermission) => [/^user GET \/rest\/api\/3\/mypermissions/, () => json(200, { permissions: { EDIT_ISSUES: { havePermission } } })];
const userCanBrowse = [/^user GET \/rest\/api\/3\/issue\//, () => json(200, ISSUE_BODY)];

test('canEditIssue: reads EDIT_ISSUES from mypermissions; errors count as no permission', async () => {
  assert.equal(await createJiraClient(fakeForgeApi([editPermission(true)])).canEditIssue('10001'), true);
  assert.equal(await createJiraClient(fakeForgeApi([editPermission(false)])).canEditIssue('10001'), false);
  const denied = fakeForgeApi([[/mypermissions/, () => json(403, { errorMessages: ['no'] })]]);
  assert.equal(await createJiraClient(denied).canEditIssue('10001'), false);
  const empty = fakeForgeApi([[/mypermissions/, () => json(200, {})]]);
  assert.equal(await createJiraClient(empty).canEditIssue('10001'), false);
});

test('a viewer without edit permission sees the panel read-only and every change is refused', async () => {
  const api = fakeForgeApi([userCanBrowse, editPermission(false)]);
  const store = createMemoryStore();
  const ui = createResolverLogic({ store, jira: createJiraClient(api), devToolsEnabled: () => true });
  const viewer = { accountId: 'viewer-account', issueId: '10001', projectKey: 'BMS' };

  const view = await ui.getPanel(viewer);
  assert.equal(view.canEdit, false);
  assert.equal(view.devTools, null);
  assert.equal(view.workOrder, null);

  const attempts = {
    draftFromDescription: () => ui.draftFromDescription(viewer),
    saveDraft: () => ui.saveDraft(viewer, { criteria: [{ text: 'X', evidenceType: 'test' }] }),
    discardDraft: () => ui.discardDraft(viewer),
    approve: () => ui.approve(viewer, { criteria: [{ text: 'X', evidenceType: 'test' }] }),
    review: () => ui.review(viewer, { evidenceSeq: 1, decision: 'accept' }),
    devTamper: () => ui.devTamper(viewer),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    const error = await attempt().catch((e) => e);
    assert.equal(error.code, 'FORBIDDEN', name);
  }
  // Nothing was written: no draft, no work order, no events
  assert.deepEqual([...store.data.keys()], []);
});

test('asUser 404 means "cannot see it": the client never falls back to asApp', async () => {
  const api = fakeForgeApi([[/^user GET \/rest\/api\/3\/issue\//, () => json(404, {})]]);
  const client = createJiraClient(api);
  assert.equal(await client.getIssue('BMS-1', { accountId: 'someone' }), null);
  assert.deepEqual(api.calls, ['user GET /rest/api/3/issue/BMS-1']);
});

test('asUser 403 falls back to asApp only with an explicit browse check for the caller', async () => {
  const handlers = (granted) => [
    [/^user GET \/rest\/api\/3\/issue\//, () => json(403, {})],
    [/^app GET \/rest\/api\/3\/issue\//, () => json(200, ISSUE_BODY)],
    [/^app POST \/rest\/api\/3\/permissions\/check/, (init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.accountId, 'agent-account');
      return json(200, { projectPermissions: [{ permission: 'BROWSE_PROJECTS', issues: granted ? [10001] : [] }] });
    }],
  ];
  const denied = createJiraClient(fakeForgeApi(handlers(false)));
  assert.equal(await denied.getIssue('BMS-1', { accountId: 'agent-account' }), null);
  const allowed = createJiraClient(fakeForgeApi(handlers(true)));
  assert.equal((await allowed.getIssue('BMS-1', { accountId: 'agent-account' })).issueKey, 'BMS-1');

  // Unknown caller: no check is even attempted, the issue is treated as not visible
  const unknownApi = fakeForgeApi(handlers(true));
  assert.equal(await createJiraClient(unknownApi).getIssue('BMS-1', { accountId: 'unknown' }), null);
  assert.equal(unknownApi.calls.some((c) => c.includes('permissions/check')), false);
});

test('agents without browse permission get ISSUE_NOT_FOUND and cannot submit evidence', async () => {
  const api = fakeForgeApi([[/^user GET \/rest\/api\/3\/issue\//, () => json(404, {})]]);
  const store = createMemoryStore();
  const tools = createTools({ store, jira: createJiraClient(api) });
  const error = await tools
    .submitEvidence({ issueKey: 'BMS-1', criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 's', agentName: 'a' }, { accountId: 'agent-account' })
    .catch((e) => e);
  assert.equal(error.code, 'ISSUE_NOT_FOUND');
  assert.deepEqual([...store.data.keys()], []);
});
