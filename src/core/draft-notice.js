// 從議題描述起草後，草稿上方給人看的提示（議題面板的草稿編輯器用）。
// 依據是後端存在草稿裡的 extraction（見 resolvers/logic.js 的 draftFromDescription）；沒有就不提示。
// 不 import 任何 @forge/*，前端與測試都可以用。

import { CRITERIA_FROM } from './adf.js';

export const FALLBACK_NOTICE =
  'The description has no "Acceptance criteria" heading with items under it, so these items come from every list in the description. Remove the ones that are not criteria before you approve.';

// 描述裡的條目超過一張工作單的上限，起草時只留了前面的
export const overLimitNotice = (found, kept) => `Found ${found} items in the description and kept the first ${kept}. Merge or remove items before you approve.`;

export function draftNotices(draft) {
  const extraction = draft?.extraction;
  if (!extraction) return [];
  const notices = [];
  if (extraction.from === CRITERIA_FROM.ALL_LISTS) notices.push(FALLBACK_NOTICE);
  if (Number.isInteger(extraction.found) && Number.isInteger(extraction.kept) && extraction.found > extraction.kept) {
    notices.push(overLimitNotice(extraction.found, extraction.kept));
  }
  return notices;
}
