import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.backup import AutoBackup
from app.config import APP_VERSION, CORS_ORIGINS, HOST, LOG_LEVEL, PORT
from app.database import init_db
from app.routers import ai_router, auth_router, health_router, sync_router
from app.routers.entity_router import build_router, reminders_extras

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("cahangir.backend")
_autobackup = AutoBackup()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Cahangir SQLite database (migrations run with a pre-migration backup)...")
    init_db()
    _autobackup.start()
    logger.info("Cahangir backend %s ready on %s:%s", APP_VERSION, HOST, PORT)
    yield
    _autobackup.stop()
    logger.info("Cahangir backend shutting down cleanly.")


app = FastAPI(
    title="Cahangir Central Memory & Sync API",
    description="Central memory, planner data, synchronization and free-tier AI routing for Cahangir.",
    version=APP_VERSION,
    lifespan=lifespan,
)

if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Admin-Token"],
    )

app.include_router(auth_router.router)
app.include_router(auth_router.devices_router)
app.include_router(sync_router.router)
app.include_router(health_router.router)
app.include_router(ai_router.router)

_reminders = build_router("reminders", "/api/reminders", "Reminders", order_by="COALESCE(snooze, due) ASC", default_status="active")
reminders_extras(_reminders)
app.include_router(_reminders)
app.include_router(build_router("memories", "/api/memories", "Structured Memory"))
app.include_router(build_router("projects", "/api/projects", "Projects"))
app.include_router(build_router("tasks", "/api/tasks", "Planner: Tasks", order_by="COALESCE(deadline, 9e15) ASC"))
app.include_router(build_router("events", "/api/events", "Planner: Calendar events", order_by="start_at ASC"))
app.include_router(build_router("plan_blocks", "/api/plan-blocks", "Planner: Scheduled blocks", order_by="start_at ASC"))
app.include_router(build_router("clipboard_items", "/api/clipboard", "Universal clipboard", order_by="created_at DESC"))


@app.get("/", tags=["Root"])
def root():
    return {"app": "Cahangir Central Backend", "version": APP_VERSION, "status": "online", "docs_url": "/docs"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level=LOG_LEVEL.lower())
