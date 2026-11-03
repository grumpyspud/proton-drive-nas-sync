# FAQ: Proton Drive NAS Sync

> **⚠️ Third-party application: not affiliated with, endorsed by, or supported
> by Proton AG.**

---

## Why was this app made?

I have a 2 TB Proton Drive account I use for both work and personal files. I
didn't want to keep a full 2 TB drive in every system I use, or install the
Proton Drive client on each one: and several of them run Linux, where Proton
still hasn't shipped a client. With this, I back up to my NAS like normal, and
the app handles the Proton Drive side for me. Simple, easy. Because it runs in
Docker, it can even serve as a Linux/Windows/macOS client if you want.

---

## Is this official? Is it supported by Proton?

No. This is a third-party, self-hosted application. It is not affiliated with,
endorsed by, or supported by Proton AG. It is built on Proton's official,
open-source Drive SDK, and access to Proton's hosted services remains subject to
Proton's own terms of service.

## What does it actually do?

Its headline feature is **two-way folder sync**: pair a NAS folder with a Proton
Drive folder and keep them mirrored. Additions, edits, and deletions on either
side propagate to the other.

It also ships an **encrypted config backup/restore**: export everything needed
to move or rebuild the app (folder pairs, Proton session, encryption key) to an
encrypted `.pdnbak` file, then restore it on a new machine without re-signing
in. (That's a snapshot of your *setup*, not your files.)

---

## What are "device syncs" (Computers)?

Proton Drive's desktop app syncs a "Computers" folder for each machine you install
it on. A **device sync** connects a NAS folder to those computer folders, so a set
of PCs and the NAS all mirror each other through Drive: an edit on one PC reaches
the NAS and the other PCs, and NAS changes flow back to them.

- One computer can be in **one** device sync; a sync can hold several computers.
- **Only one** device sync can enable **auto add/remove** (join new computers /
  drop gone ones automatically).
- A device sync may start empty **only** with auto add/remove on.
- The NAS folder is fixed at creation (delete and recreate to change it).

Device syncs also resolve conflicts automatically rather than freezing them for
review (see below).

---

## Design choices: the UI

- **One container, one surface.** The React frontend is built and served by the
  same Node backend that runs the sync engine. One image, one port, nothing else
  to host.
- **Un-branded and honest.** No Proton branding: it's explicitly third-party ~
  with a disclaimer on the login screen.
- **Two-column dashboard.** Live sync activity and progress on the left; local
  storage, Proton Drive storage, and folder pairs on the right. Everything you
  need to see is on one screen.
- **Actions live in modals.** Creating a pair, the duplicate scan, logs, and the
  trash are pop-up overlays. The top bar holds only the global controls
  (Pause/Resume, Stop, Create pair, Logs, Settings, Sign out).
- **Themeable.** Light and dark modes driven by CSS variables, so the whole UI
  switches consistently.
- **Safety-first controls.** No destructive action sits one mis-click away:
  dedupe only trashes files you don't select to keep, you have to manually
  delete any trashed file from the sync pair's trash, the deletion tripwire
  shows a confirmation before massive deletions happen, low Drive space
  warnings so you know before a failed backup happens because of an
  out-of-space error.

## Design choices: the backend

- **TypeScript on Node.js (≥ 26).** ESM, single process, SQLite for state.
- **Layered, with crypto fenced at the bottom.** Web UI → REST API → app core
  (sync engine + scheduler + state) → a crypto abstraction → auth/session →
  the Proton Drive SDK. Each layer only talks to the one below it.
- **The SDK is not auth, and it has no sync module.** Proton's official SDK is a
  Drive *client* (list/upload/download/move/trash). Authentication, session
  management, and the sync engine are all built here, on top of the SDK's
  primitives.
- **A local state DB because the SDK can't "search by path".** The SDK addresses
  nodes by link ID, not path, so the app keeps a SQLite mapping of
  `NAS path → Drive link ID → content fingerprint`. That mapping is what makes
  change detection and resume fast.
- **Two mounted volumes.** `/config` (state DB, encrypted session, pair config)
  and `/data` (the synced tree). Updating the container never loses state.
- **Polling, not push.** Proton Drive exposes no webhook for remote changes, so
  the scheduler polls the Drive event feed and stat-scans local folders on a
  short interval (default 30 s).

---

## How does authentication work?

Proton's SDK deliberately ships **without** login or session management, so the
app implements it:

- **Login**: a Secure Remote Password (SRP-6a) handshake against Proton's auth
  API. SRP means your password is never sent to Proton in the clear.
- **2FA**: an optional TOTP code, supported in the login flow.
- **Two-password mode**: if the account has a separate mailbox password, the
  app uses it to derive the key passphrase and unlock the account keyrings.
- **Session resume**: after login, only the *session* is persisted (refresh
  token + salted key passphrase) in an **AES-256-GCM encrypted blob**, keyed from
  a Docker secret/keyfile (or `PDN_ENCRYPTION_KEY`). The raw login, 2FA, and
  mailbox passwords exist in memory only during sign-in and are never written to
  disk.
- **Optional app password**: a second, self-hosted layer on top of Proton
  sign-in. It gates the dashboard, the API, and the live event stream, and is
  stored only as a scrypt hash (never plaintext). It also protects the config
  backup.

### Is my data readable by the app or server?

The app *must* be able to read the files it syncs: that is inherent to a sync
tool, and during a session it holds your Proton keys to do the decrypt/encrypt.
What it does **not** do: it stores no file *contents* locally (only paths and
content hashes in the state DB), it sends data only to Proton's servers
(encrypted with Proton's key model), and your Proton credentials are never kept
in plaintext. The one thing to protect carefully is the `/config` volume ~
treat it like your credentials, because the encrypted session blob lives there.

---

## What security hardening is built in?

- **SSRF guard.** Outbound requests are restricted to Proton-owned hosts
  (`proton.me` / `proton.ch` / `protonmail.com` / `proton.black` and their
  subdomains) over HTTPS only. The session bearer token, SRP credentials, and
  refresh token are never sent to a non-Proton host or over plain HTTP, and an
  unsafe `PROTON_DRIVE_BASE_URL` stops the app at startup.
- **Session gating.** The encrypted session blob is written to disk only after
  login fully completes (2FA + key derivation), and a partial blob (for example
  from a restart mid-2FA) is rejected on resume rather than surfacing a
  half-authenticated session.
- **App password.** An optional self-hosted password (scrypt-hashed, HMAC-signed
  session cookies) gates the dashboard, the API, and the live sync stream on top
  of the Proton login.

---

## How will the app handle Proton's upcoming crypto change?

Proton Drive is moving to a new cryptographic model around the end of 2026 /
early 2027, and clients that only speak the old model will stop interoperating
until they upgrade.

The app is built for exactly this. All cryptographic work is fenced behind a
single **`CryptoBackend` interface** (the file-encryption module, the keyring
proxy, and the SRP primitives), and only two small modules: `auth` and `crypto`
~ touch crypto directly. The sync, backup, and restore engines and the entire UI
never call crypto.

So when Proton flips models, the change is: bump the SDK dependency, add one new
backend implementation, and select it at startup. The engines and UI don't
change. The SDK's changelog is the trigger that tells us the swap is due.

---

## How does the sync engine work?

Each folder pair is a three-way reconcile, run continuously in "real time":

1. **Walk** both trees: the local NAS folder and the Proton Drive folder ~
   using the SDK's listing calls.
2. **Compare against state**: for every path, diff what's local vs. what's on
   Drive vs. what the state DB last recorded, and compute the minimal operation
   (add / modify / delete / rename).
3. **Transfer**: upload or download only the files that changed, in parallel
   (see below).
4. **Record**: write the new fingerprints back to the state DB so the next
   cycle skips unchanged files without re-hashing or re-transferring.

### How does it detect changes without re-downloading everything?

- **Local side**: a file's size + mtime are compared first; if they match the
  stored record, the stored content hash is reused and no re-hash happens. Only
  when size or mtime changes is the file re-hashed.
- **Drive side**: the SDK reports a content fingerprint (SHA-1 + size) for each
  file, which is compared against the stored one.

### What happens on a conflict?

If the same file changes in *both* places between syncs, the app does **not** pick
a winner for a regular folder pair. It preserves the **Drive** version next to the
local file as `filename.conflict-<timestamp>`, records the conflict, and freezes
that one file (skipped in later syncs) until you resolve it. Nothing is silently
overwritten or lost: you review both versions in the pair's **Conflicts** panel
(see the user guide) and choose which to keep.

**Device syncs are the exception**: they resolve conflicts automatically - the
newer version (by Drive's server-side modification time) keeps the name, and the
older version is preserved as `filename (computer-name).ext`. See the user guide's
device-sync section.

### What protects against accidental mass deletion?

Three independent barriers, applied in both directions:

1. **Source-availability gate**: if a source folder is missing/unreadable (an
   unmounted NAS share, a dropped Drive connection), the cycle halts as
   "source unavailable" instead of treating it as "everything was deleted".
2. **Deletion-rate tripwire**: if one cycle computes more than **25%** of a
   pair's files as deletions, it pauses and shows a confirmation card with the
   exact count and file breakdown before doing anything.
3. **Trash-before-delete**: the sync engine only ever soft-deletes: Drive files
   go to Proton Drive's trash, local files go to a hidden `.pdn-trash` folder.
   Permanent delete is a separate, explicit action.

### What happens if one file fails?

Skip-on-error. A single failed hash/upload/download is logged and skipped; the
rest of the sync continues. The failed file is retried on the next cycle.

---

## How did you speed up initial syncs and file transfers?

Four concurrency changes, each targeting a different bottleneck:

1. **Parallelized the Drive walk.** Listing used to happen one folder at a time
   (a network round-trip each). It now runs ~8 concurrent listing calls, which
   collapsed the "stuck on Syncing" phase on large trees.
2. **Hash each file once.** Change detection and upload both used to hash the
   same file separately; the computed hash is now passed through to the upload,
   halving hashing work on a first sync.
3. **Multi-threaded crypto.** OpenPGP decrypt of node metadata is CPU-bound and
   was single-threaded. It now runs in a pool of worker threads (one per CPU
   core, capped at 8), spreading up to 30 concurrent decrypts across the cores.
4. **Parallel file transfers.** Transfers are now bounded-concurrency
   (default **3**, max **4**, adjustable **1–4** in Settings). 1 = sequential;
   higher values overlap uploads/downloads so the wire stays busy while other
   files hash.

The overall progress bar tracks **files processed** (not just bytes), so even a
sync that mostly skips unchanged files still advances instead of sitting at 0%.
The transfer speed is sampled from the container's network
counters rather than the backend's bursty progress estimates, so it reads as a
stable real-world rate.

---

## What are the limitations?

Be aware of these before relying on it:

- **Beta.** Most milestones are complete and it's in daily use, but treat it as
  beta: test against a throwaway Proton account first.
- **Poll-based "real time".** There is no push/webhook from Proton, so sync polls
  the event feed and local folders every ~30 seconds - near "real time", not
  instant.
- **Whole-file transfer.** A changed file is re-transferred in full: there is
  no block-level (rsync-style) delta.
- **One account per instance.** A container syncs a single Proton account.
- **No automatic permanent delete.** The sync loop only soft-deletes; emptying
  trash is a manual step.
- **No file version history.** Sync mirrors the *current* state; the trash is
  the recovery path, not snapshots.
- **No automatic conflict merge.** For a regular folder pair, a conflict keeps
  both copies: the Drive version is saved as `.conflict-<ts>` and the file is
  frozen until you pick a winner in the **Conflicts** panel; there is no content
  merge. Device syncs instead auto-resolve by modification time (newer wins,
  older kept as `filename (computer-name).ext`) - still no content-level merge.
- **Dedupe is per-pair and local-only.** It finds duplicates within one pair's
  local folder, on demand: not across pairs, and not on the Drive side.
- **Human verification is manual.** Proton's CAPTCHA challenge (rare, usually
  one-time per account) requires a one-off browser step.
- **Requires Docker.** Runs as a container with `/config` and `/data` mounts.

---

## What license is it?

**GPL-3.0.** The app links `@protontech/crypto` (Proton's OpenPGP + SRP engine),
which is GPL-3.0, so the distributed work is GPL-3.0. The Drive SDK
(`@protontech/drive-sdk`) itself is MIT.

GPL-3.0 does not restrict private use: running your own instance is unaffected.
It applies when you *distribute* the code or a built image, in which case you
must do so under GPL-3.0 and make the source available.

---

## Other common questions

### Does it delete anything permanently?

Not automatically. The sync engine only trashes (Drive) and recycles (local).
Permanent deletion is a separate, explicit action you take in the Trash view.

### What happens when I sign out?

**Sign out** does a full reset of the app's sync state: it removes every folder
pair, empties each pair's local trash (`.pdn-trash`), deletes the per-file sync
records and dedupe ignore lists, stops all syncing, and signs you out of Proton
(deleting the saved session). A confirmation pop-up lists all of this first.

**Your files are not touched**: the synced files on the NAS and their copies in
Proton Drive stay exactly where they are. Sign out only clears the app's own
bookkeeping. You'll need to sign in again and recreate your folder pairs; if you
want to keep the setup, use **Backup** instead.

### Does it run on my NAS?

Any NAS that runs Docker (TrueNAS, Synology, QNAP, Unraid, etc.). Images are
published for both `amd64` and `arm64`, so it runs on x86-64 and ARM-based NAS
boxes alike.

### What if I hit my Proton Drive quota?

Uploads that would exceed quota fail that file, are logged, and are retried on
the next cycle. The dashboard shows your usage and warns you at 80% (amber) and
90% (red) so you catch it before it bites.

### Why did the Logs button turn red (or yellow)?

The **Logs ▾** button is a live indicator for the **error log**: a separate,
persistent log of errors, conflicts, and warnings. It turns **red** when there
are new (unseen) errors, **yellow** for new warnings/conflicts. Open **Logs ▾ →
Error log** to review them (colour-coded by severity), then **Reset** to clear the
indicator, **Clear** to wipe the log, or **Save** to download it.

The error log exists because the main sync log rotates once it grows large, so an
early error on a big sync could scroll away. Errors/conflicts/warnings are written
to the error log as well, so they aren't lost.

### What if I get "too many logins" (429)?

That's Proton's rate limiter, not a bug. It self-clears in minutes. Space out
logins, or just let the persisted session resume instead of signing in again.

### Is this a backup tool or a sync tool?

It's a **sync** tool: a two-way mirror. A one-way backup is "upload
new/changed files and never delete", whereas sync also propagates deletions.
The app's own **config backup** (`.pdnbak`) is a separate thing: an encrypted
snapshot of your *setup* (pairs + session + key), not your files.

### Can I use more than one account?

Run one container instance per Proton account. A single instance is tied to one
account's session.

### How do I move to a new NAS?

Copy the `/config` and `/data` volumes to the new host and point the container at
them: that moves your pairs, session, and files together. The state DB carries
the per-file fingerprints, so the new instance resumes without re-uploading or
tripping the deletion safeguard.

The encrypted `.pdnbak` backup restores the *config* only (pairs, session, and
state DB): **not your files**: so use it to rebuild the app when `/config` is
lost but the files are already on the new host.

> Each container needs its **own** Proton session. Don't restore one `.pdnbak`
> into more than one container, or otherwise share a session across containers ~
> they'll fight over the refresh token and force repeated sign-ins. If several
> containers connect to the same Proton account, sign in to each one separately,
> and only use a `.pdnbak` to skip sign-in when that container is the only one
> using that session.
