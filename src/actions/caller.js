// 呼叫者 accountId：外部 MCP 實測在第二個參數的 context.principal.accountId；
// Rovo Chat 呼叫時的形狀未完全確認，所以再看幾個可能位置，都沒有就記 unknown。
export function callerFrom(payload, context) {
  const accountId =
    context?.principal?.accountId ??
    context?.accountId ??
    payload?.context?.principal?.accountId ??
    payload?.context?.accountId ??
    'unknown';
  return { accountId: String(accountId) };
}
