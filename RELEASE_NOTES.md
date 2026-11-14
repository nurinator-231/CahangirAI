# Cahangir 1.0.0 — first release

Android app 1.0.0 (versionCode 2) · Windows app 1.0.0 · Debian backend 4.0.0 (schema v2) · sync protocol v2

## Highlights

* **Intelligent planner** on both apps (one shared engine): write or say what you have to do in English or Azerbaijani; Cahangir extracts tasks, deadlines, durations, priorities and fixed commitments, asks about what's missing instead of guessing, and schedules work into your free time with explanations. Daily agenda, weekly overview, upcoming/overdue/completed/priority views, manual editing (edited sessions are pinned), conflict detection with concrete alternatives.
* **Reliable reminders**: native on both platforms (Android `AlarmManager`; a Rust engine on Windows that keeps running in the tray and starts with Windows). One-time, recurring (DST-safe), deadline (24 h and 2 h before), session and commitment reminders; done/snooze; missed-reminder handling; re-armed after reboot, update, time and time-zone change.
* **Free-tier AI router** on the Debian server (Groq, Google Gemini, Cerebras, Mistral, OpenRouter `:free`, GitHub Models): explicit opt-in per provider, budgets at or below free-tier limits, rate-limit/quota detection, cooldowns, retry and fallback, usage tracking, no paid fallback. Everything works without AI.
* **Synchronization v2**: revision-based (immune to device clock differences), offline queues, retries, duplicate-safe, conflict detection with both versions preserved, tombstone deletions, paging, per-device status. Old v1 clients keep working.
* **Universal clipboard**: server-backed history (reaches offline devices later) plus instant direct delivery; opt-in clipboard watcher on Windows; button and *Share → Cahangir* on Android; loop prevention.
* **Secure file transfer**: paired-device discovery, HMAC-authenticated requests, progress, cancel, resumable chunks, SHA-256 verified on both sides, safe file names, history.

## Fixed

* Android: the WebView stored data in localStorage and mirrored it into SQLite on every change, resetting every item's `updated_at` (breaking last-write-wins) and never syncing deletions. Native SQLite is now the single source of truth; existing data is migrated once with its original ids.
* Android: reminders used numeric ids derived from hash codes and a legacy SharedPreferences copy; the JavaScript timer and the native alarm could both fire. Now only the native engine fires.
* Windows: the P2P server used axum 0.7 route syntax and panicked on start under axum 0.8 — file and clipboard receiving never worked.
* Windows: reminders were checked by a React `setInterval` and only when the window was open; *Start with Windows* and *clipboard sync* checkboxes had no effect; automatic sync did not exist; the *Connect* screen sent to an empty address.
* Windows AI chat could be pointed at arbitrary endpoints; it now uses the server's free-tier router only.
* Backend: v1 delta sync compared device timestamps (changes from a device with a slow clock were never delivered to others); reminder update endpoint was missing; CORS allowed any origin with credentials; admin token in URL query strings; automatic daily backups were documented but not implemented.

## Security changes and migration path

* Existing paired devices keep working (device tokens unchanged). The admin pairing token is no longer stored on devices (it is removed from existing installs) — enter it when pairing a new device or revoking one.
* Direct device-to-device transfer now requires the server-issued mesh key: **each device must sync once with the upgraded server** before file/clipboard transfer works.
* Admin calls accept the `X-Admin-Token` header; the old `?admin_token=` query parameter still works.

## Upgrade

1. Server: `git pull && cd backend && sudo bash setup_debian.sh` (makes a backup, migrates automatically).
2. Windows: run the new installer over the old version.
3. Android: see the signing note in [docs/INSTALL.md](docs/INSTALL.md#3-android-app).

## Known limitations

* Not verified on physical devices in this release's build environment (no Windows PC or Android device was available): see [docs/TESTING.md](docs/TESTING.md) for exactly what was and wasn't verified and a 20-minute manual checklist.
* Android receives direct file/clipboard transfers only while the app is open (no foreground service). Clipboard still arrives through the server's background sync.
* Android cannot read the clipboard in the background (OS restriction since Android 10); sharing from the phone is an explicit action.
* Windows reminders need the app running (tray); with *Start with Windows* this is automatic after login. Notification buttons (done/snooze) are in the app's alarm bar, not in the Windows toast.
* The Windows installer is cross-compiled with MinGW and not code-signed (SmartScreen warning). The APK is debug-signed (see install notes).
* Direct P2P over home Wi-Fi is authenticated and integrity-checked but not encrypted; use Tailscale addresses for encryption.
* Calendar import from Google/Android calendars is not included; commitments are entered in Cahangir (export of single reminders to the Android calendar still works).
