import { canonicalJson } from './canonical.js';
import { EVENT_TYPES, appendEvent, listEvents, verifyChain } from './chain.js';
import { draftKey, headKey, revKey, summaryKey } from './keys.js';
import { syncMirror } from './mirror.js';
import { EVIDENCE_SOURCE, EVIDENCE_SOURCES, MANUAL_AGENT_NAME } from './source.js';
import { buildSummary, deriveState } from './state.js';
import {
  EVIDENCE_TYPES,
  LIMITS,
  REVIEW_DECISIONS,
  VERDICTS,
  ValidationError,
  normalizeCriteria,
  requireOneOf,
  requirePositiveInteger,
  requireString,
  truncate,
} from './validate.js';

// 商業規則錯誤：帶一個穩定的代號，讓代理可以依代號判斷下一步
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export const DRAFT_SOURCES = Object.freeze(['parser', 'manual', 'agent']);

// ---- 草稿 ----

export async function getDraft(store, issueId) {
  return (await store.get(draftKey(issueId))) ?? null;
}

export async function saveDraft(store, issueId, { criteria, source, at, actor }) {
  if (!DRAFT_SOURCES.includes(source)) throw new ValidationError('Unknown draft source.');
  const draft = { criteria: normalizeCriteria(criteria), source, updatedAt: at, updatedBy: actor || 'unknown' };
  await store.set(draftKey(issueId), draft);
  return draft;
}

export async function discardDraft(store, issueId) {
  await store.delete(draftKey(issueId));
}

// ---- 已核准的工作單 ----

// 現行版次：head 記錄的版次只是提示，再往後探測是否已有更新的版次
export async function getCurrentWorkOrder(store, issueId) {
  const head = await store.get(headKey(issueId));
  let rev = head?.rev ?? 0;
  let current = rev > 0 ? await store.get(revKey(issueId, rev)) : null;
  for (;;) {
    const next = await store.get(revKey(issueId, rev + 1));
    if (!next) return current ?? null;
    rev += 1;
    current = next;
  }
}

async function recordHeadRev(store, issueId, rev) {
  const head = (await store.get(headKey(issueId))) ?? {};
  if ((head.rev ?? 0) >= rev) return;
  await store.set(headKey(issueId), { ...head, rev });
}

// 核准：把草稿凍結成下一個版次，寫入一筆 work_order_approved 事件。只能由人在議題面板觸發。
export async function approveDraft(store, issueId, { actor, at, descriptionHash }) {
  const draft = await getDraft(store, issueId);
  if (!draft || draft.criteria.length === 0) {
    throw new DomainError('EMPTY_DRAFT', 'There is no draft with at least one criterion to approve.');
  }
  const current = await getCurrentWorkOrder(store, issueId);
  const rev = (current?.rev ?? 0) + 1;
  const criteria = draft.criteria.map((c, index) => ({ id: `AC-${index + 1}`, text: c.text, evidenceType: c.evidenceType }));
  const workOrder = { rev, criteria, approvedBy: actor || 'unknown', approvedAt: at, descriptionHash, draftSource: draft.source };
  if (!(await store.setIfAbsent(revKey(issueId, rev), workOrder))) {
    throw new DomainError('CONCURRENT_APPROVAL', 'Another revision was approved at the same time. Reload and try again.');
  }
  const event = await appendEvent(store, issueId, {
    type: EVENT_TYPES.APPROVED,
    actor,
    at,
    payload: { rev, criteria, descriptionHash },
  });
  await store.set(revKey(issueId, rev), { ...workOrder, approvalSeq: event.seq });
  await recordHeadRev(store, issueId, rev);
  await discardDraft(store, issueId);
  return { ...workOrder, approvalSeq: event.seq };
}

// ---- 證據與覆核 ----

// 送回一條驗收條件的證據。版次不符或條件代號不存在就拒絕，不寫入。
// 代理經 MCP（source 為 mcp）與人在議題面板手動記錄（source 為 panel）都走這裡，驗證、截斷與寫入規則相同。
// source 由呼叫端（MCP 工具或面板的 resolver）決定，不從 input 讀；panel 時代理名稱固定為 MANUAL_AGENT_NAME，忽略 input.agentName。
export async function submitEvidence(store, issueId, input, { actor, at, source = EVIDENCE_SOURCE.MCP }) {
  if (!EVIDENCE_SOURCES.includes(source)) throw new Error(`Unknown evidence source: ${source}`);
  const manual = source === EVIDENCE_SOURCE.PANEL;
  const criterionId = requireString(input.criterionId, 'criterionId').toUpperCase();
  const workOrderRev = requirePositiveInteger(input.workOrderRev, 'workOrderRev');
  const verdict = requireOneOf(input.verdict, VERDICTS, 'verdict');
  const evidenceType = requireOneOf(input.evidenceType, EVIDENCE_TYPES, 'evidenceType');
  const summary = truncate(input.summary, LIMITS.summary);
  if (!summary.value) throw new ValidationError('summary is required.');
  const reference = truncate(input.reference, LIMITS.reference);
  const outputExcerpt = truncate(input.outputExcerpt, LIMITS.outputExcerpt);
  const agentName = manual ? { value: MANUAL_AGENT_NAME, truncated: false } : truncate(input.agentName, LIMITS.agentName);
  if (!agentName.value) throw new ValidationError('agentName is required.');

  const workOrder = await getCurrentWorkOrder(store, issueId);
  if (!workOrder) {
    throw new DomainError('NOT_APPROVED', 'This issue has no approved work order. A person must approve it in Jira first.');
  }
  if (workOrder.rev !== workOrderRev) {
    throw new DomainError(
      'REVISION_MISMATCH',
      `The current work order revision is ${workOrder.rev}, but you sent ${workOrderRev}. Call get-work-order again and use the current revision.`,
    );
  }
  const criterion = workOrder.criteria.find((c) => c.id === criterionId);
  if (!criterion) {
    throw new DomainError(
      'UNKNOWN_CRITERION',
      `Criterion ${criterionId} does not exist in revision ${workOrder.rev}. Valid IDs: ${workOrder.criteria.map((c) => c.id).join(', ')}.`,
    );
  }

  const truncated = [
    ['summary', summary],
    ['reference', reference],
    ['outputExcerpt', outputExcerpt],
    ['agentName', agentName],
  ]
    .filter(([, field]) => field.truncated)
    .map(([name]) => name);

  const event = await appendEvent(store, issueId, {
    type: EVENT_TYPES.SUBMITTED,
    actor,
    at,
    payload: {
      rev: workOrder.rev,
      criterionId,
      verdict,
      evidenceType,
      summary: summary.value,
      reference: reference.value,
      outputExcerpt: outputExcerpt.value,
      agentName: agentName.value,
      truncated,
      source,
    },
  });
  return { event, workOrder, criterion, truncated };
}

// 人覆核一筆證據：只能覆核現行版次、該條驗收條件的最新一筆證據
export async function reviewEvidence(store, issueId, input, { actor, at }) {
  const evidenceSeq = requirePositiveInteger(input.evidenceSeq, 'evidenceSeq');
  const decision = requireOneOf(input.decision, REVIEW_DECISIONS, 'decision');
  const note = truncate(input.note, LIMITS.reviewNote).value;

  const [workOrder, events] = await Promise.all([getCurrentWorkOrder(store, issueId), listEvents(store, issueId)]);
  const evidence = events.find((e) => e.seq === evidenceSeq && e.type === EVENT_TYPES.SUBMITTED);
  if (!evidence) throw new DomainError('UNKNOWN_EVIDENCE', 'That evidence record does not exist.');
  if (!workOrder || evidence.payload.rev !== workOrder.rev) {
    throw new DomainError('OUTDATED_EVIDENCE', 'That evidence belongs to an older work order revision.');
  }
  const newer = events.find(
    (e) => e.type === EVENT_TYPES.SUBMITTED && e.seq > evidence.seq && e.payload.rev === workOrder.rev && e.payload.criterionId === evidence.payload.criterionId,
  );
  if (newer) throw new DomainError('OUTDATED_EVIDENCE', 'Newer evidence exists for this criterion. Review the latest one.');

  return appendEvent(store, issueId, {
    type: EVENT_TYPES.REVIEWED,
    actor,
    at,
    payload: { rev: workOrder.rev, evidenceSeq, criterionId: evidence.payload.criterionId, decision, note },
  });
}

// ---- 彙整 ----

// 現行版本記錄要和鏈上的核准事件一致，否則代表工作單記錄被改過
function workOrderMatchesChain(workOrder, events) {
  if (!workOrder) return true;
  const approval = events.find((e) => e.type === EVENT_TYPES.APPROVED && e.payload?.rev === workOrder.rev);
  if (!approval) return false;
  return (
    canonicalJson(approval.payload.criteria) === canonicalJson(workOrder.criteria) &&
    approval.payload.descriptionHash === workOrder.descriptionHash
  );
}

// 讀出一個議題的完整狀態。currentDescriptionHash 給了才判斷是否過期。
export async function loadIssueState(store, issueId, { currentDescriptionHash } = {}) {
  const [workOrder, draft, events, head] = await Promise.all([
    getCurrentWorkOrder(store, issueId),
    getDraft(store, issueId),
    listEvents(store, issueId),
    store.get(headKey(issueId)),
  ]);
  let chain = verifyChain(events, head);
  if (chain.verified && !workOrderMatchesChain(workOrder, events)) {
    chain = { ...chain, verified: false, brokenAt: workOrder.approvalSeq ?? null, reason: 'work order record does not match its approval event' };
  }
  const stale = Boolean(workOrder && currentDescriptionHash && workOrder.descriptionHash !== currentDescriptionHash);
  const state = deriveState(events, workOrder, { stale });
  return { workOrder, draft, events, chain, stale, state };
}

// 重算並寫入矩陣摘要。issue 需要 issueId、issueKey、title、projectId。
// mirror（選用）：把摘要鏡射到 issue property 的寫入函式，見 core/mirror.js。
// 鏡射失敗只記 log，摘要照常寫入，呼叫端的主寫入也不受影響。
export async function refreshSummary(store, issue, { currentDescriptionHash, at, mirror }) {
  const loaded = await loadIssueState(store, issue.issueId, { currentDescriptionHash });
  if (loaded.state) {
    const key = summaryKey(issue.projectId, issue.issueId);
    const summary = buildSummary(issue, loaded.state, at);
    summary.chainVerified = loaded.chain.verified;
    if (mirror) {
      const previous = await store.get(key);
      const synced = await syncMirror({ issueId: issue.issueId, summary, previous, write: mirror });
      if (synced.fingerprint) summary.mirrorFingerprint = synced.fingerprint;
      loaded.mirror = synced.result;
    }
    await store.set(key, summary);
  }
  return loaded;
}
