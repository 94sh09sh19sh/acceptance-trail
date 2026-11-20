import Resolver from '@forge/resolver';
import { jiraClient } from '../jira/client.js';
import { kvsStore } from '../storage/kvs.js';
import { errorResult } from '../actions/tools.js';
import { devToolsEnabled } from './devtools-guard.js';
import { contextIdentity, createResolverLogic } from './logic.js';

// 議題面板（evidence-panel）與專案頁（trace-matrix）共用的 resolver
const logic = createResolverLogic({ store: kvsStore, jira: jiraClient, devToolsEnabled });
const resolver = new Resolver();

// 統一回傳 { ok: true, data } 或 { ok: false, error }，前端據此顯示錯誤畫面
function define(name, run) {
  resolver.define(name, async ({ payload, context }) => {
    const identity = contextIdentity(context);
    const target = identity.issueId ?? identity.projectKey ?? '-';
    try {
      const data = await run(identity, payload ?? {});
      // log 只記函式名稱、議題 ID 或專案代號、結果
      console.log(`[resolver:${name}] ${target} ok`);
      return { ok: true, data };
    } catch (error) {
      const result = errorResult(error);
      console.log(`[resolver:${name}] ${target} ${result.error.code}`);
      if (result.error.code === 'INTERNAL_ERROR') console.error(`[resolver:${name}] ${String(error?.message ?? error).slice(0, 200)}`);
      return result;
    }
  });
}

define('getPanel', (identity) => logic.getPanel(identity));
define('draftFromDescription', (identity) => logic.draftFromDescription(identity));
define('saveDraft', (identity, payload) => logic.saveDraft(identity, { criteria: payload.criteria }));
define('discardDraft', (identity) => logic.discardDraft(identity));
define('approve', (identity, payload) => logic.approve(identity, { criteria: payload.criteria }));
// 手動記錄證據：只轉交表單欄位，來源與代理名稱由後端決定（見 logic.js 的 recordEvidence）
define('recordEvidence', (identity, payload) =>
  logic.recordEvidence(identity, {
    criterionId: payload.criterionId,
    workOrderRev: payload.workOrderRev,
    verdict: payload.verdict,
    evidenceType: payload.evidenceType,
    summary: payload.summary,
    reference: payload.reference,
    outputExcerpt: payload.outputExcerpt,
  }),
);
define('review', (identity, payload) =>
  logic.review(identity, { evidenceSeq: payload.evidenceSeq, decision: payload.decision, note: payload.note }),
);
define('getMatrix', (identity) => logic.getMatrix(identity));
define('exportAudit', (identity, payload) => logic.exportAudit(identity, { format: payload.format, fixVersion: payload.fixVersion }));
// 僅限開發用的竄改工具：devToolsEnabled() 沒通過就拒絕（見 devtools-guard.js）
define('devTamper', (identity) => logic.devTamper(identity));
define('devRestore', (identity) => logic.devRestore(identity));
define('devReset', (identity) => logic.devReset(identity));

export const handler = resolver.getDefinitions();
