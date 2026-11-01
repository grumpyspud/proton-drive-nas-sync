# User Guide: Proton Drive NAS Sync

A reference for every feature and option in the web UI.

> **⚠️ Third-party application: not affiliated with, endorsed by, or supported by
> Proton AG.**
>
> **⚠️ Disclaimer:** This software is provided "as is", without warranty of any
> kind. You are solely responsible for your data. The author is not liable for any
> loss, deletion, corruption, or unintended modification of files: locally or in
> Proton Drive: arising from your use of this application. Always keep an
> independent backup of anything you can't afford to lose.

For first-time setup with screenshots see [SETUP.md](SETUP.md); for deployment,
environment variables, and security see [DEPLOY.md](DEPLOY.md).

---

## The dashboard

After signing in you land on the dashboard, with two columns:

- **Sync activity** (left): the live status and progress of the current sync, plus
  the last-sync summary.
- **Local storage**, **Proton Drive Storage**, and **Folder pairs** (right): your NAS volumes'
  usage, your Proton Drive usage, and the list of sync pairs.

![Dashboard](screenshots/06-dashboard.png)

### Top bar

| Control | What it does |
|---|---|
| **⏸ Pause / ▶ Resume** | Pause or resume all syncing globally. |
| **⏹ Stop** | Stop the current sync (shown only while a sync is running). |
| **＋ Create Sync Pair** | Add a new folder pair. |
| **Logs ▾** | **Sync log** (recent server log, searchable, downloadable), **Activity log** (recent events), or **Error log** (errors/conflicts/warnings). Turns **red** (errors) or **yellow** (warnings/conflicts) when there are new entries. |
| **⚙ Settings** | Backup, app password, lock, theme, and max concurrent transfers. |
| **Sign out** | Sign out of Proton and reset all sync state (see [Signing out](#signing-out)). |

---

## Sync pairs

A **sync pair** links a local folder on your NAS with a folder in Proton Drive and
keeps them in sync (additions, edits, and deletions on either side are mirrored to
the other).

### Creating a pair

1. Click **＋ Create Sync Pair** in the top bar.
2. **NAS / local folder**: browse or type an absolute path under a mounted
   volume (e.g. `/data/photos`). The app only accepts folders on a mounted
   volume; a path inside the container itself is rejected with a warning.
3. **Proton Drive folder**: pick an existing Drive folder, or **My Files (entire
   drive)** to sync the whole drive.
4. Click **Create pair**.

![Create sync pair](screenshots/07-add-pair-folder-picker.png)

### "Real-time" sync

Every pair syncs in "real time". The engine watches the Proton Drive event feed and
stat-scans the local folder on a short interval, mirroring additions, edits, and
deletions as soon as they are detected. The **Sync** button on a pair runs an
immediate sync on demand, and the top-bar **⏸ Pause** is the only "don't sync"
control.

---

## Running and controlling a sync

- **Sync** (on a pair) runs that pair immediately.
- **⏸ Pause / ▶ Resume** (top bar) pauses or resumes all syncing.
- **⏹ Stop** (top bar, while running) cancels the current sync.

While a sync runs, the **Sync activity** card shows:

- an **overall progress bar**: files processed (percent + count) and, while
  data is actually moving, bytes transferred plus the container's network rate,
- a **per-file progress bar** (bytes + percent) for each file currently
  transferring,
- a **last-sync summary**: uploaded, downloaded, skipped, failed, conflicts,
  trashed on Drive, and recycled locally.

![Sync in progress](screenshots/19-sync-progress.png)

---

## Duplicate files (dedupe)

Each pair has a **Dedupe Scan** button that finds identical files (by content hash)
within that pair's local folder. Empty files are always skipped.

Files are content-hashed as they're downloaded during a sync, so newly synced
files are ready for dedupe immediately. If a pair still has older files without a
stored hash, the **Dedupe Scan** button hashes those first: it shows a
**Hashing… NN%** progress bar (and disables) until the backlog is caught up, then
opens the scan as usual.

1. Click **Dedupe Scan** on a pair.
2. Choose a **minimum file size** (`No min size`, `1 KB`, `10 KB`, `100 KB`,
   `1 MB`, `10 MB`) and click **Scan**. The modal does not scan on its own.
3. Results are grouped by content: e.g. "3 identical copies · 4.2 MB each".

For each group, **check the copies you want to keep**; unchecked copies are the
ones that will be recycled. **If none are checked, everything is kept**: there is
deliberately no way to remove all copies at once.

- **Recycle N unselected**: moves the unchecked copies to the local trash
  (`.pdn-trash`); their Drive copies are trashed on the next sync.
- **Ignore**: hides that group from future scans.

Ignored files are listed at the bottom of the modal, grouped by content, where you
can **Reset** an individual group or **Reset all** to bring them back into scans.

![Duplicates](screenshots/15-duplicates.png)

---

## Conflicts

A **conflict** happens when the same file changes in *both* places between syncs ~
for example, you edit `notes.txt` on the NAS and a different version of `notes.txt`
also appears in Proton Drive. The app never guesses which one you want.

On the next sync it:

- **preserves the Drive version** as `notes.txt.conflict-<timestamp>` next to the
  local file,
- **records the conflict** so it isn't forgotten, and
- **freezes that one file**: it's skipped in later syncs until you decide. The rest
  of the pair keeps syncing normally.

A pair shows an orange **Conflicts (N)** button (next to **Dedupe Scan**) only when
it has unresolved conflicts. Click it to review them:

![Conflicts](screenshots/23-conflicts.png)

Each conflict lists both versions: **Local (NAS)** and **Drive (Proton)**: with
size, last-modified date, and content hash (SHA-1), so you can tell which is which.
Select the version to keep and click **Keep selected**:

- **Keep Local (NAS)**: re-uploads the local copy to Drive, then recycles the
  preserved `.conflict-<ts>` copy to `.pdn-trash`.
- **Keep Drive (Proton)**: recycles the local copy to `.pdn-trash` and restores
  the `.conflict-<ts>` copy into place (Drive already holds it, so nothing is
  re-uploaded).

Either way the loser is only *recycled* to `.pdn-trash`, never hard-deleted, so you
can recover it from the pair's **Trash** view if you change your mind.

---

## Trash (recycle bin)

Deletions never happen immediately: files are recycled first. Click **Trash** on a
pair to see what's been recycled:

- **Restore**: put a file back.
- **Delete**: permanently remove a single recycled file.
- **Clear all**: permanently delete every recycled file for that pair.

Recycled local files live in a hidden `.pdn-trash` folder inside the pair's local
folder; on the Drive side, deletions go to Proton Drive's trash.

![Trash](screenshots/16-trash.png)

---

## Deletion safety

Several guards prevent a mistake from wiping data:

- **Trash before delete**: deletions are recycled/trashed, not removed outright.
- **Source-availability gate**: a sync won't delete files because a source folder
  is missing or a drive is offline.
- **Deletion-rate tripwire**: if a sync would delete more than **25%** of tracked
  files, it pauses and asks for explicit confirmation, showing exactly what would
  be trashed (Drive) and recycled (local).

![Deletion confirmation](screenshots/20-deletion-hold.png)

---

## Local storage

The **Local storage** card sits above the **Proton Drive Storage** card and shows
every data volume bind-mounted into the container (for example a single `/data`,
or separate `/data/photos` and `/data/documents` shares), with per-volume
used/total and a fill bar. The container's own storage and `/config` are excluded
automatically.

## Proton Drive Storage

The **Proton Drive Storage** card shows how much of your Proton Drive quota you're using.

- **Above 80%**: the bar turns yellow-orange.
- **Above 90%**: the bar turns red and a **"Warning: Drive space almost full"**
  message appears under it.

![Storage warning](screenshots/18-storage-warning.png)

The card's **Trash** button opens your Proton Drive trash (below).

## Proton Drive trash

The **Proton Drive Storage** card's **Trash** button lists everything currently in
your Proton Drive trash:

![Proton Drive trash](screenshots/24-drive-trash.png)

Proton Drive stores only a trashed item's name (not its full path), so the list
shows each item's name and type. From here you can:

- **Restore**: return an item to its original folder. If it is inside a synced
  pair, the next sync re-downloads it.
- **Delete**: permanently remove a single item.
- **Empty trash**: permanently delete everything in the trash.

Delete and Empty trash are irreversible - that is exactly why they ask for
confirmation.

---

## Logs

The **Logs ▾** menu has three views:

![Logs menu](screenshots/14-logs-menu.png)

- **Sync log**: the recent server log (`/config/sync.log`), searchable
  and downloadable.

  ![Sync log](screenshots/10-logs.png)

- **Activity log**: the most recent sync actions from the current browser session
  (capped at 200 events).

  ![Activity log](screenshots/17-activity-log.png)

- **Error log**: a separate, persistent log of **errors**, **conflicts**, and
  **warnings** only (see below).

### Error log

The **Logs ▾** button turns **red** when there are unseen errors, or **yellow**
for unseen warnings/conflicts. Open **Logs ▾ → Error log** to review them:

![Error log](screenshots/21-error-log.png)

Entries are colour-coded by severity: **error** (red), **conflict** (orange),
**warning** (yellow). Three actions are available:

- **Reset**: mark the current entries as seen (returns the button to normal).
- **Clear**: delete every entry.
- **Save**: download the whole log as a `.txt` file.

> The main sync log is rotated once it grows large, so an early problem on a long
> sync could scroll away. The error log is separate and only records
> errors/conflicts/warnings, so those survive.

---

## Signing out

Clicking **Sign out** in the top bar signs the app out of Proton: and because it
can no longer sync once signed out, it performs a **full reset of its sync state**:

- **Removes every folder pair.**
- **Empties each pair's local trash** (the `.pdn-trash` recycle bin).
- **Deletes all sync state**: per-file records, hashes, and dedupe ignore lists.
- **Stops all syncs** and **signs out of Proton**, deleting the saved session.

A confirmation pop-up spells this out before anything happens:

![Sign out confirmation](screenshots/22-signout.png)

**No other data is deleted.** Your actual files: the ones in your synced folders
on the NAS, and their copies in Proton Drive: are left exactly where they are.

> After signing out you'll need to sign in again and recreate your folder pairs.
> To move this setup to another machine instead, use **Backup** (Settings → Backup),
> which captures the pairs and session so you don't have to rebuild them.

---

## Settings

The **⚙ Settings** menu holds:

![Settings menu](screenshots/13-settings-menu.png)

- **💾 Backup**: export an encrypted backup (see below).
- **🔒 App password / 🔓 Set password**: set or change the dashboard's own
  password.
- **🔐 Lock**: lock the dashboard without signing out of Proton (shown only when
  an app password is set).
- **☀ Light / 🌙 Dark**: switch the theme.
- **Max concurrent transfers**: how many files sync in parallel.

| Setting | Options | Default |
|---|---|---|
| Max concurrent transfers | 1 (sequential), 2, 3, 4 | 3 |

Higher concurrency is faster for bulk syncs but uses more bandwidth.

---

## App password & lock

The **app password** is an optional second lock (on top of Proton sign-in) that
protects the whole dashboard. Set it from **⚙ Settings → Set password** (minimum
6 characters). It is stored as a scrypt hash: never in plaintext.

**🔐 Lock** re-locks the app behind that password without signing you out of
Proton.

---

## Backup & restore

**💾 Backup** exports a single encrypted `.pdnbak` file containing your folder
pairs, Proton session, and encryption key: everything needed to move or rebuild
the app without re-signing in. It requires the **app password** and a **passphrase**
(12+ characters with upper + lower case, a number, and a symbol).

Restore is available from the sign-in screen (before Proton login). You'll need the
**app password** and **backup passphrase**, and: if restoring from a downloaded
file: the `.pdnbak` file itself.

> If you set an app password, it becomes part of the encryption key, so you must
> use the same value at restore time.
