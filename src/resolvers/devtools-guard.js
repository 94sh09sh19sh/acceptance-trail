import { getAppContext } from '@forge/api';
import { devToolsAllowed } from '../core/devtools.js';

// 開發者工具（模擬竄改）只有在以下兩個條件「同時」成立時才啟用：
//   1. Forge 執行環境回報目前是 development 環境。這個值來自平台而不是瀏覽器，
//      所以正式環境的安裝不可能通過。
//   2. 環境變數 EC_DEV_TOOLS 為 "1"。只有在 development 以
//      `forge variables set -e development EC_DEV_TOOLS 1` 設定；正式環境沒有這個變數。
export function devToolsEnabled() {
  try {
    return devToolsAllowed(getAppContext().environmentType, process.env.EC_DEV_TOOLS);
  } catch {
    return false;
  }
}
