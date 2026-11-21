// 從議題描述（ADF，Atlassian Document Format）抽出條列內容，當作驗收條件草稿。
// 規則（規格第 4 節第 1 步）：
//   1. 優先取「Acceptance criteria」標題底下的清單（標題可以是 heading，或整段只有這幾個字的段落）
//   2. 找不到就取全文所有清單
//   3. 都沒有就回傳空陣列（空白草稿）

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
const ITEM_TYPES = new Set(['listItem', 'taskItem']);
const HEADER_PATTERN = /^acceptance\s+criteria\s*:?$/i;
// 子節點是行內節點（文字、連結、提及等）的區塊：子節點直接相接。
// 其他有子節點的區塊（清單條目、表格儲存格、panel 等）裡是一段一段的區塊，各段之間用空白相接，避免兩段黏成一個字。
const INLINE_PARENTS = new Set(['paragraph', 'heading', 'codeBlock', 'taskItem', 'decisionItem', 'caption']);

const asString = (value) => (typeof value === 'string' ? value : '');

// date 節點的 timestamp 是毫秒字串，轉成 YYYY-MM-DD（UTC）；無效就略過
function formatDate(timestamp) {
  const ms = Number(timestamp);
  if (timestamp === undefined || timestamp === null || timestamp === '' || !Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

// 沒有 text 欄位的行內節點：智慧連結取網址、提及取顯示文字、表情取文字（沒有就 shortName）、日期轉成 YYYY-MM-DD、狀態取文字。
// 其他未知的節點若有 attrs.text 就用它，否則略過。placeholder 是範本裡的提示字，不是內容，所以不取。
function atomText(node) {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return asString(attrs.url) || asString(attrs.data?.url);
    case 'emoji':
      return asString(attrs.text) || asString(attrs.shortName);
    case 'date':
      return formatDate(attrs.timestamp);
    case 'placeholder':
      return '';
    default:
      // mention、status 與其他未知節點
      return asString(attrs.text);
  }
}

// 取一個節點底下的純文字，但不進入巢狀清單（巢狀清單的條目會另外成為一條）
function inlineText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return asString(node.text);
  if (node.type === 'hardBreak') return ' ';
  if (LIST_TYPES.has(node.type)) return '';
  if (!Array.isArray(node.content)) return atomText(node);
  return node.content.map(inlineText).join(INLINE_PARENTS.has(node.type) ? '' : ' ');
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// 把一個清單攤平成條目文字（含巢狀清單）
function listItems(listNode, out) {
  for (const item of listNode.content ?? []) {
    // 巢狀核取清單：ADF 把子 taskList 直接放在 taskList 底下（不在 taskItem 裡）
    if (LIST_TYPES.has(item.type)) {
      listItems(item, out);
      continue;
    }
    if (!ITEM_TYPES.has(item.type)) continue;
    const text = collapse(inlineText(item));
    if (text) out.push(text);
    for (const child of item.content ?? []) {
      if (LIST_TYPES.has(child.type)) listItems(child, out);
    }
  }
  return out;
}

function isCriteriaHeader(node) {
  if (node.type !== 'heading' && node.type !== 'paragraph') return false;
  return HEADER_PATTERN.test(collapse(inlineText(node)));
}

// 在同一層的區塊中，找標題之後、下一個同級或更高級標題之前的清單
function criteriaUnderHeader(blocks) {
  for (let i = 0; i < blocks.length; i += 1) {
    const header = blocks[i];
    if (!isCriteriaHeader(header)) continue;
    const level = header.type === 'heading' ? header.attrs?.level ?? 1 : 99;
    const found = [];
    for (let j = i + 1; j < blocks.length; j += 1) {
      const block = blocks[j];
      if (block.type === 'heading' && (block.attrs?.level ?? 1) <= level) break;
      if (block.type === 'paragraph' && level === 99 && isCriteriaHeader(block)) break;
      if (LIST_TYPES.has(block.type)) listItems(block, found);
      // 段落式標題底下只吃緊接著的清單，遇到下一段文字就停
      if (level === 99 && found.length > 0 && !LIST_TYPES.has(block.type)) break;
    }
    if (found.length > 0) return found;
  }
  return null;
}

// 全文所有最外層清單（巢狀的會在 listItems 裡處理）
function allLists(node, out) {
  for (const child of node.content ?? []) {
    if (LIST_TYPES.has(child.type)) listItems(child, out);
    else allLists(child, out);
  }
  return out;
}

// 也往下找容器（panel、expand 等）裡的區塊
function findUnderHeaderDeep(node) {
  const direct = criteriaUnderHeader(node.content ?? []);
  if (direct) return direct;
  for (const child of node.content ?? []) {
    if (LIST_TYPES.has(child.type) || !child.content) continue;
    const nested = findUnderHeaderDeep(child);
    if (nested) return nested;
  }
  return null;
}

export function extractCriteriaFromAdf(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.content)) return [];
  const underHeader = findUnderHeaderDeep(doc);
  if (underHeader) return underHeader;
  return allLists(doc, []);
}
