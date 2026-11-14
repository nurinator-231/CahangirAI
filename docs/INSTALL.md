# Installing Cahangir 1.0.0

Three parts work together:

| Part | What it does | Required? |
|---|---|---|
| **Debian server** (`backend/`) | Central memory, sync hub, device pairing, free-tier AI router, backups | Needed for sync between devices and for AI. Each app also works alone, offline. |
| **Windows app** (`desktop/`) | Planner, reminders, sync, clipboard, file transfer | Optional |
| **Android app** (`app/`) | Planner, reminders, voice, sync, clipboard, file transfer | Optional |

Install the server first, then pair each device once.

---

## 1. Debian server

Requirements: Debian 12/13 (any machine, the Atom D525 is fine), Python ≥ 3.10, ~60 MB RAM. Tailscale is recommended so phones reach the server from anywhere without opening ports.

```bash
git clone https://github.com/nurinator-231/CahangirAI.git
cd CahangirAI/backend
sudo bash setup_debian.sh
```

The script is safe to re-run for upgrades:

1. If `/opt/cahangir-backend/data/cahangir.db` exists it first writes `backups/pre_upgrade_<time>.db`.
2. Replaces only the code in `/opt/cahangir-backend/app` (never `data/` or `backups/`).
3. Creates/updates the virtualenv, the systemd unit and `/etc/cahangir/cahangir.env` (mode 600, only created if missing).
4. On first start after an upgrade the database is migrated to schema v2. The migration is additive and is preceded by an automatic `backups/pre_migration_v1_to_v2_<time>.db`.
5. Prints the **admin pairing token** (also in `/opt/cahangir-backend/data/admin_token.txt`, mode 600).

Check it:

```bash
systemctl status cahangir-backend
curl http://127.0.0.1:8000/api/health      # {"status":"healthy","version":"4.0.0","schema_version":2,...}
```

**Recommended hardening:** bind the API only to the Tailscale address. Edit `/etc/cahangir/cahangir.env`:

```
CAHANGIR_HOST=100.x.y.z     # output of: tailscale ip -4
```
then `sudo systemctl restart cahangir-backend`.

**AI (optional):** see [CONFIGURATION.md](CONFIGURATION.md#ai-router). Without keys everything except free-form AI chat/AI parsing works; the planner falls back to its built-in rules.

**Backups:** an automatic consistent backup is made every 24 h (14 kept) in `/opt/cahangir-backend/backups/`. Manual: `sudo -u <user> /opt/cahangir-backend/venv/bin/python -m app.backup create` (run from `/opt/cahangir-backend`). Restore: stop the service, then `python -m app.backup restore <file>` — the current database is saved first, so a restore can be undone.

---

## 2. Windows app

Installer: `release/v1.0.0/Cahangir_1.0.0_x64-setup.exe` (per-user install, no admin rights). Requires the Microsoft Edge WebView2 runtime, which is preinstalled on Windows 10 (21H2+) and 11; the installer downloads it otherwise.

> The installer is **not code-signed**. Windows SmartScreen will show "Windows protected your PC" → *More info* → *Run anyway*. Compare the SHA-256 with `release/v1.0.0/SHA256SUMS.txt` first.

First run:

1. **Settings → Debian server & pairing**: enter `http://<server>:8000`, a device name, and the admin pairing token → *Pair this PC*. The token is used once and **not stored**. A first sync runs immediately.
2. Optional: tick **Start with Windows** (registers a real login item; the app starts hidden in the tray so reminders work after a reboot) and keep **Closing the window keeps Cahangir running in the tray** on.
3. Windows Firewall will ask to allow *cahangir-desktop* on private networks — allow it, otherwise the phone cannot send files/clipboard directly (sync through the server still works).

Upgrading from the earlier desktop build: just install over it. Your existing database in `%APPDATA%\CahangirDesktop\` is migrated in place; a copy is saved first as `cahangir_desktop.pre_v2_<time>.db`. Saved settings (server URL, device token) are kept; the stored admin token is removed.

Build it yourself on Windows: `cd desktop && npm ci && npx tauri build` (needs Rust + Node 20+; produces `src-tauri/target/release/bundle/nsis/*.exe`).

---

## 3. Android app

APK: `release/v1.0.0/Cahangir_1.0.0_android.apk` (Android 8.0+, targets Android 17 / API 37).

> This APK is signed with a **debug key**. If an older Cahangir build (signed with your own Android Studio debug key) is installed, Android refuses to update it ("App not installed / package conflicts"). Options:
> * **Recommended:** build the APK yourself from this repository in Android Studio (*Build → Build APK*) so it is signed with the same key as your current install, and install it over the old app — local data is migrated in place (a copy of the DB is made first).
> * Or: in the old app open *Ayarlar → Ehtiyat nüsxə → Export*, make sure the phone has synced with the server, uninstall, install this APK, pair again (data comes back from the server) and/or import the backup.

First run:

1. Allow **notifications** when asked (needed for reminders).
2. **Ayarlar → Mərkəzi Debian server**: server URL, device name, admin token → *Serverə qoş*. The token is not stored.
3. The same card shows reminder-reliability checks. If it offers **Dəqiq zəngə icazə ver** (exact alarms) or **Tam ekran xəbərdarlığa icazə ver** (full-screen alarm), tap them and allow — otherwise Android may delay reminders by minutes. On Samsung devices also set *Settings → Apps → Cahangir → Battery → Unrestricted*.
4. Choose the background sync interval (15 min minimum on Android).

---

## 4. Daily use in 60 seconds

* **Planner** tab: type or dictate e.g. *“I have a programming assignment due Friday, about two hours. English lessons tomorrow at 10 AM.”* → **Understand** → answer the questions it asks (e.g. how long the lesson is) → **Save** → **Plan my time** → read the reasons → **Accept plan**. Sessions and reminders are created and synced to all devices.
* Edit anything by hand; a session you move is **pinned** and never moved automatically again.
* **Clipboard**: on Windows enable *Share automatically* or press *Share what I copied*; on Android tap *Kopyaladığımı göndər* or use *Share → Cahangir* from any app.
* **Files**: pick a paired device and send; the file is verified with SHA-256 on both sides. Received files go to *Downloads* (Windows: the folder chosen in Settings; Android: `Download/Cahangir`).
