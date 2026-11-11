import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  CodeBlock,
  DynamicTable,
  Heading,
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
  User,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// 草稿列的固定代號（只在前端用，送出前會拿掉）
let nextUid = 0;
const withUid = (row) => ({ ...row, uid: `r${nextUid++}` });

// 草稿列的證據類型選單固定寬度，避免被擠到只剩一個字
const evidenceSelectStyle = xcss({ width: '160px' });

// 議題面板：沒有工作單／草稿／已核准三種狀態，加上證據細節與覆核的對話框。
// 所有寫入都經過 resolver，resolver 會用 context 決定議題與使用者並檢查編輯權限。

const EVIDENCE_OPTIONS = ['test', 'analysis', 'review', 'demo'].map((value) => ({ label: value, value }));

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

const formatTime = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '');

// 呼叫 resolver，把 { ok:false } 轉成例外，讓畫面統一處理錯誤
async function call(name, payload) {
  const result = await invoke(name, payload);
  if (!result?.ok) throw new Error(result?.error?.message ?? 'Request failed.');
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

  return (
    <Stack space="space.150">
      <Heading size="xsmall">{`Draft work order (revision ${nextRev})`}</Heading>
      <Text size="small" color="color.text.subtle">
        {draft.source === 'agent'
          ? 'Proposed by an AI agent. Review every criterion before approving.'
          : 'Edit the criteria and choose the evidence each one needs. Agents cannot read this until you approve it.'}
      </Text>
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

function EvidenceModal({ criterion, onClose }) {
  const ev = criterion.latestEvidence;
  const verdict = VERDICT_LOZENGE[ev.verdict] ?? { appearance: 'default', text: ev.verdict };
  return (
    <Modal onClose={onClose}>
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
            <Text weight="semibold">Agent</Text>
            <Text>{ev.agentName}</Text>
          </Inline>
          <Inline space="space.100" alignBlock="center">
            <Text weight="semibold">Submitted by</Text>
            {ev.submittedBy && ev.submittedBy !== 'unknown' ? <User accountId={ev.submittedBy} /> : <Text>Unknown</Text>}
            <Text>{formatTime(ev.at)}</Text>
          </Inline>
          <Inline space="space.100" alignBlock="center">
            <Text weight="semibold">Event</Text>
            <Text>{`#${ev.seq} · hash ${ev.hash.slice(0, 12)}`}</Text>
          </Inline>
          {criterion.review ? (
            <Inline space="space.100" alignBlock="center">
              <Text weight="semibold">Review</Text>
              <Text>{criterion.review.decision === 'accept' ? 'Accepted by' : 'Rejected by'}</Text>
              <User accountId={criterion.review.reviewedBy} />
              <Text>{criterion.review.note ? `“${criterion.review.note}”` : ''}</Text>
            </Inline>
          ) : null}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  );
}

function ReviewModal({ criterion, decision, busy, onConfirm, onClose }) {
  const [note, setNote] = useState('');
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>{`${decision === 'accept' ? 'Accept' : 'Reject'} evidence for ${criterion.id}`}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.100">
          <Text>{criterion.latestEvidence.summary}</Text>
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

function WorkOrderTable({ view, onDetails, onReview }) {
  const head = {
    cells: [
      { key: 'id', content: 'ID', width: 8 },
      { key: 'text', content: 'Criterion', width: 30 },
      { key: 'type', content: 'Required', width: 10 },
      { key: 'status', content: 'Status', width: 16 },
      { key: 'latest', content: 'Latest evidence', width: 22 },
      { key: 'review', content: 'Review', width: 14 },
    ],
  };
  const rows = view.state.criteria.map((criterion) => {
    const status = STATUS_LOZENGE[criterion.status];
    const ev = criterion.latestEvidence;
    const verdict = ev ? VERDICT_LOZENGE[ev.verdict] : null;
    return {
      key: criterion.id,
      cells: [
        { key: 'id', content: criterion.id },
        { key: 'text', content: criterion.text },
        { key: 'type', content: criterion.evidenceType },
        { key: 'status', content: <Lozenge appearance={status.appearance}>{status.text}</Lozenge> },
        {
          key: 'latest',
          content: ev ? (
            <Stack space="space.050">
              <Lozenge appearance={verdict.appearance}>{verdict.text}</Lozenge>
              <Text size="small">{formatTime(ev.at)}</Text>
              <Text maxLines={2}>{ev.summary}</Text>
              <Button appearance="subtle" spacing="compact" onClick={() => onDetails(criterion)}>
                Details
              </Button>
            </Stack>
          ) : (
            <Text color="color.text.subtle">None yet</Text>
          ),
        },
        {
          key: 'review',
          content:
            criterion.status === 'submitted' && view.canEdit ? (
              <ButtonGroup label={`Review ${criterion.id}`}>
                <Button spacing="compact" onClick={() => onReview(criterion, 'accept')}>
                  Accept
                </Button>
                <Button spacing="compact" appearance="subtle" onClick={() => onReview(criterion, 'reject')}>
                  Reject
                </Button>
              </ButtonGroup>
            ) : criterion.status === 'submitted' ? (
              <Text size="small">Awaiting reviewer</Text>
            ) : (
              <Text size="small">{criterion.review?.note ?? ''}</Text>
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

  const load = async () => {
    setLoadError(null);
    try {
      setView(await call('getPanel'));
    } catch (error) {
      setLoadError(error.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // 每個按鈕動作都回傳更新後的整個面板資料
  const run = async (name, label, payload) => {
    setBusy(label);
    setActionError(null);
    try {
      setView(await call(name, payload));
      return true;
    } catch (error) {
      setActionError(error.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <SectionMessage appearance="error" title="Could not load Evidence Chain" actions={[<SectionMessageAction key="retry" onClick={load}>Try again</SectionMessageAction>]}>
        <Text>{loadError}</Text>
      </SectionMessage>
    );
  }
  if (!view) return <Spinner label="Loading work order" />;

  const { workOrder, draft, state, chain, stale, canEdit } = view;
  const nextRev = (workOrder?.rev ?? 0) + 1;

  return (
    <Stack space="space.200">
      {actionError ? (
        <SectionMessage appearance="error" title="That did not work">
          <Text>{actionError}</Text>
        </SectionMessage>
      ) : null}

      {!workOrder && !draft ? (
        <Stack space="space.100">
          <Text>No work order yet. Draft one from this issue's acceptance criteria, then approve it so AI agents can report evidence for each criterion.</Text>
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
            <Text size="small">{`on ${formatTime(workOrder.approvedAt)} · ${state.accepted}/${state.total} accepted · ${state.gapCount} gaps · ${chain.count} events`}</Text>
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
          <WorkOrderTable view={view} onDetails={setDetails} onReview={(criterion, decision) => setReview({ criterion, decision })} />
          {state.previousRevisions?.length ? (
            <Text size="small" color="color.text.subtle">
              {`Earlier revisions: ${state.previousRevisions
                .map((p) => `revision ${p.rev} had ${p.evidenceCount} evidence ${p.evidenceCount === 1 ? 'record' : 'records'} (${p.accepted}/${p.total} accepted)`)
                .join('; ')}. They stay in the chain but do not count toward revision ${workOrder.rev}, so agents report again for this revision.`}
            </Text>
          ) : null}
          {canEdit && !draft && !stale ? (
            <Inline>
              <Button appearance="subtle" onClick={() => run('draftFromDescription', 'draft')}>
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
          onApprove={(rows) => run('approve', 'approve', { criteria: rows })}
          onDiscard={() => run('discardDraft', 'discard')}
        />
      ) : null}
      {draft && !canEdit ? <Text size="small">{`A draft for revision ${nextRev} is waiting for someone with edit permission to approve it.`}</Text> : null}

      {/* Shown only when the backend reports the development-only tools as enabled; production never does */}
      {view.devTools && workOrder ? (
        <Stack space="space.100">
          <Heading size="xsmall">Developer tools (development environment only)</Heading>
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
        </Stack>
      ) : null}

      <ModalTransition>
        {details ? <EvidenceModal criterion={details} onClose={() => setDetails(null)} /> : null}
        {review ? (
          <ReviewModal
            criterion={review.criterion}
            decision={review.decision}
            busy={busy === 'review'}
            onClose={() => setReview(null)}
            onConfirm={async (note) => {
              const done = await run('review', 'review', { evidenceSeq: review.criterion.latestEvidence.seq, decision: review.decision, note });
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
