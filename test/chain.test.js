import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, listEvents, verifyChain, EVENT_TYPES } from '../src/core/chain.js';
import { canonicalJson } from '../src/core/canonical.js';
import { ZERO_HASH, eventKey, headKey } from '../src/core/keys.js';
import { createMemoryStore } from './helpers.js';

const ISSUE = '10001';
const ev = (n) => ({ type: EVENT_TYPES.SUBMITTED, actor: 'acc-1', at: `2026-11-10T00:00:0${n}.000Z`, payload: { n } });

test('正規化 JSON 與鍵的順序無關', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
});

test('新增事件會串成雜湊鏈並可驗證', async () => {
  const store = createMemoryStore();
  const first = await appendEvent(store, ISSUE, ev(1));
  const second = await appendEvent(store, ISSUE, ev(2));
  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, ZERO_HASH);
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);
  assert.match(second.hash, /^[0-9a-f]{64}$/);
  const events = await listEvents(store, ISSUE);
  const head = await store.get(headKey(ISSUE));
  assert.deepEqual(verifyChain(events, head), { verified: true, count: 2, brokenAt: null, reason: null });
});

test('竄改一筆事件後驗證失敗', async () => {
  const store = createMemoryStore();
  for (let i = 1; i <= 3; i += 1) await appendEvent(store, ISSUE, ev(i));
  const key = eventKey(ISSUE, 2);
  const tampered = store.data.get(key);
  tampered.payload.n = 99;
  store.data.set(key, tampered);
  const result = verifyChain(await listEvents(store, ISSUE), await store.get(headKey(ISSUE)));
  assert.equal(result.verified, false);
  assert.equal(result.brokenAt, 2);
});

test('竄改後連 hash 一起重算，下一筆的 prevHash 會對不上', async () => {
  const store = createMemoryStore();
  for (let i = 1; i <= 3; i += 1) await appendEvent(store, ISSUE, ev(i));
  const { computeEventHash } = await import('../src/core/chain.js');
  const key = eventKey(ISSUE, 2);
  const tampered = store.data.get(key);
  tampered.payload.n = 99;
  tampered.hash = computeEventHash(tampered.prevHash, tampered);
  store.data.set(key, tampered);
  const result = verifyChain(await listEvents(store, ISSUE), await store.get(headKey(ISSUE)));
  assert.equal(result.verified, false);
  assert.equal(result.brokenAt, 3);
});

test('刪掉最後一筆事件會被鏈頭抓到', async () => {
  const store = createMemoryStore();
  for (let i = 1; i <= 3; i += 1) await appendEvent(store, ISSUE, ev(i));
  store.data.delete(eventKey(ISSUE, 3));
  const result = verifyChain(await listEvents(store, ISSUE), await store.get(headKey(ISSUE)));
  assert.equal(result.verified, false);
});

test('同時新增 5 筆事件：序號連續且鏈可驗證', async () => {
  const store = createMemoryStore();
  await appendEvent(store, ISSUE, ev(0));
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => appendEvent(store, ISSUE, ev(n))));
  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [2, 3, 4, 5, 6]);
  const events = await listEvents(store, ISSUE);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(verifyChain(events, await store.get(headKey(ISSUE))).verified, true);
  assert.equal((await store.get(headKey(ISSUE))).seq, 6);
});

test('鏈頭落後（競爭造成）時仍能接在真正的鏈尾後面', async () => {
  const store = createMemoryStore();
  for (let i = 1; i <= 3; i += 1) await appendEvent(store, ISSUE, ev(i));
  store.data.set(headKey(ISSUE), { seq: 1, hash: store.data.get(eventKey(ISSUE, 1)).hash });
  const next = await appendEvent(store, ISSUE, ev(4));
  assert.equal(next.seq, 4);
  assert.equal(verifyChain(await listEvents(store, ISSUE), await store.get(headKey(ISSUE))).verified, true);
});
