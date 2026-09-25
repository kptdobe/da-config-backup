# da-config-backup

Cloudflare Worker that backs up all keys from a DA Config KV namespace to an R2 bucket daily. Only changed values are written — each change produces a timestamped snapshot alongside an always-current `latest.json`.

## How it works

1. **List** — paginates through all keys in the `DA_CONFIG` KV namespace.
2. **Compare** — fetches each key's current KV value and its last-saved R2 value in parallel.
3. **Write** — if the value has changed, writes two R2 objects:
   - `<key>/latest.json` — always reflects the current value
   - `<key>/<timestamp>.json` — immutable timestamped snapshot
4. **EW and harness index** — regardless of whether the backup value changed, each key's config is parsed for `ew.enabled` and `ew.coworker` (in the `flags` sheet) and `editor.path` overrides (in the first/`data` sheet). The scheduled backup writes each batch's compact index contribution to a run-specific R2 key, then merges the completed batches and publishes:
   - `_indexes/ew-enabled/latest.json`
   - `_indexes/ew-enabled/<timestamp>-<uuid>.json`

   Fresh indexes include `harnessFlagsIndexed: true`, so consumers can distinguish an absent `ew.coworker` flag from an older index that never extracted harness flags. An in-flight queue run started before the upgrade is marked `false` because its earlier batches did not extract those flags. The sparse `configs` map is keyed by `org` or `org/site`. Each entry is `{ ew?: boolean, coworker?: boolean, editorTypes?: string }`: `ew` and `coworker` record explicitly configured `ew.enabled` and `ew.coworker` values; an absent `coworker` defaults to da-agent, while an explicit site-level value (including `false`) overrides the org-level value. `editorTypes` summarizes which `editor.path` editors occur anywhere in that site (`c` = canvas, `f` = form, `e` = classic edit). Individual content paths are intentionally omitted because ew-report usage metrics are only available at org/site granularity. Org-level `editor.path` rows are attributed to the site named by the first path segment.

   Queue messages contain only the cursor, start timestamp, run ID, and batch number. Staged objects use `_indexes/ew-enabled/runs/<run-id>/batch-<number>.json`. Retried messages reuse their staged batch instead of re-counting its keys; the final merge requires every batch and a contiguous cursor chain. The snapshot is written once per run, and `latest.json` is updated with an R2 conditional write only if the run started after the current latest run. Runs can overlap without overwriting one another's staged data or publishing an older snapshot over a newer one. The `/run` HTTP endpoint still accumulates in memory for local testing and writes no staging objects.

   Staged objects are retained for replay safety (including queue retries). Set an R2 lifecycle expiration for the `runs/` prefix **longer than the queue's message retention period** if automatic cleanup is desired; do not expire the completed snapshots or `latest.json`.

Keys with path segments (containing `/`) are encoded per-segment so the R2 hierarchy is preserved. Keys with no change since the last run are skipped for the backup write (the ew-index is still updated for them). Failed keys are retried up to 3 times with exponential backoff.

## R2 layout

```
<encoded-key>/latest.json                      ← current value (overwritten each run)
<encoded-key>/2026-03-26T06-00-00-000Z.json    ← snapshot written on change
_indexes/ew-enabled/latest.json                ← aggregate ew-enabled index (current)
_indexes/ew-enabled/2026-03-26T06-00-00-000Z-<uuid>.json  ← completed snapshot
_indexes/ew-enabled/runs/<timestamp>-<uuid>/batch-0.json  ← staged batch contribution
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

`wrangler.toml` has `remote = true` on both bindings, so `wrangler dev` talks to the **real** `DA_CONFIG` KV and `aem-config-backup` R2 bucket — there's no local/mock mode to switch to. Two ways to exercise it locally:

- **`/run?limit=N`** — caps the KV `.list` page size (keys per page), not the total processed. Without `?maxKeys=N` (below), `/run` still drains the **entire** namespace, just in smaller pages — useful mainly combined with `maxKeys` for a bounded local sample:
  ```bash
  curl "http://localhost:8787/run?limit=1"   # drains everything, 1 key per page (slow!)
  ```
  This bypasses the queue (loops `processBatch` directly in one request), so it's fast to invoke but doesn't validate the queue message round-trip.
- **`/run?maxKeys=N`** — caps the TOTAL number of keys processed this run and stops early once reached, instead of draining the whole namespace. This is what you want for a quick local sample:
  ```bash
  curl "http://localhost:8787/run?maxKeys=50&dryRun=1" | jq .   # sample the first ~50 keys, no writes
  ```
  A capped/early-stopped run never writes a "session complete" ew-index to R2 (it's a partial sample, not the real full-namespace state) — the response says `Stopped early after N keys...` (or, combined with `dryRun`, returns JSON with `"partial": true`).
- **`/run?indexOnly=1`** — skips the per-key backup diff/write entirely (only reads `DA_CONFIG`, never touches the backup archive in R2) but still writes the ew-enabled index to R2 as usual (unless capped early via `maxKeys`). Use this to regenerate/test the aggregate index without recreating any backups:
  ```bash
  curl "http://localhost:8787/run?indexOnly=1"
  ```
- **`/run?dryRun=1`** — fully read-only: also skips writing the index to R2, and returns the computed `{ generatedAt, totals, configs }` JSON directly in the response body instead of "Backup complete", so you can inspect the result locally without touching R2 at all. Combine with `maxKeys` for a fast, bounded, zero-write test run:
  ```bash
  curl "http://localhost:8787/run?dryRun=1&maxKeys=50" | jq .
  ```
- **Trigger the real cron + queue path** — validates run-scoped R2 staging, small `{ cursor, timestamp, runId, batchNo }` queue messages, and final publication:
  ```bash
  curl "http://localhost:8787/__scheduled"
  ```

Inspect the written aggregate index:
```bash
npx wrangler r2 object get aem-config-backup/_indexes/ew-enabled/latest.json --remote --pipe | jq .
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
