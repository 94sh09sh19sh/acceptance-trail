import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Inline,
  LoadingButton,
  Lozenge,
  SectionMessage,
  SectionMessageAction,
  Spinner,
  Stack,
  Text,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { countLabel } from '../core/text.js';

// 議題內容面板（議題頁面的右欄）。Jira 一定會顯示它的標題，
// 所以使用者不用先加任何東西就找得到 Evidence Chain。這裡只是唯讀摘要；
// 起草、核准與覆核都在完整的 Evidence Chain 議題面板裡進行。

const STATUS_LOZENGE = {
  'no-evidence': { appearance: 'default', text: 'No evidence' },
  submitted: { appearance: 'inprogress', text: 'Awaiting review' },
  accepted: { appearance: 'success', text: 'Accepted' },
  rejected: { appearance: 'removed', text: 'Rejected' },
};

function OpenFullPanel({ canEdit }) {
  return canEdit ? (
    <Text size="small">
      To draft, approve or review, open the full panel: select the app actions icon under the work item title, then Evidence Chain.
    </Text>
  ) : (
    <Text size="small">People with permission to edit this work item can draft, approve and review in the full Evidence Chain panel.</Text>
  );
}

// 展開內容的重新整理。收合時的狀態標籤由 Jira 決定何時重算，app 無法要求它更新。
function RefreshButton({ refreshing, onRefresh }) {
  return (
    <Inline>
      <LoadingButton spacing="compact" appearance="subtle" isLoading={refreshing} onClick={onRefresh}>
        Refresh
      </LoadingButton>
    </Inline>
  );
}

function App() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setError(null);
    setRefreshing(true);
    try {
      const result = await invoke('getPanel');
      if (!result?.ok) throw new Error(result?.error?.message ?? 'Request failed.');
      setView(result.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <SectionMessage appearance="error" title="Could not load Evidence Chain" actions={[<SectionMessageAction key="retry" onClick={load}>Try again</SectionMessageAction>]}>
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!view) return <Spinner label="Loading evidence status" />;

  const { workOrder, draft, state, chain, stale, canEdit } = view;

  if (!workOrder) {
    return (
      <Stack space="space.100">
        <Text>{draft ? 'A draft for revision 1 is waiting for approval.' : 'No work order yet.'}</Text>
        <Text size="small">
          A work order turns this work item's acceptance criteria into a checklist that AI coding agents report evidence against.
        </Text>
        <OpenFullPanel canEdit={canEdit} />
        <RefreshButton refreshing={refreshing} onRefresh={load} />
      </Stack>
    );
  }

  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Text weight="semibold">{`Revision ${workOrder.rev}`}</Text>
        <Lozenge appearance={chain.verified ? 'success' : 'removed'} isBold>
          {chain.verified ? 'Chain verified' : 'Chain broken'}
        </Lozenge>
      </Inline>
      <Text size="small">{`${state.accepted}/${state.total} accepted · ${countLabel(state.gapCount, 'gap')}`}</Text>
      {stale ? <Lozenge appearance="moved">Description changed after approval</Lozenge> : null}
      {draft ? <Text size="small">{`A draft for revision ${workOrder.rev + 1} is waiting for approval.`}</Text> : null}
      <Stack space="space.050">
        {state.criteria.map((criterion) => {
          const status = STATUS_LOZENGE[criterion.status];
          return (
            <Inline key={criterion.id} space="space.100" alignBlock="center" shouldWrap>
              <Text weight="semibold">{criterion.id}</Text>
              <Lozenge appearance={status.appearance}>{status.text}</Lozenge>
              {/* 狀態已經能表示沒有證據、未覆核或被駁回；只有判定為失敗時才需要另外標記 */}
              {criterion.gap === 'failed' ? <Lozenge appearance="removed">Failed</Lozenge> : null}
            </Inline>
          );
        })}
      </Stack>
      <OpenFullPanel canEdit={canEdit} />
      <RefreshButton refreshing={refreshing} onRefresh={load} />
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
