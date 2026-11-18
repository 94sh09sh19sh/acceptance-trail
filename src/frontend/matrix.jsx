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
  LoadingButton,
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
import { countLabel } from '../core/text.js';
import { ALL_VERSIONS, describeVersionFilter, filterByVersion, filterFromValue, filterToValue, totalsOf } from '../core/versions.js';

// 專案頁：追溯矩陣。每列一個有工作單的議題，可依缺口種類與修正版本篩選；表格每頁 50 列。
// 修正版本篩選會同時改變表格、上方的統計與稽核包匯出的範圍（延伸功能 5）。

const GAP_LABELS = {
  'no-evidence': { text: 'No evidence', appearance: 'default' },
  failed: { text: 'Failed', appearance: 'removed' },
  unreviewed: { text: 'Unreviewed', appearance: 'inprogress' },
  rejected: { text: 'Rejected', appearance: 'removed' },
  stale: { text: 'Stale', appearance: 'moved' },
};

const ALL = { label: 'All issues', value: 'all' };
const FILTER_OPTIONS = [ALL, { label: 'Any gap', value: 'any' }, ...Object.entries(GAP_LABELS).map(([value, g]) => ({ label: g.text, value }))];

const ALL_VERSIONS_OPTION = { label: 'All versions', value: filterToValue(ALL_VERSIONS) };
const NO_VERSION_OPTION = { label: 'No version', value: 'none' };

// 版本選單：All versions、No version，再加專案的版本（已發版或封存的版本在名稱後標示）
function versionOptions(versions) {
  return [
    ALL_VERSIONS_OPTION,
    NO_VERSION_OPTION,
    ...versions.map((v) => ({ label: `${v.name}${v.archived ? ' (archived)' : v.released ? ' (released)' : ''}`, value: `v:${v.name}` })),
  ];
}

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
        description="Acceptance Trail links AI agent evidence to each acceptance criterion and shows the gaps here."
      />
      <List type="ordered">
        <ListItem>Open an issue and use the Acceptance Trail panel to draft a work order from its acceptance criteria.</ListItem>
        <ListItem>Review the criteria and approve the work order. Only people can approve.</ListItem>
        <ListItem>Connect your AI coding agent to the Acceptance Trail MCP server. It reads the work order and reports evidence for each criterion, which you then accept or reject.</ListItem>
      </List>
    </Stack>
  );
}

const FORMAT_OPTIONS = [
  { label: 'Markdown (.md)', value: 'markdown' },
  { label: 'CSV (.csv)', value: 'csv' },
];

// 稽核包匯出。UI Kit 無法觸發檔案下載，所以把稽核包顯示成文字，
// 讓使用者複製後存成建議的檔名。
function ExportModal({ onClose, versionFilter }) {
  const [format, setFormat] = useState(FORMAT_OPTIONS[0]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = async (option) => {
    setFormat(option);
    setResult(null);
    setError(null);
    try {
      const response = await invoke('exportAudit', { format: option.value, fixVersion: versionFilter });
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
                {`${countLabel(result.issueCount, 'issue')}${result.filter ? `, filtered to ${result.filter}` : ''}. Select all text in the box, copy it, and save it as ${result.fileName}. People appear as Atlassian account IDs; the app does not store names.`}
              </Text>
              {/* 用 key 讓每種格式都換成全新的非受控輸入框；UI Kit 的輸入元件不可綁定 value */}
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
  const [versionOption, setVersionOption] = useState(ALL_VERSIONS_OPTION);
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedAt, setLoadedAt] = useState(null);

  // 首次載入與 Refresh 共用。重新整理時保留目前的表格與篩選，只讓按鈕顯示載入中。
  const load = async () => {
    setError(null);
    setRefreshing(true);
    try {
      const result = await invoke('getMatrix');
      if (!result?.ok) throw new Error(result?.error?.message ?? 'Request failed.');
      setData(result.data);
      setLoadedAt(new Date().toISOString());
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // 已有資料時重新整理失敗：保留表格，在上方顯示錯誤
  const refreshError = error && data ? (
    <SectionMessage appearance="error" title="Could not refresh the traceability matrix">
      <Text>{error}</Text>
    </SectionMessage>
  ) : null;
  const refreshButton = (
    <LoadingButton isLoading={refreshing} onClick={load}>
      Refresh
    </LoadingButton>
  );

  if (error && !data) {
    return (
      <SectionMessage appearance="error" title="Could not load the traceability matrix" actions={[<SectionMessageAction key="retry" onClick={load}>Try again</SectionMessageAction>]}>
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!data) return <Spinner label="Loading traceability matrix" />;
  if (data.issues.length === 0) {
    return (
      <Stack space="space.200">
        {refreshError}
        <GettingStarted />
        <Inline>{refreshButton}</Inline>
      </Stack>
    );
  }

  // 修正版本讀不到時（fixVersionsAvailable 為 false）不顯示版本篩選與欄位，其他功能照常
  const showVersions = data.fixVersionsAvailable !== false;
  const versionFilter = showVersions ? filterFromValue(versionOption.value) : ALL_VERSIONS;
  const inVersion = filterByVersion(data.issues, versionFilter);
  const totals = totalsOf(inVersion);

  const rows = inVersion
    .filter((issue) => matches(issue, filter.value))
    .map((issue) => ({
      key: issue.issueId,
      cells: [
        { key: 'key', content: <Link href={`/browse/${issue.issueKey}`}>{issue.issueKey}</Link> },
        { key: 'title', content: issue.title },
        ...(showVersions ? [{ key: 'version', content: issue.fixVersions === null ? '-' : issue.fixVersions.length ? issue.fixVersions.join(', ') : 'None' }] : []),
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
      {refreshError}
      <Inline space="space.150" shouldWrap>
        <Stat label="Issues with work orders" value={totals.issues} />
        <Stat label="Acceptance criteria" value={totals.criteria} />
        <Stat label="Accepted" value={totals.accepted} />
        <Stat label="Gaps" value={totals.gaps} />
      </Inline>
      <Inline space="space.100" alignBlock="center" spread="space-between" shouldWrap>
        <Inline space="space.200" alignBlock="center" shouldWrap>
          <Inline space="space.100" alignBlock="center">
            <Label labelFor="gap-filter">Filter by gap</Label>
            <Select inputId="gap-filter" options={FILTER_OPTIONS} value={filter} onChange={(option) => setFilter(option ?? ALL)} />
          </Inline>
          {showVersions ? (
            <Inline space="space.100" alignBlock="center">
              <Label labelFor="version-filter">Fix version</Label>
              <Select
                inputId="version-filter"
                options={versionOptions(data.versions ?? [])}
                value={versionOption}
                onChange={(option) => setVersionOption(option ?? ALL_VERSIONS_OPTION)}
              />
            </Inline>
          ) : null}
        </Inline>
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Text size="small" color="color.text.subtle">
            {loadedAt ? `Loaded ${loadedAt.replace('T', ' ').slice(0, 16)} UTC` : ''}
          </Text>
          {refreshButton}
          <Button iconBefore="download" onClick={() => setExporting(true)}>
            Export audit pack
          </Button>
        </Inline>
      </Inline>
      {!showVersions ? (
        <Text size="small" color="color.text.subtle">
          Fix versions could not be loaded, so the version filter is hidden. Select Refresh to try again.
        </Text>
      ) : versionFilter.kind !== 'all' ? (
        <Text size="small" color="color.text.subtle">
          {`Filtered to ${describeVersionFilter(versionFilter)}. The counts above and Export audit pack use the same filter.`}
        </Text>
      ) : null}
      <DynamicTable
        caption={`Traceability matrix for ${data.projectKey}`}
        head={{
          cells: [
            // 視窗窄（約 900 像素、左側欄展開）時議題代號欄太窄會讓 BMS-2 斷成兩行，所以給 12%
            { key: 'key', content: 'Issue', width: 12 },
            { key: 'title', content: 'Title', width: showVersions ? 28 : 40 },
            ...(showVersions ? [{ key: 'version', content: 'Fix version', width: 13 }] : []),
            { key: 'rev', content: 'Work order', width: 11 },
            { key: 'progress', content: 'Accepted', width: 10 },
            { key: 'gaps', content: 'Gaps', width: showVersions ? 26 : 27 },
          ],
        }}
        rows={rows}
        rowsPerPage={50}
        emptyView={<Text>No issues match this filter.</Text>}
      />
      <Text size="small" color="color.text.subtle">
        Stale markers update automatically a few minutes after an issue description changes.
      </Text>
      <ModalTransition>{exporting ? <ExportModal versionFilter={versionFilter} onClose={() => setExporting(false)} /> : null}</ModalTransition>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
