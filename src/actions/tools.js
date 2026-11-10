// 規格第 6 節的六個工具（MCP 與 Rovo agent 共用）的商業邏輯。
// 這裡不 import 任何 @forge/*：儲存（store）與 Jira 存取（jira）都由外部注入，方便在本機測試。
//
// jira 介面：
//   getIssue(issueRef, caller)            -> { issueId, issueKey, title, projectId, projectKey, description } 或 null（不存在或沒有瀏覽權限）
//   getProject(projectKey, caller)        -> { projectId, projectKey, name } 或 null
//   filterVisibleIssueIds(ids, caller)    -> 呼叫者可瀏覽的 issueId 陣列

import { hashDescription } from '../core/canonical.js';
import { summaryPrefix } from '../core/keys.js';
import { ValidationError, parseCriteriaJson, requireIssueRef, requireProjectKey } from '../core/validate.js';
import {
  DomainError,
  getCurrentWorkOrder,
  getDraft,
  refreshSummary,
  saveDraft,
  submitEvidence as coreSubmitEvidence,
} from '../core/workorder.js';

const NEEDS_APPROVAL =
  'A person must draft and approve the work order in the Evidence Chain panel on the Jira issue. Agents cannot approve work orders.';

export function errorResult(error) {
  if (error instanceof ValidationError) return { ok: false, error: { code: 'INVALID_INPUT', message: error.message } };
  if (error instanceof DomainError) return { ok: false, error: { code: error.code, message: error.message } };
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Try again later.' } };
}

export function createTools({ store, jira, now = () => new Date().toISOString() }) {
  async function requireIssue(issueKey, caller) {
    const ref = requireIssueRef(issueKey);
    const issue = await jira.getIssue(ref, caller);
    if (!issue) throw new DomainError('ISSUE_NOT_FOUND', `Issue ${ref} was not found, or you do not have permission to view it.`);
    return issue;
  }

  async function requireProject(projectKey, caller) {
    const key = requireProjectKey(projectKey);
    const project = await jira.getProject(key, caller);
    if (!project) throw new DomainError('PROJECT_NOT_FOUND', `Project ${key} was not found, or you do not have permission to view it.`);
    return project;
  }

  // 專案內呼叫者看得到的議題摘要
  async function visibleSummaries(project, caller) {
    const rows = await store.listByPrefix(summaryPrefix(project.projectId));
    const summaries = rows.map((row) => row.value);
    if (summaries.length === 0) return [];
    const visible = new Set((await jira.filterVisibleIssueIds(summaries.map((s) => s.issueId), caller)).map(String));
    return summaries.filter((s) => visible.has(String(s.issueId))).sort((a, b) => a.issueKey.localeCompare(b.issueKey, 'en', { numeric: true }));
  }

  function refresh(issue) {
    return refreshSummary(store, issue, { currentDescriptionHash: hashDescription(issue.description), at: now() });
  }

  return {
    async getWorkOrder({ issueKey }, caller) {
      const issue = await requireIssue(issueKey, caller);
      const workOrder = await getCurrentWorkOrder(store, issue.issueId);
      if (!workOrder) {
        const draft = await getDraft(store, issue.issueId);
        return { ok: true, issueKey: issue.issueKey, status: 'not-approved', hasDraft: Boolean(draft), message: NEEDS_APPROVAL };
      }
      const { stale } = await refresh(issue);
      return {
        ok: true,
        issueKey: issue.issueKey,
        status: 'approved',
        workOrderRev: workOrder.rev,
        approvedAt: workOrder.approvedAt,
        stale,
        staleNote: stale
          ? 'The issue description changed after this revision was approved. Evidence is still accepted for this revision, but a person may draft a new revision.'
          : undefined,
        criteria: workOrder.criteria.map((c) => ({ criterionId: c.id, text: c.text, requiredEvidenceType: c.evidenceType })),
        nextStep: `Call submit-evidence once per criterion with workOrderRev=${workOrder.rev}.`,
      };
    },

    async listOpenWorkOrders({ projectKey }, caller) {
      const project = await requireProject(projectKey, caller);
      const open = (await visibleSummaries(project, caller)).filter((s) => s.gapCount > 0);
      return {
        ok: true,
        projectKey: project.projectKey,
        count: open.length,
        workOrders: open.map((s) => ({ issueKey: s.issueKey, title: s.title, workOrderRev: s.rev, gapCount: s.gapCount })),
      };
    },

    async getEvidenceStatus({ issueKey }, caller) {
      const issue = await requireIssue(issueKey, caller);
      const { state, chain } = await refresh(issue);
      if (!state) return { ok: true, issueKey: issue.issueKey, status: 'not-approved', message: NEEDS_APPROVAL };
      return {
        ok: true,
        issueKey: issue.issueKey,
        status: 'approved',
        workOrderRev: state.rev,
        stale: state.stale,
        chainVerified: chain.verified,
        gapCount: state.gapCount,
        criteria: state.criteria.map((c) => ({
          criterionId: c.id,
          status: c.status,
          gap: c.gap,
          latestVerdict: c.latestEvidence?.verdict ?? null,
          reviewNote: c.review?.note || undefined,
        })),
      };
    },

    async submitEvidence(input, caller) {
      const issue = await requireIssue(input.issueKey, caller);
      const at = now();
      const { event, truncated } = await coreSubmitEvidence(store, issue.issueId, input, { actor: caller.accountId, at });
      await refresh(issue);
      return {
        ok: true,
        issueKey: issue.issueKey,
        criterionId: event.payload.criterionId,
        seq: event.seq,
        hash: event.hash,
        truncated,
        note: truncated.length ? `These fields were truncated to the length limit: ${truncated.join(', ')}.` : undefined,
        nextStep: 'A person reviews this evidence in Jira. Do not resubmit unless the result changes.',
      };
    },

    async proposeWorkOrder({ issueKey, criteriaJson }, caller) {
      const issue = await requireIssue(issueKey, caller);
      const criteria = parseCriteriaJson(criteriaJson);
      const [current, existing] = await Promise.all([getCurrentWorkOrder(store, issue.issueId), getDraft(store, issue.issueId)]);
      await saveDraft(store, issue.issueId, { criteria, source: 'agent', at: now(), actor: caller.accountId });
      return {
        ok: true,
        issueKey: issue.issueKey,
        status: 'draft-saved',
        draftForRevision: (current?.rev ?? 0) + 1,
        replacedExistingDraft: Boolean(existing),
        currentRevisionUnchanged: current ? current.rev : null,
        message: `Draft saved with ${criteria.length} criteria and waiting for approval. ${NEEDS_APPROVAL}`,
      };
    },

    async listGaps({ projectKey }, caller) {
      const project = await requireProject(projectKey, caller);
      const summaries = await visibleSummaries(project, caller);
      const withGaps = summaries.filter((s) => s.gapCount > 0);
      return {
        ok: true,
        projectKey: project.projectKey,
        issuesWithWorkOrders: summaries.length,
        issuesWithGaps: withGaps.length,
        issues: withGaps.map((s) => ({
          issueKey: s.issueKey,
          title: s.title,
          workOrderRev: s.rev,
          stale: s.stale,
          gaps: [
            ...(s.stale ? [{ kind: 'stale', criterionId: null }] : []),
            ...s.criteria.filter((c) => c.gap).map((c) => ({ kind: c.gap, criterionId: c.id })),
          ],
        })),
      };
    },
  };
}
