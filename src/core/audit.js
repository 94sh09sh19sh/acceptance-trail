// 擴充 2（規格第 10 節）：把稽核包匯出成 CSV 或 Markdown。
// 只負責格式化，資料由 resolver 蒐集。人員一律顯示 Atlassian account ID，因為 app 不儲存姓名。

import { EVIDENCE_ROLE } from './state.js';
import { countLabel, shortHash } from './text.js';
import { describeVersionFilter } from './versions.js';

export const AUDIT_FORMATS = Object.freeze(['markdown', 'csv']);

// 代理的長文字會截斷，讓單次匯出維持合理大小；事件雜湊仍指向鏈上的完整記錄。
const MAX_TEXT = 500;

const clip = (text, max = MAX_TEXT) => {
  const value = text == null ? '' : String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

// ---- CSV ----

export const CSV_COLUMNS = [
  'issue_key',
  'issue_title',
  'work_order_rev',
  'approved_by_account_id',
  'approved_at',
  'stale',
  'chain_verified',
  'criterion_id',
  'criterion_text',
  'required_evidence',
  'status',
  'gap',
  'evidence_seq',
  'verdict',
  'evidence_type',
  'evidence_summary',
  'reference',
  'agent_name',
  'submitted_by_account_id',
  'submitted_at',
  'evidence_hash',
  'review_decision',
  'review_note',
  'reviewed_by_account_id',
  'reviewed_at',
  'superseded_evidence',
  'fix_versions',
];

// 同一條驗收條件在現行版次被較新證據取代的舊證據（新到舊）。只計入狀態的是最新一筆，
// 這裡列出來是為了讓「先失敗、修正後通過」的過程在稽核包裡看得到。
const supersededOf = (criterion) => (criterion.history ?? []).filter((h) => h.role === EVIDENCE_ROLE.SUPERSEDED);

// 一筆被取代證據的短描述：序號、判定、時間、雜湊前 12 碼，有覆核就加上結果。只用 app 產生的欄位，不含代理文字。
const supersededText = (h, formatTime) =>
  `#${h.seq} ${h.verdict} ${formatTime(h.at)} hash ${shortHash(h.hash)}${h.review ? ` (review: ${h.review.decision})` : ''}`;

// 依 RFC 4180 加引號。試算表會當成公式的儲存格開頭加上單引號，因為代理提供的文字不可信。
export function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(pack) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const issue of pack.issues) {
    for (const c of issue.criteria) {
      const ev = c.latestEvidence;
      const review = c.review;
      const row = [
        issue.issueKey,
        issue.title,
        issue.rev,
        issue.approvedBy,
        issue.approvedAt,
        issue.stale ? 'yes' : 'no',
        issue.chain.verified ? 'yes' : 'no',
        c.id,
        c.text,
        c.evidenceType,
        c.status,
        c.gap ?? '',
        ev?.seq ?? '',
        ev?.verdict ?? '',
        ev?.evidenceType ?? '',
        clip(ev?.summary),
        clip(ev?.reference),
        ev?.agentName ?? '',
        ev?.submittedBy ?? '',
        ev?.at ?? '',
        ev?.hash ?? '',
        review?.decision ?? '',
        clip(review?.note),
        review?.reviewedBy ?? '',
        review?.at ?? '',
        supersededOf(c)
          .map((h) => supersededText(h, (iso) => iso ?? ''))
          .join('; '),
        // 議題的修正版本（多個用分號隔開）；讀不到時留空。CSV 沒有放標頭文字的地方，篩選條件看檔名與這一欄
        (issue.fixVersions ?? []).join('; '),
      ];
      lines.push(row.map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---- Markdown ----

// 表格儲存格：不留換行、跳脫 | 字元、不放原始 HTML
const md = (value) =>
  (value == null || value === '' ? '-' : String(value))
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;');

const time = (iso) => (iso ? `${iso.replace('T', ' ').slice(0, 16)} UTC` : '-');

export function toMarkdown(pack) {
  const out = [];
  out.push(`# Evidence audit pack: ${md(pack.projectKey)}`);
  out.push('');
  out.push(`Generated ${time(pack.generatedAt)} by account \`${md(pack.generatedBy)}\` from Proof of Done records.`);
  out.push('It lists recorded facts (approvals, evidence, reviews, hash-chain checks). It is not a compliance determination.');
  out.push('');
  // 依修正版本篩選時，標頭要寫明範圍，讓這份檔案可以當「某個版本的發版證據包」
  if (pack.filter && pack.filter.kind !== 'all') {
    const scope = pack.filter.kind === 'none' ? 'without a fix version' : 'with this fix version';
    out.push(`**Filter: ${md(describeVersionFilter(pack.filter))}.** Only work items ${scope} are included, so the counts below cover that scope only.`);
    out.push('');
  }
  out.push('| Issues with work orders | Acceptance criteria | Accepted | Gaps |');
  out.push('|---|---|---|---|');
  out.push(`| ${pack.totals.issues} | ${pack.totals.criteria} | ${pack.totals.accepted} | ${pack.totals.gaps} |`);
  for (const issue of pack.issues) {
    out.push('');
    out.push(`## ${md(issue.issueKey)}: ${md(issue.title)}`);
    out.push('');
    out.push(`- Work order revision ${issue.rev}, approved by account \`${md(issue.approvedBy)}\` on ${time(issue.approvedAt)}`);
    out.push(
      `- Evidence chain: ${issue.chain.verified ? 'verified' : `BROKEN at event ${md(issue.chain.brokenAt)} (${md(issue.chain.reason)})`}, ${countLabel(issue.chain.count, 'event')}${issue.chain.lastHash ? `, last hash ${issue.chain.lastHash.slice(0, 12)}` : ''}`,
    );
    out.push(`- Description changed after approval (stale): ${issue.stale ? 'yes' : 'no'}`);
    if (Array.isArray(issue.fixVersions)) {
      out.push(`- Fix versions: ${issue.fixVersions.length ? issue.fixVersions.map((v) => md(v)).join(', ') : 'none'}`);
    }
    if (issue.previousRevisions?.length) {
      out.push(
        `- Earlier revisions (not counted): ${issue.previousRevisions.map((p) => `rev ${p.rev}: ${p.evidenceCount} evidence, ${p.accepted}/${p.total} accepted`).join('; ')}`,
      );
    }
    out.push('');
    out.push('| ID | Criterion | Required | Status | Gap | Latest evidence | Review |');
    out.push('|---|---|---|---|---|---|---|');
    for (const c of issue.criteria) {
      const ev = c.latestEvidence;
      const evidence = ev
        ? `${ev.verdict} (${ev.evidenceType}) #${ev.seq}, hash ${shortHash(ev.hash)}, ${md(ev.agentName)}, ${time(ev.at)}: ${md(clip(ev.summary, 200))}${ev.reference ? ` [ref: ${md(clip(ev.reference, 120))}]` : ''}`
        : '-';
      const review = c.review
        ? `${c.review.decision} by \`${md(c.review.reviewedBy)}\`, ${time(c.review.at)}${c.review.note ? `: ${md(clip(c.review.note, 200))}` : ''}`
        : '-';
      out.push(`| ${md(c.id)} | ${md(c.text)} | ${md(c.evidenceType)} | ${md(c.status)} | ${md(c.gap)} | ${evidence} | ${review} |`);
    }
    const withSuperseded = issue.criteria.filter((c) => supersededOf(c).length > 0);
    if (withSuperseded.length) {
      out.push('');
      out.push(`Superseded evidence in revision ${issue.rev} (kept in the chain, not counted; newest first):`);
      out.push('');
      for (const c of withSuperseded) {
        out.push(`- ${md(c.id)}: ${supersededOf(c).map((h) => md(supersededText(h, time))).join('; ')}`);
      }
    }
  }
  out.push('');
  return out.join('\n');
}
