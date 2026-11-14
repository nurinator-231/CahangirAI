# Testing

## Automated tests (all run in CI-like Linux environment for this release)

| Suite | Command | Result for 1.0.0 |
|---|---|---|
| Backend API, auth, sync, conflicts, migration, backup/restore, AI router | `cd backend && python -m pytest -q tests` | **39 passed** |
| Shared planner (NLU + scheduler, EN/AZ) | `TZ=Asia/Baku node --test shared/planner/planner.test.js` | **27 passed** |
| Windows app — Rust unit (storage migration, reminders, P2P auth, filename sanitizing) | `cd desktop/src-tauri && cargo test --lib` | **9 passed** |
| Windows app — type check / production build | `cd desktop && npx tsc --noEmit && npm run build` | pass |
| Windows app — `cargo clippy` | | 0 warnings |
| Android — JVM unit (reminder rules incl. DST, P2P auth vector shared with Windows, schema drift vs backend) | `./gradlew :app:testDebugUnitTest` | **9 passed** |
| Android lint | `./gradlew :app:lintDebug` | 0 errors |
| **Cross-component integration** (live FastAPI + Rust sync/P2P engine + Kotlin sync engine) | `scripts/integration-test.sh` | **pass** |

The integration script starts a throw-away backend and runs:

* **Rust (Windows engine)** — two devices: create on A → appears on B; edit on B → appears on A without conflict; B offline (server unreachable) → change stays queued → reconnect → delivered; concurrent edits → deterministic resolution, both converge, conflict logged; tombstone deletion propagates; clipboard via server; authenticated P2P ping; **wrong key rejected**; 2.5 MB file in 3 chunks with a path-traversal filename → saved inside the download folder only, bytes identical, SHA-256 verified by sender and receiver; cancel leaves no partial file; clipboard push + duplicate suppressed; device revocation rotates the P2P key and the revoked device is rejected.
* **Kotlin (Android engine)** — phone creates task + recurring reminder → other device receives; other device edits → phone receives; tombstone; revoked device gets HTTP 403.

### End-to-end UI checks (headless Chromium)

* **Windows UI** (production bundle, Tauri IPC mocked in memory): the brief's example sentence → 1 task (deadline Fri 23:59, 120 min, *study*) + 1 commitment (tomorrow 10:00) + a question about the lesson length → save → plan split into 90 + 30 min sessions around the lesson with explanations → accept → blocks + deadline/event/block reminders created; every view opened without console errors.
* **Android WebView UI** (real `www/` assets, `CahangirBridge` mocked in memory): legacy localStorage items migrated into native storage keeping their ids (merged with the row v1 had already mirrored, no duplicate), same planner flow in Azerbaijani, task completion marks its reminders done, the existing reminder list and chat reminder command still work, no console errors.

### Real desktop binary (Linux build under Xvfb, live backend)

The actual Tauri app was started headless twice: it created and migrated its database, rendered the UI with the production CSP, accepted pairing data, opened the P2P port (unsigned request → HTTP 401), **fired a due reminder from the Rust engine** while running, pulled a task created by another device through the **background sync loop**, pushed its local reminder, reported its P2P address, and fetched the mesh key.

## What could not be verified here (needs physical devices)

No Windows machine or Android device/emulator was available in the build environment. The following must be checked by hand; the procedure below takes about 20 minutes.

* Windows: toast notifications, autostart after reboot, tray behaviour, clipboard watcher, firewall prompt, the MinGW-built installer on a real Windows 10/11.
* Android: AlarmManager delivery with the screen off / Doze, full-screen alarm, notification actions, boot/time-zone re-arming, share sheet, real P2P with the PC over Wi-Fi/Tailscale, speech recognition/TTS.

## Manual verification procedure

Preparation: server running (`curl http://<server>:8000/api/health`), Windows app and Android app installed and paired (see INSTALL.md). On the phone set *Battery → Unrestricted* and grant the permissions shown in Settings.

1. **Task sync Android → Windows.** Phone → Planlayıcı: “Cüməyə qədər hesabat, 2 saat” → Anla → Saxla. Within ~1 min (or press *Sync* on Windows) the task appears in Windows → Planner → Tasks.
2. **Edit sync.** On Windows change the estimate to 90 min. Phone: pull to refresh by opening the tab after ≤15 min or *Ayarlar → İndi sinxron et* → shows 90 min.
3. **Daily plan.** Windows → Planner → *Plan my time* → read the reasons → *Accept*. Check *Today/Week*; sessions avoid commitments and have 10-min breaks. The same sessions appear on the phone after sync.
4. **Persistence.** Quit both apps completely (Windows: tray → Çıxış; Android: swipe away) and reopen — everything is still there offline.
5. **Reminders.**
   * Windows: create a reminder 2 min ahead, close the window (tray) → a Windows toast appears on time.
   * Android: create a reminder 2 min ahead, lock the phone → alarm notification/full-screen alarm on time; tap *💤 10 dəq.* → rings again 10 min later; tap *✓ Oldu* → marked done on both devices after sync.
   * Android reboot test: reminder 5 min ahead, reboot phone, don't open the app → still rings.
   * Recurring: “hər gün saat 8-də dərman” → rings next morning; the due date advances on both devices.
6. **Offline.** Turn on airplane mode on the phone; add a task; turn it off → within one sync interval it appears on Windows (Ayarlar shows *gözləyən: 0* afterwards).
7. **File transfer.** Windows → File transfer → choose the phone (Tailscale or LAN address) → *Check* (shows the phone's name) → send a file. On the phone it appears in `Download/Cahangir`. Both histories show the same SHA-256. Repeat phone → PC from *Fayllar*.
8. **Clipboard.** Windows: enable *Share automatically*, copy text → phone toast; the text is on the phone's clipboard. Phone: copy text, *Pano → Kopyaladığımı göndər* → paste on Windows. Copying the same text again does not ping-pong.
9. **AI fallback.** With two providers configured, temporarily set an invalid key for the first one → planner still parses with AI via the second (Settings shows the first as `auth_failed`). Remove all keys → the planner says “AI əlçatmazdır… daxili qaydalar” and still works.
10. **No paid usage.** `curl -H "Authorization: Bearer <device token>" http://<server>:8000/api/ai/providers` shows only enabled providers, their free-tier budgets and today's usage.
11. **Revocation.** Windows → Devices → revoke a test device with the admin token → that device's sync shows “girişi ləğv edilib”, and P2P from it is refused.
