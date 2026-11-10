// Forge action 函式入口：MCP 與 Rovo agent 呼叫的都是這裡。
// 只負責：取出呼叫者 accountId、呼叫 tools.js 的邏輯、記 log、把例外轉成給代理看的錯誤說明。
import { jiraClient } from '../jira/client.js';
import { kvsStore } from '../storage/kvs.js';
import { callerFrom } from './caller.js';
import { createTools, errorResult } from './tools.js';

const tools = createTools({ store: kvsStore, jira: jiraClient });

// 只取宣告過的輸入欄位，丟掉 context、contextToken 等平台附加的東西
function pick(payload, names) {
  const input = {};
  for (const name of names) input[name] = payload?.[name];
  return input;
}

function wrap(toolName, inputNames, run) {
  return async (payload, context) => {
    const input = pick(payload, inputNames);
    const target = String(input.issueKey ?? input.projectKey ?? '-').slice(0, 32);
    try {
      const result = await run(input, callerFrom(payload, context));
      // log 只記工具名稱、議題（或專案）代號、結果，絕不印 payload 或 context（內含短效 token）
      console.log(`[${toolName}] ${target} ok`);
      return result;
    } catch (error) {
      const result = errorResult(error);
      console.log(`[${toolName}] ${target} ${result.error.code}`);
      if (result.error.code === 'INTERNAL_ERROR') console.error(`[${toolName}] ${target} ${String(error?.message ?? error).slice(0, 200)}`);
      return result;
    }
  };
}

export const getWorkOrder = wrap('get-work-order', ['issueKey'], (input, caller) => tools.getWorkOrder(input, caller));

export const listOpenWorkOrders = wrap('list-open-work-orders', ['projectKey'], (input, caller) =>
  tools.listOpenWorkOrders(input, caller),
);

export const getEvidenceStatus = wrap('get-evidence-status', ['issueKey'], (input, caller) =>
  tools.getEvidenceStatus(input, caller),
);

export const submitEvidence = wrap(
  'submit-evidence',
  ['issueKey', 'criterionId', 'workOrderRev', 'verdict', 'evidenceType', 'summary', 'reference', 'outputExcerpt', 'agentName'],
  (input, caller) => tools.submitEvidence(input, caller),
);

export const proposeWorkOrder = wrap('propose-work-order', ['issueKey', 'criteriaJson'], (input, caller) =>
  tools.proposeWorkOrder(input, caller),
);

export const listGaps = wrap('list-gaps', ['projectKey'], (input, caller) => tools.listGaps(input, caller));
