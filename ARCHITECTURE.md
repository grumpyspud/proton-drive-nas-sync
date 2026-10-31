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
   on the SDK's client primitives (list, upload, download, move, trash), with
   change detection by interval polling: Proton Drive exposes no push/webhook
   for remote changes.
3. **The crypto model is changing.** Proton Drive moves to a new cryptographic
   model around end of 2026 / early 2027. Clients that only implement the old
   model will stop interoperating until they upgrade.

## Auth / Session layer

The SDK expects an already-authenticated HTTP client and an unlocked account
(keyrings). This project is responsible for producing both:

- **Login**: SRP-6a handshake against Proton's auth API.
- **2FA**: optional TOTP code.
- **Two-password mode**: optional second (mailbox) password used to derive the
  key passphrase and unlock the account keyrings.
- **Resume**: persists the *session* (refresh token + salted key passphrase),
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

- `auth`: SRP and key-passphrase derivation (bcrypt over fetched salts).
- `crypto`: OpenPGP operations delegated to the SDK's crypto module.

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

The engine polls on the configured interval: there is no server-side push from
Proton, and no filesystem watcher (a watcher would still miss remote Drive-side
changes). Each cycle it walks both trees and diffs them against the state DB:

- **Local (NAS) side**: a file's size + mtime are compared first; only if they
  differ is the file re-hashed. Unchanged files reuse the stored hash (no
  re-hash, no re-transfer).
- **Remote (Drive) side**: the SDK reports a content fingerprint (SHA-1 + size)
  for each file, compared against the stored one.

Each path is diffed to compute the minimal operation (add / modify / delete /
rename) on the other side. Conflicts keep both copies: the local copy wins and
the other side's version is preserved as `<name>.conflict-<timestamp>`.

### Deletion safety (catastrophic-delete protection)

Sync must never mass-delete a healthy side because the other side briefly
"looks empty": an unmounted NAS share, hardware failure, a dropped Drive
connection, or expired credentials. Deletions are gated by three independent
barriers, applied on **both** directions:

1. **Source-availability gate**: before propagating any deletion, verify the
   source actually resolves and is readable. A NAS watched folder that is
   missing/empty/not-a-directory, or a Drive side returning auth/network
   errors, is treated as "source unavailable", not "everything deleted": the
   cycle halts and raises an alert instead of deleting.
2. **Deletion-rate tripwire**: if a single cycle computes more than a
   configurable threshold (default 25%) of a pair's items as deletions, the
   engine pauses and requires manual confirmation in the UI before applying.
3. **Trash-before-delete**: the engine only ever soft-deletes (Drive trash /
   NAS recycle). Hard delete is a separate, explicit user action, so even a
   confirmed deletion remains recoverable.

These map directly onto the M1 primitives: `trashNodes` (soft) is the engine's
only deletion verb, and `deleteNodes` (hard) is never called by the sync loop.

## Backup / restore

Backup and restore are one-directional jobs layered on the same primitives as
the sync engine. They exist at the engine level; the web UI is sync-first (the
UI's "Backup" is an encrypted config backup, not a file backup).

- **Backup**: walk the NAS tree, upload new/changed files to Drive, record
  mappings.
- **Restore**: walk the Drive tree, download to a chosen NAS location.

## Packaging

- Multi-stage Docker build producing a single image (backend serves the built
  SPA).
- Two mounted volumes, so updates never lose state:
  - `/config`: SQLite state DB, encrypted session blob, folder-pair config.
  - `/data`: the NAS-side watched folders.
- Runs on any NAS that can run Docker (TrueNAS, Synology, QNAP,
  Unraid, etc.).

## License

This project is **GPL-3.0**. It links `@protontech/crypto` (Proton's OpenPGP
fork + SRP primitives), which is GPL-3.0, so the distributed work is GPL-3.0.
The Drive SDK itself (`@protontech/drive-sdk`) is MIT.
