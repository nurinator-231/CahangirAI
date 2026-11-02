# Cahangir Central Memory & Sync Server (Debian Backend)

Bu modul **Cahangir AI** şəxsi köməkçisinin mərkəzi yaddaş, sinxronizasiya və cihaz təhlükəsizlik serveridir.
Debian 13 (Intel Atom D525, 4GB RAM) kimi aşağı resurslu sistemlər üçün xüsusi olaraq optimallaşdırılmışdır.

---

## ⚡ Resurs Xərcləri və Xüsusiyyətlər
* **RAM İstifadəsi:** ~35 – 50 MB (Intel Atom üçün tamamilə təhlükəsizdir).
* **CPU Yükü:** Boş rejimdə < 0.5%, sinxronizasiya anında < 3%.
* **Verilənlər Bazası:** SQLite WAL (`Write-Ahead Logging`) rejimi — yüksək sürətli oxuma/yazma və qəzalara qarşı dayanıqlı.
* **Təhlükəsizlik:** Yalnız Tailscale VPN şəbəkəsində (`100.x.y.z`) və ya daxili LAN-da işləyir. Cihaz başına unikal tokenlə autentifikasiya.
* **Avtomatik Backup:** Hər gün avtomatik atomic SQLite `VACUUM` ehtiyat nüsxəsi yaradılır (son 7 nüsxə saxlanır).

---

## 📦 API Bölmələri

| Endpoint | Metod | Açıqlama |
|---|---|---|
| `/api/sync` | POST | İkitərəfli delta sinxronizasiyası (Push + Pull) |
| `/api/sync/pull` | GET | Son yenilənmiş məlumatları çəkmək |
| `/api/memories` | GET, POST, DELETE | Strukturlaşdırılmış yaddaş (faktlar, qeydlər, axtarış) |
| `/api/reminders` | GET, POST, PUT, DELETE | Xatırlatmalar və taymerlər |
| `/api/projects` | GET, POST, DELETE | Layihələr və tapşırıqlar |
| `/api/auth/register-device` | POST | Yeni cihazın qeydiyyatı (Android, Windows) |
| `/api/auth/devices` | GET | Qoşulmuş cihazların siyahısı |
| `/api/auth/revoke-device` | POST | İtirilmiş cihazın girişini ləğv etmək |
| `/api/health` | GET | CPU, RAM, Uptime və DB ölçüsü |
| `/api/backup` | POST | Əllə ehtiyat nüsxə çıxarmaq |

---

## 🚀 Debian 13-də Quraşdırma

1. Faylları Debian serverə köçürün (və ya git ilə çəkin):
   ```bash
   cd /path/to/cahangir/backend
   ```
2. Quraşdırma skriptini işə salın:
   ```bash
   sudo bash setup_debian.sh
   ```
3. Skript avtomatik olaraq:
   - `python3-venv` və asılılıqları quraşdıracaq,
   - `/opt/cahangir-backend` kataloquna yerləşdirəcək,
   - Systemd xidməti kimi quraşdırıb aktivləşdirəcək (`cahangir-backend.service`),
   - Sizin üçün **Admin Pairing Token** və Tailscale IP-ni ekranda göstərəcək.
