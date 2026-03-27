import { describe, it, expect, vi } from 'vitest';
import worker, { processBatch, processKey } from './index.js';

const BATCH_SIZE = 200;

function makeKv(store = {}) {
  const data = { ...store };
  return {
    list: vi.fn(async () => ({
      keys: Object.keys(data).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    })),
    get: vi.fn(async (key) => data[key] ?? null),
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
    BACKUP_QUEUE: { send: vi.fn() },
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

    // safeKey encodes each segment individually — 'org' and 'cfg' have no special chars
    const safeKey = 'org/cfg';
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
    const env = makeEnv(
      { 'org/cfg': '{"a":2}' },
      { 'org/cfg/latest.json': '{"a":1}' },
    );
    await processKey('org/cfg', env, '2026-03-26T07-00-00-000Z');
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });

  it('skips write when the value is unchanged', async () => {
    const env = makeEnv(
      { 'org/cfg': '{"a":1}' },
      { 'org/cfg/latest.json': '{"a":1}' },
    );
    await processKey('org/cfg', env, '2026-03-26T06-00-00-000Z');
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
  });

  it('encodes special characters in each R2 key segment', async () => {
    const key = 'org/sub path?query=1';
    const env = makeEnv({ [key]: '{}' });
    await processKey(key, env, '2026-03-26T06-00-00-000Z');

    // 'org' unchanged, 'sub path?query=1' → 'sub%20path%3Fquery%3D1'
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
  it('returns done:true when list_complete is true', async () => {
    const env = makeEnv({ key1: 'val1' });
    const result = await processBatch(env, null, '2026-03-27T06-00-00-000Z');
    expect(result).toEqual({ done: true, cursor: null });
  });

  it('returns done:false with next cursor when list_complete is false', async () => {
    const kv = {
      list: vi.fn().mockResolvedValueOnce({
        keys: [{ name: 'key1' }],
        list_complete: false,
        cursor: 'next-cursor',
      }),
      get: vi.fn(async () => 'val1'),
    };
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: makeR2() };
    const result = await processBatch(env, null, '2026-03-27T06-00-00-000Z');
    expect(result).toEqual({ done: false, cursor: 'next-cursor' });
  });

  it('passes cursor to the list call', async () => {
    const env = makeEnv({});
    await processBatch(env, 'some-cursor', '2026-03-27T06-00-00-000Z');
    expect(env.DA_CONFIG.list).toHaveBeenCalledWith({ cursor: 'some-cursor', limit: BATCH_SIZE });
  });

  it('uses undefined (not null) when cursor is null', async () => {
    const env = makeEnv({});
    await processBatch(env, null, '2026-03-27T06-00-00-000Z');
    expect(env.DA_CONFIG.list).toHaveBeenCalledWith({ cursor: undefined, limit: BATCH_SIZE });
  });

  it('processes all listed keys', async () => {
    const env = makeEnv({ k1: 'v1', k2: 'v2' });
    await processBatch(env, null, '2026-03-27T06-00-00-000Z');
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(4); // 2 keys × 2 puts each
  });
});

// ─── queue handler ───────────────────────────────────────────────────────────

describe('queue handler', () => {
  it('sends next batch message with delay when not done', async () => {
    const kv = {
      list: vi.fn().mockResolvedValueOnce({
        keys: [{ name: 'key1' }],
        list_complete: false,
        cursor: 'cur1',
      }),
      get: vi.fn(async () => 'val1'),
    };
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: makeR2(), BACKUP_QUEUE: { send: vi.fn() } };
    const message = { body: { cursor: null, timestamp: '2026-03-27T06-00-00-000Z' }, ack: vi.fn() };

    await worker.queue({ messages: [message] }, env);

    expect(env.BACKUP_QUEUE.send).toHaveBeenCalledWith(
      { cursor: 'cur1', timestamp: '2026-03-27T06-00-00-000Z' },
    );
    expect(message.ack).toHaveBeenCalled();
  });

  it('does not send a follow-up message when done', async () => {
    const env = makeEnv({ key1: 'val1' });
    const message = { body: { cursor: null, timestamp: '2026-03-27T06-00-00-000Z' }, ack: vi.fn() };

    await worker.queue({ messages: [message] }, env);

    expect(env.BACKUP_QUEUE.send).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });
});

// ─── fetch handler ───────────────────────────────────────────────────────────

describe('fetch handler', () => {
  it('returns 404 for unknown paths', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('http://localhost/'), env);
    expect(res.status).toBe(404);
  });

  it('runs full backup and returns 200 for /run', async () => {
    const env = makeEnv({ cfg: '{"v":1}' });
    const res = await worker.fetch(new Request('http://localhost/run'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Backup complete');
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
  });

  it('drains multiple pages for /run when keys span batches', async () => {
    const kv = {
      list: vi.fn()
        .mockResolvedValueOnce({ keys: [{ name: 'k1' }], list_complete: false, cursor: 'c1' })
        .mockResolvedValueOnce({ keys: [{ name: 'k2' }], list_complete: true, cursor: undefined }),
      get: vi.fn(async () => 'val'),
    };
    const r2 = makeR2();
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: r2, BACKUP_QUEUE: { send: vi.fn() } };
    const res = await worker.fetch(new Request('http://localhost/run'), env);
    expect(res.status).toBe(200);
    expect(r2.put).toHaveBeenCalledTimes(4); // k1 + k2, 2 puts each
  });
});

// ─── scheduled handler ───────────────────────────────────────────────────────

describe('scheduled handler', () => {
  it('enqueues a new backup message with null cursor', async () => {
    const env = makeEnv();
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    await worker.scheduled({ cron: '0 6 * * *' }, env, ctx);
    await waited[0];
    expect(env.BACKUP_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: null, timestamp: expect.any(String) }),
    );
  });
});
