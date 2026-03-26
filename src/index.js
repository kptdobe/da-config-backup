import processQueue from '@adobe/helix-shared-process-queue';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

export default {
  // Scheduled trigger (cron)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env));
  },

  // Manual trigger for local dev / testing
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      await runBackup(env);
      return new Response('Backup complete', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  },
};

export async function runBackup(env) {
  // List ALL keys in DA_CONFIG KV — paginate (max 1000 per call)
  const keys = [];
  let cursor;
  do {
    const listed = await env.DA_CONFIG.list({ cursor, limit: 1000 });
    keys.push(...listed.keys.map((k) => k.name));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  await processQueue(keys, (key) => processKey(key, env, timestamp), { maxConcurrent: 10 });
}

export async function processKey(key, env, timestamp, attempt = 1) {
  try {
    // 1. R2 keys — encode each segment to handle special characters, preserving '/' for nesting
    const safeKey = key.split('/').map(encodeURIComponent).join('/');
    const latestR2Key = `${safeKey}/latest.json`;

    // 2. Fetch KV value and last R2 value in parallel
    const [currentValue, existing] = await Promise.all([
      env.DA_CONFIG.get(key, { type: 'text' }),
      env.BACKUP_BUCKET.get(latestR2Key),
    ]);
    if (currentValue === null) return;
    const lastValue = existing ? await existing.text() : null;

    // 3. Simple string compare — a reformat counts as a change
    if (lastValue === currentValue) return; // no change

    // 4. Different — write timestamped archive + overwrite latest
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
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => { globalThis.setTimeout(resolve, RETRY_DELAY_MS * attempt); });
      return processKey(key, env, timestamp, attempt + 1);
    }
    console.error(`[da-config-backup] Failed "${key}" after ${MAX_RETRIES} attempts: ${err.message}`);
  }
}
