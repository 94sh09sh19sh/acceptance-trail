// 介面與匯出共用的計數文字：依數量切換單複數，避免出現「1 events」。
// 不 import 任何 @forge/*，前端與後端都可以用。

export function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

// 數字加名詞，例如 countLabel(1, 'event') -> '1 event'、countLabel(3, 'criterion', 'criteria') -> '3 criteria'
export function countLabel(count, singular, pluralForm) {
  return `${count} ${plural(count, singular, pluralForm)}`;
}

// 雜湊只顯示前 12 碼
export const shortHash = (hash) => (hash ? String(hash).slice(0, 12) : '');
