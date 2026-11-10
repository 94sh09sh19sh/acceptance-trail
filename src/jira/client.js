import api, { route } from '@forge/api';

// Jira REST 轉接（規格第 7 節）。
// 先用 asUser()（Jira 會用呼叫者本人的權限把關）；asUser 拋例外或回 401/403 時才改用 asApp()，
// 而且用 asApp() 時一定要另外用 bulk permission API 確認呼叫者有瀏覽權限才回資料。
// asUser 回 404 代表呼叫者看不到或議題不存在，這時不能改用 asApp()，否則會洩漏資料。

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestWithFallback(makeRoute, init) {
  let userResponse = null;
  try {
    userResponse = await api.asUser().requestJira(makeRoute(), init);
  } catch {
    // 沒有使用者身分可用（例如某些呼叫情境），改走 asApp()
    userResponse = null;
  }
  if (userResponse?.ok) return { via: 'user', body: await readJson(userResponse) };
  if (userResponse?.status === 404) return { via: 'user', body: null, notFound: true };
  if (userResponse && userResponse.status !== 401 && userResponse.status !== 403) {
    throw new Error(`Jira responded with status ${userResponse.status}`);
  }
  const appResponse = await api.asApp().requestJira(makeRoute(), init);
  if (appResponse.status === 404) return { via: 'app', body: null, notFound: true };
  if (!appResponse.ok) throw new Error(`Jira responded with status ${appResponse.status}`);
  return { via: 'app', body: await readJson(appResponse) };
}

// 用 asApp() 檢查某位使用者能瀏覽哪些議題（或某個專案）。accountId 不明時一律視為沒有權限。
async function appCheckBrowse(accountId, { issueIds = [], projectIds = [] }) {
  if (!accountId || accountId === 'unknown') return { issues: new Set(), projects: new Set() };
  const response = await api.asApp().requestJira(route`/rest/api/3/permissions/check`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId,
      projectPermissions: [
        { permissions: ['BROWSE_PROJECTS'], issues: issueIds.map(Number), projects: projectIds.map(Number) },
      ],
    }),
  });
  if (!response.ok) return { issues: new Set(), projects: new Set() };
  const body = await readJson(response);
  const grant = (body?.projectPermissions ?? []).find((p) => p.permission === 'BROWSE_PROJECTS');
  return { issues: new Set((grant?.issues ?? []).map(String)), projects: new Set((grant?.projects ?? []).map(String)) };
}

function toIssue(body) {
  return {
    issueId: String(body.id),
    issueKey: body.key,
    title: body.fields?.summary ?? '',
    projectId: String(body.fields?.project?.id ?? ''),
    projectKey: body.fields?.project?.key ?? '',
    description: body.fields?.description ?? null,
  };
}

export const jiraClient = {
  async getIssue(issueRef, caller) {
    const result = await requestWithFallback(
      () => route`/rest/api/3/issue/${issueRef}?fields=summary,description,project`,
      { headers: { Accept: 'application/json' } },
    );
    if (result.notFound || !result.body) return null;
    const issue = toIssue(result.body);
    if (result.via === 'app') {
      const allowed = await appCheckBrowse(caller?.accountId, { issueIds: [issue.issueId] });
      if (!allowed.issues.has(issue.issueId)) return null;
    }
    return issue;
  },

  async getProject(projectKey, caller) {
    const result = await requestWithFallback(() => route`/rest/api/3/project/${projectKey}`, {
      headers: { Accept: 'application/json' },
    });
    if (result.notFound || !result.body) return null;
    const project = { projectId: String(result.body.id), projectKey: result.body.key, name: result.body.name ?? '' };
    if (result.via === 'app') {
      const allowed = await appCheckBrowse(caller?.accountId, { projectIds: [project.projectId] });
      if (!allowed.projects.has(project.projectId)) return null;
    }
    return project;
  },

  // 議題層級的安全性設定可能讓同專案的部分議題看不到，所以逐筆確認（一次最多 1000 筆）
  async filterVisibleIssueIds(issueIds, caller) {
    const visible = [];
    for (let i = 0; i < issueIds.length; i += 1000) {
      const chunk = issueIds.slice(i, i + 1000).map(Number);
      let granted = null;
      try {
        const response = await api.asUser().requestJira(route`/rest/api/3/permissions/check`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPermissions: [{ permissions: ['BROWSE_PROJECTS'], issues: chunk }] }),
        });
        if (response.ok) {
          const body = await readJson(response);
          const grant = (body?.projectPermissions ?? []).find((p) => p.permission === 'BROWSE_PROJECTS');
          granted = new Set((grant?.issues ?? []).map(String));
        }
      } catch {
        granted = null;
      }
      if (!granted) granted = (await appCheckBrowse(caller?.accountId, { issueIds: chunk })).issues;
      visible.push(...chunk.map(String).filter((id) => granted.has(id)));
    }
    return visible;
  },

  // 議題面板的核准與覆核需要該議題的編輯權限（resolver 一定有使用者，所以只用 asUser）
  async canEditIssue(issueId) {
    const response = await api
      .asUser()
      .requestJira(route`/rest/api/3/mypermissions?issueId=${issueId}&permissions=EDIT_ISSUES`, {
        headers: { Accept: 'application/json' },
      });
    if (!response.ok) return false;
    const body = await readJson(response);
    return Boolean(body?.permissions?.EDIT_ISSUES?.havePermission);
  },
};
