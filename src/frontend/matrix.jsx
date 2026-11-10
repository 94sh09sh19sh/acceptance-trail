import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Label,
  Link,
  List,
  ListItem,
  Lozenge,
  SectionMessage,
  SectionMessageAction,
  Select,
  Spinner,
  Stack,
  Text,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// 專案頁：追溯矩陣。每列一個有工作單的議題，可依缺口種類篩選；表格每頁 50 列。

const GAP_LABELS = {
  'no-evidence': { text: 'No evidence', appearance: 'default' },
  failed: { text: 'Failed', appearance: 'removed' },
  unreviewed: { text: 'Unreviewed', appearance: 'inprogress' },
  rejected: { text: 'Rejected', appearance: 'removed' },
  stale: { text: 'Stale', appearance: 'moved' },
};

const ALL = { label: 'All issues', value: 'all' };
const FILTER_OPTIONS = [ALL, { label: 'Any gap', value: 'any' }, ...Object.entries(GAP_LABELS).map(([value, g]) => ({ label: g.text, value }))];

const statStyle = xcss({
  padding: 'space.150',
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderRadius: 'border.radius',
  minWidth: '140px',
});

function Stat({ label, value }) {
  return (
    <Box xcss={statStyle}>
      <Stack space="space.050">
        <Heading size="medium">{String(value)}</Heading>
        <Text size="small" color="color.text.subtle">
          {label}
        </Text>
      </Stack>
    </Box>
  );
}

function GettingStarted() {
  return (
    <Stack space="space.200">
      <EmptyState
        header="No work orders in this project yet"
        description="Evidence Chain links AI agent evidence to each acceptance criterion and shows the gaps here."
      />
      <List type="ordered">
        <ListItem>Open an issue and use the Evidence Chain panel to draft a work order from its acceptance criteria.</ListItem>
        <ListItem>Review the criteria and approve the work order. Only people can approve.</ListItem>
        <ListItem>Connect your AI coding agent to the Evidence Chain MCP server. It reads the work order and reports evidence for each criterion, which you then accept or reject.</ListItem>
      </List>
    </Stack>
  );
}

function matches(issue, filter) {
  if (filter === 'all') return true;
  if (filter === 'any') return issue.gapCount > 0;
  return issue.gapKinds.includes(filter);
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState(ALL);

  const load = async () => {
    setError(null);
    try {
      const result = await invoke('getMatrix');
      if (!result?.ok) throw new Error(result?.error?.message ?? 'Request failed.');
      setData(result.data);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <SectionMessage appearance="error" title="Could not load the traceability matrix" actions={[<SectionMessageAction key="retry" onClick={load}>Try again</SectionMessageAction>]}>
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!data) return <Spinner label="Loading traceability matrix" />;
  if (data.issues.length === 0) return <GettingStarted />;

  const rows = data.issues
    .filter((issue) => matches(issue, filter.value))
    .map((issue) => ({
      key: issue.issueId,
      cells: [
        { key: 'key', content: <Link href={`/browse/${issue.issueKey}`}>{issue.issueKey}</Link> },
        { key: 'title', content: issue.title },
        { key: 'rev', content: `rev ${issue.rev}` },
        { key: 'progress', content: `${issue.accepted}/${issue.total}` },
        {
          key: 'gaps',
          content:
            issue.gapCount === 0 ? (
              <Lozenge appearance="success">No gaps</Lozenge>
            ) : (
              <Inline space="space.050" shouldWrap>
                {issue.gapKinds.map((kind) => (
                  <Lozenge key={kind} appearance={GAP_LABELS[kind]?.appearance ?? 'default'}>
                    {`${GAP_LABELS[kind]?.text ?? kind}${kind === 'stale' ? '' : ` ×${issue.criteria.filter((c) => c.gap === kind).length}`}`}
                  </Lozenge>
                ))}
              </Inline>
            ),
        },
      ],
    }));

  return (
    <Stack space="space.200">
      <Inline space="space.150" shouldWrap>
        <Stat label="Issues with work orders" value={data.totals.issues} />
        <Stat label="Acceptance criteria" value={data.totals.criteria} />
        <Stat label="Accepted" value={data.totals.accepted} />
        <Stat label="Gaps" value={data.totals.gaps} />
      </Inline>
      <Inline space="space.100" alignBlock="center">
        <Label labelFor="gap-filter">Filter by gap</Label>
        <Select inputId="gap-filter" options={FILTER_OPTIONS} value={filter} onChange={(option) => setFilter(option ?? ALL)} />
      </Inline>
      <DynamicTable
        caption={`Traceability matrix for ${data.projectKey}`}
        head={{
          cells: [
            { key: 'key', content: 'Issue', width: 10 },
            { key: 'title', content: 'Title', width: 42 },
            { key: 'rev', content: 'Work order', width: 12 },
            { key: 'progress', content: 'Accepted', width: 10 },
            { key: 'gaps', content: 'Gaps', width: 26 },
          ],
        }}
        rows={rows}
        rowsPerPage={50}
        emptyView={<Text>No issues match this filter.</Text>}
      />
      <Text size="small" color="color.text.subtle">
        Stale markers update when someone opens the issue panel or an agent reads the work order.
      </Text>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
