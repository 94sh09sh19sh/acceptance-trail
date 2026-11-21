// 從議題描述（ADF，Atlassian Document Format）抽出條列內容，當作驗收條件草稿。
// 規則（規格第 4 節第 1 步）：
//   1. 優先取「Acceptance criteria」標題底下的條件。標題可以是 heading、整段只有標題文字的段落，或清單條目裡的這樣一段；
//      寫法見 HEADER_PATTERN 與 headerCore（開頭的表情符號與編號、結尾的冒號與括號註解都不影響）。
//      標題底下可以是清單、表格或逐段的段落，見 sectionUnderHeader。
//   2. 找不到（或標題底下沒有可用的內容）就取全文所有清單，來源標成 all-lists，讓面板提醒人刪掉不是條件的條目
//   3. 都沒有就回傳空陣列（空白草稿）

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
const ITEM_TYPES = new Set(['listItem', 'taskItem']);
// 標題主體（見 headerCore）：Acceptance criteria／criterion、AC、ACs，可再接「/ Definition of Done」這類寫法
const HEADER_PATTERN = /^(?:acceptance[\s_-]*criteri(?:a|on)|acs?)(?:\s*(?:[/&]|\band\b)\s*(?:definition\s+of\s+done|dod))?$/i;
const HEADER_MAX_LENGTH = 60;
// 描述裡常見的其他小節（見 isSectionName）
const SECTION_NAMES =
  /^(?:out[\s-]+of[\s-]+scope|not\s+in\s+scope|non[\s-]?goals?|notes?|background|context|description|summary|overview|requirements?|steps\s+to\s+reproduce|expected\s+(?:results?|behaviou?r)|actual\s+(?:results?|behaviou?r)|definition\s+of\s+done|dod|technical\s+notes|implementation\s+notes|test\s+plan|testing\s+notes|design|links|references|attachments|open\s+questions|questions|dependencies|risks|assumptions|constraints)$/i;
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

// 取一個節點底下的純文字。預設不進入巢狀清單（巢狀清單的條目會另外成為一條）；表格儲存格要連清單一起取時傳 withLists
function inlineText(node, withLists = false) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return asString(node.text);
  if (node.type === 'hardBreak') return ' ';
  if (!withLists && LIST_TYPES.has(node.type)) return '';
  if (!Array.isArray(node.content)) return atomText(node);
  return node.content.map((child) => inlineText(child, withLists)).join(INLINE_PARENTS.has(node.type) ? '' : ' ');
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

const textOf = (node) => collapse(inlineText(node));

// 標題文字的主體：去掉開頭的表情符號、符號與編號（例如「✅ 」「3. 」「:white_check_mark: 」），
// 再反覆去掉結尾的冒號（半形、全形）、其他標點與括號註解（例如「 (AC)」）
function headerCore(text) {
  let core = text.replace(/^(?::[\w+-]+:|[^\p{L}])+/u, '');
  for (;;) {
    const next = core.replace(/[^\p{L}\p{N})）\]]+$/u, '').replace(/\s*[(（\[][^()（）\[\]]*[)）\]]$/u, '');
    if (next === core) return core;
    core = next;
  }
}

// 指定類型、整段文字在 HEADER_MAX_LENGTH 以內的區塊才回傳文字，否則回傳空字串。
// 只有短的區塊才可能是標題，避免把提到 acceptance criteria 的一般句子當成標題。
function shortText(node, types) {
  if (!types.includes(node?.type)) return '';
  const text = textOf(node);
  return text.length <= HEADER_MAX_LENGTH ? text : '';
}

function isCriteriaHeader(node) {
  const text = shortText(node, ['heading', 'paragraph']);
  return Boolean(text) && HEADER_PATTERN.test(headerCore(text));
}

// 描述裡其他小節的名稱（heading 或整段只有這幾個字的段落）：出現在條件之後代表條件到此為止
function isSectionName(node) {
  const text = shortText(node, ['heading', 'paragraph']);
  return Boolean(text) && SECTION_NAMES.test(headerCore(text));
}

// 像標籤的短段落：整段粗體，或以冒號結尾（例如「The feature must:」「Edge cases:」）
function isLabel(node) {
  const text = shortText(node, ['paragraph']);
  if (!text) return false;
  if (/[:：]$/.test(text)) return true;
  const texts = (node.content ?? []).filter((c) => c?.type === 'text' && asString(c.text).trim());
  return texts.length > 0 && texts.every((c) => (c.marks ?? []).some((m) => m?.type === 'strong'));
}

const isEmptyParagraph = (node) => node?.type === 'paragraph' && !textOf(node);

function skipEmpty(blocks, start) {
  let k = start;
  while (k < blocks.length && isEmptyParagraph(blocks[k])) k += 1;
  return k;
}

// 從 start 起連續的非空段落，各段一條；遇到其他區塊、小節結束或下一個小節的標籤就停
function paragraphRun(blocks, start, endsSection) {
  const texts = [];
  let k = start;
  for (; k < blocks.length; k += 1) {
    const block = blocks[k];
    if (isEmptyParagraph(block)) continue;
    if (block?.type !== 'paragraph' || endsSection(block)) break;
    if (texts.length > 0 && isLabel(block)) break;
    texts.push(textOf(block));
  }
  return { texts, next: k };
}

// 表格：每個非標題列一條，各儲存格的文字用「 — 」相接；整列都是 tableHeader 的是標題列，空列略過。
// 儲存格裡的清單也算進該格的文字。
function tableRows(table) {
  const out = [];
  for (const row of table.content ?? []) {
    if (row?.type !== 'tableRow') continue;
    const cells = (row.content ?? []).filter((c) => c?.type === 'tableCell' || c?.type === 'tableHeader');
    if (cells.length > 0 && cells.every((c) => c.type === 'tableHeader')) continue;
    const text = cells
      .map((c) => collapse(inlineText(c, true)))
      .filter(Boolean)
      .join(' — ');
    if (text) out.push(text);
  }
  return out;
}

// 一個標題（blocks[i]）底下的條件。標題後第一個非空區塊決定取法：
//   - 清單：取清單。heading 取到下一個同級或更高級標題前的所有清單；段落式標題只取緊接著的清單。
//   - 表格：逐列取。
//   - 段落：連續的非空段落逐段一條，遇到標題、其他小節名稱（例如 Out of scope、Notes:）、下一個標籤或其他區塊就停，
//     不跳過段落去抓後面的清單。但只有一段、後面緊接清單或表格時，這段是說明文字，改取那個清單或表格。
//   開頭若是一行標籤式的引言（例如「The feature must:」）先略過。
function sectionUnderHeader(blocks, i) {
  const header = blocks[i];
  const level = header.type === 'heading' ? header.attrs?.level ?? 1 : 99;
  const endsSection = (block) =>
    (block?.type === 'heading' && (block.attrs?.level ?? 1) <= level) ||
    isSectionName(block) ||
    (level === 99 && block?.type === 'paragraph' && isCriteriaHeader(block));

  let j = skipEmpty(blocks, i + 1);
  if (j < blocks.length && isLabel(blocks[j]) && !endsSection(blocks[j])) j = skipEmpty(blocks, j + 1);
  const first = blocks[j];
  if (!first || endsSection(first)) return [];
  if (first.type === 'paragraph') {
    const { texts, next } = paragraphRun(blocks, j, endsSection);
    const after = blocks[next];
    const intro = texts.length === 1 && after && (LIST_TYPES.has(after.type) || after.type === 'table');
    if (!intro) return texts;
    j = next;
  }
  if (blocks[j].type === 'table') return tableRows(blocks[j]);

  const found = [];
  for (let k = j; k < blocks.length; k += 1) {
    const block = blocks[k];
    if (endsSection(block)) break;
    if (LIST_TYPES.has(block?.type)) listItems(block, found);
    // 段落式標題底下只吃緊接著的清單，遇到下一段文字就停
    if (level === 99 && found.length > 0 && !LIST_TYPES.has(block?.type)) break;
  }
  return found;
}

// 在同一層的區塊中找 Acceptance criteria 標題，回傳第一個底下有條件的標題的條件
function criteriaUnderHeader(blocks) {
  for (let i = 0; i < blocks.length; i += 1) {
    if (!isCriteriaHeader(blocks[i])) continue;
    const found = sectionUnderHeader(blocks, i);
    if (found.length > 0) return found;
  }
  return null;
}

// 全文所有最外層清單（巢狀的會在 listItems 裡處理）
function allLists(node, out) {
  for (const child of node.content ?? []) {
    if (LIST_TYPES.has(child?.type)) listItems(child, out);
    else if (child && typeof child === 'object') allLists(child, out);
  }
  return out;
}

// 也往下找容器（panel、expand 等）與清單條目裡的區塊：
// 整份描述是一個清單、其中一條是「Acceptance criteria:」帶子清單時，只取那個子清單
function findUnderHeaderDeep(node) {
  const direct = criteriaUnderHeader(node.content ?? []);
  if (direct) return direct;
  for (const child of node.content ?? []) {
    if (!Array.isArray(child?.content)) continue;
    const nested = findUnderHeaderDeep(child);
    if (nested) return nested;
  }
  return null;
}

// 條件的來源：section 是 Acceptance criteria 標題底下；all-lists 是找不到（或標題底下沒有可用內容）而退回取全文所有清單
export const CRITERIA_FROM = Object.freeze({ SECTION: 'section', ALL_LISTS: 'all-lists' });

// 回傳 { items, from }。沒有抽到任何條目時 from 為 null。
export function extractCriteria(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.content)) return { items: [], from: null };
  const underHeader = findUnderHeaderDeep(doc);
  if (underHeader) return { items: underHeader, from: CRITERIA_FROM.SECTION };
  const items = allLists(doc, []);
  return { items, from: items.length > 0 ? CRITERIA_FROM.ALL_LISTS : null };
}

export function extractCriteriaFromAdf(doc) {
  return extractCriteria(doc).items;
}
