# Deploying proton-drive-nas-sync

This guide covers building and running the Docker image, with notes for the
NAS () that is the primary deployment target.

> **⚠️ Third-party application — not affiliated with, endorsed by, or supported
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

## 2. Run it

```bash
docker compose up -d
```

Then open `http://<host>:8787`, log in with your Proton credentials (2FA and a
second-tier mailbox password are supported), and create a folder pair.

### Example compose override for the NAS

On the , the RAID shares are mounted under `/media`. Point `/data` at the
share you want to sync, and keep `/config` on persistent storage:

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
      - /DATA/config/proton-drive-nas-sync:/config
      - /media/media/photos:/data/photos
      - /media/backup1/documents:/data/documents
```

- `/DATA` is the 's writable user space (the root FS is read-only), so it
  is a good home for `/config`.
- Bind each NAS folder you want to sync under `/data/<name>`. In the web UI, set
  the pair's **local folder** to that absolute path (e.g. `/data/photos`).

## 3. First run

1. Open the UI and sign in with your Proton account.
2. **Add pair** — enter the local folder (absolute path under `/data`) and a
   Proton Drive folder name.
3. **Sync** — watch progress (% + speed) in real time.

The session is stored as an AES-256-GCM encrypted blob in `/config`; passwords
are never written to disk. On restart the app resumes the session automatically.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PDN_CONFIG_DIR` | `/config` | Where the session blob + sync DB live. |
| `PDN_ENCRYPTION_KEY` | *(auto-provision)* | 64-hex-char (32-byte) key encrypting the session blob. Generate with `openssl rand -hex 32`. |
| `PDN_PORT` | `8787` | Listen port (change the compose `ports` mapping to match). |
| `PDN_STATE_DB` | `<config>/sync.db` | Override the sync database path. |
| `PDN_WEB_DIR` | `<app>/web/dist` | Override the static frontend directory. |
| `PROTON_DRIVE_BASE_URL` | `drive-api.proton.me` | Custom API endpoint (rarely needed). |

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
