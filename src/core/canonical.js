import { createHash } from 'node:crypto';

// 正規化 JSON：物件的鍵依字母排序、陣列保持原順序，
// 讓同一份資料不管欄位寫入順序為何，都產生同一個字串（雜湊才會穩定）。
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 議題描述（ADF 或 null）的雜湊，用來判斷工作單核准後描述是否被改過
export function hashDescription(description) {
  return sha256Hex(canonicalJson(description ?? null));
}
