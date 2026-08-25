import { describe, it, expect, vi } from 'vitest';
import worker, {
  processBatch,
  processKey,
  extractEwEnabledDefault,
  extractEditorPathOverrides,
  buildEwEntries,
  createEmptyIndex,
  mergeIntoIndex,
} from './index.js';

// The user's real example org config (frescopa) — multi-sheet, ew.enabled=true,
// two editor.path overrides (one canvas, one form).
const REAL_ORG_CONFIG = {
  data: {
    total: 9,
    limit: 9,
    offset: 0,
    data: [
      { key: 'editor.path', value: '/exp-workspace/frescopa/forms=https://da.live/form#' },
      { key: 'aem.repositoryId', value: 'author-p133406-e1301188.adobeaemcloud.com' },
      { key: 'editor.path', value: '/exp-workspace/frescopa=https://da.live/canvas#' },
      { key: '', value: '' },
    ],
    ':colWidths': [226, 812],
  },
  permissions: { total: 0, limit: 0, offset: 0, data: [], ':colWidths': [300, 827, 132, 300] },
  flags: {
    total: 1, limit: 1, offset: 0, data: [{ key: 'ew.enabled', value: 'true' }], ':colWidths': [50, 50],
  },
  ':names': ['data', 'permissions', 'flags'],
  ':version': 3,
  ':type': 'multi-sheet',
};

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

// ─── ew-enabled index parsing ────────────────────────────────────────────────

describe('extractEwEnabledDefault', () => {
  it('returns "canvas" when ew.enabled is the string "true"', () => {
    expect(extractEwEnabledDefault(REAL_ORG_CONFIG)).toBe('canvas');
  });

  it('returns "edit" when ew.enabled is "false"', () => {
    const json = { flags: { data: [{ key: 'ew.enabled', value: 'false' }] } };
    expect(extractEwEnabledDefault(json)).toBe('edit');
  });

  it('returns null when the flags sheet has no ew.enabled row', () => {
    expect(extractEwEnabledDefault({ flags: { data: [] } })).toBeNull();
  });

  it('returns null when there is no flags sheet at all', () => {
    expect(extractEwEnabledDefault({})).toBeNull();
  });
});

describe('extractEditorPathOverrides', () => {
  it('parses both editor.path rows from the real example config', () => {
    expect(extractEditorPathOverrides(REAL_ORG_CONFIG)).toEqual([
      { pathPrefix: '/exp-workspace/frescopa/forms', type: 'form' },
      { pathPrefix: '/exp-workspace/frescopa', type: 'canvas' },
    ]);
  });

  it('classifies a URL that is neither canvas nor form as "edit"', () => {
    const json = { data: { data: [{ key: 'editor.path', value: '/foo=https://da.live/edit#' }] } };
    expect(extractEditorPathOverrides(json)).toEqual([{ pathPrefix: '/foo', type: 'edit' }]);
  });

  it('skips rows with no leading slash on the path prefix', () => {
    const json = { data: { data: [{ key: 'editor.path', value: 'no-slash=https://da.live/canvas#' }] } };
    expect(extractEditorPathOverrides(json)).toEqual([]);
  });

  it('skips rows with no "=" separator', () => {
    const json = { data: { data: [{ key: 'editor.path', value: '/foo' }] } };
    expect(extractEditorPathOverrides(json)).toEqual([]);
  });

  it('ignores non editor.path rows', () => {
    const json = { data: { data: [{ key: 'aem.repositoryId', value: 'something' }] } };
    expect(extractEditorPathOverrides(json)).toEqual([]);
  });
});

describe('buildEwEntries', () => {
  it('builds an org flag plus summarized site override types for the real example', () => {
    expect(buildEwEntries('frescopa-org', REAL_ORG_CONFIG)).toEqual({
      'frescopa-org': { ew: true },
      'frescopa-org/exp-workspace': { editorTypes: 'cf' },
    });
  });

  it('returns an empty object when neither ew.enabled nor editor.path is set', () => {
    expect(buildEwEntries('org/site', { flags: { data: [] } })).toEqual({});
  });

  it('editor.path override coexists with a differing ew.enabled default at the same key', () => {
    const json = {
      flags: { data: [{ key: 'ew.enabled', value: 'false' }] },
      data: { data: [{ key: 'editor.path', value: '/blog=https://da.live/canvas#' }] },
    };
    expect(buildEwEntries('org/site', json)).toEqual({
      'org/site': { ew: false, editorTypes: 'c' },
    });
  });

  it('attributes an org-prefixed editor.path to its second path segment', () => {
    const json = {
      data: {
        data: [{
          key: 'editor.path',
          value: '/waterscorporation/it-waters-website=https://da.live/canvas#',
        }],
      },
    };
    expect(buildEwEntries('waterscorporation', json)).toEqual({
      'waterscorporation/it-waters-website': { editorTypes: 'c' },
    });
  });
});

describe('mergeIntoIndex', () => {
  it('merges entries from multiple keys and tallies org vs site totals', () => {
    const index = createEmptyIndex();
    mergeIntoIndex(index, [
      { key: 'org1', entries: { org1: { ew: true } } },
      { key: 'org2/siteA', entries: { 'org2/siteA': { ew: false } } },
      null, // e.g. a deleted key skipped by processKey
    ]);
    expect(index).toEqual({
      configs: {
        org1: { ew: true },
        'org2/siteA': { ew: false },
      },
      totals: { orgConfigs: 1, siteConfigs: 1 },
    });
  });

  it('is idempotent-safe on re-merge of the same key (overwrites, does not duplicate totals oddly)', () => {
    const index = createEmptyIndex();
    mergeIntoIndex(index, [{ key: 'org1', entries: { org1: { ew: true } } }]);
    mergeIntoIndex(index, [{ key: 'org1', entries: { org1: { ew: false } } }]);
    expect(index.configs.org1).toEqual({ ew: false });
    expect(index.totals.orgConfigs).toBe(2); // re-processing a key still counts it seen twice
  });

  it('combines site flags and override types contributed by separate configs', () => {
    const index = createEmptyIndex();
    mergeIntoIndex(index, [
      { key: 'org1', entries: { 'org1/siteA': { editorTypes: 'cf' } } },
      { key: 'org1/siteA', entries: { 'org1/siteA': { ew: false, editorTypes: 'e' } } },
    ]);
    expect(index.configs['org1/siteA']).toEqual({ ew: false, editorTypes: 'cfe' });
  });
});

// ─── processKey (ew-index contribution) ──────────────────────────────────────

describe('processKey — ew-index contribution', () => {
  it('returns key + entries alongside doing the existing backup diff', async () => {
    const env = makeEnv({ 'frescopa-org': JSON.stringify(REAL_ORG_CONFIG) });
    const result = await processKey('frescopa-org', env, '2026-03-26T06-00-00-000Z');
    expect(result).toEqual({
      key: 'frescopa-org',
      entries: {
        'frescopa-org': { ew: true },
        'frescopa-org/exp-workspace': { editorTypes: 'cf' },
      },
    });
  });

  it('still contributes entries even when the value is unchanged (no backup write)', async () => {
    const raw = JSON.stringify(REAL_ORG_CONFIG);
    const env = makeEnv({ 'frescopa-org': raw }, { 'frescopa-org/latest.json': raw });
    const result = await processKey('frescopa-org', env, '2026-03-26T06-00-00-000Z');
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
    expect(result.entries['frescopa-org']).toEqual({ ew: true });
  });

  it('returns null and skips ew-index contribution when JSON is unparseable', async () => {
    const env = makeEnv({ 'org/cfg': 'not-json' });
    const result = await processKey('org/cfg', env, '2026-03-26T06-00-00-000Z');
    expect(result).toEqual({ key: 'org/cfg', entries: {} });
  });

  it('returns null for missing keys', async () => {
    const env = makeEnv({});
    const result = await processKey('missing-key', env, '2026-03-26T06-00-00-000Z');
    expect(result).toBeNull();
  });
});

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
    expect(result).toEqual({ done: true, cursor: null, index: expect.any(Object), keysProcessed: expect.any(Number) });
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
    expect(result).toEqual({
      done: false,
      cursor: 'next-cursor',
      index: { configs: {}, totals: { orgConfigs: 1, siteConfigs: 0 } },
      keysProcessed: 1,
    });
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
    // 2 keys × 2 backup puts each, plus 2 puts for the ew-index (latest + timestamped)
    // written once at session end since list_complete is true.
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(6);
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

    expect(env.BACKUP_QUEUE.send).toHaveBeenCalledWith({
      cursor: 'cur1',
      timestamp: '2026-03-27T06-00-00-000Z',
      index: { configs: {}, totals: { orgConfigs: 1, siteConfigs: 0 } },
    });
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
    // 2 backup puts (archive + latest) + 2 ew-index puts (latest + timestamped)
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(4);
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
    // k1 + k2, 2 backup puts each, plus 2 ew-index puts written once at the final batch
    expect(r2.put).toHaveBeenCalledTimes(6);
  });
  it('writes the ew-enabled index to R2 with correct content on session completion', async () => {
    const env = makeEnv({
      'frescopa-org': JSON.stringify(REAL_ORG_CONFIG),
      'other-org': JSON.stringify({ flags: { data: [{ key: 'ew.enabled', value: 'false' }] } }),
    });
    await worker.fetch(new Request('http://localhost/run'), env);

    const written = JSON.parse(env.BACKUP_BUCKET._store['_indexes/ew-enabled/latest.json']);
    expect(written.totals).toEqual({ orgConfigs: 2, siteConfigs: 0 });
    expect(written.configs).toEqual({
      'frescopa-org': { ew: true },
      'frescopa-org/exp-workspace': { editorTypes: 'cf' },
      'other-org': { ew: false },
    });

    const timestampedKey = Object.keys(env.BACKUP_BUCKET._store)
      .find((k) => k.startsWith('_indexes/ew-enabled/') && k !== '_indexes/ew-enabled/latest.json');
    expect(timestampedKey).toBeDefined();
    expect(env.BACKUP_BUCKET._store[timestampedKey]).toBe(env.BACKUP_BUCKET._store['_indexes/ew-enabled/latest.json']);
  });

  it('/run?indexOnly=1 skips backup diff/writes but still writes the ew-index to R2', async () => {
    const env = makeEnv({
      'frescopa-org': JSON.stringify(REAL_ORG_CONFIG),
      'other-org': JSON.stringify({ flags: { data: [{ key: 'ew.enabled', value: 'false' }] } }),
    });
    const res = await worker.fetch(new Request('http://localhost/run?indexOnly=1'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Backup complete');

    // No per-key backup archive/latest puts — only the 2 ew-index puts (timestamped + latest)
    expect(env.BACKUP_BUCKET.put).toHaveBeenCalledTimes(2);
    expect(env.BACKUP_BUCKET.get).not.toHaveBeenCalled();

    const written = JSON.parse(env.BACKUP_BUCKET._store['_indexes/ew-enabled/latest.json']);
    expect(written.totals).toEqual({ orgConfigs: 2, siteConfigs: 0 });
    expect(written.configs).toEqual({
      'frescopa-org': { ew: true },
      'frescopa-org/exp-workspace': { editorTypes: 'cf' },
      'other-org': { ew: false },
    });
  });

  it('/run?dryRun=1 performs no R2 writes at all and returns the computed index as JSON', async () => {
    const env = makeEnv({
      'frescopa-org': JSON.stringify(REAL_ORG_CONFIG),
      'other-org': JSON.stringify({ flags: { data: [{ key: 'ew.enabled', value: 'false' }] } }),
    });
    const res = await worker.fetch(new Request('http://localhost/run?dryRun=1'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(env.BACKUP_BUCKET.put).not.toHaveBeenCalled();
    expect(env.BACKUP_BUCKET.get).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.totals).toEqual({ orgConfigs: 2, siteConfigs: 0 });
    expect(body.configs).toEqual({
      'frescopa-org': { ew: true },
      'frescopa-org/exp-workspace': { editorTypes: 'cf' },
      'other-org': { ew: false },
    });
    expect(body.generatedAt).toEqual(expect.any(String));
  });

  it('/run?limit=N&dryRun=1 caps keys per page for fast local iteration', async () => {
    const kv = {
      list: vi.fn()
        .mockResolvedValueOnce({ keys: [{ name: 'k1' }], list_complete: false, cursor: 'c1' })
        .mockResolvedValueOnce({ keys: [{ name: 'k2' }], list_complete: true, cursor: undefined }),
      get: vi.fn(async () => JSON.stringify({ flags: { data: [{ key: 'ew.enabled', value: 'true' }] } })),
    };
    const r2 = makeR2();
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: r2, BACKUP_QUEUE: { send: vi.fn() } };

    const body = await (await worker.fetch(new Request('http://localhost/run?limit=1&dryRun=1'), env)).json();
    expect(kv.list).toHaveBeenCalledWith({ cursor: undefined, limit: 1 });
    expect(kv.list).toHaveBeenCalledWith({ cursor: 'c1', limit: 1 });
    expect(body.totals).toEqual({ orgConfigs: 2, siteConfigs: 0 });
    expect(r2.put).not.toHaveBeenCalled();
  });

  it('/run?maxKeys=N stops early instead of draining the whole namespace', async () => {
    const kv = {
      // 3 pages available — maxKeys=2 with limit=1 should stop after page 2, never fetching page 3
      list: vi.fn()
        .mockResolvedValueOnce({ keys: [{ name: 'k1' }], list_complete: false, cursor: 'c1' })
        .mockResolvedValueOnce({ keys: [{ name: 'k2' }], list_complete: false, cursor: 'c2' })
        .mockResolvedValueOnce({ keys: [{ name: 'k3' }], list_complete: true, cursor: undefined }),
      get: vi.fn(async () => JSON.stringify({ flags: { data: [{ key: 'ew.enabled', value: 'true' }] } })),
    };
    const r2 = makeR2();
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: r2, BACKUP_QUEUE: { send: vi.fn() } };

    const res = await worker.fetch(new Request('http://localhost/run?limit=1&maxKeys=2&indexOnly=1'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Stopped early after 2 keys (maxKeys reached)');

    expect(kv.list).toHaveBeenCalledTimes(2); // never fetched the 3rd page
    // Partial sample — no ew-index written to R2 since it doesn't reflect the full namespace
    expect(r2.put).not.toHaveBeenCalled();
  });

  it('/run?maxKeys=N&dryRun=1 returns a partial JSON body without writing anything', async () => {
    const kv = {
      list: vi.fn()
        .mockResolvedValueOnce({ keys: [{ name: 'k1' }], list_complete: false, cursor: 'c1' })
        .mockResolvedValueOnce({ keys: [{ name: 'k2' }], list_complete: true, cursor: undefined }),
      get: vi.fn(async () => JSON.stringify({ flags: { data: [{ key: 'ew.enabled', value: 'true' }] } })),
    };
    const r2 = makeR2();
    const env = { DA_CONFIG: kv, BACKUP_BUCKET: r2, BACKUP_QUEUE: { send: vi.fn() } };

    const body = await (await worker.fetch(new Request('http://localhost/run?limit=1&maxKeys=1&dryRun=1'), env)).json();
    expect(body.partial).toBe(true);
    expect(body.keysProcessed).toBe(1);
    expect(body.totals).toEqual({ orgConfigs: 1, siteConfigs: 0 });
    expect(kv.list).toHaveBeenCalledTimes(1);
    expect(r2.put).not.toHaveBeenCalled();
  });
});

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
