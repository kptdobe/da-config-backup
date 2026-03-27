import processQueue from '@adobe/helix-shared-process-queue';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const BATCH_SIZE = 200;   // ~200*(2-4) + overhead stays below 1,000 subrequest limit

export default {
  async scheduled(event, env, ctx) {
    // Kick off a fresh backup session — state travels in the queue message body
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    ctx.waitUntil(env.BACKUP_QUEUE.send({ cursor: null, timestamp }));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const { cursor, timestamp } = message.body;
      const result = await processBatch(env, cursor, timestamp);

      if (!result.done) {
        // Schedule next batch in BATCH_DELAY_S seconds
        await env.BACKUP_QUEUE.send({ cursor: result.cursor, timestamp });
      }

      message.ack();
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      // Dev/test: drain all batches synchronously in a single HTTP invocation
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      let cursor = null;
      let result;
      do {
          result = await processBatch(env, cursor, timestamp);
        cursor = result.cursor;
      } while (!result.done);
      return new Response('Backup complete', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  },
};

export async function processBatch(env, cursor, timestamp) {
  const listed = await env.DA_CONFIG.list({ cursor: cursor || undefined, limit: BATCH_SIZE });
  const keys = listed.keys.map((k) => k.name);

  await processQueue(keys, (key) => processKey(key, env, timestamp), { maxConcurrent: 5 });

  if (listed.list_complete) {
    console.log(`[da-config-backup] Backup session ${timestamp} complete.`);
    return { done: true, cursor: null };
  }

  console.log(`[da-config-backup] Processed batch, queuing next (cursor: ${listed.cursor}).`);
  return { done: false, cursor: listed.cursor };
}

export async function processKey(key, env, timestamp, attempt = 1) {
  try {
    // R2 keys — encode each segment to handle special characters, preserving '/' for nesting
    const safeKey = key.split('/').map(encodeURIComponent).join('/');
    const latestR2Key = `${safeKey}/latest.json`;

    // Fetch KV value and last R2 value in parallel
    const [currentValue, existing] = await Promise.all([
      env.DA_CONFIG.get(key, { type: 'text' }),
      env.BACKUP_BUCKET.get(latestR2Key),
    ]);
    if (currentValue === null) return;
    const lastValue = existing ? await existing.text() : null;

    // Simple string compare — a reformat counts as a change
    if (lastValue === currentValue) return;

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
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => { globalThis.setTimeout(resolve, RETRY_DELAY_MS * attempt); });
      return processKey(key, env, timestamp, attempt + 1);
    }
    console.error(`[da-config-backup] Failed "${key}" after ${MAX_RETRIES} attempts: ${err.message}`);
  }
}
