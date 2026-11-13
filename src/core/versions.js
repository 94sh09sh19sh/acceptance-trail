// 延伸功能 5（規格第 10 節）：依修正版本（fixVersion）篩選矩陣、稽核包與 list-gaps。
// 修正版本是 Jira 的議題欄位，不存進 KVS：每次查詢時才向 Jira 讀（讀取失敗不會留下過期資料，
// 版本被改掉也馬上反映）。這個檔案只有純函式（前端的矩陣頁也會 import），向 Jira 讀版本的部分在 version-lookup.js。

import { ValidationError, cleanString } from './validate.js';

// 矩陣上方的統計；矩陣頁（前端）與稽核包（後端）共用，確保兩邊的計算方式一致
export const totalsOf = (issues) => ({
  issues: issues.length,
  criteria: issues.reduce((n, s) => n + s.total, 0),
  accepted: issues.reduce((n, s) => n + s.accepted, 0),
  gaps: issues.reduce((n, s) => n + s.gapCount, 0),
});

// ---- 篩選條件 ----
// { kind: 'all' }：不篩選；{ kind: 'none' }：沒有修正版本的議題；{ kind: 'version', name }：含該版本的議題

export const ALL_VERSIONS = Object.freeze({ kind: 'all' });
export const NO_VERSION = Object.freeze({ kind: 'none' });
export const versionFilter = (name) => ({ kind: 'version', name });

export const MAX_VERSION_NAME = 255;

// 版本名稱比對不分大小寫、忽略頭尾空白（Jira 的版本名稱在同一專案內不分大小寫）
const norm = (name) => cleanString(name).toLowerCase();

// 前端經 resolver 送來的篩選條件：一律當成不可信任的輸入驗證
export function parseVersionFilter(raw) {
  if (raw === undefined || raw === null) return ALL_VERSIONS;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('fixVersion filter is not valid.');
  if (raw.kind === 'all') return ALL_VERSIONS;
  if (raw.kind === 'none') return NO_VERSION;
  if (raw.kind === 'version') {
    const name = cleanString(raw.name);
    if (!name || name.length > MAX_VERSION_NAME) throw new ValidationError('fixVersion filter needs a version name of 1 to 255 characters.');
    return versionFilter(name);
  }
  throw new ValidationError('fixVersion filter is not valid.');
}

// 工具的選填輸入 fixVersion（版本名稱字串）：沒給或空白表示不篩選
export function optionalVersionName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError('fixVersion must be a version name, for example 1.4.0.');
  }
  const name = cleanString(value);
  if (!name) return null;
  if (name.length > MAX_VERSION_NAME) throw new ValidationError('fixVersion must be at most 255 characters.');
  return name;
}

// 一個議題的修正版本（名稱陣列；讀不到時為 null，視為未知）是否符合條件。未知的議題只符合「不篩選」。
export function matchesVersionFilter(fixVersions, filter) {
  if (filter.kind === 'all') return true;
  if (!Array.isArray(fixVersions)) return false;
  if (filter.kind === 'none') return fixVersions.length === 0;
  const wanted = norm(filter.name);
  return fixVersions.some((name) => norm(name) === wanted);
}

export const filterByVersion = (issues, filter) => issues.filter((issue) => matchesVersionFilter(issue.fixVersions, filter));

// 給人看的條件說明（稽核包標頭、介面提示）
export function describeVersionFilter(filter) {
  if (filter.kind === 'none') return 'no fix version';
  if (filter.kind === 'version') return `fix version "${filter.name}"`;
  return 'all versions';
}

// 稽核包檔名用的標記；不篩選時為 null。只留英數字、點、底線、減號。
export function versionFileTag(filter) {
  if (filter.kind === 'none') return 'no-fixversion';
  if (filter.kind === 'version') {
    const slug = filter.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return `fixversion-${slug || 'version'}`;
  }
  return null;
}

// 介面選單用的值（Select 的 value 必須是字串）
export function filterToValue(filter) {
  if (filter.kind === 'none') return 'none';
  if (filter.kind === 'version') return `v:${filter.name}`;
  return 'all';
}

export function filterFromValue(value) {
  if (value === 'none') return NO_VERSION;
  if (typeof value === 'string' && value.startsWith('v:')) return versionFilter(value.slice(2));
  return ALL_VERSIONS;
}
