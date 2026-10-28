# Architecture

> ⚠️ This is a third-party application not officially supported by Proton.

## Overview

`proton-drive-nas-sync` is a Docker container that provides a web UI and a
background engine for backing up and two-way syncing folders between a NAS and
Proton Drive. It is written in TypeScript on Node.js.

## Layers

```
┌──────────────────────────────────────────────────────────┐
│  Web UI (React SPA)                                       │
│  Modern, clean look; no Proton branding; login disclaimer │
├──────────────────────────────────────────────────────────┤
│  REST API (Node)                                          │
│  auth, folder pairs, backup/restore jobs, status          │
├──────────────────────────────────────────────────────────┤
│  App Core                                                 │
│  SyncEngine (bidirectional) · BackupEngine · RestoreEngine│
│  FolderPair manager · scheduler · local state (SQLite)    │
├──────────────────────────────────────────────────────────┤
│  Crypto abstraction layer          ← the swap point       │
│  CryptoBackend interface; OpenPGP backend today,          │
│  a new backend after the model migration                  │
├──────────────────────────────────────────────────────────┤
│  Auth / Session layer (implemented here, not by the SDK)  │
│  SRP-6a login · TOTP 2FA · two-password mailbox unlock    │
│  token refresh · encrypted session store                  │
├──────────────────────────────────────────────────────────┤
│  Proton Drive SDK (@protontech/drive-sdk)                 │
│  list / upload / download / move / rename / trash / events│
└──────────────────────────────────────────────────────────┘
```

## Key facts that shaped this design

1. **The SDK is not auth.** The official SDK "does not include: authentication
   or login flows, session management, user address provider." Those are built
   in the Auth/Session layer here.
2. **The SDK has no Sync module yet.** The bidirectional sync engine is built
   on the SDK's client primitives (list, upload, download, move, trash) plus
   event-based update polling.
3. **The crypto model is changing.** Proton Drive moves to a new cryptographic
   model around end of 2026 / early 2027. Clients that only implement the old
   model will stop interoperating until they upgrade.

## Auth / Session layer

The SDK expects an already-authenticated HTTP client and an unlocked account
(keyrings). This project is responsible for producing both:

- **Login** — SRP-6a handshake against Proton's auth API.
- **2FA** — optional TOTP code.
- **Two-password mode** — optional second (mailbox) password used to derive the
  key passphrase and unlock the account keyrings.
- **Resume** — persists the *session* (refresh token + salted key passphrase),
  not the raw passwords, so the daemon can reconnect without re-entering
  credentials.

### Credential storage (security requirement)

Raw passwords (login, 2FA, mailbox) are held in memory only during sign-in and
are never written to disk. What is persisted is an **encrypted session blob**,
AES-256-GCM, keyed from a Docker secret (a mounted keyfile) rather than a
passphrase baked into the image. Losing the keyfile means re-login, never a
plaintext leak.

## Crypto abstraction layer

All direct cryptographic work is fenced into two modules:

- `auth` — SRP and key-passphrase derivation (bcrypt over fetched salts).
- `crypto` — OpenPGP operations delegated to the SDK's crypto module.

When Proton flips to the new model, the change surface is: bump the SDK
dependency, swap the `CryptoBackend` implementation, and touch only the `auth`
and `crypto` modules. The Sync/Backup/Restore engines and the UI are untouched.
The SDK changelog is watched as the trigger.

## Sync engine

Because the SDK exposes no server-side "search by path", the engine keeps a
SQLite mapping:

```
NAS path  →  Drive link ID  →  revision / content hash / mtime
```

Change detection:

- **Local (NAS) side** — filesystem watcher on the watched folders.
- **Remote (Drive) side** — the SDK's event-based update polling.

Each event is diffed against the state DB to compute the minimal operation
(add / modify / delete / rename) on the other side. Conflicts are handled by a
configurable policy (default: keep both, rename the incoming one).

## Backup / restore

Backup and restore are one-directional jobs layered on the same primitives as
the sync engine:

- **Backup** — walk the NAS tree, upload new/changed files to Drive, record
  mappings.
- **Restore** — walk the Drive tree, download to a chosen NAS location.

## Packaging

- Multi-stage Docker build producing a single image (backend serves the built
  SPA).
- Two mounted volumes, so updates never lose state:
  - `/config` — SQLite state DB, encrypted session blob, folder-pair config.
  - `/data` — the NAS-side watched folders.
- Runs on any NAS that can run Docker (, TrueNAS, Synology, QNAP,
  Unraid, etc.).
