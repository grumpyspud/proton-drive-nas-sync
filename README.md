# proton-drive-nas-sync

A self-hosted Docker app that backs up and synchronizes folders between a NAS
and Proton Drive.

> **⚠️ This is a third-party application not officially supported by Proton.**
> It is not affiliated with, endorsed by, or supported by Proton AG.

## Status

**Pre-alpha / early development.** The architecture is defined (see
[ARCHITECTURE.md](ARCHITECTURE.md)); implementation has not started. Nothing
here is usable yet.

## What it will do

- **Back up** folders from the NAS to Proton Drive.
- **Restore** folders from Proton Drive back to the NAS.
- **Bidirectional folder-pair sync** — when a file or folder is added, modified,
  or removed on one side, the change is mirrored on the other.

## How it works (planned)

- **TypeScript / Node.js** backend and **React** web UI.
- Built on the official Proton Drive SDK (`@protontech/drive-sdk`, MIT), which
  provides folder listing, upload/download, move/rename, trash, and
  event-based update polling.
- The SDK does **not** include authentication, so this project implements its
  own login (SRP, optional 2FA, optional second-tier password), session
  management, and encrypted credential storage.
- Bidirectional sync is implemented on top of the SDK's client primitives,
  since the SDK's own Sync module is not available yet.

## Disclaimer

This project uses the Proton Drive SDK in accordance with Proton's usage
guidelines for personal, non-commercial projects. Access to Proton's hosted
services remains subject to Proton's separate terms of service.

## License

[MIT](LICENSE), matching the upstream SDK.
