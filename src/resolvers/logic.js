// 議題面板與專案頁的後端邏輯。核准工作單與覆核證據只在這裡（人操作的介面）提供，不開放給代理。
// 同樣不 import @forge/*，store 與 jira 由 index.js 注入。

import { extractCriteriaFromAdf } from '../core/adf.js';
import { AUDIT_FORMATS, toCsv, toMarkdown } from '../core/audit.js';
import { hashDescription } from '../core/canonical.js';
import { countTamperedEvents, resetIssueData, restoreTamperedEvents, tamperLatestEvent } from '../core/devtools.js';
import { summaryPrefix } from '../core/keys.js';
import { MIRROR_PROPERTY_KEY } from '../core/mirror.js';
import { GAP_KINDS } from '../core/state.js';
import {
  DomainError,
  approveDraft,
  discardDraft,
  loadIssueState,
  refreshSummary,
  reviewEvidence,
  saveDraft,
} from '../core/workorder.js';

const totalsOf = (issues) => ({
  issues: issues.length,
  criteria: issues.reduce((n, s) => n + s.total, 0),
  accepted: issues.reduce((n, s) => n + s.accepted, 0),
  gaps: issues.reduce((n, s) => n + s.gapCount, 0),
});

// 介面送來的請求一律以 resolver context 決定是哪個議題與哪位使用者，不信任前端傳來的代號
export function contextIdentity(context) {
  const ext = context?.extension ?? {};
  return {
    accountId: context?.accountId ? String(context.accountId) : 'unknown',
    issueId: ext.issue?.id ?? ext.issueId ?? null,
    projectId: ext.project?.id ?? ext.projectId ?? null,
    projectKey: ext.project?.key ?? ext.projectKey ?? null,
  };
}

// devToolsEnabled：由外部注入的開發用竄改工具檢查（見 devtools-guard.js）。
// 沒有傳入檢查函式時，測試與正式環境預設都是關閉。
export function createResolverLogic({ store, jira, now = () => new Date().toISOString(), devToolsEnabled = () => false }) {
  function requireDevTools() {
    if (!devToolsEnabled()) {
      throw new DomainError('NOT_AVAILABLE', 'Developer tools are only available in the development environment.');
    }
  }

  async function requireIssue(identity) {
    if (!identity.issueId) throw new DomainError('NO_ISSUE', 'This view is not attached to an issue.');
    const issue = await jira.getIssue(String(identity.issueId), identity);
    if (!issue) throw new DomainError('ISSUE_NOT_FOUND', 'The issue was not found, or you do not have permission to view it.');
    return issue;
  }

  async function requireEditor(identity) {
    const issue = await requireIssue(identity);
    if (!(await jira.canEditIssue(issue.issueId, identity))) {
      throw new DomainError('FORBIDDEN', 'You need permission to edit this issue to change its work order or review evidence.');
    }
    return issue;
  }

  // 目前使用者看得到的專案矩陣列，依自然鍵順序排列（BMS-2 在 BMS-10 之前）
  async function visibleProjectSummaries(identity) {
    if (!identity.projectKey) throw new DomainError('NO_PROJECT', 'This view is not attached to a project.');
    const project = await jira.getProject(String(identity.projectKey), identity);
    if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'The project was not found, or you do not have permission to view it.');
    const rows = (await store.listByPrefix(summaryPrefix(project.projectId))).map((r) => r.value);
    const visible = rows.length
      ? new Set((await jira.filterVisibleIssueIds(rows.map((s) => s.issueId), identity)).map(String))
      : new Set();
    const issues = rows
      .filter((s) => visible.has(String(s.issueId)))
      .sort((a, b) => a.issueKey.localeCompare(b.issueKey, 'en', { numeric: true }));
    return { project, issues };
  }

  async function panelView(issue, identity, extra = {}) {
    const currentDescriptionHash = hashDescription(issue.description);
    // 重算摘要時以目前使用者身分鏡射到 issue property；沒有編輯權限的檢視者寫不進去，只記 log
    const loaded = await refreshSummary(store, issue, {
      currentDescriptionHash,
      at: now(),
      mirror: (value) => jira.setIssueProperty(issue.issueId, MIRROR_PROPERTY_KEY, value),
    });
    const canEdit = await jira.canEditIssue(issue.issueId, identity);
    const { workOrder, draft, chain, stale, state } = loaded;
    const devTools = canEdit && devToolsEnabled();
    return {
      issueKey: issue.issueKey,
      canEdit,
      draft,
      workOrder: workOrder
        ? { rev: workOrder.rev, approvedBy: workOrder.approvedBy, approvedAt: workOrder.approvedAt }
        : null,
      stale,
      chain,
      state,
      devTools: devTools ? { tampered: await countTamperedEvents(store, issue.issueId) } : null,
      ...extra,
    };
  }

  return {
    async getPanel(identity) {
      const issue = await requireIssue(identity);
      return panelView(issue, identity);
    },

    // 從議題描述抽出條列當草稿；現行版存在時，以現行版的條件為底（起草下一版）
    async draftFromDescription(identity) {
      const issue = await requireEditor(identity);
      const { workOrder } = await loadIssueState(store, issue.issueId);
      const parsed = extractCriteriaFromAdf(issue.description).map((text) => ({ text, evidenceType: 'test' }));
      const criteria = parsed.length > 0 ? parsed : workOrder ? workOrder.criteria.map(({ text, evidenceType }) => ({ text, evidenceType })) : [];
      await saveDraft(store, issue.issueId, {
        criteria,
        source: parsed.length > 0 ? 'parser' : 'manual',
        at: now(),
        actor: identity.accountId,
      });
      return panelView(issue, identity);
    },

    async saveDraft(identity, { criteria }) {
      const issue = await requireEditor(identity);
      await saveDraft(store, issue.issueId, { criteria, source: 'manual', at: now(), actor: identity.accountId });
      return panelView(issue, identity);
    },

    async discardDraft(identity) {
      const issue = await requireEditor(identity);
      await discardDraft(store, issue.issueId);
      return panelView(issue, identity);
    },

    // 核准前先存下畫面上的最新編輯，再以當下的議題描述雜湊核准
    async approve(identity, { criteria }) {
      const issue = await requireEditor(identity);
      const at = now();
      if (Array.isArray(criteria)) {
        await saveDraft(store, issue.issueId, { criteria, source: 'manual', at, actor: identity.accountId });
      }
      await approveDraft(store, issue.issueId, {
        actor: identity.accountId,
        at,
        descriptionHash: hashDescription(issue.description),
      });
      return panelView(issue, identity);
    },

    async review(identity, { evidenceSeq, decision, note }) {
      const issue = await requireEditor(identity);
      await reviewEvidence(store, issue.issueId, { evidenceSeq, decision, note }, { actor: identity.accountId, at: now() });
      return panelView(issue, identity);
    },

    // 僅限開發用：改動最新的已儲存事件但不修正雜湊，用來示範「Chain broken」
    async devTamper(identity) {
      requireDevTools();
      const issue = await requireEditor(identity);
      if (!(await tamperLatestEvent(store, issue.issueId))) {
        throw new DomainError('NO_EVENTS', 'There are no events to edit on this issue.');
      }
      return panelView(issue, identity);
    },

    // 僅限開發用：還原 devTamper 的改動
    async devRestore(identity) {
      requireDevTools();
      const issue = await requireEditor(identity);
      await restoreTamperedEvents(store, issue.issueId);
      return panelView(issue, identity);
    },

    // 僅限開發用：清掉這個議題的全部 Evidence Chain 資料與鏡射的 issue property，回到全新狀態。
    // 檢查順序同其他開發工具：先看開發環境，再看編輯權限，兩者沒過就什麼都不動。
    async devReset(identity) {
      requireDevTools();
      const issue = await requireEditor(identity);
      const removed = await resetIssueData(store, issue.issueId, issue.projectId);
      let propertyRemoved = true;
      try {
        await jira.deleteIssueProperty(issue.issueId, MIRROR_PROPERTY_KEY);
      } catch (error) {
        propertyRemoved = false;
        console.log(`[dev-reset] ${issue.issueId} property not removed ${String(error?.message ?? error).slice(0, 120)}`);
      }
      return panelView(issue, identity, { reset: { removed, propertyRemoved } });
    },

    async getMatrix(identity) {
      const { project, issues } = await visibleProjectSummaries(identity);
      return {
        projectKey: project.projectKey,
        gapKinds: GAP_KINDS,
        totals: totalsOf(issues),
        issues,
      };
    },

    // 擴充 2：專案頁面的稽核包。過期判斷使用已儲存的摘要（由議題更新 trigger 保持最新），
    // 並且當場重新驗證每個議題的雜湊鏈。
    async exportAudit(identity, { format }) {
      if (!AUDIT_FORMATS.includes(format)) throw new DomainError('INVALID_FORMAT', `Format must be one of: ${AUDIT_FORMATS.join(', ')}.`);
      const { project, issues } = await visibleProjectSummaries(identity);
      const packIssues = [];
      for (const summary of issues) {
        const { workOrder, chain, events, state } = await loadIssueState(store, summary.issueId);
        if (!workOrder || !state) continue;
        packIssues.push({
          issueKey: summary.issueKey,
          title: summary.title,
          rev: workOrder.rev,
          approvedBy: workOrder.approvedBy,
          approvedAt: workOrder.approvedAt,
          stale: Boolean(summary.stale),
          chain: { ...chain, lastHash: events.at(-1)?.hash ?? null },
          criteria: state.criteria,
          previousRevisions: state.previousRevisions,
        });
      }
      const pack = {
        projectKey: project.projectKey,
        generatedAt: now(),
        generatedBy: identity.accountId,
        totals: totalsOf(issues),
        issues: packIssues,
      };
      const date = pack.generatedAt.slice(0, 10);
      return format === 'csv'
        ? { format, fileName: `${project.projectKey}-evidence-audit-${date}.csv`, content: toCsv(pack), issueCount: packIssues.length }
        : { format, fileName: `${project.projectKey}-evidence-audit-${date}.md`, content: toMarkdown(pack), issueCount: packIssues.length };
    },
  };
}
