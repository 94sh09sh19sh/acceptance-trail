// 議題面板與專案頁的後端邏輯。核准工作單與覆核證據只在這裡（人操作的介面）提供，不開放給代理。
// 人手動記錄證據（recordEvidence）也只在這裡，MCP 工具與 Rovo 動作沒有這個入口。
// 同樣不 import @forge/*，store 與 jira 由 index.js 注入。

import { extractCriteria } from '../core/adf.js';
import { AUDIT_FORMATS, toCsv, toMarkdown } from '../core/audit.js';
import { hashDescription } from '../core/canonical.js';
import { countTamperedEvents, resetIssueData, restoreTamperedEvents, tamperLatestEvent } from '../core/devtools.js';
import { summaryPrefix } from '../core/keys.js';
import { MIRROR_PROPERTY_KEY } from '../core/mirror.js';
import { EVIDENCE_SOURCE } from '../core/source.js';
import { GAP_KINDS } from '../core/state.js';
import { LIMITS } from '../core/validate.js';
import { requireFixVersions, resolveVersionFilter, withFixVersions } from '../core/version-lookup.js';
import { describeVersionFilter, filterByVersion, parseVersionFilter, totalsOf, versionFileTag } from '../core/versions.js';
import {
  DomainError,
  approveDraft,
  discardDraft,
  loadIssueState,
  refreshSummary,
  reviewEvidence,
  saveDraft,
  submitEvidence,
} from '../core/workorder.js';

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
      throw new DomainError('FORBIDDEN', 'You need permission to edit this issue to change its work order, record evidence or review evidence.');
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

    // 起草（Draft work order，或有現行版時的 Draft new revision）：
    //   - 沒有現行版：取議題描述抽出的條列。
    //   - 有現行版、描述沒改過：以現行版的條件（文字與證據類型）為底，人手改過的文字、手動加或刪的條件都照現行版。
    //   - 有現行版、描述改過（stale）：用描述重新抽出的文字；文字和現行版某條相同時，帶上那條的證據類型。
    //     描述抽不到東西時沿用現行版的條件。
    // 用描述抽出的條件時，草稿記下來源與條數（extraction）：找不到 Acceptance criteria 標題而退回全文清單時 from 是 all-lists，
    // 面板會提醒人刪掉不是條件的條目。抽到的條目超過一張工作單的上限時只留前面的，存檔照常成功，面板提示找到幾條、留了幾條。
    async draftFromDescription(identity) {
      const issue = await requireEditor(identity);
      const { workOrder } = await loadIssueState(store, issue.issueId);
      const current = workOrder ? workOrder.criteria.map(({ text, evidenceType }) => ({ text, evidenceType })) : [];
      const stale = Boolean(workOrder) && workOrder.descriptionHash !== hashDescription(issue.description);
      let criteria = current;
      let source = 'manual';
      let extraction;
      if (!workOrder || stale) {
        const { items, from } = extractCriteria(issue.description);
        if (items.length > 0) {
          const sameText = (text) => text.replace(/\s+/g, ' ').trim();
          const currentType = new Map();
          for (const c of current) if (!currentType.has(sameText(c.text))) currentType.set(sameText(c.text), c.evidenceType);
          criteria = items.slice(0, LIMITS.maxCriteria).map((text) => ({ text, evidenceType: currentType.get(sameText(text)) ?? 'test' }));
          source = 'parser';
          extraction = { from, found: items.length, kept: criteria.length };
        }
      }
      await saveDraft(store, issue.issueId, { criteria, source, at: now(), actor: identity.accountId, extraction });
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

    // 人在面板手動記錄一條驗收條件的證據（Record evidence）。和 MCP 的 submit-evidence 走同一個核心函式，
    // 版次、條件代號、判定、證據類型的檢查與截斷規則相同；來源固定為 panel，代理名稱由核心固定寫入，
    // 所以這裡只挑出表單欄位，前端送來的 agentName、source 一律不用。要該議題的編輯權限，和核准、覆核相同。
    async recordEvidence(identity, input = {}) {
      const issue = await requireEditor(identity);
      const fields = {
        criterionId: input.criterionId,
        workOrderRev: input.workOrderRev,
        verdict: input.verdict,
        evidenceType: input.evidenceType,
        summary: input.summary,
        reference: input.reference,
        outputExcerpt: input.outputExcerpt,
      };
      let result;
      try {
        result = await submitEvidence(store, issue.issueId, fields, { actor: identity.accountId, at: now(), source: EVIDENCE_SOURCE.PANEL });
      } catch (error) {
        // 核心的訊息是寫給代理看的（叫它重新呼叫 get-work-order），面板改成給人看的說法，錯誤代號不變
        if (error instanceof DomainError && error.code === 'REVISION_MISMATCH') {
          throw new DomainError('REVISION_MISMATCH', 'A newer work order revision was approved while this form was open. Nothing was stored. Select Refresh, then record the evidence again.');
        }
        throw error;
      }
      const { event, truncated } = result;
      return panelView(issue, identity, { recorded: { criterionId: event.payload.criterionId, seq: event.seq, truncated } });
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

    // 僅限開發用：清掉這個議題的全部 Acceptance Trail 資料與鏡射的 issue property，回到全新狀態。
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

    // 延伸功能 5：每列帶 fixVersions（名稱陣列，讀不到為 null），另帶專案的版本清單給篩選選單。
    // 篩選與統計由前端用同一組純函式（core/versions.js）算，所以這裡的 totals 是全部議題的統計。
    // 讀不到修正版本時矩陣照常回傳，fixVersionsAvailable 為 false，前端隱藏版本篩選並提示。
    async getMatrix(identity) {
      const { project, issues } = await visibleProjectSummaries(identity);
      let rows = issues.map((issue) => ({ ...issue, fixVersions: null }));
      let fixVersionsAvailable = true;
      let versions = [];
      if (issues.length > 0) {
        try {
          rows = await withFixVersions(jira, issues, identity);
        } catch (error) {
          fixVersionsAvailable = false;
          console.log(`[resolver:getMatrix] ${project.projectKey} fix versions unavailable ${String(error?.message ?? error).slice(0, 120)}`);
        }
        if (fixVersionsAvailable) {
          try {
            versions = await jira.getProjectVersions(project, identity);
          } catch {
            versions = [];
          }
        }
      }
      return {
        projectKey: project.projectKey,
        gapKinds: GAP_KINDS,
        totals: totalsOf(issues),
        fixVersionsAvailable,
        versions: mergeVersionOptions(versions, rows),
        issues: rows,
      };
    },

    // 擴充 2：專案頁面的稽核包。過期判斷使用已儲存的摘要（由議題更新 trigger 保持最新），
    // 並且當場重新驗證每個議題的雜湊鏈。
    // fixVersion（選填，{ kind, name }）：只匯出符合的議題，統計與標頭都只算這些議題，可當某版本的發版證據包。
    // 篩選時讀不到版本或版本不存在就整個失敗，不會匯出一份看似完整、其實沒篩的檔案。
    async exportAudit(identity, { format, fixVersion }) {
      if (!AUDIT_FORMATS.includes(format)) throw new DomainError('INVALID_FORMAT', `Format must be one of: ${AUDIT_FORMATS.join(', ')}.`);
      const requested = parseVersionFilter(fixVersion);
      const { project, issues: visible } = await visibleProjectSummaries(identity);
      const filter = await resolveVersionFilter(jira, project, requested, identity);
      // 沒有篩選時修正版本只用來在匯出內容標出每個議題的版本，讀不到就略過；篩選時一定要讀到
      let withVersions;
      if (filter.kind === 'all') {
        try {
          withVersions = await withFixVersions(jira, visible, identity);
        } catch {
          withVersions = visible.map((issue) => ({ ...issue, fixVersions: null }));
        }
      } else {
        withVersions = await requireFixVersions(jira, visible, identity);
      }
      const issues = filterByVersion(withVersions, filter);
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
          fixVersions: summary.fixVersions,
          chain: { ...chain, lastHash: events.at(-1)?.hash ?? null },
          criteria: state.criteria,
          previousRevisions: state.previousRevisions,
        });
      }
      const pack = {
        projectKey: project.projectKey,
        generatedAt: now(),
        generatedBy: identity.accountId,
        filter,
        totals: totalsOf(issues),
        issues: packIssues,
      };
      const date = pack.generatedAt.slice(0, 10);
      const tag = versionFileTag(filter);
      const base = `${project.projectKey}-evidence-audit${tag ? `-${tag}` : ''}-${date}`;
      const filterText = filter.kind === 'all' ? null : describeVersionFilter(filter);
      return format === 'csv'
        ? { format, fileName: `${base}.csv`, content: toCsv(pack), issueCount: packIssues.length, filter: filterText }
        : { format, fileName: `${base}.md`, content: toMarkdown(pack), issueCount: packIssues.length, filter: filterText };
    },
  };
}

// 篩選選單的版本清單：專案的全部版本，再補上議題上有、但專案清單沒有的名稱（防萬一）
function mergeVersionOptions(projectVersions, rows) {
  const seen = new Set();
  const options = [];
  for (const v of projectVersions) {
    const key = v.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ name: v.name, released: Boolean(v.released), archived: Boolean(v.archived) });
  }
  for (const row of rows) {
    for (const name of row.fixVersions ?? []) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ name, released: false, archived: false });
    }
  }
  return options;
}
