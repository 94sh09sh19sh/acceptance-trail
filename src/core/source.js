// 證據的來源：代理經 MCP 的 submit-evidence 回報，或由人在議題面板用 Record evidence 手動記錄。
// 來源寫在事件的 payload 裡，會算進雜湊，事後改動會讓鏈驗證失敗。
// 加這個欄位之前寫入的事件沒有 source，一律視為經 MCP 送來（當時證據只有這一個入口）。
// 舊事件本身不改寫，所以它們的雜湊照舊相符。

export const EVIDENCE_SOURCE = Object.freeze({ MCP: 'mcp', PANEL: 'panel' });
export const EVIDENCE_SOURCES = Object.freeze(Object.values(EVIDENCE_SOURCE));

// 手動記錄時的代理名稱由後端固定寫入，不收使用者輸入
export const MANUAL_AGENT_NAME = 'Manual entry (Jira panel)';

// 事件 payload 的來源；沒有 source 欄位（舊事件）或不是 panel 都算 MCP
export function evidenceSource(payload) {
  return payload?.source === EVIDENCE_SOURCE.PANEL ? EVIDENCE_SOURCE.PANEL : EVIDENCE_SOURCE.MCP;
}

export const isManualEntry = (evidence) => evidence?.source === EVIDENCE_SOURCE.PANEL;

// 介面與稽核包用的一行來源說明。只看 source 欄位、不看代理名稱：
// 代理經 MCP 把自己取名為「Manual entry (Jira panel)」時，仍會標成 MCP，分得出來。
export function sourceLabel(evidence) {
  return isManualEntry(evidence) ? MANUAL_AGENT_NAME : `MCP: ${evidence?.agentName || 'unnamed agent'}`;
}
