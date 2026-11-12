import forgeApi, { route } from '@forge/api';

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

// Forge API 物件由外部注入，讓權限相關路徑可以用模擬的 Jira 回應來測試
// （test/permissions.test.js）。正式環境使用下面的 jiraClient。
export function createJiraClient(api) {
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

  // 用 asApp() 檢查某位使用者能否編輯某個議題，規則同 appCheckBrowse
  async function appCheckEdit(accountId, issueId) {
    if (!accountId || accountId === 'unknown') return false;
    const response = await api.asApp().requestJira(route`/rest/api/3/permissions/check`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, projectPermissions: [{ permissions: ['EDIT_ISSUES'], issues: [Number(issueId)] }] }),
    });
    if (!response.ok) return false;
    const body = await readJson(response);
    const grant = (body?.projectPermissions ?? []).find((p) => p.permission === 'EDIT_ISSUES');
    return (grant?.issues ?? []).map(String).includes(String(issueId));
  }

  return {
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

    // 背景工作（議題更新 trigger）讀取議題用，這種情況沒有可代表的使用者。
    // 結果只用來重算已儲存的摘要，不會回傳給任何呼叫端。
    async getIssueAsApp(issueId) {
      const response = await api
        .asApp()
        .requestJira(route`/rest/api/3/issue/${issueId}?fields=summary,description,project`, { headers: { Accept: 'application/json' } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Jira responded with status ${response.status}`);
      const body = await readJson(response);
      return body ? toIssue(body) : null;
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

    // 寫入（面板的起草、核准、覆核，以及 MCP 的 submit-evidence、propose-work-order）需要該議題的編輯權限。
    // 和讀取一樣先用 asUser()；asUser 拋例外或回 401/403 時，才改用 asApp() 對呼叫者的 accountId 明確查 EDIT_ISSUES。
    // 其他錯誤（404、5xx、空回應）一律視為沒有權限。accountId 不明時不嘗試退回，直接視為沒有權限。
    async canEditIssue(issueId, caller) {
      let response = null;
      try {
        response = await api
          .asUser()
          .requestJira(route`/rest/api/3/mypermissions?issueId=${issueId}&permissions=EDIT_ISSUES`, {
            headers: { Accept: 'application/json' },
          });
      } catch {
        response = null;
      }
      if (response?.ok) {
        const body = await readJson(response);
        return Boolean(body?.permissions?.EDIT_ISSUES?.havePermission);
      }
      if (response && response.status !== 401 && response.status !== 403) return false;
      return appCheckEdit(caller?.accountId, issueId);
    },

    // 延伸功能 4：把摘要鏡射到 issue property，讓 JQL 查得到（manifest 的 jira:entityProperty 負責編入索引）。
    // 有使用者的路徑一律 asUser()，Jira 會要求呼叫者有瀏覽與編輯權限；失敗就拋出，由呼叫端記 log 後繼續。
    async setIssueProperty(issueId, propertyKey, value) {
      const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueId}/properties/${propertyKey}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error(`Jira responded with status ${response.status}`);
    },

    // trigger 沒有使用者，只能用 app 身分寫（和 getIssueAsApp 同一個例外）
    async setIssuePropertyAsApp(issueId, propertyKey, value) {
      const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}/properties/${propertyKey}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error(`Jira responded with status ${response.status}`);
    },

    // 僅限開發用的重設會呼叫；本來就沒有這個 property（404）也算成功
    async deleteIssueProperty(issueId, propertyKey) {
      const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueId}/properties/${propertyKey}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok && response.status !== 404) throw new Error(`Jira responded with status ${response.status}`);
    },
  };
}

export const jiraClient = createJiraClient(forgeApi);
