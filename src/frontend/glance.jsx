import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Inline,
  Lozenge,
  SectionMessage,
  SectionMessageAction,
  Spinner,
  Stack,
  Text,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// Issue context panel (right-hand column of the issue view). Jira always shows its header,
// so people find Evidence Chain without adding anything first. It is a read-only summary;
// drafting, approving and reviewing happen in the full Evidence Chain issue panel.

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

function App() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    setError(null);
    try {
      const result = await invoke('getPanel');
      if (!result?.ok) throw new Error(result?.error?.message ?? 'Request failed.');
      setView(result.data);
    } catch (e) {
      setError(e.message);
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
      <Text size="small">{`${state.accepted}/${state.total} accepted · ${state.gapCount} ${state.gapCount === 1 ? 'gap' : 'gaps'}`}</Text>
      {stale ? <Lozenge appearance="moved">Description changed after approval</Lozenge> : null}
      {draft ? <Text size="small">{`A draft for revision ${workOrder.rev + 1} is waiting for approval.`}</Text> : null}
      <Stack space="space.050">
        {state.criteria.map((criterion) => {
          const status = STATUS_LOZENGE[criterion.status];
          return (
            <Inline key={criterion.id} space="space.100" alignBlock="center" shouldWrap>
              <Text weight="semibold">{criterion.id}</Text>
              <Lozenge appearance={status.appearance}>{status.text}</Lozenge>
              {/* The status already says no evidence, unreviewed or rejected; only a failing verdict needs its own marker */}
              {criterion.gap === 'failed' ? <Lozenge appearance="removed">Failed</Lozenge> : null}
            </Inline>
          );
        })}
      </Stack>
      <OpenFullPanel canEdit={canEdit} />
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
