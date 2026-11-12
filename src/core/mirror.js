import { canonicalJson } from './canonical.js';

// 延伸功能 4（規格第 10 節）：把矩陣摘要鏡射到議題的 issue property，
// manifest 的 jira:entityProperty 模組把這些欄位編入索引，JQL 就能找出有缺口的議題。
// 鏈才是事實來源；property 只是方便搜尋的副本，寫入失敗不影響任何主寫入。
// 內容不含個人資料：沒有 accountId、沒有條件文字、沒有代理送來的文字。

export const MIRROR_PROPERTY_KEY = 'evidence-chain-summary';

// 索引型別沒有布林值，所以 stale 存成字串 "true"／"false"（manifest 用 string 型別）
export function mirrorValue(summary) {
  return {
    schema: 1,
    rev: summary.rev,
    total: summary.total,
    accepted: summary.accepted,
    gapCount: summary.gapCount,
    gapKinds: [...summary.gapKinds].sort(),
    stale: summary.stale ? 'true' : 'false',
    updatedAt: summary.updatedAt,
  };
}

// 比對內容是否改變時不看更新時間，避免每次開面板都寫一次 Jira
export function mirrorFingerprint(value) {
  const { updatedAt, ...rest } = value;
  return canonicalJson(rest);
}

// 依上一次成功鏡射的指紋決定要不要寫。回傳要存回摘要的指紋與結果：
//   unchanged：內容沒變，不寫；written：寫入成功；failed：寫入失敗（保留舊指紋，下次重算時再試）
export async function syncMirror({ issueId, summary, previous, write }) {
  const value = mirrorValue(summary);
  const fingerprint = mirrorFingerprint(value);
  if (previous?.mirrorFingerprint === fingerprint) return { result: 'unchanged', fingerprint };
  try {
    await write(value);
    // 只在真的寫入時記一行（內容沒變時不寫也不記），方便從 forge logs 確認鏡射有在運作
    console.log(`[mirror] ${issueId} written`);
    return { result: 'written', fingerprint };
  } catch (error) {
    // 只記議題 ID 與錯誤訊息的前段，不印 property 內容以外的東西
    console.log(`[mirror] ${issueId} failed ${String(error?.message ?? error).slice(0, 120)}`);
    return { result: 'failed', fingerprint: previous?.mirrorFingerprint ?? null };
  }
}
