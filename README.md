# da-config-backup

Cloudflare Worker that backs up all keys from a DA Config KV namespace to an R2 bucket daily. Only changed values are written — each change produces a timestamped snapshot alongside an always-current `latest.json`.

## How it works

1. **List** — paginates through all keys in the `DA_CONFIG` KV namespace.
2. **Compare** — fetches each key's current KV value and its last-saved R2 value in parallel.
3. **Write** — if the value has changed, writes two R2 objects:
   - `<key>/latest.json` — always reflects the current value
   - `<key>/<timestamp>.json` — immutable timestamped snapshot

Keys with path segments (containing `/`) are encoded per-segment so the R2 hierarchy is preserved. Keys with no change since the last run are skipped. Failed keys are retried up to 3 times with exponential backoff.

## R2 layout

```
<encoded-key>/latest.json                      ← current value (overwritten each run)
<encoded-key>/2026-03-26T06-00-00-000Z.json    ← snapshot written on change
```

## Schedule

Runs daily at **06:00 UTC** via a Cloudflare cron trigger. Adjust in `wrangler.toml`:

```toml
[triggers]
crons = ["0 6 * * *"]
```

## Setup

### 1. Create the R2 bucket (first time only)

```bash
wrangler r2 bucket create aem-config-backup
```

### 2. Configure `wrangler.toml`

Update the KV namespace ID with your `DA_CONFIG` namespace:

```toml
[[kv_namespaces]]
binding = "DA_CONFIG"
id = "<YOUR_DA_CONFIG_KV_NAMESPACE_ID>"

[[r2_buckets]]
binding = "BACKUP_BUCKET"
bucket_name = "aem-config-backup"
```

### 3. Install dependencies

```bash
npm install
```

## Local development

```bash
npm run dev
# in another terminal:
curl http://localhost:8787/run
```

The `/run` endpoint triggers a full backup synchronously, which is useful for testing. Watch the logs for:

```
[da-config-backup] Change detected for "<key>" — saved <archive-key> + <latest-key>
```

## Deploy

```bash
npm run deploy
```

Verify the cron trigger appears under **Workers → da-config-backup → Triggers** in the Cloudflare dashboard.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server via Wrangler |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm test` | Run unit tests |
| `npm run lint` | Lint source files |
| `npm run empty-bucket` | Empty the R2 backup bucket (use with caution) |
