import processQueue from '@adobe/helix-shared-process-queue';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
export const BATCH_SIZE = 200; // max keys per invocation — 200*(2–4) + overhead stays below 1,000 subrequest limit
export const STATE_KEY = '__backup_state__'; // tracks active backup session in DA_CONFIG KV

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 6 * * *') {
      // Daily trigger: start a fresh backup session
      ctx.waitUntil(startBackup(env));
    } else {
      // Continuation trigger: process next batch if a session is active
      ctx.waitUntil(continueBackup(env));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      // Dev/test: start and drain all batches sequentially in one HTTP invocation
      await startBackup(env);
      let raw = await env.DA_CONFIG.get(STATE_KEY, { type: 'text' });
      while (raw) {
        const state = JSON.parse(raw);
        if (state.done) break;
        await processBatch(env, state);
        raw = await env.DA_CONFIG.get(STATE_KEY, { type: 'text' });
      }
      return new Response('Backup complete', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  },
};

export async function startBackup(env) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const state = { cursor: null, timestamp };
  await env.DA_CONFIG.put(STATE_KEY, JSON.stringify(state));
  await processBatch(env, state);
}

export async function continueBackup(env) {
  const raw = await env.DA_CONFIG.get(STATE_KEY, { type: 'text' });
  if (!raw) return; // no active session
  const state = JSON.parse(raw);
  if (state.done) return; // session already complete
  await processBatch(env, state);
}

export async function processBatch(env, state) {
  const listed = await env.DA_CONFIG.list({ cursor: state.cursor || undefined, limit: BATCH_SIZE });
  const keys = listed.keys.map((k) => k.name).filter((k) => k !== STATE_KEY);

  await processQueue(keys, (key) => processKey(key, env, state.timestamp), { maxConcurrent: 5 });

  const nextState = listed.list_complete
    ? { ...state, done: true }
    : { ...state, cursor: listed.cursor };

  await env.DA_CONFIG.put(STATE_KEY, JSON.stringify(nextState));

  if (listed.list_complete) {
    console.log(`[da-config-backup] Backup session ${state.timestamp} complete.`);
  } else {
    console.log(`[da-config-backup] Processed batch, continuing next invocation (cursor: ${listed.cursor}).`);
  }
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
