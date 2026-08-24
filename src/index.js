import processQueue from '@adobe/helix-shared-process-queue';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const BATCH_SIZE = 200;   // ~200*(2-4) + overhead stays below 1,000 subrequest limit
const EW_INDEX_SIZE_WARNING_BYTES = 100_000; // headroom under the 128KB queue message cap
const QUEUE_MESSAGE_MAX_BYTES = 128_000;
const EDITOR_TYPE_CODES = { canvas: 'c', form: 'f', edit: 'e' };
const EDITOR_TYPE_CODE_ORDER = ['c', 'f', 'e'];

// ─── ew-enabled index ────────────────────────────────────────────────────────
//
// Mirrors the exact override precedence used at runtime by da-live/da-nx:
//   - `flags.data` row `ew.enabled` sets the DEFAULT editor for this KV key
//     (org, or org/site) — 'canvas' when 'true', 'edit' otherwise. Site-level
//     overrides org-level per-key (site is read after org and simply wins),
//     which our sparse map already replicates: a site key is only written
//     when the site config explicitly sets the flag, so an unset site falls
//     back to the org entry via prefix lookup.
//   - `data.data` rows keyed `editor.path` (format `<pathPrefix>=<editorUrl>`)
//     are summarized by target site and editor type. Individual content paths
//     are intentionally omitted because ew-report usage is only available at
//     org/site granularity.
//
// Each sparse `configs` entry is `{ ew?: boolean, editorTypes?: string }`.
// `ew` records an explicit ew.enabled value. `editorTypes` is a compact,
// canonical string containing any editor.path types configured for that site:
// `c` = canvas, `f` = form, `e` = classic edit.

export function extractEwEnabledDefault(json) {
  const row = json?.flags?.data?.find((r) => r.key === 'ew.enabled');
  if (!row) return null; // flag not set — no entry emitted, sparse map
  return row.value === 'true' ? 'canvas' : 'edit';
}

export function extractEditorPathOverrides(json) {
  const rows = json?.data?.data ?? [];
  const overrides = [];
  for (const row of rows) {
    if (row.key !== 'editor.path' || typeof row.value !== 'string') continue;
    const eqIdx = row.value.indexOf('=');
    if (eqIdx === -1) continue;
    const pathPrefix = row.value.slice(0, eqIdx);
    const editorUrl = row.value.slice(eqIdx + 1);
    if (!pathPrefix.startsWith('/')) continue; // malformed row, skip
    const type = editorUrl.includes('canvas') ? 'canvas' : editorUrl.includes('form') ? 'form' : 'edit';
    overrides.push({ pathPrefix, type });
  }
  return overrides;
}

/** Builds the ew-index entries contributed by a single KV key's config JSON. */
export function buildEwEntries(kvKey, json) {
  const entries = {};
  const defaultType = extractEwEnabledDefault(json);
  if (defaultType) entries[kvKey] = { ew: defaultType === 'canvas' };
  for (const { pathPrefix, type } of extractEditorPathOverrides(json)) {
    const firstPathSegment = pathPrefix.split('/').filter(Boolean)[0];
    const siteKey = kvKey.includes('/') ? kvKey : firstPathSegment ? `${kvKey}/${firstPathSegment}` : null;
    if (!siteKey) continue;
    const current = entries[siteKey] ?? {};
    const types = new Set(current.editorTypes ?? '');
    types.add(EDITOR_TYPE_CODES[type]);
    entries[siteKey] = {
      ...current,
      editorTypes: EDITOR_TYPE_CODE_ORDER.filter((code) => types.has(code)).join(''),
    };
  }
  return entries;
}

export function createEmptyIndex() {
  return { configs: {}, totals: { orgConfigs: 0, siteConfigs: 0 } };
}

/** Synchronous, single-threaded merge of one batch's processKey results into the accumulator. */
export function mergeIntoIndex(index, results) {
  for (const result of results) {
    if (!result) continue;
    const { key, entries } = result;
    for (const [configKey, entry] of Object.entries(entries)) {
      const current = index.configs[configKey] ?? {};
      const types = new Set(`${current.editorTypes ?? ''}${entry.editorTypes ?? ''}`);
      index.configs[configKey] = {
        ...current,
        ...entry,
        ...(types.size > 0
          ? { editorTypes: EDITOR_TYPE_CODE_ORDER.filter((code) => types.has(code)).join('') }
          : {}),
      };
    }
    if (key.includes('/')) {
      index.totals.siteConfigs += 1;
    } else {
      index.totals.orgConfigs += 1;
    }
  }
  return index;
}

export async function writeIndex(env, timestamp, index) {
  const payload = JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: index.totals,
    configs: index.configs,
  }, null, 2);

  await Promise.all([
    env.BACKUP_BUCKET.put(`_indexes/ew-enabled/${timestamp}.json`, payload, {
      httpMetadata: { contentType: 'application/json' },
    }),
    env.BACKUP_BUCKET.put('_indexes/ew-enabled/latest.json', payload, {
      httpMetadata: { contentType: 'application/json' },
    }),
  ]);
}

export default {
  async scheduled(event, env, ctx) {
    // Kick off a fresh backup session — state travels in the queue message body
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    ctx.waitUntil(env.BACKUP_QUEUE.send({ cursor: null, timestamp, index: createEmptyIndex() }));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const { cursor, timestamp, index } = message.body;
      const result = await processBatch(env, cursor, timestamp, index ?? createEmptyIndex());

      if (!result.done) {
        // Schedule next batch in BATCH_DELAY_S seconds — the accumulator travels
        // with it, since batches are strictly sequential (max_batch_size: 1)
        const nextMessage = { cursor: result.cursor, timestamp, index: result.index };
        const messageSize = new TextEncoder().encode(JSON.stringify(nextMessage)).length;
        if (messageSize > QUEUE_MESSAGE_MAX_BYTES) {
          throw new Error(`EW index queue message is ${messageSize} bytes, above the ${QUEUE_MESSAGE_MAX_BYTES}-byte limit`);
        }
        if (messageSize > EW_INDEX_SIZE_WARNING_BYTES) {
          console.warn(`[da-config-backup] EW index queue message is ${messageSize} bytes — approaching the 128KB limit.`);
        }
        await env.BACKUP_QUEUE.send(nextMessage);
      }

      message.ack();
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      // Dev/test: drain batches synchronously in a single HTTP invocation.
      // Optional ?limit=N caps keys-per-page (KV .list page size) — separate
      // from ?maxKeys=N, which caps the TOTAL number of keys processed this
      // run and stops early (without writing a "session complete" ew-index,
      // since a capped sample isn't the real full-namespace state). Without
      // maxKeys, /run always drains the entire namespace, same as production.
      //
      // ?indexOnly=1 skips the per-key backup diff/write entirely (only reads
      // KV, never touches the backup archive in R2) — use this to test the
      // ew-enabled index generation without recreating any backups.
      // ?dryRun=1 additionally skips writing the ew-index itself to R2, and
      // returns the computed index directly in the response body instead of
      // "Backup complete" — a fully read-only local test run.
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const limit = Number(url.searchParams.get('limit')) || undefined;
      const maxKeys = Number(url.searchParams.get('maxKeys')) || undefined;
      const indexOnly = url.searchParams.has('indexOnly') || url.searchParams.has('dryRun');
      const dryRun = url.searchParams.has('dryRun');
      const options = { skipBackup: indexOnly, skipR2Write: dryRun };
      let cursor = null;
      let index = createEmptyIndex();
      let result;
      let totalKeysProcessed = 0;
      let cappedEarly = false;
      do {
        result = await processBatch(env, cursor, timestamp, index, limit, options);
        cursor = result.cursor;
        index = result.index;
        totalKeysProcessed += result.keysProcessed;
        if (maxKeys && totalKeysProcessed >= maxKeys && !result.done) {
          console.log(`[da-config-backup] /run stopped early — reached maxKeys=${maxKeys} (partial sample, no R2 write).`);
          cappedEarly = true;
          break;
        }
      } while (!result.done);

      if (dryRun) {
        return new Response(JSON.stringify({
          generatedAt: new Date().toISOString(),
          partial: cappedEarly,
          keysProcessed: totalKeysProcessed,
          ...index,
        }, null, 2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(cappedEarly ? `Stopped early after ${totalKeysProcessed} keys (maxKeys reached)` : 'Backup complete', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  },
};

export async function processBatch(env, cursor, timestamp, index = createEmptyIndex(), limit, options = {}) {
  const { skipBackup = false, skipR2Write = false } = options;
  const listed = await env.DA_CONFIG.list({ cursor: cursor || undefined, limit: limit || BATCH_SIZE });
  const keys = listed.keys.map((k) => k.name);
  const keyCount = keys.length; // processQueue mutates `keys` via queue.shift() internally — snapshot the count first

  const results = await processQueue(keys, (key) => processKey(key, env, timestamp, 1, { skipBackup }), { maxConcurrent: 5 });
  mergeIntoIndex(index, results);

  if (listed.list_complete) {
    if (!skipR2Write) await writeIndex(env, timestamp, index);
    console.log(`[da-config-backup] Backup session ${timestamp} complete.`);
    return { done: true, cursor: null, index, keysProcessed: keyCount };
  }

  console.log(`[da-config-backup] Processed batch, queuing next (cursor: ${listed.cursor}).`);
  return { done: false, cursor: listed.cursor, index, keysProcessed: keyCount };
}

export async function processKey(key, env, timestamp, attempt = 1, options = {}) {
  const { skipBackup = false } = options;
  try {
    if (skipBackup) {
      // Index-only mode (local testing via /run?indexOnly=1): skip the R2
      // backup diff/write entirely, just read the KV value and compute this
      // key's ew-index contribution.
      const currentValue = await env.DA_CONFIG.get(key, { type: 'text' });
      if (currentValue === null) return null;
      let entries = {};
      try {
        entries = buildEwEntries(key, JSON.parse(currentValue));
      } catch {
        // Not parseable JSON — no ew-index contribution.
      }
      return { key, entries };
    }

    // R2 keys — encode each segment to handle special characters, preserving '/' for nesting
    const safeKey = key.split('/').map(encodeURIComponent).join('/');
    const latestR2Key = `${safeKey}/latest.json`;

    // Fetch KV value and last R2 value in parallel
    const [currentValue, existing] = await Promise.all([
      env.DA_CONFIG.get(key, { type: 'text' }),
      env.BACKUP_BUCKET.get(latestR2Key),
    ]);
    if (currentValue === null) return null;
    const lastValue = existing ? await existing.text() : null;

    // Simple string compare — a reformat counts as a change
    if (lastValue !== currentValue) {
      // Different — write timestamped archive + overwrite latest
      const archiveR2Key = `${safeKey}/${timestamp}.json`;
      await Promise.all([
        env.BACKUP_BUCKET.put(archiveR2Key, currentValue, {
          httpMetadata: { contentType: 'application/json' },
        }),
        env.BACKUP_BUCKET.put(latestR2Key, currentValue, {
          httpMetadata: { contentType: 'application/json' },
        }),
      ]);

      console.log(`[da-config-backup] Change detected for "${key}" — saved ${archiveR2Key} + ${latestR2Key}`);
    }

    // The ew-enabled index reflects the full current state every run, not just
    // diffs, so this runs regardless of whether the backup value changed above.
    let entries = {};
    try {
      entries = buildEwEntries(key, JSON.parse(currentValue));
    } catch {
      // Not parseable JSON — no ew-index contribution, backup handling above is unaffected.
    }
    return { key, entries };
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => { globalThis.setTimeout(resolve, RETRY_DELAY_MS * attempt); });
      return processKey(key, env, timestamp, attempt + 1, options);
    }
    console.error(`[da-config-backup] Failed "${key}" after ${MAX_RETRIES} attempts: ${err.message}`);
    return null;
  }
}
