import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("CAHANGIR_DATA_DIR", str(BASE_DIR / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

BACKUP_DIR = Path(os.environ.get("CAHANGIR_BACKUP_DIR", str(BASE_DIR / "backups")))
BACKUP_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = os.environ.get("CAHANGIR_DB_PATH", str(DATA_DIR / "cahangir.db"))
HOST = os.environ.get("CAHANGIR_HOST", "0.0.0.0")
PORT = int(os.environ.get("CAHANGIR_PORT", "8000"))
LOG_LEVEL = os.environ.get("CAHANGIR_LOG_LEVEL", "INFO")
APP_VERSION = "4.0.0"

# CORS: native clients (Android/Kotlin, Windows/Rust) do not need CORS at all.
# Only enable explicit origins if a browser-based client is ever used.
CORS_ORIGINS = [o.strip() for o in os.environ.get("CAHANGIR_CORS_ORIGINS", "").split(",") if o.strip()]

# Automatic daily backup (hours between backups, 0 disables) and retention count.
BACKUP_INTERVAL_HOURS = float(os.environ.get("CAHANGIR_BACKUP_INTERVAL_HOURS", "24"))
BACKUP_KEEP = int(os.environ.get("CAHANGIR_BACKUP_KEEP", "14"))

# Maximum number of rows returned in a single sync delta (client pages with has_more).
SYNC_PAGE_LIMIT = int(os.environ.get("CAHANGIR_SYNC_PAGE_LIMIT", "2000"))

# Admin pairing token (stored in data/admin_token.txt if not in env)
TOKEN_FILE = DATA_DIR / "admin_token.txt"
if "CAHANGIR_ADMIN_TOKEN" in os.environ:
    ADMIN_TOKEN = os.environ["CAHANGIR_ADMIN_TOKEN"]
else:
    if TOKEN_FILE.exists():
        ADMIN_TOKEN = TOKEN_FILE.read_text(encoding="utf-8").strip()
    else:
        ADMIN_TOKEN = secrets.token_urlsafe(24)
        TOKEN_FILE.write_text(ADMIN_TOKEN, encoding="utf-8")
        try:
            os.chmod(TOKEN_FILE, 0o600)
        except OSError:
            pass
        print("[*] Generated new admin pairing token securely (stored in admin_token.txt).")
