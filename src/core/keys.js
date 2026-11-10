// 儲存鍵的格式（規格第 8 節）。議題一律用 issueId（數字），不用議題代號。
//
// core 不直接碰 Forge KVS，而是使用注入的 store，介面如下：
//   get(key)                -> 值，不存在時為 undefined
//   set(key, value)         -> 覆寫
//   setIfAbsent(key, value) -> 鍵不存在才寫入，寫入成功回傳 true，已存在回傳 false
//   delete(key)
//   listByPrefix(prefix)    -> [{ key, value }]，已處理分頁

export const ZERO_HASH = '0'.repeat(64);

export const draftKey = (issueId) => `wo:${issueId}:draft`;
export const revKey = (issueId, rev) => `wo:${issueId}:rev:${rev}`;
export const headKey = (issueId) => `head:${issueId}`;
export const eventKey = (issueId, seq) => `ev:${issueId}:${String(seq).padStart(6, '0')}`;
export const eventPrefix = (issueId) => `ev:${issueId}:`;
export const summaryKey = (projectId, issueId) => `sum:${projectId}:${issueId}`;
export const summaryPrefix = (projectId) => `sum:${projectId}:`;
