import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  CodeBlock,
  DynamicTable,
  Heading,
  HelperMessage,
  Inline,
  Label,
  LoadingButton,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  SectionMessageAction,
  Select,
  Spinner,
  Stack,
  Text,
  TextArea,
  Textfield,
  User,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { draftNotices } from '../core/draft-notice.js';
import { isManualEntry, sourceLabel } from '../core/source.js';
import { countLabel, shortHash } from '../core/text.js';

// 草稿列的固定代號（只在前端用，送出前會拿掉）
let nextUid = 0;
const withUid = (row) => ({ ...row, uid: `r${nextUid++}` });

// 草稿列的證據類型選單固定寬度，避免被擠到只剩一個字
const evidenceSelectStyle = xcss({ width: '160px' });

// 議題面板：沒有工作單／草稿／已核准三種狀態，加上證據細節與覆核的對話框。
// 所有寫入都經過 resolver，resolver 會用 context 決定議題與使用者並檢查編輯權限。

const EVIDENCE_OPTIONS = ['test', 'analysis', 'review', 'demo'].map((value) => ({ label: value, value }));
const VERDICT_OPTIONS = ['pass', 'fail', 'not-run'].map((value) => ({ label: value, value }));

const STATUS_LOZENGE = {
  'no-evidence': { appearance: 'default', text: 'No evidence' },
  submitted: { appearance: 'inprogress', text: 'Awaiting review' },
  accepted: { appearance: 'success', text: 'Accepted' },
  rejected: { appearance: 'removed', text: 'Rejected' },
};

const VERDICT_LOZENGE = {
  pass: { appearance: 'success', text: 'pass' },
  fail: { appearance: 'removed', text: 'fail' },
  'not-run': { appearance: 'moved', text: 'not run' },
};

const ROLE_LOZENGE = {
  latest: { appearance: 'new', text: 'latest' },
  superseded: { appearance: 'default', text: 'superseded' },
};

const REVIEW_TEXT = { accept: 'Accepted', reject: 'Rejected' };

const formatTime = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '');

// 呼叫 resolver，把 { ok:false } 轉成例外，讓畫面統一處理錯誤；錯誤代號放在例外的 code
async function call(name, payload) {
  const result = await invoke(name, payload);
  if (!result?.ok) {
    const error = new Error(result?.error?.message ?? 'Request failed.');
    error.code = result?.error?.code ?? null;
    throw error;
  }
  return result.data;
}

function DraftEditor({ draft, nextRev, busy, onSave, onApprove, onDiscard }) {
  // 每列帶一個固定的 uid 當 React key：輸入框是非受控的，刪除中間一列時不能讓後面的列接手它的內容
  const [rows, setRows] = useState(() =>
    (draft.criteria.length ? draft.criteria : [{ text: '', evidenceType: 'test' }]).map(withUid),
  );
  const update = (uid, patch) => setRows((prev) => prev.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  const filled = rows.filter((row) => row.text.trim()).length;
  const plainRows = () => rows.map(({ uid, ...rest }) => rest);
  // 從描述起草時的提示（例如退回取全文清單）；人存過草稿後就沒有
  const notices = draftNotices(draft);

  return (
    <Stack space="space.150">
      <Heading size="xsmall">{`Draft work order (revision ${nextRev})`}</Heading>
      <Text size="small" color="color.text.subtle">
        {draft.source === 'agent'
          ? 'Proposed by an AI agent. Review every criterion before approving.'
          : 'Edit the criteria and choose the evidence each one needs. Agents cannot read this until you approve it.'}
      </Text>
      {notices.length ? (
        <SectionMessage appearance="warning">
          <Stack space="space.050">
            {notices.map((notice) => (
              <Text key={notice}>{notice}</Text>
            ))}
          </Stack>
        </SectionMessage>
      ) : null}
      {rows.map((row, index) => (
        <Stack key={row.uid} space="space.050">
          <Label labelFor={`criterion-${row.uid}`}>{`AC-${index + 1}`}</Label>
          <TextArea
            id={`criterion-${row.uid}`}
            defaultValue={row.text}
            minimumRows={2}
            resize="vertical"
            placeholder="Describe one testable acceptance criterion"
            onChange={(event) => update(row.uid, { text: event.target.value })}
          />
          <Inline space="space.100" alignBlock="center">
            <Text size="small" color="color.text.subtle">
              Evidence required
            </Text>
            <Box xcss={evidenceSelectStyle}>
              <Select
                inputId={`evidence-${row.uid}`}
                options={EVIDENCE_OPTIONS}
                value={EVIDENCE_OPTIONS.find((o) => o.value === row.evidenceType)}
                onChange={(option) => update(row.uid, { evidenceType: option?.value ?? 'test' })}
              />
            </Box>
            <Button appearance="subtle" iconBefore="trash" onClick={() => setRows((prev) => prev.filter((r) => r.uid !== row.uid))}>
              Remove
            </Button>
          </Inline>
        </Stack>
      ))}
      <Inline space="space.100">
        <Button iconBefore="add" onClick={() => setRows((prev) => [...prev, withUid({ text: '', evidenceType: 'test' })])}>
          Add criterion
        </Button>
      </Inline>
      <Inline space="space.100" alignBlock="center">
        <LoadingButton appearance="primary" isLoading={busy === 'approve'} isDisabled={filled === 0 || Boolean(busy)} onClick={() => onApprove(plainRows())}>
          Approve
        </LoadingButton>
        <LoadingButton isLoading={busy === 'save'} isDisabled={Boolean(busy)} onClick={() => onSave(plainRows())}>
          Save draft
        </LoadingButton>
        <LoadingButton appearance="subtle" isLoading={busy === 'discard'} isDisabled={Boolean(busy)} onClick={onDiscard}>
          Discard
        </LoadingButton>
      </Inline>
    </Stack>
  );
}

// 同一條驗收條件在現行版次的全部證據（新到舊）。只有一筆時不顯示，避免畫面變雜。
function EvidenceHistory({ history }) {
  if (!history || history.length < 2) return null;
  const head = {
    cells: [
      { key: 'event', content: 'Event', width: 24 },
      { key: 'verdict', content: 'Verdict', width: 14 },
      { key: 'submitted', content: 'Submitted', width: 28 },
      { key: 'hash', content: 'Hash', width: 18 },
      { key: 'review', content: 'Review', width: 16 },
    ],
  };
  const rows = history.map((item) => {
    const verdict = VERDICT_LOZENGE[item.verdict] ?? { appearance: 'default', text: item.verdict };
    const role = ROLE_LOZENGE[item.role] ?? ROLE_LOZENGE.superseded;
    return {
      key: `ev-${item.seq}`,
      cells: [
        {
          key: 'event',
          content: (
            <Inline space="space.050" alignBlock="center">
              <Text>{`#${item.seq}`}</Text>
              <Lozenge appearance={role.appearance}>{role.text}</Lozenge>
            </Inline>
          ),
        },
        { key: 'verdict', content: <Lozenge appearance={verdict.appearance}>{verdict.text}</Lozenge> },
        {
          key: 'submitted',
          content: (
            <Stack space="space.0">
              <Text size="small">{formatTime(item.at)}</Text>
              {/* 來源依事件的 source 欄位顯示（MCP: 代理名稱，或 Manual entry (Jira panel)），不只看代理名稱 */}
              <Text size="small" color="color.text.subtle">
                {sourceLabel(item)}
              </Text>
            </Stack>
          ),
        },
        { key: 'hash', content: <Text size="small">{shortHash(item.hash)}</Text> },
        { key: 'review', content: <Text size="small">{item.review ? REVIEW_TEXT[item.review.decision] ?? item.review.decision : 'Not reviewed'}</Text> },
      ],
    };
  });
  return (
    <Stack space="space.050">
      <Text weight="semibold">{`History (${countLabel(history.length, 'submission')} for this revision)`}</Text>
      <Text size="small" color="color.text.subtle">
        Only the latest evidence counts toward the status and can be reviewed. Superseded evidence stays in the hash chain.
      </Text>
      <DynamicTable head={head} rows={rows} />
    </Stack>
  );
}

function EvidenceModal({ criterion, onClose }) {
  const ev = criterion.latestEvidence;
  const verdict = VERDICT_LOZENGE[ev.verdict] ?? { appearance: 'default', text: ev.verdict };
  const hasHistory = (criterion.history?.length ?? 0) > 1;
  const manual = isManualEntry(ev);
  return (
    <Modal onClose={onClose} width={hasHistory ? 'large' : 'medium'}>
      <ModalHeader>
        <ModalTitle>{`${criterion.id} evidence`}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          <Inline space="space.100" alignBlock="center">
            <Text weight="semibold">Verdict</Text>
            <Lozenge appearance={verdict.appearance}>{verdict.text}</Lozenge>
            <Text size="small">{`Evidence type: ${ev.evidenceType}`}</Text>
          </Inline>
          <Stack space="space.050">
            <Text weight="semibold">Summary</Text>
            <Text>{ev.summary}</Text>
          </Stack>
          <Stack space="space.050">
            <Text weight="semibold">Reference</Text>
            <Text>{ev.reference || 'None provided'}</Text>
          </Stack>
          {ev.outputExcerpt ? (
            <Stack space="space.050">
              <Text weight="semibold">Output excerpt</Text>
              <CodeBlock text={ev.outputExcerpt} language="text" shouldWrapLongLines />
            </Stack>
          ) : null}
          {ev.truncated?.length ? <Text size="small">{`Truncated by the app: ${ev.truncated.join(', ')}`}</Text> : null}
          <Inline space="space.100" alignBlock="center">
            <Text weight="semibold">Source</Text>
            <Text>{manual ? 'Manual entry (Jira panel), recorded by a person' : 'AI agent through MCP'}</Text>
          </Inline>
          {manual ? null : (
            <Inline space="space.100" alignBlock="center">
              <Text weight="semibold">Agent</Text>
              <Text>{ev.agentName}</Text>
            </Inline>
          )}
          <Inline space="space.100" alignBlock="center">
            <Text weight="semibold">{manual ? 'Recorded by' : 'Submitted by'}</Text>
            {ev.submittedBy && ev.submittedBy !== 'unknown' ? <User accountId={ev.submittedBy} /> : <Text>Unknown</Text>}
            <Text>{formatTime(ev.at)}</Text>
          </Inline>
          <Inline space="space.100" alignBlock="center">
            <Text weight="semibold">Event</Text>
            <Text>{`#${ev.seq} · hash ${shortHash(ev.hash)}`}</Text>
            {hasHistory ? <Lozenge appearance={ROLE_LOZENGE.latest.appearance}>{ROLE_LOZENGE.latest.text}</Lozenge> : null}
          </Inline>
          {criterion.review ? (
            <Inline space="space.100" alignBlock="center">
              <Text weight="semibold">Review</Text>
              <Text>{criterion.review.decision === 'accept' ? 'Accepted by' : 'Rejected by'}</Text>
              <User accountId={criterion.review.reviewedBy} />
              <Text>{criterion.review.note ? `“${criterion.review.note}”` : ''}</Text>
            </Inline>
          ) : null}
          <EvidenceHistory history={criterion.history} />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  );
}

// 覆核失敗時錯誤顯示在對話框裡（面板上方的錯誤會被對話框的遮罩蓋住），和 RecordEvidenceModal 相同
function ReviewModal({ criterion, decision, busy, error, onConfirm, onClose }) {
  const [note, setNote] = useState('');
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>{`${decision === 'accept' ? 'Accept' : 'Reject'} evidence for ${criterion.id}`}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.100">
          <Text>{criterion.latestEvidence.summary}</Text>
          {isManualEntry(criterion.latestEvidence) ? (
            <Text size="small" color="color.text.subtle">
              This evidence was recorded by hand in the Jira panel, not reported by an agent.
            </Text>
          ) : null}
          {error ? (
            <SectionMessage appearance="error" title="That did not work">
              <Text>{error}</Text>
            </SectionMessage>
          ) : null}
          <Label labelFor="review-note">Note (optional)</Label>
          {/* 不可綁 value：UI Kit 的受控輸入會在打字時被舊值蓋回去，只留下最後一個字元 */}
          <TextArea id="review-note" defaultValue="" onChange={(event) => setNote(event.target.value)} />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <LoadingButton appearance={decision === 'accept' ? 'primary' : 'danger'} isLoading={busy} onClick={() => onConfirm(note)}>
          {decision === 'accept' ? 'Accept' : 'Reject'}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

// 人手動記錄一條驗收條件的證據（Record evidence）。欄位與 MCP 的 submit-evidence 相同，只是沒有代理名稱：
// 來源與代理名稱由後端固定寫入。長度上限與截斷由後端照 submit-evidence 的規則處理，這裡只提示上限、不先截。
// 文字欄位同樣不可綁 value（見 ReviewModal），用 defaultValue 加 onChange 記下最新內容。
function RecordEvidenceModal({ criterion, rev, busy, error, onConfirm, onClose }) {
  const [verdict, setVerdict] = useState(null);
  const [evidenceType, setEvidenceType] = useState(criterion.evidenceType);
  const [summary, setSummary] = useState('');
  const [reference, setReference] = useState('');
  const [outputExcerpt, setOutputExcerpt] = useState('');
  const ready = Boolean(verdict) && summary.trim().length > 0;
  return (
    <Modal onClose={onClose} width="medium">
      <ModalHeader>
        <ModalTitle>{`Record evidence for ${criterion.id}`}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          <Stack space="space.050">
            <Text>{criterion.text}</Text>
            <Text size="small" color="color.text.subtle">{`Work order revision ${rev} · Required evidence: ${criterion.evidenceType}`}</Text>
          </Stack>
          <Text size="small">
            This is saved as a manual entry under your account, not as an agent report. Someone with edit permission still accepts or rejects it, and only the latest evidence for a criterion counts.
          </Text>
          {error ? (
            <SectionMessage appearance="error" title="That did not work">
              <Text>{error}</Text>
            </SectionMessage>
          ) : null}
          <Stack space="space.050">
            <Label labelFor="record-verdict">Verdict (required)</Label>
            <Select
              inputId="record-verdict"
              options={VERDICT_OPTIONS}
              value={VERDICT_OPTIONS.find((o) => o.value === verdict) ?? null}
              placeholder="Choose pass, fail or not-run"
              onChange={(option) => setVerdict(option?.value ?? null)}
            />
            <HelperMessage>fail and not-run count as gaps.</HelperMessage>
          </Stack>
          <Stack space="space.050">
            <Label labelFor="record-type">Evidence type</Label>
            <Select
              inputId="record-type"
              options={EVIDENCE_OPTIONS}
              value={EVIDENCE_OPTIONS.find((o) => o.value === evidenceType)}
              onChange={(option) => setEvidenceType(option?.value ?? criterion.evidenceType)}
            />
          </Stack>
          <Stack space="space.050">
            <Label labelFor="record-summary">Summary (required)</Label>
            <TextArea
              id="record-summary"
              defaultValue=""
              minimumRows={3}
              resize="vertical"
              placeholder="What was checked and what the result shows"
              onChange={(event) => setSummary(event.target.value)}
            />
            <HelperMessage>Up to 2,000 characters.</HelperMessage>
          </Stack>
          <Stack space="space.050">
            <Label labelFor="record-reference">Reference (optional)</Label>
            <Textfield
              id="record-reference"
              defaultValue=""
              placeholder="A commit SHA, CI run link or document link"
              onChange={(event) => setReference(event.target.value)}
            />
            <HelperMessage>Up to 500 characters.</HelperMessage>
          </Stack>
          <Stack space="space.050">
            <Label labelFor="record-output">Output excerpt (optional)</Label>
            <TextArea
              id="record-output"
              defaultValue=""
              minimumRows={3}
              resize="vertical"
              isMonospaced
              placeholder="The relevant part of a test or tool output"
              onChange={(event) => setOutputExcerpt(event.target.value)}
            />
            <HelperMessage>Up to 4,000 characters. Longer text in any field is cut to its limit, and the record says which fields were cut.</HelperMessage>
          </Stack>
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <LoadingButton
          appearance="primary"
          isLoading={busy}
          isDisabled={!ready}
          onClick={() => onConfirm({ verdict, evidenceType, summary, reference, outputExcerpt })}
        >
          Record evidence
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

// 僅限開發用的重設確認框（用 UI Kit 的 Modal，不用瀏覽器原生的 confirm）
function ResetModal({ issueKey, busy, onConfirm, onClose }) {
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>{`Reset Acceptance Trail data for ${issueKey}?`}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Text>
          This deletes the draft, every work order revision, all events and reviews, the matrix row, backups and the searchable issue property for this issue. It cannot be undone. Only development installs have this button.
        </Text>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <LoadingButton appearance="danger" isLoading={busy} onClick={onConfirm}>
          Reset
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

function WorkOrderTable({ view, onDetails, onReview, onRecord }) {
  // 欄數少、條件文字欄最寬：主欄窄時也讀得順。Required 併入條件欄的小字，覆核按鈕放在最新證據欄內第二行。
  const head = {
    cells: [
      { key: 'id', content: 'ID', width: 10 },
      { key: 'text', content: 'Criterion', width: 40 },
      { key: 'status', content: 'Status', width: 18 },
      { key: 'latest', content: 'Latest evidence and review', width: 32 },
    ],
  };
  const rows = view.state.criteria.map((criterion) => {
    const status = STATUS_LOZENGE[criterion.status];
    const ev = criterion.latestEvidence;
    const verdict = ev ? VERDICT_LOZENGE[ev.verdict] : null;
    const canReview = criterion.status === 'submitted' && view.canEdit;
    return {
      key: criterion.id,
      cells: [
        { key: 'id', content: criterion.id },
        {
          key: 'text',
          content: (
            <Stack space="space.050">
              <Text>{criterion.text}</Text>
              <Text size="small" color="color.text.subtle">{`Required evidence: ${criterion.evidenceType}`}</Text>
            </Stack>
          ),
        },
        { key: 'status', content: <Lozenge appearance={status.appearance}>{status.text}</Lozenge> },
        {
          key: 'latest',
          content: (
            <Stack space="space.075">
              {ev ? (
                <Stack space="space.050">
                  <Lozenge appearance={verdict.appearance}>{verdict.text}</Lozenge>
                  <Text size="small">{isManualEntry(ev) ? `${formatTime(ev.at)} · Manual entry` : formatTime(ev.at)}</Text>
                  <Text maxLines={2}>{ev.summary}</Text>
                  {criterion.evidenceCount > 1 ? (
                    <Text size="small" color="color.text.subtle">
                      {`${countLabel(criterion.evidenceCount - 1, 'earlier submission')}, see Details`}
                    </Text>
                  ) : null}
                </Stack>
              ) : (
                <Text color="color.text.subtle">None yet</Text>
              )}
              <Inline space="space.100" alignBlock="center" shouldWrap>
                {ev ? (
                  <Button appearance="subtle" spacing="compact" onClick={() => onDetails(criterion)}>
                    Details
                  </Button>
                ) : null}
                {canReview ? (
                  <ButtonGroup label={`Review ${criterion.id}`}>
                    <Button spacing="compact" onClick={() => onReview(criterion, 'accept')}>
                      Accept
                    </Button>
                    <Button spacing="compact" appearance="subtle" onClick={() => onReview(criterion, 'reject')}>
                      Reject
                    </Button>
                  </ButtonGroup>
                ) : null}
                {/* 次要動作：沒有編輯權限的人看不到，後端也會拒絕 */}
                {view.canEdit ? (
                  <Button spacing="compact" appearance="subtle" onClick={() => onRecord(criterion)}>
                    Record evidence
                  </Button>
                ) : null}
              </Inline>
              {criterion.status === 'submitted' && !view.canEdit ? <Text size="small">Awaiting reviewer</Text> : null}
              {criterion.status !== 'submitted' && criterion.review?.note ? (
                <Text size="small" color="color.text.subtle">{criterion.review.note}</Text>
              ) : null}
            </Stack>
          ),
        },
      ],
    };
  });
  return <DynamicTable head={head} rows={rows} />;
}

function App() {
  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [details, setDetails] = useState(null);
  const [review, setReview] = useState(null);
  const [recording, setRecording] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [loadedAt, setLoadedAt] = useState(null);

  const load = async () => {
    setLoadError(null);
    try {
      setView(await call('getPanel'));
      setLoadedAt(new Date().toISOString());
    } catch (error) {
      setLoadError(error.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // 每個按鈕動作都回傳更新後的整個面板資料。
  // Refresh 也走這裡（呼叫 getPanel），畫面保留舊資料，只讓按鈕顯示載入中；失敗時顯示錯誤訊息但不清掉畫面。
  // onError（選填）在顯示錯誤後、按鈕恢復前執行，讓呼叫端依錯誤代號做後續處理。
  const run = async (name, label, payload, { onError } = {}) => {
    setBusy(label);
    setActionError(null);
    try {
      setView(await call(name, payload));
      setLoadedAt(new Date().toISOString());
      return true;
    } catch (error) {
      setActionError(error.message);
      if (onError) await onError(error);
      return false;
    } finally {
      setBusy(null);
    }
  };

  // 重新取面板資料但保留目前的錯誤訊息；失敗就留著舊畫面與原本的錯誤
  const reloadKeepingError = async () => {
    try {
      setView(await call('getPanel'));
      setLoadedAt(new Date().toISOString());
    } catch {
      // 原本的錯誤訊息已經說明要重看，這裡不蓋掉它
    }
  };

  if (loadError) {
    return (
      <SectionMessage appearance="error" title="Could not load Acceptance Trail" actions={[<SectionMessageAction key="retry" onClick={load}>Try again</SectionMessageAction>]}>
        <Text>{loadError}</Text>
      </SectionMessage>
    );
  }
  if (!view) return <Spinner label="Loading work order" />;

  const { workOrder, draft, state, chain, stale, canEdit } = view;
  const nextRev = (workOrder?.rev ?? 0) + 1;

  return (
    <Stack space="space.200">
      {/* 代理經 MCP 送出證據後，按這裡重新取資料，不用重新載入整頁 */}
      <Inline space="space.100" alignBlock="center" spread="space-between">
        <Text size="small" color="color.text.subtle">
          {loadedAt ? `Loaded ${formatTime(loadedAt)}` : ''}
        </Text>
        <LoadingButton spacing="compact" isLoading={busy === 'refresh'} isDisabled={Boolean(busy)} onClick={() => run('getPanel', 'refresh')}>
          Refresh
        </LoadingButton>
      </Inline>
      {/* 表單或覆核對話框開著時錯誤顯示在對話框裡，這裡不重複 */}
      {actionError && !recording && !review ? (
        <SectionMessage appearance="error" title="That did not work">
          <Text>{actionError}</Text>
        </SectionMessage>
      ) : null}
      {view.recorded ? (
        <SectionMessage appearance="success" title={`Recorded evidence for ${view.recorded.criterionId}`}>
          <Text>
            {`Event #${view.recorded.seq}, saved as a manual entry. It is now the latest evidence for ${view.recorded.criterionId} and is awaiting review.${
              view.recorded.truncated?.length ? ` Cut to the length limit: ${view.recorded.truncated.join(', ')}.` : ''
            }`}
          </Text>
        </SectionMessage>
      ) : null}

      {!workOrder && !draft ? (
        <Stack space="space.100">
          <Text>
            No work order yet. Draft one from this issue's acceptance criteria, then approve it. After that, AI agents can report evidence for each criterion through MCP, and people who can edit the issue can record evidence by hand.
          </Text>
          {canEdit ? (
            <Inline>
              <LoadingButton appearance="primary" isLoading={busy === 'draft'} onClick={() => run('draftFromDescription', 'draft')}>
                Draft work order
              </LoadingButton>
            </Inline>
          ) : (
            <Text size="small">You need permission to edit this issue to draft a work order.</Text>
          )}
        </Stack>
      ) : null}

      {workOrder ? (
        <Stack space="space.150">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Heading size="xsmall">{`Work order revision ${workOrder.rev}`}</Heading>
            <Lozenge appearance={chain.verified ? 'success' : 'removed'} isBold>
              {chain.verified ? 'Chain verified' : 'Chain broken'}
            </Lozenge>
          </Inline>
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Text size="small">Approved by</Text>
            {workOrder.approvedBy !== 'unknown' ? <User accountId={workOrder.approvedBy} /> : <Text size="small">Unknown</Text>}
            <Text size="small">{`on ${formatTime(workOrder.approvedAt)} · ${state.accepted}/${state.total} accepted · ${countLabel(state.gapCount, 'gap')} · ${countLabel(chain.count, 'event')}`}</Text>
          </Inline>
          {!chain.verified ? (
            <SectionMessage appearance="error" title="Chain broken">
              <Text>{`Stored records do not match the hash chain (event ${chain.brokenAt ?? '?'}: ${chain.reason}). Treat this work order's evidence as untrusted.`}</Text>
            </SectionMessage>
          ) : null}
          {stale ? (
            <SectionMessage
              appearance="warning"
              title="The issue description changed after approval"
              actions={canEdit && !draft ? [<SectionMessageAction key="redraft" onClick={() => run('draftFromDescription', 'draft')}>Draft new revision</SectionMessageAction>] : []}
            >
              <Text>This work order may be out of date. Draft and approve a new revision if the acceptance criteria changed.</Text>
            </SectionMessage>
          ) : null}
          <WorkOrderTable
            view={view}
            onDetails={setDetails}
            onReview={(criterion, decision) => {
              setActionError(null);
              setReview({ criterion, decision });
            }}
            onRecord={(criterion) => {
              setActionError(null);
              setRecording(criterion);
            }}
          />
          {state.previousRevisions?.length ? (
            <Text size="small" color="color.text.subtle">
              {`Earlier revisions: ${state.previousRevisions
                .map((p) => `revision ${p.rev} had ${countLabel(p.evidenceCount, 'evidence record')} (${p.accepted}/${p.total} accepted)`)
                .join('; ')}. They stay in the chain but do not count toward revision ${workOrder.rev}, so agents report again for this revision.`}
            </Text>
          ) : null}
          {canEdit && !draft && !stale ? (
            <Inline>
              <Button onClick={() => run('draftFromDescription', 'draft')}>
                Draft new revision
              </Button>
            </Inline>
          ) : null}
        </Stack>
      ) : null}

      {draft && canEdit ? (
        <DraftEditor
          key={draft.updatedAt}
          draft={draft}
          nextRev={nextRev}
          busy={busy}
          onSave={(rows) => run('saveDraft', 'save', { criteria: rows })}
          // 帶上畫面上的版次：請求重送或另一個分頁已經核准過時，後端回 ALREADY_APPROVED，不會多出一版
          onApprove={(rows) => run('approve', 'approve', { criteria: rows, expectedRev: nextRev })}
          onDiscard={() => run('discardDraft', 'discard')}
        />
      ) : null}
      {draft && !canEdit ? <Text size="small">{`A draft for revision ${nextRev} is waiting for someone with edit permission to approve it.`}</Text> : null}

      {/* 只有後端回報開發用工具已啟用時才顯示；正式環境永遠不會啟用 */}
      {view.devTools ? (
        <Stack space="space.100">
          <Heading size="xsmall">Developer tools (development environment only)</Heading>
          {workOrder ? (
            <>
              <Text size="small">
                Simulates someone editing a stored event outside the app, so you can see the chain report it. These buttons do not exist in production.
              </Text>
              <Inline space="space.100">
                <LoadingButton appearance="warning" isLoading={busy === 'tamper'} isDisabled={Boolean(busy)} onClick={() => run('devTamper', 'tamper')}>
                  Edit latest event
                </LoadingButton>
                <LoadingButton
                  isLoading={busy === 'restore'}
                  isDisabled={Boolean(busy) || view.devTools.tampered === 0}
                  onClick={() => run('devRestore', 'restore')}
                >
                  {`Restore edited events (${view.devTools.tampered})`}
                </LoadingButton>
              </Inline>
            </>
          ) : null}
          <Text size="small">
            Reset deletes this issue's draft, every work order revision, all events, the matrix row, backups and the searchable issue property, so you can start a demo from scratch. Production has no way to delete events.
          </Text>
          <Inline space="space.100">
            <Button appearance="danger" isDisabled={Boolean(busy)} onClick={() => setConfirmReset(true)}>
              {"Reset this issue's Acceptance Trail data"}
            </Button>
          </Inline>
          {view.reset ? (
            <Text size="small" color="color.text.subtle">
              {`Reset done: ${countLabel(view.reset.removed, 'stored record')} removed${view.reset.propertyRemoved ? '.' : '. The issue property could not be removed; see the app log.'}`}
            </Text>
          ) : null}
        </Stack>
      ) : null}

      <ModalTransition>
        {confirmReset ? (
          <ResetModal
            issueKey={view.issueKey}
            busy={busy === 'reset'}
            onClose={() => setConfirmReset(false)}
            onConfirm={async () => {
              const done = await run('devReset', 'reset');
              if (done) setConfirmReset(false);
            }}
          />
        ) : null}
        {details ? <EvidenceModal criterion={details} onClose={() => setDetails(null)} /> : null}
        {recording && workOrder ? (
          <RecordEvidenceModal
            criterion={recording}
            rev={workOrder.rev}
            busy={busy === 'record'}
            error={actionError}
            onClose={() => {
              setRecording(null);
              setActionError(null);
            }}
            onConfirm={async (form) => {
              // 版次用開表單當下面板顯示的版次；期間有人核准新版次時，後端回 REVISION_MISMATCH，不寫入
              const done = await run('recordEvidence', 'record', { criterionId: recording.id, workOrderRev: workOrder.rev, ...form });
              if (done) setRecording(null);
            }}
          />
        ) : null}
        {review ? (
          <ReviewModal
            criterion={review.criterion}
            decision={review.decision}
            busy={busy === 'review'}
            error={actionError}
            onClose={() => {
              setReview(null);
              setActionError(null);
            }}
            onConfirm={async (note) => {
              const done = await run(
                'review',
                'review',
                { evidenceSeq: review.criterion.latestEvidence.seq, decision: review.decision, note },
                {
                  // 有較新的證據或版次已換：這筆不能再覆核。關掉對話框並重新載入，錯誤訊息留在面板上方說明為什麼要重看
                  onError: async (error) => {
                    if (error.code !== 'OUTDATED_EVIDENCE') return;
                    setReview(null);
                    await reloadKeepingError();
                  },
                },
              );
              if (done) setReview(null);
            }}
          />
        ) : null}
      </ModalTransition>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
