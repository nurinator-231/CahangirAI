import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

BACKUP_DIR = BASE_DIR / "backups"
BACKUP_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = os.environ.get("CAHANGIR_DB_PATH", str(DATA_DIR / "cahangir.db"))
HOST = os.environ.get("CAHANGIR_HOST", "0.0.0.0")
PORT = int(os.environ.get("CAHANGIR_PORT", "8000"))
LOG_LEVEL = os.environ.get("CAHANGIR_LOG_LEVEL", "INFO")

# Default admin token for pairing initial devices (stored in data/admin_token.txt if not in env)
TOKEN_FILE = DATA_DIR / "admin_token.txt"
if "CAHANGIR_ADMIN_TOKEN" in os.environ:
    ADMIN_TOKEN = os.environ["CAHANGIR_ADMIN_TOKEN"]
else:
    if TOKEN_FILE.exists():
        ADMIN_TOKEN = TOKEN_FILE.read_text(encoding="utf-8").strip()
    else:
        ADMIN_TOKEN = secrets.token_urlsafe(24)
        TOKEN_FILE.write_text(ADMIN_TOKEN, encoding="utf-8")
        print("[*] Generated new admin pairing token securely (stored in admin_token.txt).")
