// 規格第 6 節的六個工具（MCP 與 Rovo agent 共用）的商業邏輯。
// 這裡不 import 任何 @forge/*：儲存（store）與 Jira 存取（jira）都由外部注入，方便在本機測試。
//
// jira 介面：
//   getIssue(issueRef, caller)            -> { issueId, issueKey, title, projectId, projectKey, description } 或 null（不存在或沒有瀏覽權限）
//   getProject(projectKey, caller)        -> { projectId, projectKey, name } 或 null
//   filterVisibleIssueIds(ids, caller)    -> 呼叫者可瀏覽的 issueId 陣列
//   canEditIssue(issueId, caller)         -> 呼叫者能否編輯該議題（寫入類工具用）
//   setIssueProperty(issueId, key, value) -> 以呼叫者身分寫 issue property（摘要鏡射，失敗會拋出）
//   getProjectVersions(project, caller)   -> [{ id, name, released, archived }]（list-gaps 的 fixVersion 檢查用，失敗會拋出）
//   getFixVersions(issueIds, caller)      -> Map(issueId -> 版本名稱陣列)（失敗會拋出）

import { hashDescription } from '../core/canonical.js';
import { summaryPrefix } from '../core/keys.js';
import { MIRROR_PROPERTY_KEY } from '../core/mirror.js';
import { countLabel } from '../core/text.js';
import { requireFixVersions, resolveVersionFilter } from '../core/version-lookup.js';
import { ALL_VERSIONS, filterByVersion, optionalVersionName, versionFilter } from '../core/versions.js';
import { ValidationError, parseCriteriaJson, requireIssueRef, requireProjectKey } from '../core/validate.js';
import {
  DomainError,
  getCurrentWorkOrder,
  getDraft,
  refreshSummary,
  saveDraft,
  submitEvidence as coreSubmitEvidence,
} from '../core/workorder.js';

const NEEDS_EDIT = (issueKey, what) =>
  `You can view ${issueKey} but do not have permission to edit it, so you cannot ${what}. Nothing was stored. Ask a person who can edit the issue, or use the read-only tools.`;

const NEEDS_APPROVAL =
  'A person must draft and approve the work order in the Acceptance Trail panel on the Jira issue. Agents cannot approve work orders.';

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

  // 寫入類工具（submit-evidence、propose-work-order）和議題面板的其他寫入一樣，要有該議題的編輯權限
  async function requireEditableIssue(issueKey, caller, what) {
    const issue = await requireIssue(issueKey, caller);
    if (!(await jira.canEditIssue(issue.issueId, caller))) throw new DomainError('FORBIDDEN', NEEDS_EDIT(issue.issueKey, what));
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

  // 重算摘要，並以呼叫者身分鏡射到 issue property（失敗只記 log，見 core/mirror.js）
  function refresh(issue) {
    return refreshSummary(store, issue, {
      currentDescriptionHash: hashDescription(issue.description),
      at: now(),
      mirror: (value) => jira.setIssueProperty(issue.issueId, MIRROR_PROPERTY_KEY, value),
    });
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
          // 這一版次送過幾筆（含被取代的）；只有最新一筆計入狀態
          evidenceCount: c.evidenceCount,
          reviewNote: c.review?.note || undefined,
        })),
        previousRevisions: state.previousRevisions.length ? state.previousRevisions : undefined,
        previousRevisionsNote: state.previousRevisions.length
          ? `Evidence for earlier revisions stays in the chain but does not count toward revision ${state.rev}. Submit evidence again with workOrderRev=${state.rev}.`
          : undefined,
      };
    },

    async submitEvidence(input, caller) {
      const issue = await requireEditableIssue(input.issueKey, caller, 'submit evidence');
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
      const issue = await requireEditableIssue(issueKey, caller, 'propose a work order');
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
        message: `Draft saved with ${countLabel(criteria.length, 'criterion', 'criteria')} and waiting for approval. ${NEEDS_APPROVAL}`,
      };
    },

    // fixVersion（選填）：只看含該修正版本的議題。版本名稱不存在時回 VERSION_NOT_FOUND 並列出可用版本，
    // 不回空清單；讀不到版本時回 VERSIONS_UNAVAILABLE，不退回成不篩選。沒給 fixVersion 時行為與回傳都和以前相同。
    async listGaps({ projectKey, fixVersion }, caller) {
      const wanted = optionalVersionName(fixVersion);
      const project = await requireProject(projectKey, caller);
      const filter = wanted ? await resolveVersionFilter(jira, project, versionFilter(wanted), caller) : ALL_VERSIONS;
      let summaries = await visibleSummaries(project, caller);
      if (wanted) summaries = filterByVersion(await requireFixVersions(jira, summaries, caller), filter);
      const withGaps = summaries.filter((s) => s.gapCount > 0);
      return {
        ok: true,
        projectKey: project.projectKey,
        fixVersion: wanted ? filter.name : undefined,
        issuesWithWorkOrders: summaries.length,
        issuesWithGaps: withGaps.length,
        issues: withGaps.map((s) => ({
          issueKey: s.issueKey,
          title: s.title,
          workOrderRev: s.rev,
          stale: s.stale,
          fixVersions: wanted ? s.fixVersions : undefined,
          gaps: [
            ...(s.stale ? [{ kind: 'stale', criterionId: null }] : []),
            ...s.criteria.filter((c) => c.gap).map((c) => ({ kind: c.gap, criterionId: c.id })),
          ],
        })),
      };
    },
  };
}
