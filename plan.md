# `da-config-backup` — Cloudflare Worker Execution Plan

## 1. Create the repo

```bash
gh repo create da-config-backup --public  # or --private
cd da-config-backup
```

Mirror the structure of `da-backup-launcher`:
```
da-config-backup/
├── src/
│   └── index.js        ← worker logic
├── .gitignore
├── README.md
├── package.json
├── package-lock.json
└── wrangler.toml
```

---

## 2. `wrangler.toml`

```toml
name = "da-config-backup"
main = "src/index.js"
compatibility_date = "2024-01-01"

[triggers]
crons = ["0 6 * * *"]   # every day at 06:00 UTC — adjust as needed

[[kv_namespaces]]
binding = "DA_CONFIG"
id = "<YOUR_DA_CONFIG_KV_NAMESPACE_ID>"

[[r2_buckets]]
binding = "BACKUP_BUCKET"
bucket_name = "aem-config-backup"
```

---

## 3. `package.json`

```json
{
  "name": "da-config-backup",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^3"
  }
}
```

---

## 4. `src/index.js` — Worker Logic

```js
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

async function runBackup(env) {
  // 1. List ALL keys in DA_CONFIG KV — paginate (max 1000 per call)
  const keys = [];
  let cursor;
  do {
    const listed = await env.DA_CONFIG.list({ cursor, limit: 1000 });
    keys.push(...listed.keys.map((k) => k.name));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); // e.g. 2026-03-26T06-00-00-000Z

  // Process in parallel batches to stay well within CPU budget
  const BATCH_SIZE = 100;
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((key) => processKey(key, env, timestamp)));
  }
}

async function processKey(key, env, timestamp) {
  // 1. Read current value from KV
  const currentValue = await env.DA_CONFIG.get(key, { type: 'text' });
  if (currentValue === null) return;

  // 2. R2 keys — encode to handle special characters safely
  const safeKey = encodeURIComponent(key);
  const latestR2Key = `${safeKey}/latest.json`;

  // 3. Read last saved value from R2
  const existing = await env.BACKUP_BUCKET.get(latestR2Key);
  const lastValue = existing ? await existing.text() : null;

  // 4. Simple string compare — a reformat counts as a change
  if (lastValue === currentValue) return; // no change

  // 5. Different — write timestamped archive + overwrite latest
  const archiveR2Key = `${safeKey}/${timestamp}.json`;
  await Promise.all([
    env.BACKUP_BUCKET.put(archiveR2Key, currentValue, {
      httpMetadata: { contentType: 'application/json' },
    }),
    env.BACKUP_BUCKET.put(latestR2Key, currentValue, {
      httpMetadata: { contentType: 'application/json' },
    }),
  ]);

  console.log(`[da-config-backup] Change detected for "${key}" — saved ${archiveR2Key}`);
}
```

> **Note on KV pagination:** if `DA_CONFIG` has >1000 keys, `list()` will return a cursor.
> Add a pagination loop (check `listed.list_complete` and re-call with `{ cursor }`) before going to production.

---

## 5. Secrets / variables to configure

| What | How |
|---|---|
| KV Namespace ID | Grab from Cloudflare dashboard → Workers & Pages → KV, then paste into `wrangler.toml` |
| R2 bucket `aem-config-backup` | Create if it doesn't exist: `wrangler r2 bucket create aem-config-backup` |
| Any secrets needed | `wrangler secret put <NAME>` |

---

## 6. Local dev & test

```bash
npm install
# create .dev.vars if you need any secrets locally
npm run dev
# in another terminal:
curl http://localhost:8787/run
```

Check logs for `[da-config-backup] Change detected for key ...` lines.

---

## 7. Deploy

```bash
npm run deploy
```

Verify the cron trigger appears in the Cloudflare dashboard under **Workers → da-config-backup → Triggers**.

---

## 8. Verify in R2

After the first run, the `aem-config-backup` bucket should contain:
```
<org-key>/latest.json                    ← always the current value
<org-key>/2026-03-26T06-00-00-000Z.json  ← timestamped snapshot on change
```
