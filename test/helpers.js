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

// 假的 Jira：issues 以 issueId 為鍵；hidden 裡的 issueId 對呼叫者不可見
export function createFakeJira({ issues = [], projects = [], hidden = [], editors = true } = {}) {
  const byId = new Map(issues.map((issue) => [issue.issueId, issue]));
  const hiddenSet = new Set(hidden.map(String));
  return {
    issues: byId,
    async getIssue(ref) {
      const issue = byId.get(String(ref)) ?? [...byId.values()].find((i) => i.issueKey === ref);
      if (!issue || hiddenSet.has(issue.issueId)) return null;
      return structuredClone(issue);
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
