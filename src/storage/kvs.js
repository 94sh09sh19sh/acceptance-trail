import { kvs, WhereConditions } from '@forge/kvs';

// Forge KVS 轉接，實作 core/keys.js 說明的 store 介面。
// 查詢單頁上限依文件為 100 筆，用 cursor 讀完全部頁。
const PAGE_SIZE = 100;

// The KVS client is injected so the paging logic can be tested with a fake (test/paging.test.js).
export function createKvsStore(client, where) {
  return {
    get(key) {
      return client.get(key);
    },

    set(key, value) {
      return client.set(key, value);
    },

    delete(key) {
      return client.delete(key);
    },

    // keyPolicy: 'FAIL_IF_EXISTS'：鍵已存在就不覆寫。文件沒有寫明失敗時的錯誤代號，
    // 所以失敗後再讀一次：鍵已存在就當成「被別人搶先寫入」，否則是其他錯誤，照原樣拋出。
    async setIfAbsent(key, value) {
      try {
        await client.set(key, value, { keyPolicy: 'FAIL_IF_EXISTS' });
        return true;
      } catch (error) {
        const existing = await client.get(key);
        if (existing !== undefined) return false;
        throw error;
      }
    },

    async listByPrefix(prefix) {
      const rows = [];
      let cursor;
      do {
        let query = client.query().where('key', where.beginsWith(prefix)).limit(PAGE_SIZE);
        if (cursor) query = query.cursor(cursor);
        const page = await query.getMany();
        rows.push(...page.results.map((r) => ({ key: r.key, value: r.value })));
        cursor = page.nextCursor;
      } while (cursor);
      return rows;
    },
  };
}

export const kvsStore = createKvsStore(kvs, WhereConditions);
