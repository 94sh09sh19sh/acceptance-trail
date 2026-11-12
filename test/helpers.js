// 測試用的記憶體版 store 與假的 Jira。每個操作都先讓出事件迴圈，
// 讓同時進行的寫入真的會交錯，才測得出競爭問題。

const tick = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function createMemoryStore() {
  const data = new Map();
  return {
    data,
    async get(key) {
      await tick();
      return clone(data.get(key));
    },
    async set(key, value) {
      await tick();
      data.set(key, clone(value));
    },
    async delete(key) {
      await tick();
      data.delete(key);
    },
    async setIfAbsent(key, value) {
      await tick();
      if (data.has(key)) return false;
      data.set(key, clone(value));
      return true;
    },
    async listByPrefix(prefix) {
      await tick();
      return [...data.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: clone(value) }));
    },
  };
}

// 假的 Jira：issues 以 issueId 為鍵；hidden 裡的 issueId 對呼叫者不可見。
// properties 記錄鏡射的 issue property（鍵為 "issueId/propertyKey"），propertyWrites 記錄每次寫入是用誰的身分；
// failPropertyWrites 為 true 時寫入一律失敗，用來測鏡射失敗不影響主寫入。
export function createFakeJira({ issues = [], projects = [], hidden = [], editors = true, failPropertyWrites = false } = {}) {
  const byId = new Map(issues.map((issue) => [issue.issueId, issue]));
  const hiddenSet = new Set(hidden.map(String));
  const properties = new Map();
  const propertyWrites = [];
  const writeProperty = (as) => async (issueId, key, value) => {
    await tick();
    propertyWrites.push(as);
    if (fake.failPropertyWrites) throw new Error('Jira responded with status 503');
    properties.set(`${issueId}/${key}`, structuredClone(value));
  };
  const fake = {
    issues: byId,
    properties,
    propertyWrites,
    failPropertyWrites,
    setIssueProperty: writeProperty('user'),
    setIssuePropertyAsApp: writeProperty('app'),
    async deleteIssueProperty(issueId, key) {
      await tick();
      properties.delete(`${issueId}/${key}`);
    },
    async getIssue(ref) {
      const issue = byId.get(String(ref)) ?? [...byId.values()].find((i) => i.issueKey === ref);
      if (!issue || hiddenSet.has(issue.issueId)) return null;
      return structuredClone(issue);
    },
    // 背景（trigger）讀取：app 看得到每個議題，不論是否被隱藏
    async getIssueAsApp(issueId) {
      const issue = byId.get(String(issueId));
      return issue ? structuredClone(issue) : null;
    },
    async getProject(key) {
      const project = projects.find((p) => p.projectKey === key);
      return project ? { ...project } : null;
    },
    async filterVisibleIssueIds(ids) {
      return ids.map(String).filter((id) => !hiddenSet.has(id));
    },
    async canEditIssue() {
      return editors;
    },
  };
  return fake;
}

export function sequentialClock(start = Date.UTC(2026, 10, 10, 0, 0, 0)) {
  let t = start;
  return () => {
    t += 1000;
    return new Date(t).toISOString();
  };
}

export function adfDoc(...content) {
  return { type: 'doc', version: 1, content };
}
export const p = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
export const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
export const ul = (...items) => ({
  type: 'bulletList',
  content: items.map((item) => (typeof item === 'string' ? { type: 'listItem', content: [p(item)] } : item)),
});
