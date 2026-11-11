import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/actions/tools.js';
import { TAMPER_MARK, devBackupPrefix } from '../src/core/devtools.js';
import { eventKey } from '../src/core/keys.js';
import { createResolverLogic } from '../src/resolvers/logic.js';
import { adfDoc, createFakeJira, createMemoryStore, h, sequentialClock, ul } from './helpers.js';

const HUMAN = { accountId: 'human-account', issueId: '10001', projectKey: 'BMS' };
const AGENT = { accountId: 'agent-account' };

function setup({ devTools = true, editors = true } = {}) {
  const store = createMemoryStore();
  const jira = createFakeJira({
    issues: [{ issueId: '10001', issueKey: 'BMS-1', title: 'T', projectId: '20000', projectKey: 'BMS', description: adfDoc(h(2, 'Acceptance criteria'), ul('A', 'B')) }],
    projects: [{ projectId: '20000', projectKey: 'BMS', name: 'Battery' }],
    editors,
  });
  const now = sequentialClock();
  const ui = createResolverLogic({ store, jira, now, devToolsEnabled: () => devTools });
  const tools = createTools({ store, jira, now });
  return { store, jira, ui, tools };
}

async function approvedWithEvidence(ctx) {
  // Approve as an editor, then submit one piece of evidence
  const editorUi = createResolverLogic({ store: ctx.store, jira: createFakeJira({ issues: [...ctx.jira.issues.values()] }), now: sequentialClock() });
  await editorUi.draftFromDescription(HUMAN);
  await editorUi.approve(HUMAN, {});
  return ctx.tools.submitEvidence(
    { issueKey: 'BMS-1', criterionId: 'AC-1', workOrderRev: 1, verdict: 'pass', evidenceType: 'test', summary: 'Simulated test data', agentName: 'Test agent' },
    AGENT,
  );
}

test('dev tools: tamper makes the chain broken, restore makes it verified again', async () => {
  const ctx = setup();
  const sent = await approvedWithEvidence(ctx);
  let view = await ctx.ui.getPanel(HUMAN);
  assert.equal(view.chain.verified, true);
  assert.deepEqual(view.devTools, { tampered: 0 });

  view = await ctx.ui.devTamper(HUMAN);
  assert.equal(view.chain.verified, false);
  assert.equal(view.chain.brokenAt, sent.seq);
  assert.equal(view.devTools.tampered, 1);
  assert.ok(ctx.store.data.get(eventKey('10001', sent.seq)).payload.summary.endsWith(TAMPER_MARK));

  // Tampering twice keeps the first clean copy as the backup
  await ctx.ui.devTamper(HUMAN);
  view = await ctx.ui.devRestore(HUMAN);
  assert.equal(view.chain.verified, true);
  assert.equal(view.devTools.tampered, 0);
  assert.equal(ctx.store.data.get(eventKey('10001', sent.seq)).payload.summary, 'Simulated test data');
});

test('dev tools: refused and invisible when the development guard is off', async () => {
  const ctx = setup({ devTools: false });
  const sent = await approvedWithEvidence(ctx);
  const before = structuredClone(ctx.store.data.get(eventKey('10001', sent.seq)));
  const view = await ctx.ui.getPanel(HUMAN);
  assert.equal(view.devTools, null);
  for (const call of ['devTamper', 'devRestore']) {
    const error = await ctx.ui[call](HUMAN).catch((e) => e);
    assert.equal(error.code, 'NOT_AVAILABLE');
  }
  assert.deepEqual(ctx.store.data.get(eventKey('10001', sent.seq)), before);
  assert.equal((await ctx.store.listByPrefix(devBackupPrefix('10001'))).length, 0);
});

test('dev tools: people without edit permission cannot use them even in development', async () => {
  const ctx = setup({ editors: false });
  await approvedWithEvidence(ctx);
  const error = await ctx.ui.devTamper(HUMAN).catch((e) => e);
  assert.equal(error.code, 'FORBIDDEN');
  assert.equal((await ctx.ui.getPanel(HUMAN)).devTools, null);
});
