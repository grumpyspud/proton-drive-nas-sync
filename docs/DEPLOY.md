# Deploying proton-drive-nas-sync

This guide covers building and running the Docker image, with notes for NAS
deployments (bind mounts, persistent volumes, and security).

> **⚠️ Third-party application: not affiliated with, endorsed by, or supported
> by Proton AG.**

## What the container needs

The image runs the web UI + sync engine on port **8787** and expects two
persistent paths:

| Path | Purpose |
|------|---------|
| `/config` | Encrypted session blob, sync database, and (optionally) the encryption keyfile. Must persist across restarts/rebuilds. |
| `/data` | The local folders you pair with Proton Drive folders. Bind your NAS shares here. |

The container runs as **root** by default (so bind-mounted NAS folders are
writable out of the box). See [Security](#security) for hardening options.

## 1. Build the image

```bash
git clone git@github.com:grumpyspud/proton-drive-nas-sync.git
cd proton-drive-nas-sync
docker build -t proton-drive-nas-sync:latest .
```

The build is multi-stage: it installs dependencies, builds the React frontend,
and produces a single runtime image. (The repo is private, so clone with a key
or token that has read access.)

> Prebuilt images are published to the GitHub Container Registry
> (`ghcr.io/grumpyspud/proton-drive-nas-sync`) on version tags, for both
> `linux/amd64` and `linux/arm64`.

## 2. Run it

```bash
docker compose up -d
```

Then open `https://<host>:8787`, log in with your Proton credentials (2FA and a
second-tier mailbox password are supported), and create a folder pair. (The UI
serves HTTPS by default: see [HTTPS](#https).)

### Example compose override for a NAS

On most NAS devices, shared folders live under a path such as `/media` or
`/volume1`. Point `/data` at the share you want to sync, and keep `/config` on
persistent storage:

```yaml
services:
  proton-drive-nas-sync:
    image: proton-drive-nas-sync:latest
    container_name: proton-drive-nas-sync
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      TZ: America/Chicago
      # PDN_ENCRYPTION_KEY: "openssl_rand_hex_32_output"
    volumes:
      - /path/to/config:/config
      - /media/photos:/data/photos
      - /media/documents:/data/documents
```

- Put `/config` on persistent storage so the session blob and sync database
  survive reboots and image rebuilds.
- Bind each NAS folder you want to sync under `/data/<name>`. In the web UI, set
  the pair's **local folder** to that absolute path (e.g. `/data/photos`).
- Only folders on a mounted volume can be paired: a path inside the container
  itself is rejected, so a sync can't write to the container's own storage.

## 3. First run

1. Open the UI and sign in with your Proton account.
2. **Create Sync Pair** (top bar): pick the local folder (absolute path under
   `/data`) and a Proton Drive folder. The pair starts syncing in real time
   automatically - no schedule to set.
3. Watch progress (files processed, bytes, network rate) in the dashboard.

For a full walkthrough with screenshots see [SETUP.md](SETUP.md); for a reference
of every feature and option see [USER_GUIDE.md](USER_GUIDE.md).

The session is stored as an AES-256-GCM encrypted blob in `/config`; passwords
are never written to disk. On restart the app resumes the session automatically.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PDN_CONFIG_DIR` | `/config` | Where the session blob + sync DB live. |
| `PDN_ENCRYPTION_KEY` | *(auto-provision)* | 64-hex-char (32-byte) key encrypting the session blob. Generate with `openssl rand -hex 32`. |
| `PDN_PORT` | `8787` | Listen port (change the compose `ports` mapping to match). |
| `PDN_TLS_CERT` | *(auto self-signed)* | Path to a PEM TLS certificate (use with `PDN_TLS_KEY`) to serve HTTPS with your own cert. |
| `PDN_TLS_KEY` | *(auto self-signed)* | Path to the matching PEM TLS private key. |
| `PDN_HTTP` | `false` | Set to `true` to serve plain HTTP instead (e.g. behind a reverse proxy that terminates TLS). |
| `PDN_STATE_DB` | `<config>/sync.db` | Override the sync database path. |
| `PDN_WEB_DIR` | `<app>/web/dist` | Override the static frontend directory. |
| `PROTON_DRIVE_BASE_URL` | `drive-api.proton.me` | Custom API endpoint (rarely needed). |
| `PDN_CACHE` | `disk` | Drive SDK entity-cache backend: `disk` (persistent on-disk cache with an in-memory LRU front, default), `memory` (unbounded in-memory), `lru` (bounded least-recently-used), or `null` (disabled - every scan is cold). |
| `PDN_CACHE_LRU_MAX` | `2000` | Max entries for `lru`, or the size of the RAM front for `disk` (0 = none). Keep modest to bound RAM; raise on big-RAM hosts, lower on constrained ones. |
| `PDN_CACHE_DIR` | `<config>/cache` | Directory for the disk-backed cache (only when `PDN_CACHE=disk`). Mount fast storage (NVMe) here. |
| `PDN_LOG_SKIPS` | `off` | Set `on` to write per-file `[skip]` lines (unchanged files) to `sync.log` for troubleshooting. Default keeps the log small and speeds up large-tree reconciles. |
| `PDN_LOCAL_PRUNE` | `on` | Prune the local stat-scan with directory mtimes: each tick stats only directories and descends into the ones whose mtime changed (add/remove/rename), skipping per-file stats for unchanged folders. `off` restores the always-full scan. |
| `PDN_FULL_SCAN_INTERVAL` | `300` | Seconds between full local scans while `PDN_LOCAL_PRUNE` is on. A full scan re-stats every file, so it is the only thing that catches in-place content edits (a directory mtime does not change on a content-only write). `0` disables the periodic scan. |
| `PDN_REALTIME_INTERVAL` | `30` | Seconds between sync ticks (the event-feed poll + local stat-scan loop). Clamped to 10-60. |
| `PDN_DELTA` | `on` | Set `off` to disable the surgical delta engine and full-walk every pair each tick (the original behavior). |

The default `disk` cache writes each Drive entity to a SQLite database on disk
and keeps only a bounded `PDN_CACHE_LRU_MAX`-sized slice in RAM, so memory stays
low on large trees and re-scans after a restart start warm instead of cold.
`cache.db` typically stays around ~1 GB even for a large tree, so the default
location under `/config/cache` is fine; point `PDN_CACHE_DIR` at a dedicated fast
volume only if you want it elsewhere. Set `PDN_CACHE=memory` for an unbounded
in-memory cache (fastest, but can consume many GB on a large tree), `lru` to
bound memory without disk persistence (evicted entries are re-fetched), or
`null` to disable the cache entirely (every scan re-walks Drive). In every mode
except `null` the small crypto-key cache stays in memory.

## HTTPS

The web UI serves **HTTPS** by default with a self-signed certificate generated on
first boot and cached in `/config` (`selfsigned.crt` + `selfsigned.key`). This
encrypts the browser ↔ app link (including the Proton login) out of the box.

A self-signed certificate makes your browser show a "not secure" warning the first
time you connect: accept it to proceed. To serve HTTPS without the warning,
provide your own certificate:

```yaml
    environment:
      PDN_TLS_CERT: /config/certs/fullchain.pem
      PDN_TLS_KEY: /config/certs/privkey.pem
    volumes:
      - /path/to/certs:/config/certs:ro
```

To run plain HTTP instead (for example behind a reverse proxy or Tailscale that
already terminates TLS), set `PDN_HTTP: "true"`.

## Security

- **Encryption key.** Without `PDN_ENCRYPTION_KEY`, the app auto-provisions a
  random key at `/config/encryption.key` (mode 0600). That is fine for a home
  NAS, but for anything more sensitive, set `PDN_ENCRYPTION_KEY` to a fixed value
  (e.g. from a Docker secret) so the blob survives rebuilds and stays recoverable.
- **Non-root.** To run as your NAS user, uncomment `user: "1000:1000"` in the
  compose file (set the uid/gid to match), and `chown -R 1000:1000` the host
  `config` and `data` folders first.
- **Exposure.** The UI has no built-in authentication beyond the Proton login;
  it also serves the storage/sync controls. Put it behind a reverse proxy with
  auth (or restrict to Tailscale) before exposing it beyond your LAN.

## Troubleshooting

- **Healthcheck.** `docker inspect --format '{{.State.Health.Status}}' proton-drive-nas-sync`
  should read `healthy`. The app exposes `GET /api/health`.
- **Logs.** `docker logs -f proton-drive-nas-sync`.
- **"Too many recent logins" (429).** Proton rate-limits repeated logins in a
  short window; wait a few minutes and retry.
- **Port conflict.** Change `PDN_PORT` and the compose `ports` mapping together.
