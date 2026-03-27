import { describe, it, expect, vi } from 'vitest';
import worker, {
  startBackup, continueBackup, processBatch, processKey, STATE_KEY, BATCH_SIZE,
} from './index.js';

function makeKv(store = {}) {
  const data = { ...store };
  return {
    list: vi.fn(async () => ({
      keys: Object.keys(data).filter((k) => k !== STATE_KEY).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    })),
    get: vi.fn(async (key) => data[key] ?? null),
    put: vi.fn(async (key, value) => { data[key] = value; }),
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

    // safeKey encodes each segment individually, preserving '/'
    const safeKey = 'org/cfg'; // no special chars in either segment
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
    // safeKey encodes each segment individually — 'org' and 'cfg' have no special chars
    const env = makeEnv(
      { 'org/cfg': '{"a":1}' },
      { 'org/cfg/latest.json': '{"a":1}' },
    );
    await processKey('org/cfg', env, '2026-03-26T06-00-00-000Z');

    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });

  it('encodes special characters in the R2 key', async () => {
    const key = 'org/sub path?query=1';
    const env = makeEnv({ [key]: '{}' });
    await processKey(key, env, '2026-03-26T06-00-00-000Z');

    // Each segment encoded individually: 'org' stays 'org', 'sub path?query=1' → 'sub%20path%3Fquery%3D1'
    const safeKey = 'org/sub%20path%3Fquery%3D1';
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledWith(
      expect.stringContaining(safeKey),
      '{}',
      expect.any(Object),
    );
  });
});

// ─── processBatch ────────────────────────────────────────────────────────────

describe('processBatch', () => {
  it('marks session done when list_complete is true', async () => {
    const env = makeEnv({ key1: 'val1' });
    const state = { cursor: null, timestamp: '2026-03-27T06-00-00-000Z' };
    await processBatch(env, state);
    expect(env.DA_CONFIG.put).toHaveBeenCalledWith(
      STATE_KEY,
      JSON.stringify({ cursor: null, timestamp: '2026-03-27T06-00-00-000Z', done: true }),
    );
  });

  it('saves next cursor when list_complete is false', async () => {
    const kv = {
      list: vi.fn().mockResolvedValueOnce({
        keys: [{ name: 'key1' }],
        list_complete: false,
        cursor: 'next-cursor',
      }),
      get: vi.fn(async () => 'val1'),
      put: vi.fn(),
    };
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: makeR2() };
    const state = { cursor: null, timestamp: '2026-03-27T06-00-00-000Z' };
    await processBatch(env, state);
    expect(kv.put).toHaveBeenCalledWith(
      STATE_KEY,
      JSON.stringify({ cursor: 'next-cursor', timestamp: '2026-03-27T06-00-00-000Z' }),
    );
  });

  it('passes cursor from state to the list call', async () => {
    const env = makeEnv({});
    const state = { cursor: 'some-cursor', timestamp: '2026-03-27T06-00-00-000Z' };
    await processBatch(env, state);
    expect(env.DA_CONFIG.list).toHaveBeenCalledWith({ cursor: 'some-cursor', limit: BATCH_SIZE });
  });

  it('uses undefined cursor (not null) when state.cursor is null', async () => {
    const env = makeEnv({});
    const state = { cursor: null, timestamp: '2026-03-27T06-00-00-000Z' };
    await processBatch(env, state);
    expect(env.DA_CONFIG.list).toHaveBeenCalledWith({ cursor: undefined, limit: BATCH_SIZE });
  });

  it('filters out STATE_KEY from processed keys', async () => {
    const kv = {
      list: vi.fn().mockResolvedValueOnce({
        keys: [{ name: STATE_KEY }, { name: 'real-key' }],
        list_complete: true,
        cursor: undefined,
      }),
      get: vi.fn(async (key) => (key === 'real-key' ? 'val' : null)),
      put: vi.fn(),
    };
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: makeR2() };
    const state = { cursor: null, timestamp: '2026-03-27T06-00-00-000Z' };
    await processBatch(env, state);
    // Only real-key → 2 R2 puts; STATE_KEY skipped
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });

  it('resumes from cursor on a second batch call', async () => {
    const kv = {
      list: vi.fn()
        .mockResolvedValueOnce({ keys: [{ name: 'key1' }], list_complete: false, cursor: 'cur1' })
        .mockResolvedValueOnce({ keys: [{ name: 'key2' }], list_complete: true, cursor: undefined }),
      get: vi.fn(async (key) => (key === 'key1' ? 'val1' : 'val2')),
      put: vi.fn(),
    };
    const r2 = makeR2();
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: r2 };

    await processBatch(env, { cursor: null, timestamp: '2026-03-27T06-00-00-000Z' });
    expect(kv.list).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: BATCH_SIZE });
    expect(r2.put).toHaveBeenCalledTimes(2); // key1

    await processBatch(env, { cursor: 'cur1', timestamp: '2026-03-27T06-00-00-000Z' });
    expect(kv.list).toHaveBeenNthCalledWith(2, { cursor: 'cur1', limit: BATCH_SIZE });
    expect(r2.put).toHaveBeenCalledTimes(4); // key1 + key2
  });
});

// ─── startBackup ─────────────────────────────────────────────────────────────

describe('startBackup', () => {
  it('initializes state with a timestamp and cursor null, then processes first batch', async () => {
    const env = makeEnv({ cfg: '{"v":1}' });
    await startBackup(env);
    const [firstPut] = env.DA_CONFIG.put.mock.calls;
    expect(firstPut[0]).toBe(STATE_KEY);
    const initialState = JSON.parse(firstPut[1]);
    expect(initialState.cursor).toBeNull();
    expect(typeof initialState.timestamp).toBe('string');
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });

  it('marks session done when all keys fit in one batch', async () => {
    const env = makeEnv({ cfg: '{"v":1}' });
    await startBackup(env);
    const lastPut = env.DA_CONFIG.put.mock.calls.at(-1);
    expect(JSON.parse(lastPut[1]).done).toBe(true);
  });

  it('does not process any keys when KV is empty', async () => {
    const env = makeEnv({});
    await startBackup(env);
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });
});

// ─── continueBackup ──────────────────────────────────────────────────────────

describe('continueBackup', () => {
  it('does nothing when no active session', async () => {
    const env = makeEnv({});
    await continueBackup(env);
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });

  it('does nothing when session is marked done', async () => {
    const kv = makeKv({});
    kv.get = vi.fn(async (key) => {
      if (key === STATE_KEY) return JSON.stringify({ cursor: null, timestamp: '2026-03-27T06-00-00-000Z', done: true });
      return null;
    });
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: makeR2() };
    await continueBackup(env);
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });

  it('processes next batch when session has a pending cursor', async () => {
    const timestamp = '2026-03-27T06-00-00-000Z';
    const kv = {
      list: vi.fn().mockResolvedValueOnce({
        keys: [{ name: 'cfg' }],
        list_complete: true,
        cursor: undefined,
      }),
      get: vi.fn(async (key) => {
        if (key === STATE_KEY) return JSON.stringify({ cursor: 'cur1', timestamp });
        return '{"v":1}';
      }),
      put: vi.fn(),
    };
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: makeR2() };
    await continueBackup(env);
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
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

  it('runs full backup and returns 200 for /run', async () => {
    const env = makeEnv({ cfg: '{"v":1}' });
    const res = await worker.fetch(new Request('http://localhost/run'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Backup complete');
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });

  it('drains multiple batches for /run when keys span pages', async () => {
    const kv = {
      list: vi.fn()
        .mockResolvedValueOnce({ keys: [{ name: 'k1' }], list_complete: false, cursor: 'c1' })
        .mockResolvedValueOnce({ keys: [{ name: 'k2' }], list_complete: true, cursor: undefined }),
      get: vi.fn(async (key) => {
        if (key === STATE_KEY) return null; // initial: no session
        return 'val';
      }),
      put: vi.fn(async (key, value) => {
        // Make subsequent get(STATE_KEY) return the latest put value
        if (key === STATE_KEY) {
          kv.get = vi.fn(async (k) => (k === STATE_KEY ? value : 'val'));
        }
      }),
    };
    const r2 = makeR2();
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: r2 };
    const res = await worker.fetch(new Request('http://localhost/run'), env);
    expect(res.status).toBe(200);
    expect(r2.put).toHaveBeenCalledTimes(4); // k1 + k2, 2 puts each
  });
});

// ─── scheduled handler ───────────────────────────────────────────────────────

describe('scheduled handler', () => {
  it('starts a new backup on the daily cron (0 6 * * *)', async () => {
    const env = makeEnv({ cfg: '{"v":1}' });
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    await worker.scheduled({ cron: '0 6 * * *' }, env, ctx);
    expect(waited).toHaveLength(1);
    await waited[0];
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });

  it('processes next batch on the continuation cron when a session is active', async () => {
    const timestamp = '2026-03-27T06-00-00-000Z';
    const kv = {
      list: vi.fn().mockResolvedValueOnce({
        keys: [{ name: 'cfg' }],
        list_complete: true,
        cursor: undefined,
      }),
      get: vi.fn(async (key) => {
        if (key === STATE_KEY) return JSON.stringify({ cursor: 'cur1', timestamp });
        return '{"v":1}';
      }),
      put: vi.fn(),
    };
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: makeR2() };
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    await worker.scheduled({ cron: '*/10 * * * *' }, env, ctx);
    await waited[0];
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });

  it('does nothing on the continuation cron when no session is active', async () => {
    const env = makeEnv({});
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    await worker.scheduled({ cron: '*/10 * * * *' }, env, ctx);
    await waited[0];
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });
});
