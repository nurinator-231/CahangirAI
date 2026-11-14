# Cahangir 1.0 architecture

```
          ┌──────────────── Debian server (FastAPI + SQLite WAL) ────────────────┐
          │  devices & pairing ─ revision-based sync ─ conflict log ─ backups   │
          │  tasks · events · plan_blocks · reminders · memories · projects ·   │
          │  clipboard_items                     AI router (free tiers only)    │
          └───────────────▲──────────────────────────────▲───────────────────────┘
             HTTPS/HTTP over Tailscale (bearer device token)
          ┌───────────────┴───────────┐        ┌─────────┴──────────────────────┐
          │ Windows (Tauri 2)         │  P2P   │ Android (Kotlin + WebView)     │
          │ React UI ⇄ Rust commands  │◄──────►│ WebView UI ⇄ CahangirBridge    │
          │ SQLite store · sync loop  │ HMAC   │ SQLite EntityStore · WorkMgr   │
          │ reminder engine · tray    │ 8767   │ AlarmManager · P2P receiver    │
          └───────────────────────────┘        └────────────────────────────────┘
                 shared/planner/planner.js (same planning engine on both)
```

## Data model and source of truth

* The **Debian server** is the central store. Each device keeps a full local copy and works offline.
* On **Android**, native SQLite (`EntityStore`) is the only store for domain data. The WebView's `store.js` is an in-memory cache over it; localStorage holds UI preferences only. (Before 1.0 the WebView kept data in localStorage and mirrored it to SQLite on every save, rewriting every item's timestamp and never propagating deletions.)
* On **Windows**, the Rust `Database` is the store; React only calls commands.
* Entities and columns are declared once per platform and kept identical: `backend/app/entities.py`, `desktop/src-tauri/src/db/storage.rs`, `app/.../data/local/EntitySpec.kt` (an Android unit test fails if they drift from the backend).
* Every row: `id`, `created_at`, `updated_at`, `deleted` (tombstone), and on clients `sync_status` (pending) and `server_rev`.

## Synchronization protocol v2

`POST /api/sync` with `since_rev` and the pending rows, each carrying `base_rev` (the server revision it was edited from).

* The server stamps every write with a monotonic `server_rev`. Pulls ask for “everything after my revision”, so device clock skew can no longer hide changes (the v1 protocol filtered by device timestamps).
* Push of an item: new → insert; `base_rev` = current → fast-forward; identical → no-op (safe retries); otherwise a **conflict**: the newer edit wins, but a concurrent edit can never clear `events.confirmed` or `plan_blocks.locked` (AI/auto changes don't override confirmed commitments). Both versions are kept in `sync_conflicts` (`GET /api/sync/conflicts`).
* Response: `acks` (new revision per pushed item), the delta (paged with `has_more`), conflicts, rejected items. Clients mark an item synced only if it wasn't edited again while the request was in flight.
* v1 clients (already-installed old apps) keep working with the old request/response shape.

Clients sync in the background (Windows: Rust loop, every N min + 3 s after local edits; Android: WorkManager periodic + debounced one-shot) and on demand.

## Planner

`shared/planner/planner.js` (no dependencies) is loaded by both UIs:

* `parse()` — English/Azerbaijani rules: tasks vs. commitments, deadlines, times, durations, recurrence, priority, category. Unstated information stays empty and becomes a focused question; vague dates (“next week”) are asked about.
* Optional AI parsing goes through the server (`/api/ai/parse`); its output is validated so a deadline/time/duration is only kept if quoted from the user's text.
* `schedule()` — earliest-deadline-first with priority, inside working hours, around expanded (recurring) commitments with buffers; splits long tasks (≤ 90 min sessions, 10 min breaks, ≤ 3 h per task per day); keeps done/confirmed/locked sessions; proposes moving unlocked sessions that now clash; reports conflicts with alternatives (work later, move lower-priority sessions, schedule after the deadline, reduce estimate); explains every session.
* Reminders and block ids are deterministic, so two devices planning the same thing don't create duplicates.

## Reminders

* **Android:** one exact `AlarmManager` alarm for the earliest pending reminder; the receiver fires all due ones (one notification each, full-screen alarm when permitted), advances recurring ones in local calendar time, records `fired_at` locally, and re-arms. Re-armed on app start, every data change, boot, app update, time and time-zone change. Reminders due while the phone was off are delivered as “missed”.
* **Windows:** the same logic in a Rust task inside the app process (independent of the React UI); it keeps running while the window is closed to the tray; autostart brings it back after login.
* `done`/`snooze`/`due` sync across devices; `fired_at` is per device.

## Security

* Pairing: admin token once (header), device gets a random 256-bit token (stored hashed on the server; Android Keystore-encrypted prefs / Windows per-user AppData on clients). The admin token is no longer stored on devices. Brute-force throttling; constant-time comparisons.
* P2P: every request is signed with HMAC-SHA256 using a mesh key that only paired, non-revoked devices can fetch from the server; timestamp window and nonce replay cache; revoking a device rotates the key. File names are sanitized; files are written to `.part` and only renamed after SHA-256 matches on both sides.
* CORS disabled by default; desktop WebView has only core IPC permissions and a strict CSP; Android WebView grants only the microphone.
* AI keys live only in `/etc/cahangir/cahangir.env` on the server.
