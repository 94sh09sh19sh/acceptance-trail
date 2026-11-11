import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  TextArea,
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

const FORMAT_OPTIONS = [
  { label: 'Markdown (.md)', value: 'markdown' },
  { label: 'CSV (.csv)', value: 'csv' },
];

// Audit pack export. UI Kit cannot start a file download, so the pack is shown as text to copy
// into a file with the suggested name.
function ExportModal({ onClose }) {
  const [format, setFormat] = useState(FORMAT_OPTIONS[0]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = async (option) => {
    setFormat(option);
    setResult(null);
    setError(null);
    try {
      const response = await invoke('exportAudit', { format: option.value });
      if (!response?.ok) throw new Error(response?.error?.message ?? 'Request failed.');
      setResult(response.data);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load(FORMAT_OPTIONS[0]);
  }, []);

  return (
    <Modal onClose={onClose} width="x-large">
      <ModalHeader>
        <ModalTitle>Export audit pack</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          <Inline space="space.100" alignBlock="center">
            <Label labelFor="export-format">Format</Label>
            <Select inputId="export-format" options={FORMAT_OPTIONS} value={format} onChange={(option) => option && load(option)} />
          </Inline>
          {error ? (
            <SectionMessage appearance="error" title="Could not build the audit pack">
              <Text>{error}</Text>
            </SectionMessage>
          ) : null}
          {!result && !error ? <Spinner label="Building audit pack" /> : null}
          {result ? (
            <Stack space="space.100">
              <Text size="small">
                {`${result.issueCount} issues. Select all text in the box, copy it, and save it as ${result.fileName}. People appear as Atlassian account IDs; the app does not store names.`}
              </Text>
              {/* key forces a fresh uncontrolled box per format; UI Kit inputs must not bind value */}
              <TextArea key={`${result.format}-${result.content.length}`} id="export-content" defaultValue={result.content} isReadOnly isMonospaced minimumRows={16} resize="vertical" />
            </Stack>
          ) : null}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
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
  const [exporting, setExporting] = useState(false);

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
      <Inline space="space.100" alignBlock="center" spread="space-between">
        <Inline space="space.100" alignBlock="center">
          <Label labelFor="gap-filter">Filter by gap</Label>
          <Select inputId="gap-filter" options={FILTER_OPTIONS} value={filter} onChange={(option) => setFilter(option ?? ALL)} />
        </Inline>
        <Button iconBefore="download" onClick={() => setExporting(true)}>
          Export audit pack
        </Button>
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
        Stale markers update automatically a few minutes after an issue description changes.
      </Text>
      <ModalTransition>{exporting ? <ExportModal onClose={() => setExporting(false)} /> : null}</ModalTransition>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
