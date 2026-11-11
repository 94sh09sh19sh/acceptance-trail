// Extension 2 (spec section 10): audit pack export as CSV or Markdown.
// Pure formatting; the resolver collects the data. People are shown as Atlassian account IDs
// because the app never stores names.

export const AUDIT_FORMATS = Object.freeze(['markdown', 'csv']);

// Long agent text is cut so one export stays a manageable size; the event hash still points
// to the full record in the chain.
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
];

// RFC 4180 quoting. Cells that a spreadsheet would read as a formula get a leading apostrophe,
// because agent-supplied text is untrusted.
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
      ];
      lines.push(row.map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---- Markdown ----

// Table cells: no line breaks, escaped pipes, no raw HTML
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
  out.push(`Generated ${time(pack.generatedAt)} by account \`${md(pack.generatedBy)}\` from Evidence Chain records.`);
  out.push('It lists recorded facts (approvals, evidence, reviews, hash-chain checks). It is not a compliance determination.');
  out.push('');
  out.push('| Issues with work orders | Acceptance criteria | Accepted | Gaps |');
  out.push('|---|---|---|---|');
  out.push(`| ${pack.totals.issues} | ${pack.totals.criteria} | ${pack.totals.accepted} | ${pack.totals.gaps} |`);
  for (const issue of pack.issues) {
    out.push('');
    out.push(`## ${md(issue.issueKey)}: ${md(issue.title)}`);
    out.push('');
    out.push(`- Work order revision ${issue.rev}, approved by account \`${md(issue.approvedBy)}\` on ${time(issue.approvedAt)}`);
    out.push(
      `- Evidence chain: ${issue.chain.verified ? 'verified' : `BROKEN at event ${md(issue.chain.brokenAt)} (${md(issue.chain.reason)})`}, ${issue.chain.count} events${issue.chain.lastHash ? `, last hash ${issue.chain.lastHash.slice(0, 12)}` : ''}`,
    );
    out.push(`- Description changed after approval (stale): ${issue.stale ? 'yes' : 'no'}`);
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
        ? `${ev.verdict} (${ev.evidenceType}) #${ev.seq}, hash ${ev.hash.slice(0, 12)}, ${md(ev.agentName)}, ${time(ev.at)}: ${md(clip(ev.summary, 200))}${ev.reference ? ` [ref: ${md(clip(ev.reference, 120))}]` : ''}`
        : '-';
      const review = c.review
        ? `${c.review.decision} by \`${md(c.review.reviewedBy)}\`, ${time(c.review.at)}${c.review.note ? `: ${md(clip(c.review.note, 200))}` : ''}`
        : '-';
      out.push(`| ${md(c.id)} | ${md(c.text)} | ${md(c.evidenceType)} | ${md(c.status)} | ${md(c.gap)} | ${evidence} | ${review} |`);
    }
  }
  out.push('');
  return out.join('\n');
}
