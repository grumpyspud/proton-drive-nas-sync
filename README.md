# proton-drive-nas-sync

A self-hosted Docker app that backs up and synchronizes folders between a NAS
and Proton Drive.

> **⚠️ This is a third-party application not officially supported by Proton.**
> It is not affiliated with, endorsed by, or supported by Proton AG.

## Features

- **Back up** folders from the NAS to Proton Drive.
- **Restore** folders from Proton Drive back to the NAS.
- **Bidirectional folder-pair sync** — additions, edits, and deletions on either
  side are mirrored to the other.
- **Deletion safety** — source-availability gate, a deletion-rate tripwire, and
  trash-before-delete (Drive `trashNodes` / local recycle) so a missing folder or
  drive can never wipe your data.
- **Web UI** — Proton-style login (SRP + optional 2FA + optional mailbox
  password), folder-pair manager, and a live sync dashboard with progress bars
  (percent + speed), storage usage, and low-space warnings.
- **Flexible schedules** — manual or auto-sync, from every 1 minute up to monthly.
- **Duplicate-file scan** — find and recycle duplicate files within a pair, with a
  minimum-size filter and an ignore list.
- **Configurable concurrency** — 1–4 parallel transfers.
- **Encrypted-at-rest credentials** — only an AES-256-GCM encrypted session blob
  is persisted; passwords are never stored.

## How it works

- **TypeScript / Node.js** backend and **React** web UI.
- Built on the official Proton Drive SDK (`@protontech/drive-sdk`, MIT), with the
  account/auth module vendored and extended for 2FA + two-password login.
- Crypto is behind a swappable `CryptoBackend` abstraction, ready for Proton's
  upcoming crypto-model migration.
- Bidirectional sync is implemented on the SDK's client primitives, since the
  SDK's own Sync module is not available yet.

## Quick start

### Docker

```bash
git clone git@github.com:grumpyspud/proton-drive-nas-sync.git
cd proton-drive-nas-sync
docker build -t proton-drive-nas-sync:latest .
docker compose up -d
```

Open `http://localhost:8787`, sign in, and add a folder pair. For a step-by-step
walkthrough with screenshots, see [docs/SETUP.md](docs/SETUP.md). For a reference
of every feature and option, see [docs/USER_GUIDE.md](docs/USER_GUIDE.md). For
common questions and design rationale, see [docs/FAQ.md](docs/FAQ.md). For
full deployment instructions and configuration reference,
see [docs/DEPLOY.md](docs/DEPLOY.md).

### Development

```bash
npm install          # applies the @protontech/crypto patch via patch-package
npm run server       # backend on :8787
npm run web:dev      # Vite dev server (proxies /api to :8787)
```

Requires Node.js >= 26 (uses `node:sqlite` and the `Uint8Array.prototype.toHex` API
that `@protontech/crypto` depends on).

## Status

M0–M6 complete: auth spike → file ops → encrypted session → state DB + backup/
restore → bidirectional sync + progress UI → Docker packaging. Usable as a
personal backup/sync tool; treat as beta, test against a throwaway Proton
account first.

## Disclaimer

This project uses the Proton Drive SDK in accordance with Proton's usage
guidelines for personal, non-commercial projects. Access to Proton's hosted
services remains subject to Proton's separate terms of service.

## License

[MIT](LICENSE), matching the upstream SDK.
