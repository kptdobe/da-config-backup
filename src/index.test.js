import { describe, it, expect, vi } from 'vitest';
import worker, { runBackup, processKey } from './index.js';

function makeKv(store = {}) {
  return {
    list: vi.fn(async () => ({
      keys: Object.keys(store).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    })),
    get: vi.fn(async (key) => store[key] ?? null),
  };
}

function makeR2(store = {}) {
  const bucket = {
    _store: { ...store },
    get: vi.fn(async (key) => {
      const val = bucket._store[key];
      if (val === undefined) return null;
      return { text: async () => val };
    }),
    put: vi.fn(async (key, value) => {
      bucket._store[key] = value;
    }),
  };
  return bucket;
}

function makeEnv(kvStore = {}, r2Store = {}) {
  return {
    DA_CONFIG: makeKv(kvStore),
    BACKUP_BUCKET: makeR2(r2Store),
  };
}

// ─── processKey ──────────────────────────────────────────────────────────────

describe('processKey', () => {
  it('skips keys whose KV value is null', async () => {
    const env = makeEnv({});
    await processKey('missing-key', env, '2026-03-26T06-00-00-000Z');
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });

  it('writes both archive and latest when no previous backup exists', async () => {
    const env = makeEnv({ 'org/cfg': '{"a":1}' });
    await processKey('org/cfg', env, '2026-03-26T06-00-00-000Z');

    const safeKey = encodeURIComponent('org/cfg');
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledWith(
      `${safeKey}/2026-03-26T06-00-00-000Z.json`,
      '{"a":1}',
      { httpMetadata: { contentType: 'application/json' } },
    );
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledWith(
      `${safeKey}/latest.json`,
      '{"a":1}',
      { httpMetadata: { contentType: 'application/json' } },
    );
  });

  it('writes both archive and latest when the value has changed', async () => {
    const safeKey = encodeURIComponent('org/cfg');
    const env = makeEnv(
      { 'org/cfg': '{"a":2}' },
      { [`${safeKey}/latest.json`]: '{"a":1}' },
    );
    await processKey('org/cfg', env, '2026-03-26T07-00-00-000Z');

    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });

  it('skips write when the value is unchanged', async () => {
    const safeKey = encodeURIComponent('org/cfg');
    const env = makeEnv(
      { 'org/cfg': '{"a":1}' },
      { [`${safeKey}/latest.json`]: '{"a":1}' },
    );
    await processKey('org/cfg', env, '2026-03-26T06-00-00-000Z');

    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });

  it('encodes special characters in the R2 key', async () => {
    const key = 'org/sub path?query=1';
    const env = makeEnv({ [key]: '{}' });
    await processKey(key, env, '2026-03-26T06-00-00-000Z');

    const safeKey = encodeURIComponent(key);
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledWith(
      expect.stringContaining(safeKey),
      '{}',
      expect.any(Object),
    );
  });
});

// ─── runBackup ───────────────────────────────────────────────────────────────

describe('runBackup', () => {
  it('processes all keys returned from KV', async () => {
    const env = makeEnv({ key1: '{"x":1}', key2: '{"x":2}' });
    await runBackup(env);

    // 2 keys × 2 puts each = 4 total
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(4);
  });

  it('does nothing when KV is empty', async () => {
    const env = makeEnv({});
    await runBackup(env);
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });

  it('paginates when list_complete is false', async () => {
    // First call returns cursor, second call returns remaining key
    const kv = {
      list: vi.fn()
        .mockResolvedValueOnce({
          keys: [{ name: 'key1' }],
          list_complete: false,
          cursor: 'cur1',
        })
        .mockResolvedValueOnce({
          keys: [{ name: 'key2' }],
          list_complete: true,
          cursor: undefined,
        }),
      get: vi.fn(async (key) => (key === 'key1' ? 'val1' : 'val2')),
    };
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: makeR2() };
    await runBackup(env);

    expect(kv.list).toHaveBeenCalledTimes(2);
    expect(kv.list).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 1000 });
    expect(kv.list).toHaveBeenNthCalledWith(2, { cursor: 'cur1', limit: 1000 });
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(4);
  });
});

// ─── fetch handler ───────────────────────────────────────────────────────────

describe('fetch handler', () => {
  it('returns 404 for unknown paths', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('http://localhost/'), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('runs backup and returns 200 for /run', async () => {
    const env = makeEnv({ cfg: '{"v":1}' });
    const res = await worker.fetch(new Request('http://localhost/run'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Backup complete');
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });
});

// ─── scheduled handler ───────────────────────────────────────────────────────

describe('scheduled handler', () => {
  it('calls waitUntil with the backup promise', async () => {
    const env = makeEnv({ cfg: '{"v":1}' });
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    await worker.scheduled({}, env, ctx);
    expect(waited).toHaveLength(1);
    await waited[0]; // resolve the backup
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });
});
