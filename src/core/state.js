import { EVENT_TYPES } from './chain.js';

// 驗收條件的狀態（規格第 8 節）
export const STATUS = Object.freeze({
  NO_EVIDENCE: 'no-evidence',
  SUBMITTED: 'submitted',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
});

// 缺口種類（規格第 3 節）
export const GAP = Object.freeze({
  NO_EVIDENCE: 'no-evidence',
  FAILED: 'failed',
  UNREVIEWED: 'unreviewed',
  REJECTED: 'rejected',
  STALE: 'stale',
});

export const GAP_KINDS = Object.freeze(Object.values(GAP));

// 由事件推導每條驗收條件的狀態。只看現行版次的證據；同一條有多筆證據時看最新一筆，
// 覆核也只看針對那一筆最新證據的最新一次覆核。
export function deriveState(events, workOrder, { stale = false } = {}) {
  if (!workOrder) return null;
  const latestEvidence = new Map();
  const evidenceCount = new Map();
  const reviewsBySeq = new Map();

  for (const event of events) {
    if (event.type === EVENT_TYPES.SUBMITTED && event.payload?.rev === workOrder.rev) {
      const id = event.payload.criterionId;
      latestEvidence.set(id, event);
      evidenceCount.set(id, (evidenceCount.get(id) ?? 0) + 1);
    } else if (event.type === EVENT_TYPES.REVIEWED) {
      reviewsBySeq.set(event.payload?.evidenceSeq, event);
    }
  }

  const criteria = workOrder.criteria.map((criterion) => {
    const evidence = latestEvidence.get(criterion.id) ?? null;
    const review = evidence ? reviewsBySeq.get(evidence.seq) ?? null : null;
    let status = STATUS.NO_EVIDENCE;
    if (evidence) {
      if (!review) status = STATUS.SUBMITTED;
      else status = review.payload.decision === 'accept' ? STATUS.ACCEPTED : STATUS.REJECTED;
    }
    let gap = null;
    if (!evidence) gap = GAP.NO_EVIDENCE;
    else if (evidence.payload.verdict !== 'pass') gap = GAP.FAILED;
    else if (status === STATUS.REJECTED) gap = GAP.REJECTED;
    else if (status === STATUS.SUBMITTED) gap = GAP.UNREVIEWED;
    return {
      id: criterion.id,
      text: criterion.text,
      evidenceType: criterion.evidenceType,
      status,
      gap,
      evidenceCount: evidenceCount.get(criterion.id) ?? 0,
      latestEvidence: evidence ? evidenceView(evidence) : null,
      review: review ? reviewView(review) : null,
    };
  });

  const criterionGaps = criteria.filter((c) => c.gap).length;
  const gapKinds = [...new Set([...criteria.map((c) => c.gap).filter(Boolean), ...(stale ? [GAP.STALE] : [])])];
  return {
    rev: workOrder.rev,
    stale,
    total: criteria.length,
    accepted: criteria.filter((c) => c.status === STATUS.ACCEPTED && !c.gap).length,
    gapCount: criterionGaps + (stale ? 1 : 0),
    gapKinds,
    criteria,
    previousRevisions: workOrder.isPrevious ? [] : previousRevisions(events, workOrder.rev),
  };
}

// 證據綁定在送出時的版次。核准新版次後，舊的證據與覆核仍留在鏈上（只能附加），
// 但不會計入新版次：每條驗收條件都重新從沒有證據開始，即使條件文字沒有變。
// 這裡彙整每個舊版次當時的內容，由該版次的核准事件重建。
function previousRevisions(events, currentRev) {
  return events
    .filter((e) => e.type === EVENT_TYPES.APPROVED && e.payload?.rev < currentRev && Array.isArray(e.payload?.criteria))
    .map((approval) => {
      const old = deriveState(events, { rev: approval.payload.rev, criteria: approval.payload.criteria, isPrevious: true });
      return {
        rev: old.rev,
        total: old.total,
        accepted: old.accepted,
        evidenceCount: old.criteria.reduce((n, c) => n + c.evidenceCount, 0),
      };
    })
    .sort((a, b) => a.rev - b.rev);
}

function evidenceView(event) {
  const p = event.payload;
  return {
    seq: event.seq,
    verdict: p.verdict,
    evidenceType: p.evidenceType,
    summary: p.summary,
    reference: p.reference,
    outputExcerpt: p.outputExcerpt,
    agentName: p.agentName,
    truncated: p.truncated ?? [],
    submittedBy: event.actor,
    at: event.at,
    hash: event.hash,
  };
}

function reviewView(event) {
  return {
    seq: event.seq,
    decision: event.payload.decision,
    note: event.payload.note,
    reviewedBy: event.actor,
    at: event.at,
  };
}

// 給矩陣頁與 list-* 工具用的摘要（存在 sum:{projectId}:{issueId}）
export function buildSummary({ issueId, issueKey, title }, state, at) {
  return {
    issueId: String(issueId),
    issueKey,
    title,
    rev: state.rev,
    total: state.total,
    accepted: state.accepted,
    gapCount: state.gapCount,
    gapKinds: state.gapKinds,
    stale: state.stale,
    criteria: state.criteria.map((c) => ({ id: c.id, status: c.status, gap: c.gap })),
    updatedAt: at,
  };
}
