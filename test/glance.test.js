import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glanceStatus, loadGlanceStatus } from '../src/core/glance.js';
import { draftKey, summaryKey } from '../src/core/keys.js';
import { createMemoryStore } from './helpers.js';

const label = (status) => `${status.value.label}|${status.value.type}`;

test('glance status: no work order, draft, gaps, all accepted, broken chain', () => {
  assert.equal(label(glanceStatus({})), 'No work order|default');
  assert.equal(label(glanceStatus({ draft: { criteria: [] } })), 'Draft|new');
  const summary = { gapCount: 3, accepted: 1, total: 4, chainVerified: true };
  assert.equal(label(glanceStatus({ summary })), '3 gaps|moved');
  assert.equal(label(glanceStatus({ summary: { ...summary, gapCount: 1 } })), '1 gap|moved');
  assert.equal(label(glanceStatus({ summary: { ...summary, gapCount: 0, accepted: 4 } })), '4/4 accepted|success');
  assert.equal(label(glanceStatus({ summary: { ...summary, chainVerified: false } })), 'Chain broken|removed');
  assert.equal(glanceStatus({}).type, 'lozenge');
});

test('glance status reads the stored summary and draft for the issue', async () => {
  const store = createMemoryStore();
  assert.equal(label(await loadGlanceStatus(store, { issueId: '10001', projectId: '20000' })), 'No work order|default');
  await store.set(draftKey('10001'), { criteria: [{ text: 'A', evidenceType: 'test' }] });
  assert.equal(label(await loadGlanceStatus(store, { issueId: '10001', projectId: '20000' })), 'Draft|new');
  await store.set(summaryKey('20000', '10001'), { gapCount: 2, accepted: 2, total: 4, chainVerified: true });
  assert.equal(label(await loadGlanceStatus(store, { issueId: '10001', projectId: '20000' })), '2 gaps|moved');
  assert.equal(label(await loadGlanceStatus(store, { issueId: null })), 'Open|default');
});
