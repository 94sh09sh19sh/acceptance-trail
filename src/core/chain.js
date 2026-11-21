import { canonicalJson, sha256Hex } from './canonical.js';
import { DomainError } from './errors.js';
import { ZERO_HASH, eventKey, eventPrefix, headKey } from './keys.js';

export const EVENT_TYPES = Object.freeze({
  APPROVED: 'work_order_approved',
  SUBMITTED: 'evidence_submitted',
  REVIEWED: 'evidence_reviewed',
});

// 同時寫入時最多重試幾次；每次衝突代表別人搶先寫了一筆，序號往後推一格再試
export const MAX_APPEND_ATTEMPTS = 25;

// 衝突後、重試前等一段隨機時間（毫秒），讓同時寫入的請求錯開；等待上限隨重試次數增加，最多 50 毫秒
export function retryJitter(attempt) {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(50, 5 * attempt)));
}

// hash = SHA-256(prevHash + 正規化 JSON)。被雜湊的內容是事件本體（不含 prevHash 與 hash 欄位）。
export function computeEventHash(prevHash, body) {
  const { seq, type, at, actor, payload } = body;
  return sha256Hex(prevHash + canonicalJson({ seq, type, at, actor, payload }));
}

// 讀出一個議題的全部事件，依序號排序（KVS 查詢的排序未在文件中保證，所以自己排）
export async function listEvents(store, issueId) {
  const rows = await store.listByPrefix(eventPrefix(issueId));
  return rows.map((row) => row.value).sort((a, b) => a.seq - b.seq);
}

// 找出目前鏈尾：先看 head（只是提示，可能因競爭而落後），再往後探測實際存在的事件
async function resolveTip(store, issueId) {
  const head = await store.get(headKey(issueId));
  let tip = { seq: head?.seq ?? 0, hash: head?.hash ?? ZERO_HASH };
  if (tip.seq > 0) {
    // head 記錄的那一筆以事件本體為準，避免 head 本身被動過
    const atHead = await store.get(eventKey(issueId, tip.seq));
    if (atHead) tip = { seq: atHead.seq, hash: atHead.hash };
  }
  for (;;) {
    const next = await store.get(eventKey(issueId, tip.seq + 1));
    if (!next) return tip;
    tip = { seq: next.seq, hash: next.hash };
  }
}

// head 只往前推，不往回改；序號較小的寫入者不會蓋掉較新的鏈頭
async function advanceHead(store, issueId, seq, hash) {
  const head = (await store.get(headKey(issueId))) ?? {};
  if ((head.seq ?? 0) >= seq) return;
  await store.set(headKey(issueId), { ...head, seq, hash });
}

// 新增一筆事件。防競爭的做法：事件鍵用「鍵不存在才寫入」，
// 兩個寫入者搶同一個序號時只有一個成功，另一個隨機等一下、重新找鏈尾再試，所以序號不會重複、也不會跳號。
// 重試用完時回 BUSY（可辨識的「請重試」），什麼都沒寫入。wait 可注入，測試用來省掉等待。
export async function appendEvent(store, issueId, { type, actor, payload, at }, { wait = retryJitter } = {}) {
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(attempt);
    const tip = await resolveTip(store, issueId);
    const body = { seq: tip.seq + 1, type, at, actor: actor || 'unknown', payload };
    const event = { ...body, prevHash: tip.hash, hash: computeEventHash(tip.hash, body) };
    if (await store.setIfAbsent(eventKey(issueId, event.seq), event)) {
      await advanceHead(store, issueId, event.seq, event.hash);
      return event;
    }
  }
  throw new DomainError('BUSY', 'Too many writes at once. Retry this call.');
}

// 驗證整條鏈：序號從 1 連續、每筆的 prevHash 等於前一筆的 hash、hash 重算相符。
// head 若記錄了比實際更新的序號，代表有事件被刪除，也算斷鏈（head 落後則是正常的競爭結果）。
export function verifyChain(events, head) {
  let prevHash = ZERO_HASH;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const expectedSeq = i + 1;
    if (event.seq !== expectedSeq) {
      return { verified: false, count: events.length, brokenAt: expectedSeq, reason: 'missing or out-of-order event' };
    }
    if (event.prevHash !== prevHash) {
      return { verified: false, count: events.length, brokenAt: event.seq, reason: 'previous hash does not match' };
    }
    if (computeEventHash(prevHash, event) !== event.hash) {
      return { verified: false, count: events.length, brokenAt: event.seq, reason: 'event content does not match its hash' };
    }
    prevHash = event.hash;
  }
  if (head && typeof head.seq === 'number') {
    const last = events[events.length - 1];
    if (head.seq > (last?.seq ?? 0)) {
      return { verified: false, count: events.length, brokenAt: (last?.seq ?? 0) + 1, reason: 'events are missing after the last stored event' };
    }
    if (last && head.seq === last.seq && head.hash && head.hash !== last.hash) {
      return { verified: false, count: events.length, brokenAt: last.seq, reason: 'chain head does not match the last event' };
    }
  }
  return { verified: true, count: events.length, brokenAt: null, reason: null };
}
