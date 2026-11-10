// 輸入驗證與截斷。工具的輸入來自外部代理，一律當成不可信任的資料處理。

export const EVIDENCE_TYPES = Object.freeze(['test', 'analysis', 'review', 'demo']);
export const VERDICTS = Object.freeze(['pass', 'fail', 'not-run']);
export const REVIEW_DECISIONS = Object.freeze(['accept', 'reject']);

// 規格第 6 節的長度上限，其餘是為了控制單筆儲存值大小而設
export const LIMITS = Object.freeze({
  summary: 2000,
  outputExcerpt: 4000,
  reference: 500,
  agentName: 100,
  criterionText: 1000,
  reviewNote: 500,
  maxCriteria: 30,
});

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// 轉成字串並去頭尾空白；null／undefined 視為空字串
export function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

// 超過上限就截斷，並回報是否截斷過，讓呼叫端在回傳裡註明
export function truncate(value, max) {
  const text = cleanString(value);
  if (text.length <= max) return { value: text, truncated: false };
  return { value: text.slice(0, max), truncated: true };
}

export function requireString(value, name) {
  const text = cleanString(value);
  if (!text) throw new ValidationError(`${name} is required.`);
  return text;
}

export function requireOneOf(value, allowed, name) {
  const text = cleanString(value).toLowerCase();
  if (!allowed.includes(text)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return text;
}

// 正整數；MCP 客戶端有時會把整數當字串送來，所以接受數字字串
export function requirePositiveInteger(value, name) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1) {
    throw new ValidationError(`${name} must be a positive integer.`);
  }
  return number;
}

// 議題代號（例如 BMS-12）或數字 issueId
export function requireIssueRef(value) {
  const text = requireString(value, 'issueKey').toUpperCase();
  if (!/^([A-Z][A-Z0-9_]*-\d+|\d+)$/.test(text)) {
    throw new ValidationError('issueKey must look like PROJ-123.');
  }
  return text;
}

export function requireProjectKey(value) {
  const text = requireString(value, 'projectKey').toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(text)) {
    throw new ValidationError('projectKey must look like PROJ.');
  }
  return text;
}

// 驗收條件清單（草稿用）：每筆 { text, evidenceType }。空白的條目直接丟掉。
export function normalizeCriteria(list) {
  if (!Array.isArray(list)) throw new ValidationError('Criteria must be a list.');
  const criteria = [];
  for (const item of list) {
    const text = truncate(item?.text, LIMITS.criterionText).value;
    if (!text) continue;
    const rawType = cleanString(item?.evidenceType).toLowerCase() || 'test';
    if (!EVIDENCE_TYPES.includes(rawType)) {
      throw new ValidationError(`evidenceType must be one of: ${EVIDENCE_TYPES.join(', ')}.`);
    }
    criteria.push({ text, evidenceType: rawType });
  }
  if (criteria.length > LIMITS.maxCriteria) {
    throw new ValidationError(`A work order can have at most ${LIMITS.maxCriteria} criteria.`);
  }
  return criteria;
}

// propose-work-order 的 criteriaJson 是 JSON 陣列字串（工具輸入只能是純量）
export function parseCriteriaJson(json) {
  let parsed;
  try {
    parsed = JSON.parse(cleanString(json));
  } catch {
    throw new ValidationError('criteriaJson must be a JSON array, for example [{"text":"...","evidenceType":"test"}].');
  }
  const criteria = normalizeCriteria(parsed);
  if (criteria.length === 0) throw new ValidationError('criteriaJson must contain at least one criterion with text.');
  return criteria;
}
