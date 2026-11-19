# Running on TrueNAS SCALE

How to run proton-drive-nas-sync as a custom app on TrueNAS SCALE, using the
published image and your existing datasets.

> **⚠️ Third-party application: not affiliated with, endorsed by, or supported by
> Proton AG**, and not affiliated with iXsystems / TrueNAS either. Always keep an
> independent backup of anything you can't afford to lose.

This guide assumes **TrueNAS SCALE 24.10 (Electric Eel) or later**, where apps run
on Docker and a custom app can be installed from a Docker Compose YAML. The
examples use a pool named `tank`: replace it with your own pool name. Paths are
case-sensitive (`/mnt/tank/Photos` is not `/mnt/tank/photos`).

For general deployment details (environment variables, HTTPS, security), see
[DEPLOY.md](DEPLOY.md). For a walkthrough of the web UI, see [SETUP.md](SETUP.md).

---

## 1. Create a dataset for `/config`

The app keeps its encrypted session, sync database, and cache in `/config`. Give
it its own dataset so it survives app reinstalls and can be snapshotted.

1. Go to **Datasets**, select the dataset that holds your apps (or the pool root),
   and click **Add Dataset**.
2. **Name:** `proton-drive-nas-sync`
3. **Dataset Preset:** **Apps**. This grants the built-in `apps` user (UID/GID
   `568`) access, which is the user the container runs as below.
4. Save.

Do **not** share this dataset over SMB/NFS: anyone who can read it can resume
your Proton session.

## 2. Give the app access to the folders you want to sync

Each folder you sync is mounted into the container under `/data/<name>`. The
container runs as the `apps` user, so that user needs write access:

1. Go to **Datasets**, select the dataset (e.g. `Photos`), and click **Edit** on
   the **Permissions** card.
2. **Add Item**: **Who:** User, **User:** `apps`, **Permissions:** Modify.
3. Tick **Apply permissions recursively** so existing files are covered too.
4. **Save Access Control List**.

Repeat for every dataset you want to sync. Only mount (and grant access to) the
folders you actually want the app to touch.

## 3. Install the app from YAML

Go to **Apps → Discover Apps**, choose **Install via YAML** (in the ⋮ menu next to
**Custom App**), give the app a name, and paste:

```yaml
services:
  proton-drive-nas-sync:
    image: ghcr.io/grumpyspud/proton-drive-nas-sync:latest
    container_name: proton-drive-nas-sync
    restart: unless-stopped
    user: "568:568"
    ports:
      - "8787:8787"
    environment:
      TZ: Etc/UTC   # your timezone, e.g. America/Chicago
      # Optional: seed the app password on first run (change it in the UI later)
      # PDN_APP_PASSWORD: "change-me"
    volumes:
      - /mnt/tank/apps/proton-drive-nas-sync:/config
      - /mnt/tank/Documents:/data/Documents
      - /mnt/tank/Photos:/data/Photos
      # - /mnt/tank/Music:/data/Music
```

- The first volume is the `/config` dataset from step 1.
- Add one line per dataset from step 2, mapped under `/data/<name>`. Mounting a
  folder does not start syncing it: nothing syncs until you create a pair for it
  in the web UI.
- If another app already uses port `8787`, change only the left side, e.g.
  `"8788:8787"`.

Save, and wait for the app to show **Running**.

## 4. First run

1. Open `https://<truenas-ip>:8787`. The certificate is self-signed, so accept the
   browser warning (see [DEPLOY.md](DEPLOY.md#https) to use your own).
2. Set an **app password** (⚙ Settings → Set password) before anything else.
   Without it, anyone on your network who can reach the port can use the
   dashboard.
3. Sign in to Proton and create your first pair. Start with a small folder to
   check permissions and sync direction before adding large datasets.

Sync is **two-way**: deleting a file in Proton Drive also deletes it on the NAS,
and the other way round. Deleted files go to a `.pdn-trash` folder inside the
synced folder first. Be careful with datasets that another app manages (for
example a photo library): that app will also see files arriving from Drive and
the `.pdn-trash` folder.

## 5. Updating

The YAML uses the `:latest` tag, which always points to the newest release.
TrueNAS periodically checks the registry: when a new release is published, the
app shows **Update available**. Click **Update** to pull it and restart. Nothing
updates without that click.

The app's own dashboard also shows when a newer release exists, which is a useful
backup if TrueNAS does not flag the update.

Before updating, **take a snapshot of the `/config` dataset** (Datasets →
select it → **Take Snapshot**) so you can restore your settings and sync state if
a new version misbehaves.

## Troubleshooting

When the app fails to start, TrueNAS shows an error like
`[EFAULT] Failed 'up' action for '<app>' app. Please check /var/log/app_lifecycle.log`.
Open **System → Shell** (or SSH in) and read the log:

```bash
sudo tail -n 40 /var/log/app_lifecycle.log
```

| Message in the log | Likely cause |
|--------------------|--------------|
| `manifest unknown` | The image tag doesn't exist. Check the spelling (`latest`, not `lastest`). If the tag is right, the published image itself may be unavailable: check the repository's issues. |
| `bind source path does not exist` | A host path in `volumes:` doesn't match a dataset. Check the pool name, dataset name, and capitalization. |
| `port is already allocated` | Another app uses the same host port. Change the left side of the `ports:` mapping. |

If the app starts but then stops or keeps restarting, read the container's own
output:

```bash
sudo docker logs proton-drive-nas-sync
```

`permission denied` / `EACCES` errors there usually mean the `apps` user can't
write to `/config` (recreate the dataset with the **Apps** preset) or to one of the
`/data` folders (see step 2).
